import type { LibraryBookListRow } from '../types/d1-rows';
// Student Model - State Management with Cloudflare D1 (V3)
// Architecture Principle 3: D1 DB Update Defense (Null Guard)
// All JSON/array fields use safeJSON* helpers before DB writes

import type { SessionState, SessionPhase, LegacyPhase, RadarScores, EvaluationResult, Message, SessionReport, Credibility, Weakness } from '../types';
import type { BookData } from '../data/books';
import { callAIJSON } from './ai-client';
import { saveChunksToD1 } from './rag-ingestion';
import { LIBRARY_CHUNKING_VERSION, sha256Hex } from './library-ingestion';

// ============================================
// D1 Database Operations
// ============================================

// Serialize SessionState to D1 row
// 🔴 Null Guard helpers - prevent DB type errors
function safeJSONStringify(value: unknown, fallback: string = '{}'): string {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value);
  } catch (e) { console.error("[P1-004] Caught:", e);
    return fallback;
  }
}

function safeJSONParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (e) { console.error("[P1-004] Caught:", e);
    return fallback;
  }
}

const UNKNOWN_RADAR_SCORES: RadarScores = {
  defense: 0,
  consistency: 0,
  evidence: 0,
  relevance: 0,
  clarity: 0,
};

function sessionToRow(session: SessionState) {
  return {
    id: session.id,
    user_id: session.userId,
    book_id: session.bookId,
    book_title: session.bookTitle,
    book_chapter: session.bookChapter,
    topic: session.topic,
    created_at: session.createdAt,
    initial_radar_scores: safeJSONStringify(session.initialRadarScores, JSON.stringify(UNKNOWN_RADAR_SCORES)),
    current_turn: session.currentTurn || 1,
    max_turns: session.maxTurns || 10,
    current_phase: session.currentPhase || 'thesis',
    core_claim: session.coreClaim || '',
    current_claim: session.currentClaim || '',
    evidence_used: safeJSONStringify(session.evidenceUsed, '[]'),
    weakness_pattern: safeJSONStringify(session.weaknessPattern, '[]'),
    hint_level: session.hintLevel ?? 0,
    hint_request_count: session.hintRequestCount ?? 0,
    consecutive_no_evidence: session.consecutiveNoEvidence ?? 0,
    radar_scores: safeJSONStringify(session.radarScores, JSON.stringify(UNKNOWN_RADAR_SCORES)),
    previous_radar_scores: safeJSONStringify(session.previousRadarScores, JSON.stringify(UNKNOWN_RADAR_SCORES)),
    textual_evidence_cited: session.textualEvidenceCited ?? 0,
    logical_fallacies_avoided: session.logicalFallaciesAvoided ?? 0,
    fallacies_detected: session.fallaciesDetected ?? 0,
    avg_logic: session.avgLogic ?? 0,
    rating: session.rating || 'UNKNOWN',
    dialectic_pace: session.dialecticPace ?? 0,
    credibility: safeJSONStringify(session.credibility, '{"level":"UNKNOWN","tier":0}'),
    current_weakness: session.currentWeakness ? safeJSONStringify(session.currentWeakness) : null,
    last_question_type: session.lastQuestionType || '',
    turn_start_times: safeJSONStringify(session.turnStartTimes, '[]'),
    is_completed: session.isCompleted ? 1 : 0,
    is_abandoned: session.isAbandoned ? 1 : 0,
    abandoned_at: session.abandonedAt,
    abandoned_turn: session.abandonedTurn,
    ended_at: session.endedAt,
    session_completion_turn: session.isCompleted ? Math.max(0, session.currentTurn - 1) : null,
  };
}

// Deserialize D1 row to SessionState
// 🔴 Null Guard: All JSON.parse calls use safeJSONParse with fallbacks
type SessionHydrationRow = {
  id: string; user_id: string | null; book_id: string | null; book_title: string | null;
  book_chapter: string | null; topic: string | null; created_at: number | null;
  initial_radar_scores: string | null; current_turn: number | null; max_turns: number | null;
  current_phase: SessionPhase | null; core_claim: string | null; current_claim: string | null;
  evidence_used: string | null; weakness_pattern: string | null; hint_level: number | null;
  hint_request_count: number | null; consecutive_no_evidence: number | null;
  radar_scores: string | null; previous_radar_scores: string | null;
  textual_evidence_cited: number | null; logical_fallacies_avoided: number | null;
  fallacies_detected: number | null; avg_logic: number | null; rating: string | null;
  dialectic_pace: number | null; credibility: string | null; turn_start_times: string | null;
  current_weakness: string | null; last_question_type: string | null;
  is_completed: number | boolean | null; is_abandoned: number | boolean | null;
  abandoned_at: number | null; abandoned_turn: number | null; ended_at: number | null;
  tutor_state: SessionState['tutorState'] | null; student_model: string | null;
  layer_state_json: string | null; initial_claim_v12: string | null;
  thought_profile_json: string | null; challenge_state_json: string | null;
};
type SessionMessageRow = { role: 'user' | 'ai'; content: string; turn: number; timestamp: number };

