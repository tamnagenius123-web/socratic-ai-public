// BKT Engine – Bayesian Knowledge Tracing
// Formula: P(L_n | Obs) = P(L_n) * P(Obs|L) / [P(L_n)*P(Obs|L) + (1-P(L_n))*P(Obs|¬L)]
// Where:
//   P(L_n) = prior probability of mastery
//   P(S) = slip probability (knows but answers wrong)
//   P(G) = guess probability (doesn't know but correct)
//   P(T) = transit probability (learning after one session)
//
// Observation encoding: score >= 3 (out of 5) → correct, else incorrect
// After posterior, apply learning transition:
//   P(L_{n+1}) = P(L_n|Obs) + (1 - P(L_n|Obs)) * P(T)

export interface BKTState {
  concept: string;
  p_know: number;    // P(L_n): [0.0, 1.0]
  p_transit: number; // P(T):   [0.0, 1.0]
  p_slip: number;    // P(S):   [0.0, 1.0]
  p_guess: number;   // P(G):   [0.0, 1.0]
  observations: number;
}

export interface BKTObservation {
  concept: string;
  score: number; // 1-5 scale from evaluation
  isCorrect: boolean; // score >= 3
}

// ==============================================
// Core BKT Update (single Bayes step, < 1ms)
// ==============================================
export function bktUpdate(state: BKTState, isCorrect: boolean): number {
  const { p_know, p_slip, p_guess } = state;

  // P(Obs | L) = (1 - P(S)) if correct, P(S) if incorrect
  // P(Obs | ¬L) = P(G) if correct, (1 - P(G)) if incorrect
  const pObsGivenL = isCorrect ? (1 - p_slip) : p_slip;
  const pObsGivenNotL = isCorrect ? p_guess : (1 - p_guess);

  // Bayes posterior: P(L | Obs)
  const numerator = p_know * pObsGivenL;
  const denominator = numerator + (1 - p_know) * pObsGivenNotL;

  // Guard against division by zero
  if (denominator === 0) return p_know;

  const posterior = numerator / denominator;

  // Apply learning transition: P(L_{n+1}) = P(L|Obs) + (1 - P(L|Obs)) * P(T)
  const pNext = posterior + (1 - posterior) * state.p_transit;

  // Clamp to [0.01, 0.99] to avoid degenerate certainty
  return Math.max(0.01, Math.min(0.99, pNext));
}

// ==============================================
// v16: ELO-Infused BKT Parameters (Yudelson 2021)
// ==============================================
// 학생의 ELO 레이팅으로 BKT 초기 파라미터를 개별화
// 수학적 모델:
//   P(L0) = σ((ELO_student - ELO_baseline) / scale + logit(P_default))
//   P(T) = base_transit × (1 + γ × (ELO_student - 1000) / 400)
// =============================================
const DEFAULT_BKT_PARAMS: BKTState = {
  concept: '',
  p_know: 0.3,
  p_transit: 0.1,
  p_slip: 0.15,
  p_guess: 0.25,
  observations: 0,
};

export function getEloInfusedBKTParams(
  studentElo: number,
  concept: string,
  baseParams: BKTState = DEFAULT_BKT_PARAMS,
): BKTState {
  const ELO_BASELINE = 1000;
  const SCALE = 200;
  const GAMMA = 0.3;

  // P(L0): sigmoid transform ELO → initial mastery probability
  const logitDefault = Math.log(baseParams.p_know / (1 - baseParams.p_know));
  const adjusted = (studentElo - ELO_BASELINE) / SCALE + logitDefault;
  const p_know = 1 / (1 + Math.exp(-adjusted));

  // P(T): ELO가 높으면 전이 확률 상승 (더 빨리 학습)
  const p_transit = Math.max(0.05, Math.min(0.5,
    baseParams.p_transit * (1 + GAMMA * (studentElo - ELO_BASELINE) / 400)
  ));

  // P(S), P(G): ELO가 높으면 슬립 확률 감소, 추측 확률 감소
  const eloFactor = Math.max(0.5, Math.min(1.5, studentElo / ELO_BASELINE));
  const p_slip = Math.max(0.01, baseParams.p_slip / eloFactor);
  const p_guess = Math.max(0.05, baseParams.p_guess / eloFactor);

  return {
    concept,
    p_know: Math.max(0.05, Math.min(0.95, p_know)),
    p_transit,
    p_slip,
    p_guess,
    observations: 0,
  };
}

