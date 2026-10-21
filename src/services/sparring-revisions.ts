import { GrowthServiceError } from './growth-cycle-types';
import { loadOwnedSparringContext } from './learning-session-context';
import { requireSparringControl } from './sparring-controls';

type Input={priorMessageId:number;revisedStatement:string;explanation:string;sourceIds:string[];supportId:string|null;expectedRevision:number;expectedTurn:number;controlRevision:number;mutationKey:string};
type Row={id:string;revision:number;expected_revision:number;expected_turn:number;control_revision:number;prior_message_id:number;prior_evaluation_id:number;prior_turn:number;prior_statement:string;revised_statement:string;explanation:string;source_ids_json:string;manifest_sha256:string;support_id:string|null;created_at:number;consumed_by_turn:number|null};
type Prior={id:number;turn:number;content:string;evaluation_id:number;manifest_id:string;manifest_sha256:string};
function fail(status:400|404|409|503,code:string):never{throw new GrowthServiceError({status,code,phase:status===400?'validation':status===404?'authorization':status===409?'conflict':'unavailable',retryable:status===503});}
function parse(value:unknown):Input{
 if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'SPARRING_REVISION_INPUT_INVALID');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['priorMessageId','revisedStatement','explanation','sourceIds','supportId','expectedRevision','expectedTurn','controlRevision','mutationKey'].includes(k))
  ||!Number.isSafeInteger(v.priorMessageId)||Number(v.priorMessageId)<1||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0
  ||!Number.isSafeInteger(v.expectedTurn)||Number(v.expectedTurn)<2||!Number.isSafeInteger(v.controlRevision)||Number(v.controlRevision)<0
  ||typeof v.revisedStatement!=='string'||!v.revisedStatement.trim()||v.revisedStatement.length>4000
  ||typeof v.explanation!=='string'||!v.explanation.trim()||v.explanation.length>4000
  ||!Array.isArray(v.sourceIds)||v.sourceIds.length>20||v.sourceIds.some(id=>typeof id!=='string'||!id.trim()||id.length>300)
  ||(v.supportId!==null&&(typeof v.supportId!=='string'||!v.supportId||v.supportId.length>100))
  ||typeof v.mutationKey!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(v.mutationKey))fail(400,'SPARRING_REVISION_INPUT_INVALID');
 return {priorMessageId:Number(v.priorMessageId),expectedRevision:Number(v.expectedRevision),expectedTurn:Number(v.expectedTurn),controlRevision:Number(v.controlRevision),
  revisedStatement:(v.revisedStatement as string).trim(),explanation:(v.explanation as string).trim(),sourceIds:[...new Set(v.sourceIds as string[])].sort(),supportId:v.supportId as string|null,mutationKey:v.mutationKey as string};
}
async function owned(db:D1Database,owner:string,sessionId:string){
 const session=await db.prepare('SELECT id,current_turn FROM sessions WHERE id=?1 AND user_id=?2').bind(sessionId,owner).first<{id:string;current_turn:number}>();
 if(!session)fail(404,'SPARRING_REVISION_NOT_FOUND');
 return session;
}
function project(row:Row){
 const sources:unknown=JSON.parse(row.source_ids_json);
 if(!Array.isArray(sources)||sources.some(id=>typeof id!=='string'))fail(503,'SPARRING_REVISION_HISTORY_UNAVAILABLE');
 return {id:row.id,revision:row.revision,priorMessageId:row.prior_message_id,priorEvaluationId:row.prior_evaluation_id,priorTurn:row.prior_turn,priorStatement:row.prior_statement,
  revisedStatement:row.revised_statement,explanation:row.explanation,sourceIds:sources as string[],manifestSha256:row.manifest_sha256,supportId:row.support_id,
  validationStatus:'UNVERIFIED' as const,createdAt:row.created_at,consumedByTurn:row.consumed_by_turn??null};
}
export async function loadSparringRevisions(db:D1Database,owner:string,sessionId:string){
 const session=await owned(db,owner,sessionId);
 const rows=await db.prepare(`SELECT r.*,m.turn AS consumed_by_turn FROM sparring_learner_revisions r
  LEFT JOIN messages m ON m.sparring_revision_id=r.id AND m.role='user' AND m.session_id=r.session_id
  WHERE r.session_id=?1 AND r.owner_user_id=?2 ORDER BY r.revision`).bind(sessionId,owner).all<Row>();
 if(!rows.success||!Array.isArray(rows.results))fail(503,'SPARRING_REVISION_HISTORY_UNAVAILABLE');
 const history=rows.results.map(project),latest=history.at(-1);
 const priors=await db.prepare(`SELECT m.id,m.turn,m.content,e.id AS evaluation_id,f.id AS manifest_id,f.manifest_sha256
  FROM messages m JOIN evaluations e ON e.session_id=m.session_id AND e.turn=m.turn AND e.user_id=?2
  JOIN sparring_evidence_manifests f ON f.session_id=m.session_id AND f.turn_number=m.turn AND f.user_id=?2
  WHERE m.session_id=?1 AND m.role='user' AND (SELECT COUNT(*) FROM evaluations WHERE session_id=m.session_id AND turn=m.turn AND user_id=?2)=1 ORDER BY m.turn`)
  .bind(sessionId,owner).all<Prior>();
 if(!priors.success||!Array.isArray(priors.results))fail(503,'SPARRING_REVISION_HISTORY_UNAVAILABLE');
 const candidates=[];
 for(const prior of priors.results){
  const sources=await db.prepare('SELECT chunk_id AS sourceId,content_snapshot AS excerpt,content_sha256 AS contentSha256 FROM sparring_turn_evidence WHERE manifest_id=?1 ORDER BY chunk_index').bind(prior.manifest_id).all<{sourceId:string;excerpt:string;contentSha256:string}>();
  const support=await db.prepare('SELECT id,response_text AS responseText FROM sparring_hint_responses WHERE session_id=?1 AND owner_user_id=?2 AND prior_message_id=?3 AND prior_evaluation_id=?4 ORDER BY hint_revision').bind(sessionId,owner,prior.id,prior.evaluation_id).all<{id:string;responseText:string}>();
  if(!sources.success||!Array.isArray(sources.results)||!support.success||!Array.isArray(support.results))fail(503,'SPARRING_REVISION_HISTORY_UNAVAILABLE');
  candidates.push({messageId:prior.id,turn:prior.turn,statement:prior.content,evaluationId:prior.evaluation_id,sources:sources.results,support:support.results});
 }
 return {status:'AVAILABLE' as const,revision:latest?.revision||0,expectedTurn:session.current_turn,history,pending:latest&&latest.consumedByTurn===null?latest:null,candidates};
}
export async function readSparringRevisions(db:D1Database,owner:string,sessionId:string){
 try{return await loadSparringRevisions(db,owner,sessionId);}catch{return {status:'UNAVAILABLE',revision:null,history:[],pending:null,candidates:[]} as const;}
}
export async function declareSparringRevision(db:D1Database,owner:string,sessionId:string,value:unknown){
 const input=parse(value),session=await owned(db,owner,sessionId),context=await loadOwnedSparringContext(db,sessionId,owner);
 const replay=async()=>{
  const row=await db.prepare(`SELECT r.*,m.turn AS consumed_by_turn FROM sparring_learner_revisions r LEFT JOIN messages m ON m.sparring_revision_id=r.id AND m.session_id=r.session_id AND m.role='user' WHERE r.session_id=?1 AND r.owner_user_id=?2 AND r.mutation_key=?3`).bind(sessionId,owner,input.mutationKey).first<Row>();
  if(!row)return null;
  if(row.prior_message_id!==input.priorMessageId||row.revised_statement!==input.revisedStatement||row.explanation!==input.explanation||row.source_ids_json!==JSON.stringify(input.sourceIds)||row.support_id!==input.supportId||row.expected_revision!==input.expectedRevision||row.expected_turn!==input.expectedTurn||row.control_revision!==input.controlRevision)fail(409,'SPARRING_REVISION_CONFLICT');
  // Replay never repeats the declaration; consumption is current derived metadata.
  return project(row);
 };
 const saved=await replay();if(saved)return saved;
 const control=await requireSparringControl(db,owner,sessionId,true);
 if(control.revision!==input.controlRevision||session.current_turn!==input.expectedTurn)fail(409,'SPARRING_REVISION_CONFLICT');
 const loaded=await loadSparringRevisions(db,owner,sessionId),prior=loaded.candidates.find(row=>row.messageId===input.priorMessageId);
 if(!prior)fail(404,'SPARRING_REVISION_PRIOR_NOT_FOUND');
 if(input.sourceIds.some(id=>!prior.sources.some(source=>source.sourceId===id))||(input.supportId!==null&&!prior.support.some(h=>h.id===input.supportId)))fail(400,'SPARRING_REVISION_SOURCE_INVALID');
 const manifest=await db.prepare('SELECT id,manifest_sha256 FROM sparring_evidence_manifests WHERE session_id=?1 AND turn_number=?2 AND user_id=?3').bind(sessionId,prior.turn,owner).first<{id:string;manifest_sha256:string}>();
 if(!manifest)fail(409,'SPARRING_REVISION_CONTEXT_REQUIRED');
 const id=crypto.randomUUID(),createdAt=Date.now();
 try{
  const result=await db.prepare(`INSERT INTO sparring_learner_revisions
   (id,session_id,context_id,owner_user_id,revision,expected_revision,mutation_key,expected_turn,control_revision,prior_message_id,prior_evaluation_id,prior_turn,prior_statement,revised_statement,explanation,source_ids_json,manifest_id,manifest_sha256,support_id,validation_status,created_at)
   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'UNVERIFIED',?20)`)
   .bind(id,sessionId,context.id,owner,input.expectedRevision+1,input.expectedRevision,input.mutationKey,input.expectedTurn,input.controlRevision,prior.messageId,prior.evaluationId,prior.turn,prior.statement,input.revisedStatement,input.explanation,JSON.stringify(input.sourceIds),manifest.id,manifest.manifest_sha256,input.supportId,createdAt).run();
  if(!result.success||result.meta.changes!==1)throw new Error('Revision persistence unconfirmed');
 }catch(error){
  const committed=await replay();if(committed)return committed;
  if(/SPARRING_REVISION_CONFLICT|UNIQUE constraint/.test(String(error)))fail(409,'SPARRING_REVISION_CONFLICT');
  fail(503,'SPARRING_REVISION_PERSISTENCE_REQUIRED');
 }
 return project({id,revision:input.expectedRevision+1,expected_revision:input.expectedRevision,expected_turn:input.expectedTurn,control_revision:input.controlRevision,prior_message_id:prior.messageId,prior_evaluation_id:prior.evaluationId,prior_turn:prior.turn,prior_statement:prior.statement,revised_statement:input.revisedStatement,explanation:input.explanation,source_ids_json:JSON.stringify(input.sourceIds),manifest_sha256:manifest.manifest_sha256,support_id:input.supportId,created_at:createdAt,consumed_by_turn:null});
}
