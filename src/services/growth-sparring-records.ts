import { loadOwnedSparringContext } from './learning-session-context';
import { readSparringHints } from './sparring-hints';
import { loadSparringRevisions } from './sparring-revisions';
import { loadSparringControls } from './sparring-controls';
import { sha256Hex } from './library-ingestion';
import { GrowthServiceError } from './growth-cycle-types';

type Turn = { id:number; turn:number; content:string; timestamp:number; revisionId:string|null };
type Evaluation = { id:number; turn:number; createdAt:number };
const unavailable = () => new GrowthServiceError({status:503,code:'GROWTH_RECHECK_ASSISTANCE_UNAVAILABLE',phase:'evidence',retryable:true});
const whole = (v:unknown) => Number.isSafeInteger(v) && Number(v)>=0;

/** Read original owner-scoped records. The resulting text is never persisted in Growth. */
async function records(db:D1Database,owner:string,sessionId:string,contextId:string) {
  const context=await loadOwnedSparringContext(db,sessionId,owner);
  if(context.id!==contextId)throw unavailable();
  const [turns,evaluations,hints,revisions,controls]=await Promise.all([
    db.prepare(`SELECT m.id,m.turn,m.content,m.timestamp,m.sparring_revision_id AS revisionId
      FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.id=?1 AND s.user_id=?2 AND s.is_completed=1 AND m.role='user' AND m.turn>=1
      ORDER BY m.turn,m.id`).bind(sessionId,owner).all<Turn>(),
    db.prepare(`SELECT e.id,e.turn,e.created_at AS createdAt FROM evaluations e
      JOIN sessions s ON s.id=e.session_id WHERE s.id=?1 AND s.user_id=?2 AND e.user_id=?2
      ORDER BY e.turn,e.created_at,e.id`).bind(sessionId,owner).all<Evaluation>(),
    readSparringHints(db,owner,sessionId),loadSparringRevisions(db,owner,sessionId),loadSparringControls(db,owner,sessionId),
  ]);
  if(!turns.success||!Array.isArray(turns.results)||!turns.results.length
    ||!evaluations.success||!Array.isArray(evaluations.results)||hints.status==='UNAVAILABLE'
    ||turns.results.some(r=>!whole(r.id)||!whole(r.turn)||r.turn<1||!whole(r.timestamp)||typeof r.content!=='string'||!r.content.trim())
    ||evaluations.results.some(r=>!whole(r.id)||!whole(r.turn)||!whole(r.createdAt))
    ||revisions.history.some(r=>!r.id||!whole(r.revision)||!whole(r.createdAt)||typeof r.priorStatement!=='string'
      ||typeof r.revisedStatement!=='string'||typeof r.explanation!=='string'||!r.revisedStatement.trim()||!r.explanation.trim()
      ||!/^[a-f0-9]{64}$/.test(r.manifestSha256))
    ||controls.history.some(r=>!r.id||!whole(r.revision)||!whole(r.created_at)||!['PAUSE','RESUME','STOP'].includes(r.action)
      ||!['LEARNER','POLICY'].includes(r.origin))) throw unavailable();
  return {turns:turns.results,evaluations:evaluations.results,hints:hints.responses,revisions:revisions.history,
    controls:controls.history.map(r=>({id:r.id,revision:r.revision,action:r.action,reason:r.reason,origin:r.origin,
      policyReason:r.policy_reason,previousMessageId:r.previous_message_id,previousEvaluationId:r.previous_evaluation_id,
      latestMessageId:r.latest_message_id,latestEvaluationId:r.latest_evaluation_id,createdAt:r.created_at}))};
}
export type GrowthSparringRecords = Awaited<ReturnType<typeof records>>;
export type GrowthSparringRecordDetail = {status:'AVAILABLE'; records:GrowthSparringRecords} | {status:'UNAVAILABLE'};

function identifiers(value:GrowthSparringRecords) {
  return {turns:value.turns.map(r=>r.id),evaluations:value.evaluations.map(r=>r.id),hints:value.hints.map(r=>r.hintId),
    revisions:value.revisions.map(r=>r.id),controls:value.controls.map(r=>r.id)};
}

export async function captureSparringRecordIndex(db:D1Database,owner:string,sessionId:string,contextId:string) {
  try {
    const value=await records(db,owner,sessionId,contextId);
    return {recordIds:identifiers(value),recordsSha256:await sha256Hex(JSON.stringify(value))};
  } catch { throw unavailable(); }
}

/** Hash mismatches, failed reads and erasure withhold source text, without fabricating empty history. */
export async function resolveSparringRecordIndex(db:D1Database,owner:string,sessionId:string,contextId:string,index:unknown):Promise<GrowthSparringRecordDetail> {
  try {
    if(!index||typeof index!=='object'||Array.isArray(index))return {status:'UNAVAILABLE'};
    const expected=index as Record<string,unknown>;
    const value=await records(db,owner,sessionId,contextId);
    if(await sha256Hex(JSON.stringify(value))!==expected.recordsSha256
      ||JSON.stringify(identifiers(value))!==JSON.stringify(expected.recordIds))return {status:'UNAVAILABLE'};
    // Close a context-erasure race after reading the independent record sets.
    if((await loadOwnedSparringContext(db,sessionId,owner)).id!==contextId)return {status:'UNAVAILABLE'};
    return {status:'AVAILABLE',records:value};
  } catch { return {status:'UNAVAILABLE'}; }
}
