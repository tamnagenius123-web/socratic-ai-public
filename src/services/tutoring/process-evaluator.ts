// ============================================================
// v19 Process-Oriented Evaluator
// ============================================================
// 학술 근거:
//   Park et al. (2024) "Adaptive Socratic Tutor for Critical Thinking"
//   "Process-oriented evaluation measures the quality of reasoning journey"
//
// 핵심: 단순 결과 채점이 아닌 사고 과정 자체를 평가
//   - 논리 진화 궤적 (logicalProgressionRate)
//   - 수정의 질 (revisionQualityIndex)
//   - 소크라틱 압박 반응 (pressureResponseScore)
//   - 논증 깊이 성장 (argumentDepthGrowth)
//   - 유연성 시계열 (flexibilityTrajectory)
//   - 메타인지 활성화 (metacognitionActivationRate)
// ============================================================

import type { MicroScoreBatch } from './micro-indicator-engine';

// =============================================
// 턴별 스냅샷 (궤적 추적 단위)
// =============================================

export interface TurnSnapshot {
  turnNumber: number;
  microScores: {
    axisSummary: { logical: number; data: number; flexibility: number; communication: number };
    overallScore: number;
    scores: { indicatorId: string; normalizedScore: number }[];
  };
  daAct: string | null;
  illocutionaryStrength: number | null;
  state: string | null;
  pressureMove: string | null;
  revisionOccurred: boolean | null;
}

// =============================================
// 과정 중심 평가 지표
// =============================================

export interface ProcessMetrics {
  logicalProgressionRate: number;    // 턴별 논리 점수 상승 기울기
  revisionQualityIndex: number;      // 수정의 질 (-1 ~ 1)
  pressureResponseScore: number;     // 소크라틱 압박 반응 품질
  argumentDepthGrowth: number;       // 논증 깊이 성장 기울기
  flexibilityTrajectory: number[];   // 턴별 유연성 점수 시계열
  peakFlexibilityTurn: number;       // 최고 유연성 턴 번호
  sustainedFlexibility: number;      // 3턴 이상 유연성 유지 (0-1)
  metacognitionActivationRate: number;  // 메타인지 DA 발생 빈도
  selfCorrectionDepth: number;       // 자기 교정의 깊이
  processScore: number;              // 과정 종합 점수 (0-100)
}

// =============================================
// Main: 과정 중심 평가 계산
// =============================================

