// ============================================================
// v18 LinUCB Contextual Bandit Engine
// ============================================================
// 학술 근거: Li et al. (2010) "A Contextual-Bandit Approach to
//   Personalized News Article Recommendation"
// v18: ε-greedy MAB Q-Table → LinUCB 컨텍스트 밴딧 교체
// ============================================================

export interface LinUCBContext {
  daTags: number[];          // DA 태그 원-핫 벡터 (14차원)
  thoughtProfile: number[];  // [absolutist, binary, vague, intuition] (4차원)
  challengeLevel: number;    // 0-1
  eloNormalized: number;     // (ELO - 1000) / 400
  revisionDebt: number | null; // null is unknown; mask the feature during encoding
  turnProgress: number;      // turnNumber / maxTurns
}

export interface LinUCBArm {
  action: string;
  A: number[][];   // d×d 행렬
  b: number[];     // d차원 벡터
  timesSelected: number;
  totalReward: number;
}

const CONTEXT_DIM = 22; // 14 + 4 + 1 + 1 + 1 + 1

export function createLinUCBArm(action: string): LinUCBArm {
  const A = Array.from({ length: CONTEXT_DIM }, (_, i) =>
    Array.from({ length: CONTEXT_DIM }, (_, j) => (i === j ? 1 : 0))
  );
  return { action, A, b: new Array(CONTEXT_DIM).fill(0), timesSelected: 0, totalReward: 0 };
}

function contextToVector(ctx: LinUCBContext): number[] {
  return [
    ...ctx.daTags,
    ...ctx.thoughtProfile,
    ctx.challengeLevel,
    ctx.eloNormalized,
    // Zero masks an unavailable feature in the vector; it is not measured zero debt.
    ctx.revisionDebt ?? 0,
    ctx.turnProgress,
  ];
}

function dotProduct(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * (b[i] || 0), 0);
}

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / pivot;
      for (let j = 0; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
    for (let j = 0; j <= n; j++) aug[col][j] /= pivot;
  }
  return aug.map(row => row[n]);
}

function invertMatrix(A: number[][]): number[][] {
  const n = A.length;
  const aug = A.map((row, i) => {
    const identity = new Array(n).fill(0);
    identity[i] = 1;
    return [...row, ...identity];
  });

  for (let col = 0; col < n; col++) {
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-10) continue;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / pivot;
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
  }
  return aug.map(row => row.slice(n));
}

function quadraticForm(A: number[][], x: number[]): number {
  const Ax = A.map(row => dotProduct(row, x));
  return Math.abs(dotProduct(x, Ax));
}

export function selectLinUCBAction(
  arms: LinUCBArm[],
  context: LinUCBContext,
  alpha: number = 1.0,
): { action: string; ucb: number } {
  const x = contextToVector(context);
  let bestAction = arms[0]?.action || 'ask_evidence';
  let bestUCB = -Infinity;

  for (const arm of arms) {
    try {
      const theta = solveLinearSystem(arm.A, arm.b);
      const expectedReward = dotProduct(theta, x);
      const confidence = Math.sqrt(quadraticForm(invertMatrix(arm.A), x));
      const ucb = expectedReward + alpha * confidence;

      if (ucb > bestUCB) {
        bestUCB = ucb;
        bestAction = arm.action;
      }
    } catch (e) { console.error("[P1-004] Caught:", e);
      // 행렬 연산 실패 시 건너뜀
      continue;
    }
  }

  return { action: bestAction, ucb: bestUCB };
}

export function updateLinUCBArm(
  arm: LinUCBArm,
  context: LinUCBContext,
  reward: number,
): LinUCBArm {
  const x = contextToVector(context);
  const updatedA = arm.A.map((row, i) =>
    row.map((val, j) => val + x[i] * x[j])
  );
  const updatedB = arm.b.map((val, i) => val + reward * x[i]);

  return {
    ...arm,
    A: updatedA,
    b: updatedB,
    timesSelected: arm.timesSelected + 1,
    totalReward: arm.totalReward + reward,
  };
}
