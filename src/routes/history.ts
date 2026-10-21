import { loadSparringRevisions,readSparringRevisions,declareSparringRevision } from '../services/sparring-revisions';
import { loadSparringControls, readSparringControls, requestSparringControl } from '../services/sparring-controls';
import { GrowthServiceError } from '../services/growth-cycle-types';
import { LearningSessionContextError, loadOwnedSparringContext } from '../services/learning-session-context';
import { readSparringHints } from '../services/sparring-hints';
import { readFollowUpLink } from '../services/growth-follow-up';
// History API Route - /api/sessions
import { Hono, type Context } from 'hono';
import type { Bindings } from '../types';
import { getSession, generateSessionReport } from '../services/student-model';
import { requireAuth, getAuthUser, canAccessOwnerResource } from '../middleware/auth';
import { TrainingOperationError, legacyScenarioProjection, listTrainingSessions, promoteLegacyScenarioForResume, publicTrainingSession, readTrainingHistoryGrounding, toPublicTrainingMode } from './training';
import { loadTrainingCaseContractProjection } from '../services/training/scenario-evidence';
import { readOwnedTrainingHistorySupplements } from '../services/training/history-supplements';
import { loadLearnerSourceAttributions } from '../services/source-attribution';
import { readTrainingFollowUpLink } from '../services/growth-follow-up';
import { readOwnedHeldOutAttempt } from '../services/training/heldout-delivery';

type SparringSessionListRow = {
  id: string; topic: string; book_title: string | null; book_chapter: string | null;
  created_at: number; current_turn: number; max_turns: number; is_completed: number;
  core_claim: string | null; textual_evidence_cited: number | null;
  avg_logic: number | null; rating: string | null; has_evaluation: number;
};

const historyRoute = new Hono<{ Bindings: Bindings }>();

historyRoute.use('/api/sessions', requireAuth);
historyRoute.use('/api/sessions/*', requireAuth);

function requesterId(c: Context<{ Bindings: Bindings }>): string | null {
  return getAuthUser(c)?.userId || null;
}

function controlFailure(c:Context<{Bindings:Bindings}>,error:unknown){
 if(error instanceof GrowthServiceError)return c.json({error:'대화 상태를 변경하지 못했습니다.',code:error.code,retryable:error.retryable},error.status);
 if(error instanceof LearningSessionContextError)return c.json({error:'학습 맥락을 확인할 수 없습니다.',code:error.code==='CONTEXT_NOT_FOUND'?'SESSION_CONTEXT_REQUIRED':'SESSION_CONTEXT_INVALID',retryable:false},error.code==='CONTEXT_NOT_FOUND'?409:503);
 if(error instanceof SyntaxError)return c.json({code:'SPARRING_CONTROL_INPUT_INVALID'},400);
 return c.json({error:'대화 상태를 확인할 수 없습니다.',code:'SPARRING_CONTROL_UNAVAILABLE',retryable:true},503);
}
historyRoute.get('/api/sessions/:id/controls',async c=>{
 try{const owner=requesterId(c)!;const control=await loadSparringControls(c.env.DB,owner,c.req.param('id'));await loadOwnedSparringContext(c.env.DB,c.req.param('id'),owner);return c.json(control);}
 catch(error){return controlFailure(c,error);}
});
historyRoute.post('/api/sessions/:id/controls',async c=>{
 try{return c.json(await requestSparringControl(c.env.DB,requesterId(c)!,c.req.param('id'),await c.req.json()));}
 catch(error){return controlFailure(c,error);}
});

function revisionFailure(c:Context<{Bindings:Bindings}>,error:unknown){
 if(error instanceof GrowthServiceError)return c.json({error:'생각 수정 기록을 확인하거나 저장하지 못했습니다.',code:error.code,retryable:error.retryable},error.status);
 if(error instanceof SyntaxError)return c.json({error:'입력 형식을 확인해 주세요.',code:'SPARRING_REVISION_INPUT_INVALID'},400);
 return c.json({error:'생각 수정 기록을 현재 불러올 수 없습니다.',code:'SPARRING_REVISION_HISTORY_UNAVAILABLE',retryable:true},503);
}
 historyRoute.get('/api/sessions/:id/revisions',async c=>{
 try{return c.json(await loadSparringRevisions(c.env.DB,requesterId(c)!,c.req.param('id')));}catch(error){return revisionFailure(c,error);}
});
 historyRoute.post('/api/sessions/:id/revisions',async c=>{
 try{return c.json(await declareSparringRevision(c.env.DB,requesterId(c)!,c.req.param('id'),await c.req.json()));}catch(error){return revisionFailure(c,error);}
});