// ==============================================
// Batch BKT Update from Session Results
// ==============================================
export function computeBKTUpdates(
  existingStates: BKTState[],
  weaknessTags: string[],
  evaluationScores: Record<string, number>,
): { concept: string; newPKnow: number; observation: boolean }[] {
  const results: { concept: string; newPKnow: number; observation: boolean }[] = [];

  // Map weakness tags to concepts and evaluate
  const conceptScores = mapWeaknessToScore(weaknessTags, evaluationScores);

  for (const [concept, score] of Object.entries(conceptScores)) {
    const isCorrect = score >= 3;
    const existing = existingStates.find(s => s.concept === concept);

    const state: BKTState = existing || {
      concept,
      p_know: 0.3,    // Default prior
      p_transit: 0.1,
      p_slip: 0.15,
      p_guess: 0.25,
      observations: 0,
    };

    const newPKnow = bktUpdate(state, isCorrect);
    results.push({ concept, newPKnow, observation: isCorrect });
  }

  return results;
}

// ==============================================
// Map weakness tags to evaluation dimensions
// ==============================================
function mapWeaknessToScore(
  weaknessTags: string[],
  scores: Record<string, number>,
): Record<string, number> {
  const conceptMap: Record<string, number> = {};

  // Always track core dimensions
  const dimensionMapping: Record<string, string> = {
    '근거 부족': 'evidence_use',
    '텍스트 미참조': 'evidence_use',
    '결론만 제시': 'evidence_use',
    '추론 비약': 'reasoning_strength',
    '추상어 과다': 'claim_clarity',
    '모순 발생': 'consistency',
    '질문 이탈': 'relevance',
    '반례 미고려': 'reasoning_strength',
  };

  // Track all weakness tags as concepts
  for (const tag of weaknessTags) {
    const dimension = dimensionMapping[tag];
    if (dimension && scores[dimension] !== undefined) {
      conceptMap[tag] = scores[dimension];
    } else {
      // Default to average if dimension not found
      const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(scores).length);
      conceptMap[tag] = avg;
    }
  }

  // Also track the 5 core evaluation dimensions directly
  if (scores.claim_clarity !== undefined) conceptMap['주장_명확성'] = scores.claim_clarity;
  if (scores.evidence_use !== undefined) conceptMap['근거_활용'] = scores.evidence_use;
  if (scores.reasoning_strength !== undefined) conceptMap['추론_강도'] = scores.reasoning_strength;
  if (scores.consistency !== undefined) conceptMap['일관성'] = scores.consistency;
  if (scores.relevance !== undefined) conceptMap['관련성'] = scores.relevance;

  return conceptMap;
}

// ==============================================
// SQL helpers for D1 integration
// ==============================================
export function buildBKTUpsertSQL(
  userId: string | null,
  concept: string,
  newPKnow: number,
  sessionId: string,
): { sql: string; binds: unknown[] } {
  return {
    sql: `INSERT INTO bkt_knowledge_states (user_id, concept, p_know, observations, last_session_id, updated_at)
          VALUES (?1, ?2, ?3, 1, ?4, ?5)
          ON CONFLICT(user_id, concept) DO UPDATE SET
            p_know = ?3,
            observations = observations + 1,
            last_session_id = ?4,
            updated_at = ?5`,
    binds: [userId, concept, newPKnow, sessionId, Date.now()],
  };
}

// ==============================================
// Get lowest-mastery concepts for question generation
// ==============================================
export function buildLowestMasteryQuery(
  userId: string | null,
  limit: number = 5,
): { sql: string; binds: unknown[] } {
  return {
    sql: `SELECT concept, p_know, observations, last_session_id
          FROM bkt_knowledge_states
          WHERE user_id ${userId ? '= ?1' : 'IS NULL'}
          AND observations >= 2
          ORDER BY p_know ASC
          LIMIT ?${userId ? '2' : '1'}`,
    binds: userId ? [userId, limit] : [limit],
  };
}

// ==============================================
// Get student level bucket for MAB Q-Table
// ==============================================
export function getStudentLevelBucket(avgPKnow: number): string {
  // Calculate from average BKT mastery across all concepts
  if (avgPKnow >= 0.9) return 'master';
  if (avgPKnow >= 0.75) return 'expert';
  if (avgPKnow >= 0.55) return 'journeyman';
  if (avgPKnow >= 0.35) return 'apprentice';
  return 'novice';
}