function rowToSession(row: SessionHydrationRow, messages: Message[] = []): SessionState {
  const defaultRadar = { ...UNKNOWN_RADAR_SCORES };
  return {
    id: row.id,
    userId: row.user_id || null,
    bookId: row.book_id || '',
    bookTitle: row.book_title || '',
    bookChapter: row.book_chapter || '',
    topic: row.topic || '',
    createdAt: row.created_at || Date.now(),
    initialRadarScores: safeJSONParse(row.initial_radar_scores, defaultRadar),
    currentTurn: row.current_turn ?? 1,
    maxTurns: row.max_turns ?? 10,
    currentPhase: row.current_phase || 'thesis',
    coreClaim: row.core_claim || '',
    currentClaim: row.current_claim || '',
    evidenceUsed: safeJSONParse(row.evidence_used, []),
    weaknessPattern: safeJSONParse(row.weakness_pattern, []),
    hintLevel: (row.hint_level ?? 0) as 0 | 1 | 2,
    hintRequestCount: row.hint_request_count ?? 0,
    consecutiveNoEvidence: row.consecutive_no_evidence ?? 0,
    radarScores: safeJSONParse(row.radar_scores, defaultRadar),
    previousRadarScores: safeJSONParse(row.previous_radar_scores, defaultRadar),
    textualEvidenceCited: row.textual_evidence_cited ?? 0,
    logicalFallaciesAvoided: row.logical_fallacies_avoided ?? 0,
    fallaciesDetected: row.fallacies_detected ?? 0,
    avgLogic: row.avg_logic ?? 0,
    rating: row.rating || 'UNKNOWN',
    dialecticPace: row.dialectic_pace ?? 0,
    credibility: safeJSONParse(row.credibility, { level: 'UNKNOWN', tier: 0 }),
    conversationHistory: messages,
    turnStartTimes: safeJSONParse(row.turn_start_times, []),
    currentWeakness: row.current_weakness ? safeJSONParse(row.current_weakness, null) : null,
    lastQuestionType: row.last_question_type || '',
    isCompleted: !!row.is_completed,
    isAbandoned: !!row.is_abandoned,
    abandonedAt: row.abandoned_at || null,
    abandonedTurn: row.abandoned_turn || null,
    endedAt: row.ended_at || null,

    // D-Plan v12 State
    tutorState: row.tutor_state || 'elicitation',
    studentModelRaw: row.student_model || '{}',
    layerStateJson: row.layer_state_json || '{"currentLayer":"surface","layerHistory":["surface"],"surfaceCleared":false,"structureCleared":false,"assumptionCleared":false,"turnsInCurrentLayer":0,"layerTransitionTurns":[]}',
    initialClaimV12: row.initial_claim_v12 || '',

    // v14.0: Intelligence Layer
    thoughtProfileJson: row.thought_profile_json || '{}',
    challengeStateJson: row.challenge_state_json || '{"currentLevel":1,"history":[],"consecutiveSuccess":0,"consecutiveStruggle":0}',
  };
}

// ============================================
// Session CRUD Operations
// ============================================

export async function createSession(
  db: D1Database,
  bookId: string,
  bookTitle: string,
  bookChapter: string,
  topic: string,
  coreClaim: string,
  userId: string | null = null
): Promise<SessionState> {
  const id = generateId();
  const now = Date.now();

  // D1's legacy schema keeps these columns non-null. Zero is a storage sentinel,
  // while rating=UNKNOWN is the authoritative signal that no measurement exists.
  const initialScores: RadarScores = { ...UNKNOWN_RADAR_SCORES };

  const session: SessionState = {
    id,
    userId,
    bookId,
    bookTitle,
    bookChapter,
    topic,
    createdAt: now,
    initialRadarScores: { ...initialScores },
    currentTurn: 1,
    maxTurns: 10,
    currentPhase: 'thesis',
    coreClaim,
    currentClaim: coreClaim,
    evidenceUsed: [],
    weaknessPattern: [],
    hintLevel: 0 as 0 | 1 | 2,
    hintRequestCount: 0,
    consecutiveNoEvidence: 0,
    radarScores: { ...initialScores },
    previousRadarScores: { ...initialScores },
    textualEvidenceCited: 0,
    logicalFallaciesAvoided: 0,
    fallaciesDetected: 0,
    avgLogic: 0,
    rating: 'UNKNOWN',
    dialecticPace: 0,
    credibility: { level: 'UNKNOWN', tier: 0 },
    conversationHistory: [],
    turnStartTimes: [now],
    currentWeakness: null,
    lastQuestionType: '',
    isCompleted: false,
    isAbandoned: false,
    abandonedAt: null,
    abandonedTurn: null,
    endedAt: null,

    // D-Plan v12 State
    tutorState: 'elicitation',
    studentModelRaw: '{}',
    layerStateJson: '',
    initialClaimV12: '',
    thoughtProfileJson: '{}',
    challengeStateJson: '{"currentLevel":1,"history":[],"consecutiveSuccess":0,"consecutiveStruggle":0}',
  };

  const row = sessionToRow(session);

  await db.prepare(`
    INSERT INTO sessions (
      id, user_id, book_id, book_title, book_chapter, topic, created_at,
      initial_radar_scores, current_turn, max_turns, current_phase,
      core_claim, current_claim, evidence_used, weakness_pattern,
      hint_level, hint_request_count, consecutive_no_evidence,
      radar_scores, previous_radar_scores,
      textual_evidence_cited, logical_fallacies_avoided, fallacies_detected,
      avg_logic, rating, dialectic_pace, credibility,
      current_weakness, last_question_type, turn_start_times,
      is_completed, is_abandoned
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7,
      ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, ?15,
      ?16, ?17, ?18,
      ?19, ?20,
      ?21, ?22, ?23,
      ?24, ?25, ?26, ?27,
      ?28, ?29, ?30,
      0, 0
    )
  `).bind(
    row.id, row.user_id, row.book_id, row.book_title, row.book_chapter, row.topic, row.created_at,
    row.initial_radar_scores, row.current_turn, row.max_turns, row.current_phase,
    row.core_claim, row.current_claim, row.evidence_used, row.weakness_pattern,
    row.hint_level, row.hint_request_count, row.consecutive_no_evidence,
    row.radar_scores, row.previous_radar_scores,
    row.textual_evidence_cited, row.logical_fallacies_avoided, row.fallacies_detected,
    row.avg_logic, row.rating, row.dialectic_pace, row.credibility,
    row.current_weakness, row.last_question_type, row.turn_start_times
  ).run();

  return session;
}