function publicSparringMeasurement(
  avgLogic: unknown,
  rating: unknown,
  radarScores: unknown,
  hasPersistedEvaluation: boolean,
) {
  const score = typeof avgLogic === 'number' ? avgLogic : Number(avgLogic);
  const ratingValue = typeof rating === 'string' ? rating.trim() : '';
  const measured = hasPersistedEvaluation
    && ratingValue !== '' && ratingValue !== 'UNKNOWN'
    && Number.isFinite(score) && score >= 20 && score <= 100;
  return measured
    ? { avgLogic: score, rating: ratingValue, radarScores: radarScores ?? null, evaluationStatus: 'MEASURED' as const }
    : { avgLogic: null, rating: 'UNKNOWN', radarScores: null, evaluationStatus: 'UNKNOWN' as const };
}

async function hasSparringEvaluation(db: D1Database, sessionId: string): Promise<boolean> {
  return Boolean(await db.prepare(
    'SELECT 1 AS present FROM evaluations WHERE session_id = ?1 LIMIT 1'
  ).bind(sessionId).first<{ present: number }>());
}

// Get all session history (summary list) — includes Sparring + Training sessions
historyRoute.get('/api/sessions', async (c) => {
  const db = c.env.DB;
  const userId = requesterId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다.' }, 401);

  // Sparring sessions
  const sparringResult = await db.prepare(`
    SELECT s.*,
      EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id) AS has_evaluation
    FROM sessions s
    WHERE s.user_id = ?1
    ORDER BY s.created_at DESC LIMIT 50
  `).bind(userId).all<SparringSessionListRow>();

  const sparringSessions = await Promise.all((sparringResult.results || []).map(async (s: SparringSessionListRow) => {
    const controls=await readSparringControls(db,userId,s.id);
    const measurement = publicSparringMeasurement(
      s.avg_logic,
      s.rating,
      null,
      Number(s.has_evaluation) === 1,
    );
    return {
      id: s.id,
      type: 'sparring',
      topic: s.topic,
      bookTitle: s.book_title,
      bookChapter: s.book_chapter,
      createdAt: s.created_at,
      currentTurn: s.current_turn,
      maxTurns: s.max_turns,
      avgLogic: measurement.avgLogic,
      rating: measurement.rating,
      evaluationStatus: measurement.evaluationStatus,
      isCompleted: !!s.is_completed || s.current_turn > s.max_turns,
      coreClaim: s.core_claim,
      textualEvidenceCited: s.textual_evidence_cited,
      canDelete: true,
      controlState: controls.state,
      canResume: ['ACTIVE','PAUSED'].includes(controls.state),
    };
  }));

  // Training is canonical. Its list also projects owned, unpromoted legacy Scenario rows.
  const trainingResult = await listTrainingSessions(c.env, userId);
  const trainingSessions = trainingResult.map((s) => ({
    id: s.id,
    type: 'training',
    topic: s.question_title || s.category,
    category: s.category,
    difficulty: s.difficulty,
    createdAt: s.created_at,
    currentTurn: Math.max(0, (Number(s.current_turn) || 1) - 1),
    maxTurns: s.max_turns || 8,
    avgLogic: s.avg_score == null ? null : Number(s.avg_score),
    rating: s.rating ?? (s.origin === 'legacy_scenario' ? 'UNKNOWN' : null),
    evaluationStatus: ('evaluation_status' in s && s.evaluation_status) || 'UNKNOWN',
    isCompleted: !!s.is_completed,
    canDelete: true,
    canResume: !s.is_completed && (s.current_turn || 1) <= (s.max_turns || 8),  // Training sessions now support resume
    mode: s.mode,
    origin: s.origin,
  }));

  // Merge and sort by createdAt descending
  const allSessions = [...sparringSessions, ...trainingSessions]
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .slice(0, 50);

  return c.json({ sessions: allSessions });
});

