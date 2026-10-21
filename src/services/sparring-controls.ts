import { GrowthServiceError } from './growth-cycle-types';
import { loadOwnedSparringContext } from './learning-session-context';

type Action='PAUSE'|'RESUME'|'STOP';
type ControlRow={id:string;revision:number;expected_revision:number;action:Action;reason:string;created_at:number;origin:'LEARNER'|'POLICY';policy_reason:string|null;previous_message_id:number|null;previous_evaluation_id:number|null;latest_message_id:number|null;latest_evaluation_id:number|null};
function conflict(){return new GrowthServiceError({status:409,code:'SPARRING_CONTROL_CONFLICT',phase:'conflict'});}

export async function loadSparringControls(db:D1Database,owner:string,sessionId:string){
 const session=await db.prepare('SELECT id,is_completed,is_abandoned,current_turn,max_turns FROM sessions WHERE id=?1 AND user_id=?2')
  .bind(sessionId,owner).first<{id:string;is_completed:number;is_abandoned:number;current_turn:number;max_turns:number}>();
 if(!session)throw new GrowthServiceError({status:404,code:'SPARRING_SESSION_NOT_FOUND',phase:'authorization'});
 const rows=await db.prepare('SELECT * FROM sparring_controls WHERE session_id=?1 AND owner_user_id=?2 ORDER BY revision').bind(sessionId,owner).all<ControlRow>();
 if(!rows.success||!Array.isArray(rows.results))throw new GrowthServiceError({status:503,code:'SPARRING_CONTROL_UNAVAILABLE',phase:'unavailable'});
 const history=rows.results,latest=history.at(-1);
 const state=latest?.action==='STOP'?'STOPPED':session.is_completed||session.current_turn>session.max_turns?'COMPLETED':session.is_abandoned?'ABANDONED':latest?.action==='PAUSE'?'PAUSED':'ACTIVE';
 return {state,revision:latest?.revision||0,history} as const;
}

export async function requireSparringControl(db:D1Database,owner:string,sessionId:string,allowPaused=false){
 const control=await loadSparringControls(db,owner,sessionId);
 if(control.state!=='ACTIVE'&&!(allowPaused&&control.state==='PAUSED'))throw new GrowthServiceError({status:409,code:'SPARRING_'+control.state,phase:'conflict'});
 return control;
}

export async function requestSparringControl(db:D1Database,owner:string,sessionId:string,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new GrowthServiceError({status:400,code:'SPARRING_CONTROL_INPUT_INVALID',phase:'validation'});
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['action','reason','expectedRevision','mutationKey'].includes(k))
  ||!['PAUSE','RESUME','STOP'].includes(String(v.action))||!['LEARNER_REQUEST','DISTRESS','UNSAFE_ERROR','TIME_LIMIT','INSUFFICIENT_EVIDENCE'].includes(String(v.reason))
  ||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0||typeof v.mutationKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(v.mutationKey))
  throw new GrowthServiceError({status:400,code:'SPARRING_CONTROL_INPUT_INVALID',phase:'validation'});
 const current=await loadSparringControls(db,owner,sessionId);
 const context=await loadOwnedSparringContext(db,sessionId,owner);
 const action=v.action as Action,reason=String(v.reason),expectedRevision=Number(v.expectedRevision),key=v.mutationKey;
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM sparring_controls WHERE session_id=?1 AND owner_user_id=?2 AND mutation_key=?3').bind(sessionId,owner,key).first<ControlRow>();
  if(!row)return false;
  if(row.origin!=='LEARNER'||row.action!==action||row.reason!==reason||row.expected_revision!==expectedRevision)throw conflict();
  return true;
 };
 if(await replay())return loadSparringControls(db,owner,sessionId);
 if(!['ACTIVE','PAUSED'].includes(current.state))throw new GrowthServiceError({status:409,code:'SPARRING_'+current.state,phase:'conflict'});
 if(expectedRevision!==current.revision||(action==='RESUME'&&current.state!=='PAUSED')||(action==='PAUSE'&&current.state==='PAUSED'))throw conflict();
 try{
  const result=await db.prepare('INSERT INTO sparring_controls (id,session_id,context_id,owner_user_id,revision,expected_revision,mutation_key,action,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)')
   .bind(crypto.randomUUID(),sessionId,context.id,owner,expectedRevision+1,expectedRevision,key,action,reason,Date.now()).run();
  if(!result.success||result.meta.changes!==1)throw new Error('Control persistence unconfirmed');
 }catch(error){
  if(await replay())return loadSparringControls(db,owner,sessionId);
  await loadOwnedSparringContext(db,sessionId,owner);
  await loadSparringControls(db,owner,sessionId);
  if(String(error).includes('SPARRING_CONTROL_CONFLICT'))throw conflict();
  throw new GrowthServiceError({status:503,code:'SPARRING_CONTROL_UNAVAILABLE',phase:'unavailable',retryable:true});
 }
 return loadSparringControls(db,owner,sessionId);
}

