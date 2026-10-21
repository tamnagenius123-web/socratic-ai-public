// BKT Engine - Bayesian Knowledge Tracking (Lightweight)
// Mathematical Model: Hidden Markov Model simplified to static Bayes update
//
// Core Formula (single Bayes update per observation):
// If student answered correctly (score >= threshold):
//   P(L_n | correct) = P(L_{n-1}) * (1 - P(S)) / [P(L_{n-1})*(1-P(S)) + (1-P(L_{n-1}))*P(G)]
// If student answered incorrectly:
//   P(L_n | wrong) = P(L_{n-1}) * P(S) / [P(L_{n-1})*P(S) + (1-P(L_{n-1}))*(1-P(G))]
// Then apply learning transition:
//   P(L_n) = P(L_n | Obs) + (1 - P(L_n | Obs)) * P(T)
//
// All computation is pure arithmetic — no ML libraries needed. < 1ms per update.

export interface BKTState {
  concept: string;
  p_know: number;     // P(L): probability of mastery
  p_transit: number;  // P(T): learning rate
  p_slip: number;     // P(S): slip probability
  p_guess: number;    // P(G): guess probability
  observations: number;
}

type BKTStateRow = {
  concept: string;
  p_know: number | null;
  p_transit: number | null;
  p_slip: number | null;
  p_guess: number | null;
  observations: number | null;
};

export interface BKTUpdateResult {
  concept: string;
  previousPKnow: number;
  newPKnow: number;
  isCorrect: boolean;
  observations: number;
  masteryLevel: 'unknown' | 'learning' | 'near_mastery' | 'mastered';
}

// Default BKT parameters (based on educational research norms)
const DEFAULT_BKT: Omit<BKTState, 'concept'> = {
  p_know: 0.3,      // 30% initial mastery assumption
  p_transit: 0.1,   // 10% chance of learning per session
  p_slip: 0.15,     // 15% chance of slip
  p_guess: 0.25,    // 25% chance of guessing correctly
  observations: 0,
};

// Score threshold for "correct" observation (1-5 scale, >=3 means correct)
const CORRECT_THRESHOLD = 3;

export function percentageToBKTScore(percentage: number): number | null {
  if (!Number.isFinite(percentage) || percentage < 20 || percentage > 100) {
    return null;
  }
  return percentage / 20;
}

function isBKTScore(score: number): boolean {
  return Number.isFinite(score) && score >= 1 && score <= 5;
}

// =============================================
// Core BKT Update: Single Bayes Step
// Calculate P(L_n | Obs) using Bayes' theorem
// =============================================
export function updateBKT(
  state: BKTState,
  observedScore: number, // 1-5 scale evaluation score
): BKTUpdateResult {
  if (!isBKTScore(observedScore)) {
    throw new RangeError('BKT observation must be a finite score on the 1-5 scale.');
  }
  const { p_know, p_transit, p_slip, p_guess } = state;
  const isCorrect = observedScore >= CORRECT_THRESHOLD;

  // Step 1: Posterior update via Bayes' rule
  // P(L | Obs) = P(Obs | L) * P(L) / P(Obs)
  let pKnowPosterior: number;

  if (isCorrect) {
    // P(correct | know) = 1 - P(S), P(correct | ¬know) = P(G)
    const pObsGivenKnow = 1 - p_slip;
    const pObsGivenNotKnow = p_guess;
    const pObs = p_know * pObsGivenKnow + (1 - p_know) * pObsGivenNotKnow;
    pKnowPosterior = pObs > 0 ? (p_know * pObsGivenKnow) / pObs : p_know;
  } else {
    // P(wrong | know) = P(S), P(wrong | ¬know) = 1 - P(G)
    const pObsGivenKnow = p_slip;
    const pObsGivenNotKnow = 1 - p_guess;
    const pObs = p_know * pObsGivenKnow + (1 - p_know) * pObsGivenNotKnow;
    pKnowPosterior = pObs > 0 ? (p_know * pObsGivenKnow) / pObs : p_know;
  }

  // Step 2: Apply learning transition
  // P(L_n) = P(L_n | Obs) + (1 - P(L_n | Obs)) * P(T)
  const newPKnow = clamp(pKnowPosterior + (1 - pKnowPosterior) * p_transit, 0, 1);

  return {
    concept: state.concept,
    previousPKnow: p_know,
    newPKnow,
    isCorrect,
    observations: state.observations + 1,
    masteryLevel: getMasteryLevel(newPKnow),
  };
}