// Get session detail for resume
historyRoute.get('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;

  const training = await db.prepare(`
    SELECT ts.*,
      EXISTS(
        SELECT 1 FROM training_turns tt
        WHERE tt.session_id = ts.id
          AND tt.claim_clarity BETWEEN 1 AND 5
          AND tt.evidence_use BETWEEN 1 AND 5
          AND tt.reasoning_strength BETWEEN 1 AND 5
          AND tt.consistency_score BETWEEN 1 AND 5
          AND tt.relevance_score BETWEEN 1 AND 5
      ) AS has_evaluated_turn
    FROM training_sessions ts WHERE ts.id = ?1
  `).bind(id).first<Record<string, unknown>>();
  if (training) {
    if (!canAccessOwnerResource((training.user_id as string | null) || null, requesterUserId)) return c.json({ error: '접근 권한이 없습니다.' }, 403);
    const grounding = await readTrainingHistoryGrounding(db, id, toPublicTrainingMode(training.training_mode));
    const caseReadback = await loadTrainingCaseContractProjection(db, id);
    if (caseReadback.status === 'broken') return c.json({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', error: '훈련 사례 스냅샷을 검증하지 못했습니다.', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' }, 409);
    const messages = await db.prepare('SELECT role, content, turn, timestamp FROM training_messages WHERE session_id = ?1 ORDER BY timestamp ASC').bind(id).all();
    const attributions = await loadLearnerSourceAttributions(db, { userId: requesterUserId!, sessionKind: 'training', sessionId: id });
    return c.json({ growthFollowUp: await readTrainingFollowUpLink(db, requesterUserId!, id), grounding, caseContract: caseReadback.caseContract, caseContractStatus: caseReadback.status, trainingHistory: await readOwnedTrainingHistorySupplements(db, requesterUserId!, id), heldOutAttempt: await readOwnedHeldOutAttempt(db, requesterUserId!, id), id: training.id, type: 'training', topic: training.question_title || training.category, currentTurn: training.current_turn, maxTurns: training.max_turns, isCompleted: !!training.is_completed, mode: toPublicTrainingMode(training.training_mode), origin: String(training.id).startsWith('scn_') ? 'legacy_scenario' : 'training', conversationHistory: messages.results || [], attributions });
  }

  const legacy = await legacyScenarioProjection(c.env, requesterUserId || '', id);
  if (legacy) {
    return c.json({ id: legacy.session.id, type: 'training', topic: legacy.session.question_title || legacy.session.category, currentTurn: legacy.session.current_turn, maxTurns: legacy.session.max_turns, isCompleted: !!legacy.session.is_completed, mode: 'constructed', origin: 'legacy_scenario', readOnly: !!legacy.session.is_completed, conversationHistory: legacy.messages });
  }

  const session = await getSession(db, id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const hintHistory=await readSparringHints(db,requesterUserId!,id);
  const attributions = await loadLearnerSourceAttributions(db, { userId: requesterUserId!, sessionKind: 'sparring', sessionId: id });
  const measurement = publicSparringMeasurement(
    session.avgLogic,
    session.rating,
    session.radarScores,
    await hasSparringEvaluation(db, id),
  );
  return c.json({
    growthFollowUp: await readFollowUpLink(db,requesterUserId!,id,'SPARRING'),
    controls: await readSparringControls(db,requesterUserId!,id),
    hintResponses: hintHistory.responses, hintHistoryStatus: hintHistory.status,
    revisions: await readSparringRevisions(db,requesterUserId!,id),
    id: session.id,
    topic: session.topic,
    bookId: session.bookId,
    bookTitle: session.bookTitle,
    bookChapter: session.bookChapter,
    currentTurn: session.currentTurn,
    maxTurns: session.maxTurns,
    currentPhase: session.currentPhase,
    hintLevel: session.hintLevel,
    radarScores: measurement.radarScores,
    avgLogic: measurement.avgLogic,
    rating: measurement.rating,
    evaluationStatus: measurement.evaluationStatus,
    coreClaim: session.coreClaim,
    currentClaim: session.currentClaim,
    conversationHistory: session.conversationHistory,
    isCompleted: session.isCompleted || session.currentTurn > session.maxTurns,
    attributions,
  });
});