export async function getSession(db: D1Database, id: string): Promise<SessionState | null> {
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?1').bind(id).first<SessionHydrationRow>();
  if (!row) return null;

  // Load messages
  const msgResult = await db.prepare(
    'SELECT role, content, turn, timestamp FROM messages WHERE session_id = ?1 ORDER BY timestamp ASC'
  ).bind(id).all<SessionMessageRow>();

  const messages: Message[] = (msgResult.results || []).map((m) => ({
    role: m.role,
    content: m.content,
    turn: m.turn,
    timestamp: m.timestamp,
  }));

  return rowToSession(row, messages);
}

function buildFullSessionSaveStatement(db: D1Database, session: SessionState, expectedTurn?: number): D1PreparedStatement {
  const row = sessionToRow(session);

  return db.prepare(`
      UPDATE sessions SET
        book_id = ?2, book_title = ?3, book_chapter = ?4, topic = ?5,
        initial_radar_scores = ?6, current_turn = ?7, max_turns = ?8, current_phase = ?9,
        core_claim = ?10, current_claim = ?11, evidence_used = ?12, weakness_pattern = ?13,
        hint_level = ?14, hint_request_count = ?15, consecutive_no_evidence = ?16,
        radar_scores = ?17, previous_radar_scores = ?18,
        textual_evidence_cited = ?19, logical_fallacies_avoided = ?20, fallacies_detected = ?21,
        avg_logic = ?22, rating = ?23, dialectic_pace = ?24, credibility = ?25,
        current_weakness = ?26, last_question_type = ?27, turn_start_times = ?28,
        is_completed = ?29, is_abandoned = ?30, abandoned_at = ?31, abandoned_turn = ?32, ended_at = ?33,
        tutor_state = ?34, student_model = ?35, layer_state_json = ?36, initial_claim_v12 = ?37,
        thought_profile_json = ?38, challenge_state_json = ?39,
        session_completion_turn = ?40
      WHERE id = ?1 AND (?41 IS NULL OR (user_id = ?42 AND current_turn = ?41 AND is_completed = 0 AND is_abandoned = 0))
    `).bind(
      row.id, row.book_id, row.book_title, row.book_chapter, row.topic,
      row.initial_radar_scores, row.current_turn, row.max_turns, row.current_phase,
      row.core_claim, row.current_claim, row.evidence_used, row.weakness_pattern,
      row.hint_level, row.hint_request_count, row.consecutive_no_evidence,
      row.radar_scores, row.previous_radar_scores,
      row.textual_evidence_cited, row.logical_fallacies_avoided, row.fallacies_detected,
      row.avg_logic, row.rating, row.dialectic_pace, row.credibility,
      row.current_weakness, row.last_question_type, row.turn_start_times,
      row.is_completed, row.is_abandoned, row.abandoned_at, row.abandoned_turn, row.ended_at,
      session.tutorState || 'elicitation',
      session.studentModelRaw || '{}',
      session.layerStateJson || '',
      session.initialClaimV12 || '',
      session.thoughtProfileJson || '{}',
      session.challengeStateJson || '{"currentLevel":1,"history":[],"consecutiveSuccess":0,"consecutiveStruggle":0}',
      row.session_completion_turn, expectedTurn ?? null, session.userId ?? null
    );
}