export function computeProcessMetrics(trajectory: TurnSnapshot[]): ProcessMetrics {
  if (trajectory.length === 0) {
    return getDefaultProcessMetrics();
  }

  // 1. 논리 진화 궤적 (Logical Progression Rate)
  const logicalScores = trajectory.map(t => t.microScores.axisSummary.logical);
  const logicalProgressionRate = computeTrendSlope(logicalScores);

  // 2. 수정의 질 평가
  const revisionTurns = trajectory.filter(t => t.revisionOccurred);
  let revisionQualityIndex = 0;
  if (revisionTurns.length > 0) {
    revisionTurns.forEach(t => {
      const prevTurn = trajectory.find(p => p.turnNumber === t.turnNumber - 1);
      if (prevTurn) {
        const logicalGain = t.microScores.axisSummary.logical - prevTurn.microScores.axisSummary.logical;
        const dataGain = t.microScores.axisSummary.data - prevTurn.microScores.axisSummary.data;
        revisionQualityIndex += (logicalGain + dataGain) / 2;
      }
    });
    revisionQualityIndex /= revisionTurns.length;
    revisionQualityIndex = Math.max(-1, Math.min(1, revisionQualityIndex));
  }

  // 3. 소크라틱 압박 반응 점수
  const pressureTurns = trajectory.filter(t => t.pressureMove !== null);
  let pressureResponseScore = 0;
  if (pressureTurns.length > 0) {
    pressureTurns.forEach(t => {
      const nextTurn = trajectory.find(p => p.turnNumber === t.turnNumber + 1);
      if (nextTurn) {
        const improvement = nextTurn.microScores.overallScore - t.microScores.overallScore;
        pressureResponseScore += improvement;
      }
    });
    pressureResponseScore /= pressureTurns.length;
  }

  // 4. 논증 깊이 성장
  const depthScores = trajectory.map(t =>
    t.microScores.scores.find(s => s.indicatorId === 'ls_premise_sufficiency')?.normalizedScore || 0
  );
  const argumentDepthGrowth = computeTrendSlope(depthScores);

  // 5. 유연성 시계열
  const flexibilityTrajectory = trajectory.map(t => t.microScores.axisSummary.flexibility);
  const peakFlexibilityIdx = flexibilityTrajectory.indexOf(Math.max(...flexibilityTrajectory));

  // 3턴 이상 연속 유연성 유지 (0.6 이상)
  let maxConsecutiveHigh = 0, currentConsecutive = 0;
  flexibilityTrajectory.forEach(f => {
    if (f >= 0.6) { currentConsecutive++; maxConsecutiveHigh = Math.max(maxConsecutiveHigh, currentConsecutive); }
    else { currentConsecutive = 0; }
  });
  const sustainedFlexibility = Math.min(1, maxConsecutiveHigh / 3);

  // 6. 메타인지 활성화율
  const metaTurns = trajectory.filter(t =>
    t.daAct === 'meta_reasoning' || t.daAct === 'self_correction'
  );
  const metacognitionActivationRate = metaTurns.length / Math.max(1, trajectory.length);

  // 7. 자기 교정 깊이
  const selfCorrectionTurns = trajectory.filter(t => t.daAct === 'self_correction');
  let selfCorrectionDepth = 0;
  selfCorrectionTurns.forEach(t => {
    const logScore = t.microScores.axisSummary.logical;
    selfCorrectionDepth += logScore >= 0.7 ? 1.0 : logScore >= 0.4 ? 0.5 : 0.2;
  });
  selfCorrectionDepth = selfCorrectionTurns.length > 0
    ? selfCorrectionDepth / selfCorrectionTurns.length
    : 0;

  // 8. 종합 과정 점수 (McKinsey Process-Oriented 공식)
  // v19 BUG-105 Fix: 모든 항목을 [0,100] 스케일로 정규화하여 합계 최대 100점 보장
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const processScore = Math.round((
    clamp01((logicalProgressionRate + 1) / 2) * 100 * 0.25 +  // [-1,1] → [0,100] → 최대 25
    clamp01((revisionQualityIndex + 1) / 2) * 100 * 0.20 +   // [-1,1] → [0,100] → 최대 20
    clamp01((pressureResponseScore + 1) / 2) * 100 * 0.20 +  // [-1,1] → [0,100] → 최대 20
    clamp01(sustainedFlexibility) * 100 * 0.15 +              // [0,1]  → [0,100] → 최대 15
    clamp01(metacognitionActivationRate) * 100 * 0.10 +       // [0,1]  → [0,100] → 최대 10
    clamp01(selfCorrectionDepth) * 100 * 0.10                 // [0,1]  → [0,100] → 최대 10
  ) * 10) / 10;  // 합계 최대 = 25 + 20 + 20 + 15 + 10 + 10 = 100 ✓

  return {
    logicalProgressionRate: Math.round(logicalProgressionRate * 1000) / 1000,
    revisionQualityIndex: Math.round(revisionQualityIndex * 1000) / 1000,
    pressureResponseScore: Math.round(pressureResponseScore * 1000) / 1000,
    argumentDepthGrowth: Math.round(argumentDepthGrowth * 1000) / 1000,
    flexibilityTrajectory,
    peakFlexibilityTurn: trajectory[peakFlexibilityIdx]?.turnNumber || 0,
    sustainedFlexibility: Math.round(sustainedFlexibility * 1000) / 1000,
    metacognitionActivationRate: Math.round(metacognitionActivationRate * 1000) / 1000,
    selfCorrectionDepth: Math.round(selfCorrectionDepth * 1000) / 1000,
    processScore: Math.min(100, processScore),
  };
}