// Resume session (touch endpoint + snapshot)
historyRoute.post('/api/sessions/:id/resume', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;

  const training = await db.prepare(`
    SELECT ts.*,
      EXISTS(
        SELECT 1 FROM training_turns tt
        WHERE tt.session_id = ts.id
          AND tt.claim_clarity BETWEEN 1 AND 5
          AND tt.evidence_use BETWEEN 1 AND 5
          AND tt.reasoning_strength BETWEEN 1 AND 5
          AND tt.consistency_score BETWEEN 1 AND 5
          AND tt.relevance_score BETWEEN 1 AND 5
      ) AS has_evaluated_turn
    FROM training_sessions ts WHERE ts.id = ?1
  `).bind(id).first<Record<string, unknown>>();
  if (training) {
    if (!canAccessOwnerResource((training.user_id as string | null) || null, requesterUserId)) return c.json({ error: '접근 권한이 없습니다.' }, 403);
    const heldOutAttempt = await readOwnedHeldOutAttempt(db, requesterUserId!, id);
    if (training.is_completed && heldOutAttempt.status === 'NONE') return c.json({ error: '이미 완료된 세션입니다.' }, 400);
    const grounding = await readTrainingHistoryGrounding(db, id, toPublicTrainingMode(training.training_mode));
    const caseReadback = await loadTrainingCaseContractProjection(db, id);
    if (caseReadback.status === 'broken') return c.json({ code: 'TRAINING_CASE_SNAPSHOT_INVALID', error: '훈련 사례 스냅샷을 검증하지 못했습니다.', assessmentState: 'UNGRADABLE', caseContractStatus: 'broken' }, 409);
    const attributions = await loadLearnerSourceAttributions(db, { userId: requesterUserId!, sessionKind: 'training', sessionId: id });
    return c.json({ success: true, message: '세션을 이어서 진행할 수 있습니다.', session: publicTrainingSession(training), grounding, caseContract: caseReadback.caseContract, caseContractStatus: caseReadback.status, attributions, trainingHistory: await readOwnedTrainingHistorySupplements(db, requesterUserId!, id), heldOutAttempt, growthFollowUp: await readTrainingFollowUpLink(db, requesterUserId!, id) });
  }
  try {
    const promoted = await promoteLegacyScenarioForResume(c.env, requesterUserId || '', id);
    if (promoted) {
      const session = await db.prepare(`
        SELECT ts.*,
          EXISTS(
            SELECT 1 FROM training_turns tt
            WHERE tt.session_id = ts.id
              AND tt.claim_clarity BETWEEN 1 AND 5
              AND tt.evidence_use BETWEEN 1 AND 5
              AND tt.reasoning_strength BETWEEN 1 AND 5
              AND tt.consistency_score BETWEEN 1 AND 5
              AND tt.relevance_score BETWEEN 1 AND 5
          ) AS has_evaluated_turn
        FROM training_sessions ts
        WHERE ts.id = ?1 AND ts.user_id = ?2
      `).bind(id, requesterUserId).first<Record<string, unknown>>();
      if (!session) return c.json({ error: 'Session not found' }, 404);
      return c.json({ success: true, message: '레거시 시나리오를 Training으로 이어서 진행합니다.', session: publicTrainingSession(session) });
    }
  } catch (error) {
    if (error instanceof Error) return c.json({ error: error.message }, 400);
  }

  const session = await getSession(db, id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  if (session.isCompleted || session.currentTurn > session.maxTurns) {
    return c.json({ error: '이미 완료된 세션입니다.' }, 400);
  }

  const hintHistory=await readSparringHints(db,requesterUserId!,id);
  const attributions = await loadLearnerSourceAttributions(db, { userId: requesterUserId!, sessionKind: 'sparring', sessionId: id });
  const measurement = publicSparringMeasurement(
    session.avgLogic,
    session.rating,
    session.radarScores,
    await hasSparringEvaluation(db, id),
  );
  return c.json({
    success: true,
    message: '저장된 대화와 현재 상태를 불러왔습니다. 계속하기 가능 여부는 controls 상태에 따릅니다.',
    growthFollowUp: await readFollowUpLink(db,requesterUserId!,id,'SPARRING'),
    controls: await readSparringControls(db,requesterUserId!,id),
    hintResponses: hintHistory.responses, hintHistoryStatus: hintHistory.status,
    revisions: await readSparringRevisions(db,requesterUserId!,id),
    session: {
      id: session.id,
      topic: session.topic,
      bookId: session.bookId,
      bookTitle: session.bookTitle,
      bookChapter: session.bookChapter,
      currentTurn: session.currentTurn,
      maxTurns: session.maxTurns,
      currentPhase: session.currentPhase,
      hintLevel: session.hintLevel,
      radarScores: measurement.radarScores,
      avgLogic: measurement.avgLogic,
      rating: measurement.rating,
      evaluationStatus: measurement.evaluationStatus,
      coreClaim: session.coreClaim,
      currentClaim: session.currentClaim,
      conversationHistory: session.conversationHistory,
      isCompleted: false,
      attributions,
    },
  });
});

