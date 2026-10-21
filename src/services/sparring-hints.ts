import { requireSparringHintControl } from './sparring-controls';
import type { Bindings } from '../types';
import { createAIRouter } from './ai-router';
import { getSession } from './student-model';
import { loadOwnedSparringContext } from './learning-session-context';
import { retrieveLibraryChunks } from './library-retrieval';
import { generateBoundedSupport } from './training/bounded-support';
import { GrowthServiceError } from './growth-cycle-types';
import { resetRequestTokenUsage, setTokenTrackingContext } from './ai-client';

type HintRow={control_revision?:number;id:string;turn_number:number;hint_level:number;response_text:string;source_snapshot_json:string;created_at:number};
function project(row:HintRow){
  const parsed:unknown=JSON.parse(row.source_snapshot_json);
  if(!Array.isArray(parsed)||!parsed.length||parsed.some(source=>!source||typeof source!=='object'||typeof source.sourceId!=='string'||!source.sourceId.trim()||typeof source.excerpt!=='string'||!source.excerpt.trim()||typeof source.contentSha256!=='string'||!/^([a-f0-9]{64})$/.test(source.contentSha256))
    ||typeof row.id!=='string'||!row.id.trim()||!Number.isSafeInteger(row.created_at)||row.created_at<0
    ||typeof row.response_text!=='string'||!row.response_text.trim()||!Number.isSafeInteger(row.turn_number)||row.turn_number<2||![1,2].includes(row.hint_level))throw new GrowthServiceError({status:503,code:'SPARRING_HINT_HISTORY_UNAVAILABLE',phase:'evidence'});
  const sources=parsed as Array<{sourceId:string;excerpt:string;contentSha256:string}>;
  return {hintId:row.id,turnNumber:row.turn_number,hintLevel:row.hint_level,hintLevelName:'근거 설명',
    hintMessage:row.response_text,sourceIds:sources.map(source=>source.sourceId),
    sources:sources.map(source=>({sourceId:source.sourceId,excerpt:source.excerpt,contentSha256:source.contentSha256})),createdAt:row.created_at,
    graded:false,responseStatus:'RESPONSE_COMMITTED',deliveryValidation:'UNKNOWN'} as const;
}

export async function readSparringHints(db:D1Database,owner:string,sessionId:string){
  const unavailable={status:'UNAVAILABLE',responses:[] as ReturnType<typeof project>[]} as const;
  try{
    const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sparring_hint_responses'").first();
    if(!exists)return unavailable;
    const rows=await db.prepare(`SELECT hint.* FROM sparring_hint_responses hint JOIN sessions s ON s.id=hint.session_id
      WHERE hint.session_id=?1 AND hint.owner_user_id=?2 AND s.user_id=?2 ORDER BY hint.hint_revision`)
      .bind(sessionId,owner).all<HintRow>();
    if(!rows.success||!Array.isArray(rows.results))return unavailable;
    return {status:rows.results.length?'RECORDED':'NOT_RECORDED',responses:rows.results.map(project)} as const;
  }catch{return unavailable;}
}