// =============================================
// D1 Persist: 턴별 스냅샷 저장
// =============================================

export async function persistTurnSnapshot(
  db: D1Database,
  sessionId: string,
  snapshot: TurnSnapshot,
): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO session_process_snapshots
      (id, session_id, turn_number, logical_score, data_score, flexibility_score,
       communication_score, overall_score, da_act, illocutionary_strength,
       pressure_move, revision_occurred, state, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    `).bind(
      `sps_${sessionId}_t${snapshot.turnNumber}`,
      sessionId,
      snapshot.turnNumber,
      snapshot.microScores.axisSummary.logical,
      snapshot.microScores.axisSummary.data,
      snapshot.microScores.axisSummary.flexibility,
      snapshot.microScores.axisSummary.communication,
      snapshot.microScores.overallScore,
      snapshot.daAct,
      snapshot.illocutionaryStrength,
      snapshot.pressureMove,
      snapshot.revisionOccurred === null ? null : snapshot.revisionOccurred ? 1 : 0,
      snapshot.state,
      Date.now(),
    ).run();
  } catch (e) {
    console.warn('[PROCESS_SNAPSHOT] Non-critical:', e);
  }
}

// =============================================
// D1 Persist: 세션 종료 시 종합 평가 저장
// =============================================

export async function persistProcessEvaluation(
  db: D1Database,
  sessionId: string,
  userId: string | null,
  metrics: ProcessMetrics,
  trajectory: TurnSnapshot[],
): Promise<void> {
  if (!db) return;
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO session_process_evaluations
      (id, session_id, user_id,
       logical_progression_rate, revision_quality_index, pressure_response_score,
       argument_depth_growth, peak_flexibility_turn, sustained_flexibility,
       metacognition_activation_rate, self_correction_depth, process_score,
       snapshot_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    `).bind(
      `spe_${sessionId}`,
      sessionId,
      userId,
      metrics.logicalProgressionRate,
      metrics.revisionQualityIndex,
      metrics.pressureResponseScore,
      metrics.argumentDepthGrowth,
      metrics.peakFlexibilityTurn,
      metrics.sustainedFlexibility,
      metrics.metacognitionActivationRate,
      metrics.selfCorrectionDepth,
      metrics.processScore,
      JSON.stringify(trajectory.slice(-20)), // 최근 20턴만 저장
      Date.now(),
    ).run();
    console.log(`[PROCESS v18] Session ${sessionId}: processScore=${metrics.processScore}`);
  } catch (e) {
    console.warn('[PROCESS_EVAL] Non-critical:', e);
  }
}

// =============================================
// Helpers
// =============================================

// v19: 공개 헬퍼로 승격 (EMA 평활화에서도 재사용)
export function computeTrendSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let numerator = 0, denominator = 0;
  values.forEach((y, x) => {
    numerator += (x - xMean) * (y - yMean);
    denominator += (x - xMean) ** 2;
  });
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * v19: 지수 이동 평균(EMA) 궤적 평활화
 * Park (2024): 턴간 노이즈를 제거하여 진정한 학습 추세를 드러냄
 */
export function computeSmoothedTrajectory(values: number[], alpha: number = 0.3): number[] {
  const smoothed: number[] = [];
  values.forEach((val, i) => {
    if (i === 0) smoothed.push(val);
    else smoothed.push(val * alpha + smoothed[i - 1] * (1 - alpha));
  });
  return smoothed;
}

function getDefaultProcessMetrics(): ProcessMetrics {
  return {
    logicalProgressionRate: 0, revisionQualityIndex: 0,
    pressureResponseScore: 0, argumentDepthGrowth: 0,
    flexibilityTrajectory: [], peakFlexibilityTurn: 0,
    sustainedFlexibility: 0, metacognitionActivationRate: 0,
    selfCorrectionDepth: 0, processScore: 0,
  };
}