function buildLegacySessionSaveStatement(db: D1Database, session: SessionState, expectedTurn?: number): D1PreparedStatement {
  const row = sessionToRow(session);

  return db.prepare(`
      UPDATE sessions SET
        book_id = ?2, book_title = ?3, book_chapter = ?4, topic = ?5,
        initial_radar_scores = ?6, current_turn = ?7, max_turns = ?8, current_phase = ?9,
        core_claim = ?10, current_claim = ?11, evidence_used = ?12, weakness_pattern = ?13,
        hint_level = ?14, hint_request_count = ?15, consecutive_no_evidence = ?16,
        radar_scores = ?17, previous_radar_scores = ?18,
        textual_evidence_cited = ?19, logical_fallacies_avoided = ?20, fallacies_detected = ?21,
        avg_logic = ?22, rating = ?23, dialectic_pace = ?24, credibility = ?25,
        current_weakness = ?26, last_question_type = ?27, turn_start_times = ?28,
        is_completed = ?29, is_abandoned = ?30, abandoned_at = ?31, abandoned_turn = ?32, ended_at = ?33,
        tutor_state = ?34, student_model = ?35, layer_state_json = ?36, initial_claim_v12 = ?37,
        session_completion_turn = ?38
      WHERE id = ?1 AND (?39 IS NULL OR (user_id = ?40 AND current_turn = ?39 AND is_completed = 0 AND is_abandoned = 0))
    `).bind(
      row.id, row.book_id, row.book_title, row.book_chapter, row.topic,
      row.initial_radar_scores, row.current_turn, row.max_turns, row.current_phase,
      row.core_claim, row.current_claim, row.evidence_used, row.weakness_pattern,
      row.hint_level, row.hint_request_count, row.consecutive_no_evidence,
      row.radar_scores, row.previous_radar_scores,
      row.textual_evidence_cited, row.logical_fallacies_avoided, row.fallacies_detected,
      row.avg_logic, row.rating, row.dialectic_pace, row.credibility,
      row.current_weakness, row.last_question_type, row.turn_start_times,
      row.is_completed, row.is_abandoned, row.abandoned_at, row.abandoned_turn, row.ended_at,
      session.tutorState || 'elicitation',
      session.studentModelRaw || '{}',
      session.layerStateJson || '',
      session.initialClaimV12 || '',
      row.session_completion_turn, expectedTurn ?? null, session.userId ?? null
    );
}

function isMissingIntelligenceColumn(error: unknown): boolean {
  const message = String(error);
  return message.includes('no such column')
    && (message.includes('thought_profile_json') || message.includes('challenge_state_json'));
}

// PATCH-004: BUG-003 fix — defensive coding for v14 columns (migration not yet applied)
async function saveSession(db: D1Database, session: SessionState): Promise<void> {
  try {
    // Full v14 save (with thought_profile_json + challenge_state_json)
    await buildFullSessionSaveStatement(db, session).run();
  } catch (e) {
    // Fallback: save without v14 Intelligence Layer columns if migration 0013 not applied
    if (isMissingIntelligenceColumn(e)) {
      console.warn('[SAVE_SESSION] v14 columns missing (migration 0013 not applied), saving without intelligence layer');
      await buildLegacySessionSaveStatement(db, session).run();
    } else {
      throw e;
    }
  }
}

