// ======================================================
// SocraticAI v26 — BKT/LinUCB Hybrid Adaptive Engine
// References:
//   BKT: Jyväskylä Deep Knowledge Tracing Review 2025
//   LinUCB: Springer "Raising student completion rates" 2022
// ======================================================

import type { BKTState, LinUCBArm, HybridKTState, DDAState } from '../types/d1-rows';

// ===== BKT Engine (Context+Guess+Slip variant = CGSBKT) =====

const BKT_DEFAULTS = {
  pLearn: 0.15,
  pGuess: 0.25,
  pSlip: 0.10,
  pForget: 0.05,
  pInit: 0.30
};

/**
 * Update BKT knowledge state using CGSBKT variant
 * P(Ln) = P(L_{n-1}) * (1 - forget) + (1 - P(L_{n-1})) * learn
 */
export function updateBKTState(
  state: BKTState,
  isCorrect: boolean,
  contextDifficulty: number = 0.5
): BKTState {
  const { pKnown, pLearn, pGuess, pSlip, pForget } = state;

  // Context-adjusted parameters
  const adjustedGuess = pGuess * (1 - contextDifficulty * 0.3);
  const adjustedSlip = pSlip * (1 + contextDifficulty * 0.2);

  // Posterior calculation using Bayes' theorem
  let posterior: number;
  if (isCorrect) {
    const pCorrectGivenKnown = 1 - adjustedSlip;
    const pCorrectGivenUnknown = adjustedGuess;
    const pCorrect = pKnown * pCorrectGivenKnown + (1 - pKnown) * pCorrectGivenUnknown;
    posterior = (pKnown * pCorrectGivenKnown) / Math.max(pCorrect, 0.001);
  } else {
    const pIncorrectGivenKnown = adjustedSlip;
    const pIncorrectGivenUnknown = 1 - adjustedGuess;
    const pIncorrect = pKnown * pIncorrectGivenKnown + (1 - pKnown) * pIncorrectGivenUnknown;
    posterior = (pKnown * pIncorrectGivenKnown) / Math.max(pIncorrect, 0.001);
  }

  // State transition: learning + forgetting
  const newPKnown = posterior * (1 - pForget) + (1 - posterior) * pLearn;

  return {
    ...state,
    pKnown: Math.max(0, Math.min(1, newPKnown)),
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Predict performance on a concept
 */
export function predictBKTPerformance(state: BKTState): number {
  return state.pKnown * (1 - state.pSlip) + (1 - state.pKnown) * state.pGuess;
}

/**
 * Initialize BKT state for a new concept
 */
export function initBKTState(conceptId: string): BKTState {
  return {
    conceptId,
    pKnown: BKT_DEFAULTS.pInit,
    pLearn: BKT_DEFAULTS.pLearn,
    pGuess: BKT_DEFAULTS.pGuess,
    pSlip: BKT_DEFAULTS.pSlip,
    pForget: BKT_DEFAULTS.pForget,
    lastUpdated: new Date().toISOString()
  };
}

// ===== LinUCB Contextual Bandit Engine =====

const LINUCB_ALPHA = 0.5; // Exploration parameter
const CONTEXT_DIM = 6; // Feature vector dimension

/**
 * Initialize LinUCB arm for a tutoring action
 */
export function initLinUCBArm(armId: string): LinUCBArm {
  return {
    armId,
    theta: new Array(CONTEXT_DIM).fill(0),
    A: identityMatrix(CONTEXT_DIM),
    b: new Array(CONTEXT_DIM).fill(0),
    pullCount: 0,
    totalReward: 0
  };
}

/**
 * Select action using LinUCB Upper Confidence Bound
 * UCB = θ^T * x + α * sqrt(x^T * A^{-1} * x)
 */
export function selectLinUCBAction(
  arms: Record<string, LinUCBArm>,
  context: number[]
): { armId: string; ucb: number; expectedReward: number } {
  let bestArm = '';
  let bestUCB = -Infinity;
  let bestExpected = 0;

  for (const [armId, arm] of Object.entries(arms)) {
    const AInv = invertMatrix(arm.A);
    const theta = matVecMul(AInv, arm.b);
    const expectedReward = dotProduct(theta, context);
    
    const uncertainty = Math.sqrt(
      dotProduct(matVecMul(AInv, context), context)
    );
    
    const ucb = expectedReward + LINUCB_ALPHA * uncertainty;
    
    if (ucb > bestUCB) {
      bestUCB = ucb;
      bestArm = armId;
      bestExpected = expectedReward;
    }
  }

  return { armId: bestArm, ucb: bestUCB, expectedReward: bestExpected };
}

/**
 * Update LinUCB arm after receiving reward
 * A = A + x * x^T
 * b = b + reward * x
 */
export function updateLinUCBArm(
  arm: LinUCBArm,
  context: number[],
  reward: number
): LinUCBArm {
  const newA = arm.A.map((row, i) =>
    row.map((val, j) => val + context[i] * context[j])
  );
  const newB = arm.b.map((val, i) => val + reward * context[i]);

  return {
    ...arm,
    A: newA,
    b: newB,
    pullCount: arm.pullCount + 1,
    totalReward: arm.totalReward + reward
  };
}

// ===== Hybrid KT Engine (BKT + LinUCB) =====

/**
 * Initialize hybrid KT state for a user
 */
export function initHybridKTState(userId: string): HybridKTState {
  // Define tutoring action arms
  const defaultArms: Record<string, LinUCBArm> = {};
  const actionTypes = [
    'direct_question', 'socratic_probe', 'counter_example',
    'evidence_request', 'perspective_shift', 'synthesis_challenge',
    'metacognitive_prompt', 'scaffolded_hint'
  ];
  for (const action of actionTypes) {
    defaultArms[action] = initLinUCBArm(action);
  }

  return {
    userId,
    bktStates: {},
    linucbArms: defaultArms,
    alpha: LINUCB_ALPHA
  };
}

/**
 * Build context vector from user state for LinUCB
 */
export function buildContextVector(
  bktStates: Record<string, BKTState>,
  turnNumber: number,
  lastScore: number,
  difficulty: number
): number[] {
  const concepts = Object.values(bktStates);
  const avgKnowledge = concepts.length > 0
    ? concepts.reduce((sum, s) => sum + s.pKnown, 0) / concepts.length
    : 0.3;
  
  return [
    avgKnowledge,
    Math.min(1, turnNumber / 10),
    lastScore / 100,
    difficulty,
    concepts.length > 0 ? Math.min(...concepts.map(s => s.pKnown)) : 0.3,
    concepts.length > 0 ? Math.max(...concepts.map(s => s.pKnown)) : 0.3
  ];
}

/**
 * Recommend next tutoring action using hybrid BKT+LinUCB
 */
export function recommendNextAction(
  state: HybridKTState,
  turnNumber: number,
  lastScore: number,
  difficulty: number
): { action: string; confidence: number; reasoning: string } {
  const context = buildContextVector(state.bktStates, turnNumber, lastScore, difficulty);
  const selection = selectLinUCBAction(state.linucbArms, context);
  
  // Determine confidence and reasoning
  const arm = state.linucbArms[selection.armId];
  const confidence = arm.pullCount > 0
    ? Math.min(0.95, arm.totalReward / arm.pullCount)
    : 0.5;

  const reasoning = generateActionReasoning(selection.armId, context, confidence);

  return {
    action: selection.armId,
    confidence: Math.round(confidence * 100) / 100,
    reasoning
  };
}

function generateActionReasoning(action: string, context: number[], confidence: number): string {
  const avgKnowledge = context[0];
  const turnProgress = context[1];
  const lastScore = context[2];

  const reasons: Record<string, string> = {
    direct_question: `지식 수준 ${(avgKnowledge * 100).toFixed(0)}%에서 직접 질문으로 이해도를 확인합니다.`,
    socratic_probe: `소크라테스식 탐구로 더 깊은 사고를 유도합니다.`,
    counter_example: `반례를 통해 논리적 견고함을 시험합니다.`,
    evidence_request: `근거 요청으로 주장의 타당성을 검증합니다.`,
    perspective_shift: `관점 전환으로 인지 유연성을 강화합니다.`,
    synthesis_challenge: `종합 과제로 전체적 이해를 평가합니다.`,
    metacognitive_prompt: `메타인지 프롬프트로 자기 성찰을 유도합니다.`,
    scaffolded_hint: `스캐폴딩 힌트로 학습을 지원합니다 (점수 ${(lastScore * 100).toFixed(0)}%).`
  };

  return reasons[action] || `적응형 튜터링 액션: ${action}`;
}

// ===== DDA (Dynamic Difficulty Adjustment) Engine =====

export function initDDAState(): DDAState {
  return {
    currentDifficulty: 0.5,
    successRate: 0.5,
    avgResponseTime: 0,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
    adjustmentHistory: []
  };
}

/**
 * Fuzzy logic based difficulty adjustment
 * Reference: Springer "Fuzzy-based DDA" 2023
 */
export function adjustDifficulty(
  state: DDAState,
  score: number,
  responseTimeMs: number
): DDAState {
  const newState = { ...state };
  const normalizedScore = score / 100;
  
  // Update running stats
  newState.avgResponseTime = state.avgResponseTime * 0.7 + responseTimeMs * 0.3;
  newState.successRate = state.successRate * 0.8 + normalizedScore * 0.2;

  // Track streaks
  if (normalizedScore >= 0.7) {
    newState.consecutiveCorrect++;
    newState.consecutiveWrong = 0;
  } else if (normalizedScore < 0.4) {
    newState.consecutiveWrong++;
    newState.consecutiveCorrect = 0;
  }

  // Fuzzy logic rules
  let adjustment = 0;
  const prevDifficulty = state.currentDifficulty;

  // Rule 1: High success + fast response -> increase difficulty
  if (newState.successRate > 0.75 && responseTimeMs < 30000) {
    adjustment += 0.1;
  }
  // Rule 2: Low success -> decrease difficulty
  if (newState.successRate < 0.4) {
    adjustment -= 0.15;
  }
  // Rule 3: Consecutive streaks
  if (newState.consecutiveCorrect >= 3) {
    adjustment += 0.08;
  }
  if (newState.consecutiveWrong >= 2) {
    adjustment -= 0.12;
  }
  // Rule 4: Very slow response -> slight decrease
  if (responseTimeMs > 120000) {
    adjustment -= 0.05;
  }

  newState.currentDifficulty = Math.max(0.1, Math.min(1.0, prevDifficulty + adjustment));

  if (adjustment !== 0) {
    newState.adjustmentHistory.push({
      from: Math.round(prevDifficulty * 100) / 100,
      to: Math.round(newState.currentDifficulty * 100) / 100,
      reason: adjustment > 0 ? 'performance_up' : 'performance_down'
    });
  }

  return newState;
}

// ===== Linear Algebra Helpers =====

function identityMatrix(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
}

function matVecMul(mat: number[][], vec: number[]): number[] {
  return mat.map(row => dotProduct(row, vec));
}

function invertMatrix(matrix: number[][]): number[][] {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  ]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) maxRow = k;
    }
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    const pivot = augmented[i][i];
    if (Math.abs(pivot) < 1e-10) continue;

    for (let j = 0; j < 2 * n; j++) augmented[i][j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const factor = augmented[k][i];
      for (let j = 0; j < 2 * n; j++) augmented[k][j] -= factor * augmented[i][j];
    }
  }

  return augmented.map(row => row.slice(n));
}