// =============================================
// Batch BKT Update from Evaluation
// Maps weakness_tags to BKT concepts and updates each
// =============================================
export function mapEvaluationToBKTObservations(evaluation: {
  claim_clarity: number;
  evidence_use: number;
  reasoning_strength: number;
  consistency: number;
  relevance: number;
  weakness_tags?: string[];
}): Array<{ concept: string; score: number }> {
  const scores = [
    evaluation.claim_clarity,
    evaluation.evidence_use,
    evaluation.reasoning_strength,
    evaluation.consistency,
    evaluation.relevance,
  ];
  if (scores.some(score => !isBKTScore(score))) {
    throw new RangeError('BKT evaluation contains an invalid 1-5 score; no observation was recorded.');
  }

  const observations: Array<{ concept: string; score: number }> = [];

  // Direct score-to-concept mapping
  observations.push(
    { concept: '주장 명확성', score: evaluation.claim_clarity },
    { concept: '근거 활용', score: evaluation.evidence_use },
    { concept: '추론 강도', score: evaluation.reasoning_strength },
    { concept: '논리 일관성', score: evaluation.consistency },
    { concept: '주제 관련성', score: evaluation.relevance },
  );

  // Weakness tags → negative observations
  const tagToConceptMap: Record<string, string> = {
    '근거 부족': '근거 활용',
    '추론 비약': '추론 강도',
    '질문 이탈': '주제 관련성',
    '모순 발생': '논리 일관성',
    '추상어 과다': '주장 명확성',
    '결론만 제시': '근거 활용',
    '성급한 일반화': '추론 강도',
    '무관한 사례': '주제 관련성',
  };

  if (evaluation.weakness_tags) {
    for (const tag of evaluation.weakness_tags) {
      const concept = tagToConceptMap[tag];
      if (concept) {
        // Weakness tag presence → reinforces low score observation
        const existing = observations.find(o => o.concept === concept);
        if (existing && existing.score > 2) {
          existing.score = Math.max(1, existing.score - 1);
        }
      }
    }
  }

  return observations;
}

// =============================================
// DB Integration: Read/Write BKT States
// =============================================
export async function loadBKTStates(
  db: D1Database,
  userId: string | null,
): Promise<BKTState[]> {
  const result = await db.prepare(
    'SELECT concept, p_know, p_transit, p_slip, p_guess, observations FROM bkt_knowledge_states WHERE user_id IS ?1'
  ).bind(userId).all<BKTStateRow>();

  return (result.results || []).map((row) => ({
    concept: row.concept,
    p_know: row.p_know ?? DEFAULT_BKT.p_know,
    p_transit: row.p_transit ?? DEFAULT_BKT.p_transit,
    p_slip: row.p_slip ?? DEFAULT_BKT.p_slip,
    p_guess: row.p_guess ?? DEFAULT_BKT.p_guess,
    observations: row.observations ?? 0,
  }));
}

export async function upsertBKTState(
  db: D1Database,
  userId: string | null,
  result: BKTUpdateResult,
  sessionId: string,
): Promise<void> {
  await buildBKTUpsertStatement(db, userId, result, sessionId).run();
}

function buildBKTUpsertStatement(
  db: D1Database,
  userId: string | null,
  result: BKTUpdateResult,
  sessionId: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO bkt_knowledge_states (user_id, concept, p_know, observations, last_session_id, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(user_id, concept) DO UPDATE SET
      p_know = ?3,
      observations = ?4,
      last_session_id = ?5,
      updated_at = ?6
  `).bind(
    userId,
    result.concept,
    result.newPKnow,
    result.observations,
    sessionId,
    Date.now(),
  );
}

// =============================================
// Batch update: process all observations from a single evaluation
// =============================================
export async function processSessionBKT(
  db: D1Database,
  userId: string | null,
  sessionId: string,
  evaluation: {
    claim_clarity: number;
    evidence_use: number;
    reasoning_strength: number;
    consistency: number;
    relevance: number;
    weakness_tags?: string[];
  },
): Promise<BKTUpdateResult[]> {
  const observations = mapEvaluationToBKTObservations(evaluation);
  const existingStates = await loadBKTStates(db, userId);
  const stateMap = new Map(existingStates.map(s => [s.concept, s]));

  const results: BKTUpdateResult[] = [];

  for (const obs of observations) {
    const existing = stateMap.get(obs.concept) || {
      concept: obs.concept,
      ...DEFAULT_BKT,
    };
    const result = updateBKT(existing, obs.score);
    results.push(result);
    stateMap.set(obs.concept, {
      ...existing,
      p_know: result.newPKnow,
      observations: result.observations,
    });
  }

  // Persist the complete evaluation as one D1 transaction: no concept can
  // advance unless every concept derived from this accepted turn advances.
  if (results.length > 0) {
    await db.batch(results.map(result => (
      buildBKTUpsertStatement(db, userId, result, sessionId)
    )));
  }

  return results;
}

// =============================================
// Get weakest concepts (for question generation)
// Returns concepts with lowest P(know), i.e., student struggles most
// =============================================
export async function getWeakestConcepts(
  db: D1Database,
  userId: string | null,
  limit: number = 5,
): Promise<Array<{ concept: string; p_know: number | null; masteryLevel: string }>> {
  const result = await db.prepare(
    'SELECT concept, p_know FROM bkt_knowledge_states WHERE user_id IS ?1 AND observations >= 2 ORDER BY p_know ASC LIMIT ?2'
  ).bind(userId, limit).all<Pick<BKTStateRow, 'concept' | 'p_know'>>();

  return (result.results || []).map((row) => ({
    concept: row.concept,
    p_know: row.p_know,
    masteryLevel: row.p_know === null ? 'unknown' : getMasteryLevel(row.p_know),
  }));
}

// =============================================
// Helpers
// =============================================
function getMasteryLevel(pKnow: number): 'unknown' | 'learning' | 'near_mastery' | 'mastered' {
  if (pKnow >= 0.85) return 'mastered';
  if (pKnow >= 0.6) return 'near_mastery';
  if (pKnow >= 0.3) return 'learning';
  return 'unknown';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
