// ============================================================
// v18 Hybrid Knowledge Tracing Engine (BKT + DKT Ensemble)
// ============================================================
// 학술 근거: Piech et al. (2015) Deep Knowledge Tracing
//   + Yudelson (2021) ELO-Infused BKT
// 파괴적 혁신 #1: BKT + DKT 듀얼 스트림 앙상블
// ============================================================

export interface HybridKTResult {
  bktPKnow: number;
  dktPKnow: number;
  ensembledPKnow: number;
  confidence: number;
  ktMethod: 'bkt_only' | 'dkt_only' | 'ensemble';
}

/**
 * BKT 순수 업데이트 (빠른 동기 연산)
 */
function updateBKTPure(
  params: { p_know: number; p_transit: number; p_slip: number; p_guess: number },
  correct: boolean,
): number {
  const { p_know, p_transit, p_slip, p_guess } = params;
  const p_correct_given_know = 1 - p_slip;
  const p_correct_given_not_know = p_guess;
  const p_correct = p_know * p_correct_given_know + (1 - p_know) * p_correct_given_not_know;

  const p_know_given_obs = correct
    ? (p_know * p_correct_given_know) / Math.max(0.001, p_correct)
    : (p_know * p_slip) / Math.max(0.001, 1 - p_correct);

  return p_know_given_obs + (1 - p_know_given_obs) * p_transit;
}

/**
 * DKT 추론 (시퀀스 패턴 기반 휴리스틱)
 * 실제 DKT 모델 대신 상호작용 이력 기반 패턴 분석
 * v19에서 Cloudflare AI Workers 커스텀 모델로 교체 예정
 */
function dktInference(
  interactionHistory: { correct: boolean; difficulty: number }[],
  concept: string,
): number {
  if (interactionHistory.length === 0) return 0.3;

  // 최근 상호작용에 가중치 부여 (Exponential decay)
  let weightedCorrect = 0;
  let totalWeight = 0;
  const decay = 0.85;

  for (let i = interactionHistory.length - 1; i >= 0; i--) {
    const weight = Math.pow(decay, interactionHistory.length - 1 - i);
    totalWeight += weight;
    if (interactionHistory[i].correct) {
      weightedCorrect += weight;
    }
  }

  const baseEstimate = totalWeight > 0 ? weightedCorrect / totalWeight : 0.3;

  // 연속 정답/오답 스트릭 탐지 (학습 도약/정체 현상)
  let consecutiveCorrect = 0;
  for (let i = interactionHistory.length - 1; i >= 0; i--) {
    if (interactionHistory[i].correct) consecutiveCorrect++;
    else break;
  }

  // 학습 도약 보너스: 연속 3+ 정답 시 급격한 p_know 상승
  const leapBonus = consecutiveCorrect >= 3 ? Math.min(0.15, consecutiveCorrect * 0.03) : 0;

  // 난이도 보정: 어려운 문제를 맞추면 더 높은 p_know
  const avgDifficulty = interactionHistory.reduce((sum, h) => sum + h.difficulty, 0) / interactionHistory.length;
  const difficultyBonus = avgDifficulty > 0.7 ? 0.05 : 0;

  return Math.min(1, Math.max(0, baseEstimate + leapBonus + difficultyBonus));
}

/**
 * Hybrid KT: BKT + DKT 앙상블
 * ELO 기반 가중 평균으로 두 모델 결합
 */
export function computeHybridKT(
  concept: string,
  bktParams: { p_know: number; p_transit: number; p_slip: number; p_guess: number },
  interactionHistory: { correct: boolean; difficulty: number }[],
  studentElo: number,
  latestCorrect: boolean,
): HybridKTResult {
  // Stream 1: BKT (동기, 빠름)
  const bktPKnow = updateBKTPure(bktParams, latestCorrect);

  // Stream 2: DKT (패턴 분석)
  const dktPKnow = dktInference(interactionHistory, concept);

  // 앙상블: ELO 기반 가중 평균
  // 고ELO 학생 → DKT 신뢰도 높음 (비선형 학습 패턴 포착)
  // 저ELO 학생 → BKT 안정성 선호
  const dktWeight = Math.min(0.7, Math.max(0.3, (studentElo - 600) / 800));
  const bktWeight = 1 - dktWeight;
  const ensembledPKnow = bktPKnow * bktWeight + dktPKnow * dktWeight;

  // 신뢰도: 두 모델의 예측 일치도
  const confidence = 1 - Math.abs(bktPKnow - dktPKnow);

  return {
    bktPKnow: Math.round(bktPKnow * 1000) / 1000,
    dktPKnow: Math.round(dktPKnow * 1000) / 1000,
    ensembledPKnow: Math.max(0, Math.min(1, Math.round(ensembledPKnow * 1000) / 1000)),
    confidence: Math.round(confidence * 1000) / 1000,
    ktMethod: 'ensemble',
  };
}