function buildMessageStatements(db: D1Database, sessionId: string, messages: Message[], controlRevision?: number, revision?: {id:string;revision:number}|null): D1PreparedStatement[] {
  const stmt = db.prepare(
    controlRevision === undefined ? 'INSERT INTO messages (session_id, role, content, turn, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)'
      : 'INSERT INTO messages (session_id, role, content, turn, timestamp, sparring_control_revision, sparring_revision_id, sparring_revision_number) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  );
  return messages.map(m =>
    controlRevision === undefined ? stmt.bind(sessionId, m.role, m.content, m.turn, m.timestamp) : stmt.bind(sessionId, m.role, m.content, m.turn, m.timestamp, controlRevision, m.role==='user'?revision?.id??null:null, m.role==='user'?revision?.revision??null:null)
  );
}

async function saveMessages(db: D1Database, sessionId: string, messages: Message[]): Promise<void> {
  const batch = buildMessageStatements(db, sessionId, messages);
  if (batch.length > 0) await db.batch(batch);
}

// ============================================
// Evaluation Storage
// ============================================

export function buildEvaluationSaveStatement(
  db: D1Database,
  sessionId: string,
  userId: string | null,
  turn: number,
  evaluation: EvaluationResult
): D1PreparedStatement {
  const scores = evaluation.radarScores;
  const avgScore = Math.round((scores.defense + scores.consistency + scores.evidence + scores.relevance + scores.clarity) / 5);

  return db.prepare(`
    INSERT INTO evaluations (session_id, user_id, turn, defense_score, consistency_score, evidence_score, relevance_score, clarity_score, avg_score, evidence_found, fallacy_detected, fallacy_type, weakness, feedback, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  `).bind(
    sessionId, userId, turn,
    scores.defense, scores.consistency, scores.evidence, scores.relevance, scores.clarity,
    avgScore,
    evaluation.evidenceFound ? 1 : 0,
    evaluation.fallacyDetected ? 1 : 0,
    evaluation.fallacyType || null,
    evaluation.weaknessDescription || null,
    JSON.stringify({
      diagnosis: evaluation.diagnosis || '',
      reasoningGap: evaluation.reasoningGap || '',
      missingPiece: evaluation.missingPiece || '',
      recommendedMove: evaluation.recommendedMove || '',
      extendedMetrics: evaluation.extendedMetrics || null,
    }),
    Date.now()
  );
}

// ============================================
// Session Completion / Abandonment
// ============================================

export async function markSessionCompleted(db: D1Database, session: SessionState): Promise<void> {
  session.isCompleted = true;
  session.endedAt = Date.now();
  await db.prepare(
    'UPDATE sessions SET is_completed = 1, ended_at = ?2, session_completion_turn = ?3 WHERE id = ?1'
  ).bind(session.id, session.endedAt, Math.max(0, session.currentTurn - 1)).run();
}

export async function markSessionAbandoned(db: D1Database, sessionId: string): Promise<boolean> {
  const row = await db.prepare('SELECT current_turn, is_completed, is_abandoned FROM sessions WHERE id = ?1').bind(sessionId).first();
  if (!row || row.is_completed || row.is_abandoned) return false;

  const now = Date.now();
  await db.prepare(
    'UPDATE sessions SET is_abandoned = 1, abandoned_at = ?2, abandoned_turn = ?3, dropoff_turn = ?3, last_failure_reason = COALESCE(last_failure_reason, ?4) WHERE id = ?1'
  ).bind(sessionId, now, row.current_turn, '세션 중도 이탈').run();
  return true;
}

// ============================================
// Business Logic
// ============================================

export async function updateSessionAfterEvaluation(
  db: D1Database,
  session: SessionState,
  evaluation: EvaluationResult,
  studentMessage: string,
  aiReply: string,
  questionType: string,
  atomicStatements: D1PreparedStatement[] = [],
  controlRevision?: number,
  learnerRevision?: {id:string;revision:number}|null,
): Promise<SessionState> {
  const now = Date.now();




  const previousEvaluation = await db.prepare(
    'SELECT 1 AS present FROM evaluations WHERE session_id = ?1 LIMIT 1'
  ).bind(session.id).first<{ present: number }>();
  const hasMeasuredEvaluation = Boolean(previousEvaluation);
  const measuredScores = { ...evaluation.radarScores };

  // The first successful evaluation establishes the baseline. Never blend it
  // with the unmeasured storage sentinel from a newly-created session.
  session.previousRadarScores = hasMeasuredEvaluation
    ? { ...session.radarScores }
    : { ...measuredScores };

  // Set coreClaim on first turn if not already set
  if (session.currentTurn === 1 && !session.coreClaim) {
    session.coreClaim = evaluation.currentClaimUpdate || studentMessage;
  }

  if (hasMeasuredEvaluation) {
    // Smooth score transition after a real baseline exists (40% old + 60% new).
    session.radarScores = {
      defense: blend(session.radarScores.defense, measuredScores.defense),
      consistency: blend(session.radarScores.consistency, measuredScores.consistency),
      evidence: blend(session.radarScores.evidence, measuredScores.evidence),
      relevance: blend(session.radarScores.relevance, measuredScores.relevance),
      clarity: blend(session.radarScores.clarity, measuredScores.clarity),
    };
  } else {
    session.initialRadarScores = { ...measuredScores };
    session.radarScores = { ...measuredScores };
  }

  // Update claim
  session.currentClaim = evaluation.currentClaimUpdate || session.currentClaim;

  // Evidence tracking
  if (evaluation.evidenceFound) {
    session.textualEvidenceCited++;
    session.consecutiveNoEvidence = 0;
    session.hintLevel = Math.max(0, session.hintLevel - 1) as 0 | 1 | 2;
  } else {
    session.consecutiveNoEvidence++;
    if (session.consecutiveNoEvidence >= 2) {
      session.hintLevel = Math.min(2, session.hintLevel + 1) as 0 | 1 | 2;
    }
  }

  // Fallacy tracking
  if (evaluation.fallacyDetected) {
    session.fallaciesDetected++;
    if (!session.weaknessPattern.includes(evaluation.fallacyType || '')) {
      session.weaknessPattern.push(evaluation.fallacyType || 'unknown');
    }
  } else {
    session.logicalFallaciesAvoided = Math.min(2, session.logicalFallaciesAvoided + 1);
  }

  // Update avg logic
  const scores = session.radarScores;
  session.avgLogic = Math.round(
    (scores.defense + scores.consistency + scores.evidence + scores.relevance + scores.clarity) / 5
  );

  // Update rating
  session.rating = calculateRating(session.avgLogic);

  // Update dialectic pace (minutes per turn)
  if (session.turnStartTimes.length > 1) {
    const totalTime = now - session.turnStartTimes[0];
    session.dialecticPace = Math.round((totalTime / (session.currentTurn * 60000)) * 10) / 10;
  }

  // Update credibility
  session.credibility = calculateCredibility(session);

  // Update weakness
  session.currentWeakness = evaluation.weaknessDescription
    ? {
        detected: true,
        description: evaluation.weaknessDescription,
        prompt: evaluation.weaknessPrompt,
      }
    : null;

  // New messages to save
  const newMessages: Message[] = [
    { role: 'user', content: studentMessage, turn: session.currentTurn, timestamp: now },
    { role: 'ai', content: aiReply, turn: session.currentTurn, timestamp: now },
  ];

  // Add to in-memory history
  session.conversationHistory.push(...newMessages);

  // Track question type
  session.lastQuestionType = questionType;

  // Advance turn
  session.currentTurn++;
  session.turnStartTimes.push(now);

  // Phase transition
  session.currentPhase = getPhaseForTurn(session.currentTurn);

  // Reset hint level on phase change
  const prevPhase = getPhaseForTurn(session.currentTurn - 1);
  if (session.currentPhase !== prevPhase) {
    session.hintLevel = 0;
  }

  // Completion is part of the same canonical accepted-turn boundary. Once the
  // final learner turn commits, later report/enrichment work must not decide
  // whether the session itself is complete.
  if (session.currentTurn > session.maxTurns) {
    session.isCompleted = true;
    session.endedAt = now;
  }

  // D1 batch is the canonical accepted-turn boundary: session advance, both
  // messages, evaluation, and immutable attribution succeed or roll back together.
  const buildAcceptedTurnBatch = (sessionStatement: D1PreparedStatement): D1PreparedStatement[] => [
    sessionStatement,
    ...buildMessageStatements(db, session.id, newMessages, controlRevision, learnerRevision),
    ...atomicStatements,
  ];
  try {
    await db.batch(buildAcceptedTurnBatch(buildFullSessionSaveStatement(db, session, controlRevision === undefined ? undefined : session.currentTurn - 1)));
  } catch (error) {
    if (!isMissingIntelligenceColumn(error)) throw error;
    // A failed D1 batch rolls back as a unit. Retry the exact accepted turn
    // against the pre-0013 session shape so compatibility never splits state,
    // messages, evaluation, or attribution across commits.
    console.warn('[ACCEPTED_TURN] v14 columns missing; retrying canonical batch without intelligence columns');
    await db.batch(buildAcceptedTurnBatch(buildLegacySessionSaveStatement(db, session, controlRevision === undefined ? undefined : session.currentTurn - 1)));
  }



  const weaknessHistory = Array.from(new Set([
    ...session.weaknessPattern,
    evaluation.fallacyType || '',
    evaluation.weaknessDescription || '',
  ].map(v => (v || '').trim()).filter(Boolean))).slice(-30);
  const lastFailureReason = !evaluation.evidenceFound
    ? '근거 부족'
    : (evaluation.fallacyDetected ? (evaluation.fallacyType || '논리 오류') : null);

  try {
    await db.prepare(`
      UPDATE sessions SET
        -- Legacy inferred counters are retained as history, never extended here.
        weakness_tags_history = ?2,

        last_failure_reason = COALESCE(?3, last_failure_reason)
      WHERE id = ?1
    `).bind(
      session.id,

      safeJSONStringifyArray(weaknessHistory),

      lastFailureReason,
    ).run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    console.warn('[OPS_METRICS] Post-commit update skipped:', msg);
  }

  return session;
}

export async function requestHint(db: D1Database, session: SessionState): Promise<{ hintLevel: number; message: string; changed: boolean }> {
  const prevLevel = session.hintLevel;
  session.hintLevel = Math.min(2, session.hintLevel + 1) as 0 | 1 | 2;
  session.hintRequestCount++;

  const messages: Record<number, string> = {
    0: '힌트 없이 스스로 생각해 보세요.',
    1: '텍스트의 특정 부분에 주목해 보세요. 관련 내용을 찾을 수 있을 거예요.',
    2: '핵심 비유나 키워드에 주목하여 텍스트를 다시 읽어보세요.',
  };

  await saveSession(db, session);

  return {
    hintLevel: session.hintLevel,
    message: messages[session.hintLevel] || messages[0],
    changed: session.hintLevel !== prevLevel,
  };
}

export function generateSessionReport(session: SessionState): SessionReport {
  const rs = session.radarScores;
  const irs = session.initialRadarScores;

  const radarChange = [
    { axis: 'Defense', from: irs.defense, to: rs.defense, change: rs.defense - irs.defense },
    { axis: 'Consistency', from: irs.consistency, to: rs.consistency, change: rs.consistency - irs.consistency },
    { axis: 'Evidence', from: irs.evidence, to: rs.evidence, change: rs.evidence - irs.evidence },
    { axis: 'Relevance', from: irs.relevance, to: rs.relevance, change: rs.relevance - irs.relevance },
    { axis: 'Clarity', from: irs.clarity, to: rs.clarity, change: rs.clarity - irs.clarity },
  ];

  const bestAxis = radarChange.reduce((a, b) => (b.to > a.to ? b : a));
  const worstAxis = radarChange.reduce((a, b) => (b.to < a.to ? b : a));
  const mostImproved = radarChange.reduce((a, b) => (b.change > a.change ? b : a));

  return {
    topic: session.topic,
    bookTitle: session.bookTitle,
    coreClaim: session.coreClaim,
    finalClaim: session.currentClaim,
    radarChange,
    initialRadarScores: session.initialRadarScores,
    strengths: `${bestAxis.axis} 축에서 가장 높은 점수(${bestAxis.to}점)를 기록했습니다. ${mostImproved.change > 5 ? `특히 ${mostImproved.axis} 축에서 ${mostImproved.change}점 성장하여 가장 큰 발전을 보였습니다.` : '해당 영역에서의 논증 능력이 돋보입니다.'}`,
    improvements: `${worstAxis.axis} 축(${worstAxis.to}점)에서 개선이 필요합니다. ${worstAxis.axis === 'Evidence' ? '텍스트 근거를 더 적극적으로 활용해 보세요.' : worstAxis.axis === 'Defense' ? '반론에 대한 방어 논리를 더 견고하게 준비해 보세요.' : '해당 영역의 논증력을 강화해 보세요.'}`,
    nextRecommendation: '다음 세션에서는 다른 관점에서 텍스트를 탐구해 보는 것을 추천합니다.',
    totalTurns: session.currentTurn - 1,
    totalEvidenceCited: session.textualEvidenceCited,
    avgLogic: session.avgLogic,
    finalRating: session.rating,
  };
}

export async function generateSessionSummary(
  apiKey: string,
  session: SessionState,
  report: SessionReport,
  fallbackApiKey?: string,
): Promise<string> {
  try {
    const conversationSummary = session.conversationHistory
      .slice(-8)
      .map(m => `${m.role === 'ai' ? 'AI' : '학생'}: ${m.content}`)
      .join('\n');

    const result = await callAIJSON<{ summary: string }>(
      apiKey,
      fallbackApiKey,
      '당신은 교육 평가 전문가입니다. 소크라테스식 독서 토론 세션의 전체 내용을 분석하여 학생의 사고 발전 과정을 3문장으로 요약합니다. 한국어로 응답하세요.',
      `다음 토론 세션을 3문장으로 요약하세요.

토픽: ${session.topic}
도서: ${session.bookTitle}
초기 주장: ${session.coreClaim}
최종 주장: ${session.currentClaim}
평균 논리 점수: ${report.avgLogic}%
근거 인용 횟수: ${report.totalEvidenceCited}

대화 내용:
${conversationSummary}

JSON으로 응답:
{ "summary": "3문장 요약" }`,
      { temperature: 0.5, maxTokens: 500 },
    );
    return result.summary;
  } catch (error) {
    console.error('Summary generation error:', error);
    return `${session.topic}에 대한 ${report.totalTurns}턴의 토론을 진행했습니다. 평균 논리 점수 ${report.avgLogic}%를 기록했으며, ${report.totalEvidenceCited}회의 근거 인용이 있었습니다. 전반적으로 ${report.finalRating} 등급의 논증 능력을 보여주었습니다.`;
  }
}

export async function saveSessionReport(db: D1Database, sessionId: string, report: SessionReport): Promise<void> {
  await db.prepare(
    'UPDATE sessions SET session_report = ?2 WHERE id = ?1'
  ).bind(sessionId, JSON.stringify(report)).run();
}

// Get all sessions (for history feature)
export async function getAllSessions(db: D1Database): Promise<SessionState[]> {
  const result = await db.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50'
  ).all<SessionHydrationRow>();

  if (!result.results) return [];

  return result.results.map((row) => rowToSession(row, []));
}