export async function provideSparringHint(env:Bindings,owner:string,sessionId:string,mutationKey:string,expectedTurn:number){
  const db=env.DB;
  const session=await getSession(db,sessionId);
  if(!session||session.userId!==owner)throw new GrowthServiceError({status:404,code:'SPARRING_SESSION_NOT_FOUND',phase:'authorization'});
  const context=await loadOwnedSparringContext(db,sessionId,owner);
  const prior=await db.prepare('SELECT * FROM sparring_hint_responses WHERE session_id=?1 AND owner_user_id=?2 AND mutation_key=?3')
    .bind(sessionId,owner,mutationKey).first<HintRow>();
  if(prior){
    if(prior.turn_number!==expectedTurn)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_CONTEXT_CHANGED',phase:'conflict'});
    return project(prior);
  }
  if(session.currentTurn!==expectedTurn)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_CONTEXT_CHANGED',phase:'conflict'});
  if(session.isCompleted||session.isAbandoned||session.currentTurn>session.maxTurns)throw new GrowthServiceError({status:409,code:'SPARRING_SESSION_ENDED',phase:'conflict'});
  const control=await requireSparringHintControl(db,owner,sessionId);
  const episodeReplay=()=>db.prepare('SELECT * FROM sparring_hint_responses WHERE session_id=?1 AND owner_user_id=?2 AND control_revision=?3').bind(sessionId,owner,control.revision).first<HintRow>();
  if(control.state==='PAUSED'){
    const saved=await episodeReplay();
    if(saved)return project(saved);
  }
  const observation=await db.prepare(`SELECT m.id AS message_id,m.content,e.id AS evaluation_id,e.feedback
    FROM messages m JOIN evaluations e ON e.id=(SELECT id FROM evaluations WHERE session_id=m.session_id AND user_id=?2 AND turn=m.turn ORDER BY created_at DESC,id DESC LIMIT 1)
    WHERE m.session_id=?1 AND m.role='user' AND m.turn=?3 ORDER BY m.id DESC LIMIT 1`)
    .bind(sessionId,owner,session.currentTurn-1).first<{message_id:number;content:string;evaluation_id:number;feedback:string}>();
  if(!observation)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_DIAGNOSIS_REQUIRED',phase:'evidence'});
  let feedback:unknown;
  try{feedback=JSON.parse(observation.feedback);}catch{feedback=null;}
  if(!feedback||typeof feedback!=='object'||!('diagnosis' in feedback)||typeof feedback.diagnosis!=='string'||!feedback.diagnosis.trim()||typeof observation.content!=='string'||!observation.content.trim())throw new GrowthServiceError({status:503,code:'SPARRING_HINT_DIAGNOSIS_UNAVAILABLE',phase:'evidence'});
  const chunks=(await retrieveLibraryChunks(db,session.bookId,session.currentClaim||session.topic,owner)).filter(chunk=>chunk.content.trim());
  if(!chunks.length)throw new GrowthServiceError({status:409,code:'SPARRING_SOURCE_UNAVAILABLE',phase:'evidence',retryable:false});
  const sources=chunks.map(chunk=>({sourceId:chunk.chunkId,excerpt:chunk.content,contentSha256:chunk.contentSha256}));
  const router=createAIRouter(env,{mode:'context_bound',pinnedRoutePlan:context.routes,invocationScope:{
    sessionContextId:context.id,sessionId,turnNumber:session.currentTurn,promptCacheNamespace:context.promptCacheNamespace}});
  resetRequestTokenUsage();
  setTokenTrackingContext({db,sessionId,userId:owner,turnNumber:session.currentTurn,callType:'mentor'});
  let result;
  try{result=await generateBoundedSupport(router,{studentMessage:observation.content,diagnosis:feedback.diagnosis,currentState:session.tutorState||'elicitation',topic:session.topic,sources});}
  finally{setTokenTrackingContext(null);}
  const hintId=crypto.randomUUID(),createdAt=Date.now(),level=Math.min(2,session.hintLevel+1);
  const snapshot=JSON.stringify(sources);
  try{
    const results=await db.batch([
      db.prepare(`INSERT INTO sparring_hint_responses (id,session_id,context_id,owner_user_id,mutation_key,prior_message_id,prior_evaluation_id,
        turn_number,hint_revision,hint_level,response_text,source_snapshot_json,diagnosis_json,routing_json,policy_revision,created_at,control_revision)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'sparring-bounded-hint-v1',?15,?16)`)
        .bind(hintId,sessionId,context.id,owner,mutationKey,observation.message_id,observation.evaluation_id,session.currentTurn,
          session.hintRequestCount+1,level,result.finalResponse,snapshot,observation.feedback,JSON.stringify({actor:result.actorRoute,critic:result.criticRoute}),createdAt,control.revision),
      db.prepare('UPDATE sessions SET hint_request_count=?3,hint_level=?4 WHERE id=?1 AND user_id=?2 AND current_turn=?5 AND hint_request_count=?6 AND is_completed=0 AND is_abandoned=0')
        .bind(sessionId,owner,session.hintRequestCount+1,level,session.currentTurn,session.hintRequestCount),
    ]);
    if(results.length!==2||results.some(row=>!row.success||row.meta.changes!==1))throw new Error('Hint persistence unconfirmed');
  }catch(error){
    if(String(error).includes('SPARRING_SOURCE_UNAVAILABLE'))throw new GrowthServiceError({status:409,code:'SPARRING_SOURCE_UNAVAILABLE',phase:'evidence',retryable:false});
    // A concurrent same-key commit is a replay. Other races must not return stale help.
    const saved=await db.prepare('SELECT * FROM sparring_hint_responses WHERE session_id=?1 AND owner_user_id=?2 AND mutation_key=?3').bind(sessionId,owner,mutationKey).first<HintRow>();
    if(saved){
      if(saved.turn_number!==expectedTurn||saved.control_revision!==control.revision)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_CONTEXT_CHANGED',phase:'conflict'});
      return project(saved);
    }
    const current=await db.prepare('SELECT current_turn,hint_request_count,is_completed,is_abandoned FROM sessions WHERE id=?1 AND user_id=?2').bind(sessionId,owner).first<{current_turn:number;hint_request_count:number;is_completed:number;is_abandoned:number}>();
    if(!current||current.current_turn!==expectedTurn||current.hint_request_count!==session.hintRequestCount||current.is_completed||current.is_abandoned)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_CONTEXT_CHANGED',phase:'conflict'});
    const activeControl=await requireSparringHintControl(db,owner,sessionId);
    if(activeControl.revision!==control.revision)throw new GrowthServiceError({status:409,code:'SPARRING_CONTROL_CONFLICT',phase:'conflict'});
    if(activeControl.state==='PAUSED'){const saved=await episodeReplay();if(saved)return project(saved);}
    const activeContext=await loadOwnedSparringContext(db,sessionId,owner);
    if(activeContext.id!==context.id)throw new GrowthServiceError({status:409,code:'SPARRING_HINT_CONTEXT_CHANGED',phase:'conflict'});
    throw new GrowthServiceError({status:503,code:'SPARRING_HINT_PERSISTENCE_REQUIRED',phase:'unavailable',retryable:true});
  }
  return project({id:hintId,turn_number:session.currentTurn,hint_level:level,response_text:result.finalResponse,source_snapshot_json:snapshot,created_at:createdAt});
}