// Delete session
historyRoute.delete('/api/sessions/:id', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;

  const session = await getSession(db, id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  await db.batch([
    // A context-bound session must open its explicit, per-context deletion
    // authorization before immutable evidence can be removed. The SELECT is a
    // no-op for legacy sessions, preserving their established delete path.
    db.prepare(`
      INSERT INTO learning_session_context_deletion_authorizations (
        session_context_id, authorization_id, created_at
      )
      SELECT id, ?2, ?3
      FROM learning_session_contexts
      WHERE session_kind = 'SPARRING'
        AND session_id = ?1
        AND owner_user_id = ?4
    `).bind(id, crypto.randomUUID(), Date.now(), requesterUserId!),
    db.prepare('DELETE FROM messages WHERE session_id = ?1').bind(id),
    db.prepare('DELETE FROM evaluations WHERE session_id = ?1').bind(id),
    db.prepare('DELETE FROM session_reports WHERE session_id = ?1').bind(id),
    db.prepare('DELETE FROM sparring_turn_evidence WHERE session_id = ?1').bind(id),
    db.prepare('DELETE FROM sparring_evidence_manifests WHERE session_id = ?1').bind(id),
    db.prepare(`
      DELETE FROM learning_session_contexts
      WHERE session_kind = 'SPARRING' AND session_id = ?1 AND owner_user_id = ?2
    `).bind(id, requesterUserId!),
    db.prepare('DELETE FROM sessions WHERE id = ?1').bind(id),
  ]);

  return c.json({ success: true, deletedSessionId: id });
});

// Get session detail with report
historyRoute.get('/api/sessions/:id/report', async (c) => {
  const id = c.req.param('id');
  const requesterUserId = requesterId(c);
  const db = c.env.DB;
  const session = await getSession(db, id);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (!canAccessOwnerResource(session.userId, requesterUserId)) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  // Try to load saved report first, otherwise generate
  const row = await db.prepare('SELECT session_report FROM sessions WHERE id = ?1').bind(id).first<{ session_report: string | null }>();
  let report = null;

  const measurement = publicSparringMeasurement(
    session.avgLogic,
    session.rating,
    session.radarScores,
    await hasSparringEvaluation(db, id),
  );
  if (measurement.evaluationStatus === 'UNKNOWN') {
    report = null;
  } else if (row?.session_report) {
    report = JSON.parse(row.session_report);
  } else if (session.currentTurn > session.maxTurns) {
    report = generateSessionReport(session);
  }
  const attributions = await loadLearnerSourceAttributions(db, { userId: requesterUserId!, sessionKind: 'sparring', sessionId: id });

  const hintHistory=await readSparringHints(db,requesterUserId!,id);
  return c.json({
    controls: await readSparringControls(db,requesterUserId!,id),
    hintResponses: hintHistory.responses, hintHistoryStatus: hintHistory.status,
    revisions: await readSparringRevisions(db,requesterUserId!,id),
    session: {
      id: session.id,
      topic: session.topic,
      bookTitle: session.bookTitle,
      bookChapter: session.bookChapter,
      createdAt: session.createdAt,
      currentTurn: session.currentTurn,
      maxTurns: session.maxTurns,
      avgLogic: measurement.avgLogic,
      rating: measurement.rating,
      radarScores: measurement.radarScores,
      evaluationStatus: measurement.evaluationStatus,
      conversationHistory: session.conversationHistory,
    },
    report,
    attributions,
  });
});

export default historyRoute;