// ============================================
// Book D1 Operations
// ============================================

export async function seedBuiltinBooks(db: D1Database, books: BookData[]): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO books (
      id, title, author, chapter, language, text, key_passages,
      is_builtin, owner_user_id, visibility, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 'builtin', ?8, ?8)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      author = excluded.author,
      chapter = excluded.chapter,
      language = excluded.language,
      text = excluded.text,
      key_passages = excluded.key_passages,
      is_builtin = 1,
      owner_user_id = NULL,
      visibility = 'builtin',
      updated_at = excluded.updated_at
  `);

  const now = Date.now();
  const batch = books.map(book =>
    stmt.bind(book.id, book.title, book.author, book.chapter, book.language, book.text, JSON.stringify(book.keyPassages), now)
  );

  await db.batch(batch);

  for (const book of books) {
    const contentSha256 = await sha256Hex(book.text);
    const current = await db.prepare(`
      SELECT chunk_count, content_sha256 FROM books WHERE id = ?1 AND is_builtin = 1
    `).bind(book.id).first<{ chunk_count: number; content_sha256: string | null }>();
    if (Number(current?.chunk_count || 0) > 0 && current?.content_sha256 === contentSha256) continue;

    const chunkCount = await saveChunksToD1(db, book.id, book.text);
    await db.prepare(`
      UPDATE books
      SET chunk_count = ?2, ingestion_status = 'd1_ready', content_sha256 = ?3,
          chunking_version = ?4, last_ingestion_error = NULL, updated_at = ?5
      WHERE id = ?1 AND is_builtin = 1
    `).bind(book.id, chunkCount, contentSha256, LIBRARY_CHUNKING_VERSION, Date.now()).run();
  }
}

export async function getAllBooksFromDB(db: D1Database, requesterUserId: string | null): Promise<LibraryBookListRow[]> {
  const result = await db.prepare(
    `SELECT id, title, author, chapter, language, key_passages, text, is_builtin, created_at,
            chunk_count, ingestion_status, vector_status, lifecycle_status, owner_user_id, visibility
     FROM books
     WHERE (lifecycle_status = 'active' OR lifecycle_status IS NULL)
       AND (
         (is_builtin = 1 AND visibility = 'builtin')
         OR (owner_user_id = ?1 AND visibility = 'private')
       )
     ORDER BY is_builtin DESC, created_at DESC`
  ).bind(requesterUserId).all<LibraryBookListRow>();
  return result.results || [];
}

export async function getBookFromDB(db: D1Database, id: string, requesterUserId: string | null): Promise<any | null> {
  return await db.prepare(`
    SELECT * FROM books
    WHERE id = ?1
      AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
      AND (
        (is_builtin = 1 AND visibility = 'builtin')
        OR (owner_user_id = ?2 AND visibility = 'private')
      )
  `).bind(id, requesterUserId).first();
}

export async function addBookToDB(db: D1Database, book: {
  id: string; title: string; author: string; chapter: string; language: string; text: string; keyPassages: unknown[]; ownerUserId: string;
}): Promise<void> {
  const now = Date.now();
  await db.prepare(`
    INSERT INTO books (
      id, title, author, chapter, language, text, key_passages,
      is_builtin, owner_user_id, visibility, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, 'private', ?9, ?9)
  `).bind(book.id, book.title, book.author, book.chapter, book.language, book.text, JSON.stringify(book.keyPassages), book.ownerUserId, now).run();
}

export async function deleteBookFromDB(
  db: D1Database,
  id: string,
  ownerUserId: string,
): Promise<{ deleted: boolean; cleanupJobId: string | null }> {
  const book = await db.prepare(`
    SELECT id FROM books
    WHERE id = ?1 AND owner_user_id = ?2 AND is_builtin = 0 AND visibility = 'private'
      AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
  `).bind(id, ownerUserId).first<{ id: string }>();
  if (!book) return { deleted: false, cleanupJobId: null };

  const now = Date.now();
  const cleanupJobId = `vcleanup_${crypto.randomUUID()}`;
  const results = await db.batch([
    db.prepare(`
      INSERT INTO vector_cleanup_jobs (
        id, book_id, owner_user_id, vector_count, status, attempts, created_at, updated_at
      )
      SELECT ?1, id, owner_user_id, chunk_count, 'pending', 0, ?4, ?4
      FROM books
      WHERE id = ?2 AND owner_user_id = ?3 AND is_builtin = 0 AND visibility = 'private'
    `).bind(cleanupJobId, id, ownerUserId, now),
    db.prepare('DELETE FROM document_chunks WHERE book_id = ?1').bind(id),
    db.prepare(`
      UPDATE sparring_evidence_manifests
      SET lifecycle_status = 'deleted',
          deleted_at = COALESCE(deleted_at, ?2)
      WHERE book_id = ?1 AND (lifecycle_status <> 'deleted' OR lifecycle_status IS NULL)
    `).bind(id, now),
    db.prepare(`
      UPDATE sparring_turn_evidence
      SET lifecycle_status = 'deleted',
          deleted_at = COALESCE(deleted_at, ?2)
      WHERE book_id = ?1 AND (lifecycle_status <> 'deleted' OR lifecycle_status IS NULL)
    `).bind(id, now),
    db.prepare(`
      UPDATE training_scenario_evidence
      SET lifecycle_status = 'deleted',
          deleted_at = COALESCE(deleted_at, ?2)
      WHERE book_id = ?1 AND (lifecycle_status <> 'deleted' OR lifecycle_status IS NULL)
    `).bind(id, now),
    db.prepare(
      `UPDATE sessions SET is_abandoned = 1, abandoned_at = ?2
       WHERE book_id = ?1 AND user_id = ?3 AND is_completed = 0 AND is_abandoned = 0`
    ).bind(id, now, ownerUserId),
    db.prepare(
      "UPDATE vector_documents SET status = 'cleanup_pending', updated_at = ?2 WHERE source_type = 'book' AND source_id = ?1"
    ).bind(id, now),
    db.prepare(`
      UPDATE books
      SET title = '삭제된 도서', author = '', chapter = '', text = '', key_passages = '[]',
          chunk_count = 0, content_sha256 = NULL, ingestion_status = 'deleted',
          vector_status = 'cleanup_pending', last_ingestion_error = NULL,
          lifecycle_status = 'deleted', visibility = 'quarantined', deleted_at = ?3, updated_at = ?3
      WHERE id = ?1 AND owner_user_id = ?2 AND is_builtin = 0 AND visibility = 'private'
    `).bind(id, ownerUserId, now),
  ]);
  return {
    deleted: Number(results.at(-1)?.meta?.changes || 0) > 0,
    cleanupJobId,
  };
}

export async function searchBooksInDB(db: D1Database, query: string, requesterUserId: string | null): Promise<LibraryBookListRow[]> {
  const pattern = `%${query}%`;
  // Phase 2: Only show active books in search results
  const result = await db.prepare(
    `SELECT id, title, author, chapter, language, key_passages, text, is_builtin, created_at,
            chunk_count, ingestion_status, vector_status, lifecycle_status, owner_user_id, visibility
     FROM books
     WHERE (title LIKE ?1 OR author LIKE ?1 OR chapter LIKE ?1)
       AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
       AND (
         (is_builtin = 1 AND visibility = 'builtin')
         OR (owner_user_id = ?2 AND visibility = 'private')
       )
     ORDER BY is_builtin DESC, created_at DESC`
  ).bind(pattern, requesterUserId).all<LibraryBookListRow>();
  return result.results || [];
}

// ============================================
// Helpers
// ============================================

function safeJSONStringifyArray(value: unknown): string {
  if (!Array.isArray(value)) return '[]';
  return JSON.stringify(value.filter((item) => item !== undefined && item !== null));
}

function generateId(): string {
  return `ses_${crypto.randomUUID()}`;
}

function blend(old: number, newVal: number): number {
  return Math.round(old * 0.4 + newVal * 0.6);
}

function getPhaseForTurn(turn: number): LegacyPhase {
  if (turn <= 2) return 'thesis';
  if (turn <= 4) return 'opening';
  if (turn <= 6) return 'defense';
  if (turn <= 8) return 'synthesis';
  return 'conclusion';
}

function calculateRating(avgLogic: number): string {
  if (avgLogic >= 80) return 'CRITICAL';
  if (avgLogic >= 60) return 'ANALYTICAL';
  if (avgLogic >= 40) return 'ADAPTIVE';
  return 'NOVICE';
}

function calculateCredibility(session: SessionState): { level: string; tier: number } {
  const progress = session.currentTurn / session.maxTurns;
  const score = session.avgLogic;

  if (score >= 70) return { level: 'INTERMEDIATE', tier: Math.min(3, Math.ceil(progress * 3)) };
  if (score >= 50) return { level: 'NOVICE', tier: Math.min(5, Math.ceil(progress * 5)) };
  return { level: 'NOVICE', tier: Math.min(3, Math.ceil(progress * 3)) };
}
