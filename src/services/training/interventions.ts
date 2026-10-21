export class TrainingInterventionError extends Error {
 constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function assertTrainingNotStopped(db:D1Database,sessionId:string) {
 const stopped=await db.prepare("SELECT id FROM training_interventions WHERE session_id=?1 AND action='STOP' LIMIT 1").bind(sessionId).first();
 if(stopped) throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_TERMINAL');
}
export type InterventionAction = 'HELP' | 'PAUSE' | 'RESUME' | 'STOP';
export type InterventionReason = 'LEARNER_REQUEST' | 'NON_PROGRESS' | 'DISTRESS' | 'UNSAFE_ERROR' | 'TIME_LIMIT' | 'INSUFFICIENT_EVIDENCE';
type Input = { action: InterventionAction; reason: InterventionReason; expectedRevision: number; mutationKey: string };
type EventRow = { id: string; revision: number; expected_revision: number; action: InterventionAction; reason: InterventionReason; origin: string; prior_turn_id: number | null; created_at: number; response: string | null };
export async function loadTrainingInterventions(db: D1Database, owner: string, sessionId: string) {
 const session = await db.prepare('SELECT id, is_completed FROM training_sessions WHERE id=?1 AND user_id=?2').bind(sessionId,owner).first<{id:string; is_completed:number}>();
 if (!session) throw new TrainingInterventionError(404,'TRAINING_INTERVENTION_NOT_FOUND');
 const rows = await db.prepare(`SELECT e.*, r.response FROM training_interventions e LEFT JOIN training_support_responses r ON r.intervention_id=e.id
 WHERE e.session_id=?1 AND e.owner_user_id=?2 ORDER BY e.revision`).bind(sessionId,owner).all<EventRow>();
 const history = rows.results || [], latest = history.at(-1) || null;
 const state = session.is_completed ? 'COMPLETED' : latest?.action === 'STOP' ? 'STOPPED' : latest?.action === 'PAUSE' ? 'PAUSED' : latest?.action === 'HELP' && !latest.response ? 'SUPPORT_PENDING' : 'ACTIVE';
 return { state, revision:latest?.revision || 0, latest, history };
}
function parseInput(value: unknown): Input {
 if (!value || typeof value!=='object' || Array.isArray(value)) throw new TrainingInterventionError(400,'TRAINING_INTERVENTION_INPUT_INVALID');
 const v=value as Record<string,unknown>;
 if (Object.keys(v).some(k=>!['action','reason','expectedRevision','mutationKey'].includes(k))
 || !['HELP','PAUSE','RESUME','STOP'].includes(String(v.action)) || !['LEARNER_REQUEST','DISTRESS','UNSAFE_ERROR','TIME_LIMIT','INSUFFICIENT_EVIDENCE'].includes(String(v.reason))
 || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision)<0 || typeof v.mutationKey!=='string' || !/^[A-Za-z0-9_-]{8,100}$/.test(v.mutationKey)) throw new TrainingInterventionError(400,'TRAINING_INTERVENTION_INPUT_INVALID');
 return v as Input;
}
export async function requestTrainingIntervention(db: D1Database, owner: string, sessionId: string, value: unknown) {
 return insertIntervention(db,owner,sessionId,parseInput(value),'LEARNER');
}
async function insertIntervention(db:D1Database,owner:string,sessionId:string,input:Input,origin:'LEARNER'|'POLICY') {
 const current=await loadTrainingInterventions(db,owner,sessionId);
 async function replay() {
  const row=await db.prepare('SELECT * FROM training_interventions WHERE session_id=?1 AND owner_user_id=?2 AND mutation_key=?3').bind(sessionId,owner,input.mutationKey).first<EventRow>();
  if (!row) return false;
  if (row.action!==input.action || row.reason!==input.reason || row.expected_revision!==input.expectedRevision || row.origin!==origin) throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_IDEMPOTENCY_CONFLICT');
  return true;
 }
 if (await replay()) return loadTrainingInterventions(db,owner,sessionId);
 if (['STOPPED','COMPLETED'].includes(current.state)) throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_TERMINAL');
 if (current.revision!==input.expectedRevision || (input.action==='RESUME' && current.state!=='PAUSED')) throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_CONFLICT');
 const prior=await db.prepare('SELECT id FROM training_turns WHERE session_id=?1 ORDER BY turn_number DESC, id DESC LIMIT 1').bind(sessionId).first<{id:number}>();
 if (input.action==='HELP' && !prior) throw new TrainingInterventionError(409,'TRAINING_SUPPORT_DIAGNOSIS_REQUIRED');
 try {
  await db.prepare('INSERT INTO training_interventions (id,session_id,owner_user_id,revision,expected_revision,mutation_key,action,reason,origin,prior_turn_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)')
  .bind(crypto.randomUUID(),sessionId,owner,input.expectedRevision+1,input.expectedRevision,input.mutationKey,input.action,input.reason,origin,prior?.id??null,Date.now()).run();
 } catch(error) {
  if (/TRAINING_INTERVENTION_CONFLICT|UNIQUE constraint/.test(String(error))) { if (await replay()) return loadTrainingInterventions(db,owner,sessionId); throw new TrainingInterventionError(409,'TRAINING_INTERVENTION_CONFLICT'); }
  throw error;
 }
 return loadTrainingInterventions(db,owner,sessionId);
}
/** Two consecutive accepted low-reasoning observations warrant a pause to choose support, not a diagnosis. */
export async function guardTrainingIntervention(db:D1Database,owner:string,sessionId:string) {
 let control=await loadTrainingInterventions(db,owner,sessionId);
 if(control.state==='ACTIVE') {
  const turns=await db.prepare('SELECT id, reasoning_strength, evidence_use FROM training_turns WHERE session_id=?1 ORDER BY turn_number DESC, id DESC LIMIT 2').bind(sessionId).all<{id:number;reasoning_strength:number|null;evidence_use:number|null}>();
  const recent=turns.results || [];
  if(recent.length===2 && recent.every(t=>t.reasoning_strength!==null && t.evidence_use!==null && t.reasoning_strength>=1 && t.reasoning_strength<=2 && t.evidence_use>=1 && t.evidence_use<=2)
  && (!control.latest?.prior_turn_id || control.latest.prior_turn_id<recent[0].id)) {
   control=await insertIntervention(db,owner,sessionId,{action:'PAUSE',reason:'NON_PROGRESS',expectedRevision:control.revision,mutationKey:'nonprogress-'+recent[0].id},'POLICY');
  }
 }
 if(control.state!=='ACTIVE') throw new TrainingInterventionError(409,'TRAINING_'+control.state);
 return control;
}