export async function readSparringControls(db:D1Database,owner:string,sessionId:string){
 try{await loadOwnedSparringContext(db,sessionId,owner);return await loadSparringControls(db,owner,sessionId);}catch{return {state:'UNAVAILABLE',revision:null,history:[]} as const;}
}

// Low rubric observations justify an optional change of approach, not a diagnosis.
export async function guardSparringNonProgress(db:D1Database,owner:string,sessionId:string){
 const control=await requireSparringControl(db,owner,sessionId);
 const observation=await db.prepare(`SELECT a.id AS previous_message_id,ea.id AS previous_evaluation_id,b.id AS latest_message_id,eb.id AS latest_evaluation_id
  FROM sessions s JOIN messages b ON b.session_id=s.id AND b.role='user' AND b.turn=s.current_turn-1
  JOIN messages a ON a.session_id=s.id AND a.role='user' AND a.turn=b.turn-1
  JOIN evaluations ea ON ea.session_id=s.id AND ea.user_id=s.user_id AND ea.turn=a.turn
  JOIN evaluations eb ON eb.session_id=s.id AND eb.user_id=s.user_id AND eb.turn=b.turn
  WHERE s.id=?1 AND s.user_id=?2
   AND ea.defense_score IN (20,40) AND ea.evidence_score IN (20,40) AND eb.defense_score IN (20,40) AND eb.evidence_score IN (20,40)
   AND (SELECT COUNT(*) FROM evaluations WHERE session_id=s.id AND user_id=s.user_id AND turn IN (a.turn,b.turn))=2
   AND (SELECT COUNT(*) FROM messages WHERE session_id=s.id AND role='user' AND turn IN (a.turn,b.turn))=2
   AND NOT EXISTS(SELECT 1 FROM sparring_controls WHERE session_id=s.id AND origin='POLICY' AND latest_message_id=b.id)`)
  .bind(sessionId,owner).first<{previous_message_id:number;previous_evaluation_id:number;latest_message_id:number;latest_evaluation_id:number}>();
 if(!observation)return control;
 const context=await loadOwnedSparringContext(db,sessionId,owner);
 try{
  const saved=await db.prepare(`INSERT INTO sparring_controls
   (id,session_id,context_id,owner_user_id,revision,expected_revision,mutation_key,action,reason,created_at,origin,policy_reason,previous_message_id,previous_evaluation_id,latest_message_id,latest_evaluation_id)
   VALUES (?1,?2,?3,?4,?5,?6,?7,'PAUSE','INSUFFICIENT_EVIDENCE',?8,'POLICY','NON_PROGRESS',?9,?10,?11,?12)`)
   .bind(crypto.randomUUID(),sessionId,context.id,owner,control.revision+1,control.revision,'policy-'+crypto.randomUUID(),Date.now(),observation.previous_message_id,observation.previous_evaluation_id,observation.latest_message_id,observation.latest_evaluation_id).run();
  if(!saved.success||saved.meta.changes!==1)throw new Error('Policy pause persistence unconfirmed');
 }catch(error){
  // A winning pause/stop is authoritative. A concurrent resume must be retried,
  // not used to generate from the pre-race session and control snapshot.
  await requireSparringControl(db,owner,sessionId);
  if(String(error).includes('SPARRING_CONTROL_CONFLICT')||String(error).includes('UNIQUE constraint'))throw conflict();
  throw new GrowthServiceError({status:503,code:'SPARRING_CONTROL_UNAVAILABLE',phase:'unavailable',retryable:true});
 }
 throw new GrowthServiceError({status:409,code:'SPARRING_PAUSED',phase:'conflict'});
}

export async function requireSparringHintControl(db:D1Database,owner:string,sessionId:string){
 const control=await loadSparringControls(db,owner,sessionId),latest=control.history.at(-1);
 if(control.state==='ACTIVE'||(control.state==='PAUSED'&&latest?.origin==='POLICY'&&latest.policy_reason==='NON_PROGRESS'))return control;
 throw new GrowthServiceError({status:409,code:'SPARRING_'+control.state,phase:'conflict'});
}
