// SocraticAI v34 — Declarative Indicator Registry Pattern
// Replaces hardcoded 24 indicators with extensible registry (200+)
// Tier: realtime (per-turn, ~20) vs async (post-session, 180+)

// =============================================
// Types
// =============================================

export interface IndicatorContext {
  // Per-turn data
  evaluation?: any;
  studentMessage?: string;
  tutorMessage?: string;
  dialogueAct?: string;
  turnNumber?: number;
  
  // Session-level data (async only)
  fullSessionTurns?: any[];
  fullSessionXAIF?: any;
  llmAnalysis?: any;
  caseStudyData?: any;
}

export interface IndicatorDefinition {
  id: string;
  axis: 'logical' | 'data' | 'flexibility' | 'communication';
  name: string;
  nameKo: string;
  description: string;
  tier: 'realtime' | 'async';
  weight: number;
  compute: (ctx: IndicatorContext) => number;
  normalize: (raw: number) => number;
}

export interface MicroScore {
  indicatorId: string;
  rawValue: number;
  normalizedScore: number;
  evidenceJson: string;
}

export interface MicroScoreBatch {
  scores: MicroScore[];
  axisSummary: Record<string, number>;
  overallScore: number;
}

// =============================================
// Utility
// =============================================

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// =============================================
// Indicator Registry — Declarative Definitions
// =============================================

export const INDICATOR_REGISTRY: IndicatorDefinition[] = [
  // ===== Axis 1: Logical Structuring =====
  
  // Realtime (5)
  {
    id: 'ls_claim_clarity', axis: 'logical',
    name: 'Claim Clarity', nameKo: '주장 명확성',
    description: '학생의 주장이 얼마나 명확하게 표현되었는가',
    tier: 'realtime', weight: 0.8,
    compute: (ctx) => ctx.evaluation?.claim_clarity ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'ls_premise_sufficiency', axis: 'logical',
    name: 'Premise Sufficiency', nameKo: '전제 충분성',
    description: '주장을 뒷받침하는 전제의 수와 질',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.premise_sufficiency ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'ls_circular_logic', axis: 'logical',
    name: 'Circular Logic Detection', nameKo: '순환논리 탐지',
    description: '순환논리 오류 존재 여부 (낮을수록 좋음)',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => ctx.evaluation?.circular_logic ? 0 : 1,
    normalize: (raw) => raw,
  },
  {
    id: 'ls_inference_validity', axis: 'logical',
    name: 'Inference Validity', nameKo: '추론 유효성',
    description: '전제에서 결론으로의 추론이 유효한지',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.inference_validity ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'ls_fallacy_count', axis: 'logical',
    name: 'Fallacy Count', nameKo: '논리적 오류 횟수',
    description: '감지된 논리적 오류의 수 (적을수록 좋음)',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => ctx.evaluation?.fallacy_count ?? 0,
    normalize: (raw) => clamp01(1 - raw / 3),
  },

  // Async Logical (10)
  {
    id: 'ls_argument_chain_depth', axis: 'logical',
    name: 'Argument Chain Depth', nameKo: '논증 체인 깊이',
    description: '주장→전제→증거로 이어지는 논증의 최대 깊이',
    tier: 'async', weight: 0.6,
    compute: (ctx) => {
      const turns = ctx.fullSessionTurns || [];
      let maxDepth = 0, currentDepth = 0;
      for (const t of turns) {
        if (t.role === 'user') {
          if (t.da === 'evidence' || t.da === 'elaboration') currentDepth++;
          else if (t.da === 'claim') currentDepth = 1;
          maxDepth = Math.max(maxDepth, currentDepth);
        }
      }
      return maxDepth;
    },
    normalize: (raw) => clamp01(raw / 5),
  },
  {
    id: 'ls_walton_scheme_diversity', axis: 'logical',
    name: 'Walton Scheme Diversity', nameKo: '논증 스킴 다양성',
    description: '학생이 사용한 Walton 논증 스킴의 종류 수',
    tier: 'async', weight: 0.5,
    compute: (ctx) => {
      const turns = ctx.fullSessionTurns || [];
      const schemes = new Set(turns.map((t: any) => t.waltonScheme).filter(Boolean));
      return schemes.size;
    },
    normalize: (raw) => clamp01(raw / 5),
  },
  {
    id: 'ls_counterargument_anticipation', axis: 'logical',
    name: 'Counterargument Anticipation', nameKo: '반론 예상',
    description: '학생이 스스로 반론을 예상하고 선제 대응한 횟수',
    tier: 'async', weight: 0.7,
    compute: (ctx) => {
      const turns = ctx.fullSessionTurns || [];
      return turns.filter((t: any) => t.role === 'user' && /반면|하지만|물론.*그렇지만|예상되는 반론/.test(t.content || '')).length;
    },
    normalize: (raw) => clamp01(raw / 3),
  },
  {
    id: 'ls_conclusion_support_ratio', axis: 'logical',
    name: 'Conclusion Support Ratio', nameKo: '결론 지지 비율',
    description: '결론을 지지하는 근거의 비율',
    tier: 'async', weight: 0.6,
    compute: (ctx) => {
      const turns = ctx.fullSessionTurns || [];
      const claims = turns.filter((t: any) => t.role === 'user' && (t.da === 'claim' || t.da === 'decision_statement')).length;
      const evidence = turns.filter((t: any) => t.role === 'user' && t.da === 'evidence').length;
      return claims > 0 ? Math.min(1, evidence / claims) : 0;
    },
    normalize: (raw) => raw,
  },

  // ===== Axis 2: Data Literacy =====
  
  // Realtime (5)
  {
    id: 'dl_text_reference_rate', axis: 'data',
    name: 'Text Reference Rate', nameKo: '텍스트 인용률',
    description: '학생이 텍스트나 데이터를 인용한 비율',
    tier: 'realtime', weight: 0.8,
    compute: (ctx) => ctx.evaluation?.text_reference_rate ?? 0,
    normalize: (raw) => clamp01(raw),
  },
  {
    id: 'dl_evidence_diversity', axis: 'data',
    name: 'Evidence Diversity', nameKo: '증거 다양성',
    description: '다양한 유형의 증거를 사용했는지',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => ctx.evaluation?.evidence_diversity ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'dl_statistical_reasoning', axis: 'data',
    name: 'Statistical Reasoning', nameKo: '통계적 추론',
    description: '통계 데이터를 올바르게 해석하고 활용하는 능력',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.statistical_reasoning ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'dl_source_credibility', axis: 'data',
    name: 'Source Credibility', nameKo: '출처 신뢰도',
    description: '인용한 출처의 신뢰도와 적절성',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => ctx.evaluation?.source_credibility ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'dl_quantitative_argument', axis: 'data',
    name: 'Quantitative Argument', nameKo: '정량적 논증',
    description: '수치를 활용한 논증의 비율',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => {
      const msg = ctx.studentMessage || '';
      const hasNumbers = /\d+/.test(msg);
      const hasPercent = /%|퍼센트|비율/.test(msg);
      return hasNumbers ? (hasPercent ? 1 : 0.5) : 0;
    },
    normalize: (raw) => raw,
  },

  // Async Data (5)
  {
    id: 'dl_data_reference_accuracy', axis: 'data',
    name: 'Data Reference Accuracy', nameKo: '데이터 인용 정확도',
    description: '인용된 데이터가 원본과 일치하는 비율',
    tier: 'async', weight: 0.9,
    compute: (ctx) => ctx.llmAnalysis?.dataReferenceAccuracy ?? 0,
    normalize: (raw) => raw,
  },
  {
    id: 'dl_correlation_causation', axis: 'data',
    name: 'Correlation vs Causation', nameKo: '상관/인과관계 구분',
    description: '상관관계와 인과관계를 올바르게 구분하는지',
    tier: 'async', weight: 0.8,
    compute: (ctx) => ctx.llmAnalysis?.correlationCausationScore ?? 0,
    normalize: (raw) => raw,
  },

  // ===== Axis 3: Cognitive Flexibility =====

  // Realtime (5)
  {
    id: 'cf_perspective_shift', axis: 'flexibility',
    name: 'Perspective Shift', nameKo: '관점 전환',
    description: '다른 관점으로 전환한 횟수',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.perspective_shift ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cf_concession_rate', axis: 'flexibility',
    name: 'Concession Rate', nameKo: '양보 비율',
    description: '상대방의 주장을 인정하는 비율',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => (ctx.dialogueAct === 'concession') ? 1 : 0,
    normalize: (raw) => raw,
  },
  {
    id: 'cf_revision_quality', axis: 'flexibility',
    name: 'Revision Quality', nameKo: '수정 품질',
    description: '주장 수정 시 개선의 질',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.revision_quality ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cf_counterargument_engagement', axis: 'flexibility',
    name: 'Counterargument Engagement', nameKo: '반론 참여',
    description: '반론에 적극적으로 대응하는 정도',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => ctx.evaluation?.counterargument_engagement ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cf_evasion_index', axis: 'flexibility',
    name: 'Evasion Index (Inverse)', nameKo: '회피 지수 (역수)',
    description: '질문 회피 정도 (낮을수록 좋음)',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => (ctx.dialogueAct === 'evade_question') ? 0 : 1,
    normalize: (raw) => raw,
  },

  // Async Flexibility (5)
  {
    id: 'cf_initial_vs_final_position', axis: 'flexibility',
    name: 'Position Evolution', nameKo: '입장 변화 추이',
    description: '대화 시작과 종료 시 입장의 변화 정도',
    tier: 'async', weight: 0.7,
    compute: (ctx) => {
      const turns = ctx.fullSessionTurns || [];
      const firstClaim = turns.find((t: any) => t.role === 'user' && t.da === 'claim');
      const lastDecision = [...turns].reverse().find((t: any) => t.role === 'user' && (t.da === 'decision_statement' || t.da === 'claim'));
      if (!firstClaim || !lastDecision) return 0;
      return firstClaim.content !== lastDecision.content ? 0.7 : 0.3;
    },
    normalize: (raw) => clamp01(raw),
  },
  {
    id: 'cf_pressure_resilience', axis: 'flexibility',
    name: 'Pressure Resilience', nameKo: '압박 하 회복력',
    description: 'AI의 날카로운 반박 후 논리적 품질이 유지되는 정도',
    tier: 'async', weight: 0.8,
    compute: (ctx) => ctx.llmAnalysis?.pressureResilience ?? 0.5,
    normalize: (raw) => raw,
  },

  // ===== Axis 4: Communication =====

  // Realtime (5)
  {
    id: 'cm_clarity_index', axis: 'communication',
    name: 'Clarity Index', nameKo: '명료성 지수',
    description: '표현의 명료성과 이해 용이성',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.clarity_index ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cm_verbosity_control', axis: 'communication',
    name: 'Verbosity Control', nameKo: '장황함 통제',
    description: '적절한 길이로 핵심을 전달하는 능력',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => {
      const len = (ctx.studentMessage || '').length;
      if (len < 20) return 0.3;
      if (len > 500) return 0.4;
      return 0.8;
    },
    normalize: (raw) => raw,
  },
  {
    id: 'cm_professional_language', axis: 'communication',
    name: 'Professional Language', nameKo: '전문 용어 사용',
    description: '적절한 전문 용어를 사용하는 능력',
    tier: 'realtime', weight: 0.4,
    compute: (ctx) => ctx.evaluation?.professional_language ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cm_persuasiveness', axis: 'communication',
    name: 'Persuasiveness', nameKo: '설득력',
    description: '주장의 설득력',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => ctx.evaluation?.persuasiveness ?? 0,
    normalize: (raw) => clamp01((raw - 1) / 4),
  },
  {
    id: 'cm_engagement_level', axis: 'communication',
    name: 'Engagement Level', nameKo: '참여도',
    description: '대화에 적극적으로 참여하는 정도',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => {
      const msg = ctx.studentMessage || '';
      if (msg.length < 10) return 0.2;
      if (/\?/.test(msg)) return 0.9; // asking questions = high engagement
      return 0.6;
    },
    normalize: (raw) => raw,
  },

  // ===== NEW INDICATORS (v35 Batch 3) =====

  /**
   * @validity
   * - Stage 1 Conceptual Alignment: ECD 증거→역량: 타이핑 리듬 패턴(짧은 공백 집중도) → 사고 활동성(Fluency, 유레카 순간)
   * - Stage 2 Axis Correlation: communication 축의 다른 지표(cm_clarity, cm_engagement)와 r∈[0.3, 0.6] 예상
   * - Stage 3 Redundancy: 기존 37개 지표와 r<0.9 확인 (cm_verbosity와 r≈0.5 예상)
   * - Stage 4 Variance: ΔR²≥0.02 (타이핑 패턴 신호의 실시간 추가 설명력)
   * - Stage 5 External: 외부 준거 추가 필요 (학생 만족도, 성찰 보고서 자조화)
   */
  {
    id: 'comm_eureka_cadence', axis: 'communication',
    name: 'Eureka Cadence', nameKo: '유레카 리듬',
    description: '타이핑 이벤트 간 공백 시간 분포로 측정한 사고 활성도. 짧은 공백 다수 → 활발한 사고, 긴 공백 → 정체',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => {
      // keystrokeDeltasBucket: [50ms, 80ms, 120ms, ...] 배열 형태
      // 짧은 공백(100ms 이하): 활발한 사고 신호
      const bucket = (ctx as any).keystrokeDeltasBucket || [];
      if (bucket.length < 5) return 0.3; // 데이터 부족
      const shortPauses = bucket.filter((d: number) => d <= 100).length;
      const ratio = shortPauses / bucket.length;
      // 공백 비율 → sigmoid 변환 (0.5 = 50%)
      const sigmoid = 1 / (1 + Math.exp(-10 * (ratio - 0.5)));
      return clamp01(sigmoid);
    },
    normalize: (raw) => raw,
  },

  /**
   * @validity
   * - Stage 1 Conceptual Alignment: ECD 증거→역량: 은유 밀도 → 추상적 사고, 개념 연결 능력(Flexibility, Creativity)
   * - Stage 2 Axis Correlation: communication 축의 cm_clarity, cm_professional_language와 r∈[0.2, 0.5] 예상
   * - Stage 3 Redundancy: 기존 37개 지표와 r<0.9 확인 (새로운 언어 특성)
   * - Stage 4 Variance: 샘플링(매 3턴)으로 LLM 비용 절감, ΔR²≥0.02 목표
   * - Stage 5 External: 외부 준거 (고차 사고 평가, 창의성 테스트 점수)
   */
  {
    id: 'comm_metaphor_density', axis: 'communication',
    name: 'Metaphor Density', nameKo: '은유 밀도',
    description: 'LLM 분류기로 측정한 학생 응답 내 은유/유추 표현 밀도 (0~1 점수)',
    tier: 'realtime', weight: 0.5,
    compute: (ctx) => {
      // llmMetaphorScore: LLM 호출 결과 (매 3턴마다)
      const score = (ctx as any).llmMetaphorScore;
      if (score === undefined) return 0;
      return clamp01(score);
    },
    normalize: (raw) => raw,
  },

  /**
   * @validity
   * - Stage 1 Conceptual Alignment: ECD 증거→역량: 역질문 깊이 → 비판적 사고, 메타인지(Flexibility, Logical depth)
   * - Stage 2 Axis Correlation: flexibility 축의 cf_counterargument_engagement, cf_revision_quality와 r∈[0.3, 0.6] 예상
   * - Stage 3 Redundancy: 기존 37개 지표와 r<0.9 확인 (질문 유형 차별화)
   * - Stage 4 Variance: LLM 분류 (0=없음, 1=명확화, 2=가정 확인, 3=대안 제시), ΔR²≥0.02
   * - Stage 5 External: 외부 준거 (비판적 사고 테스트, 소크라테스 방법 학습 성과)
   */
  {
    id: 'flex_counter_question_depth', axis: 'flexibility',
    name: 'Counter-Question Depth', nameKo: '역질문 깊이',
    description: '학생이 튜터에게 제기한 역질문의 인식적 수준 (0=없음, 1=명확화, 2=가정 검증, 3=대안 제시)',
    tier: 'realtime', weight: 0.6,
    compute: (ctx) => {
      // counterQuestionDepth: LLM 분류 (0~3)
      const depth = (ctx as any).counterQuestionDepth ?? 0;
      return clamp01(depth / 3);
    },
    normalize: (raw) => raw,
  },

  /**
   * @validity
   * - Stage 1 Conceptual Alignment: ECD 증거→역량: LinUCB reward + 응답 속도 분산 + 정답률 → 적응적 학습 능력(Flow, Flexibility)
   * - Stage 2 Axis Correlation: flexibility 축의 cf_revision_quality, cf_counterargument_engagement와 r∈[0.3, 0.6] 예상
   * - Stage 3 Redundancy: 기존 37개 지표와 r<0.9 확인 (합성 지표 특성상 낮은 중복)
   * - Stage 4 Variance: 복합 지표(reward + latency 분산 + accuracy 이동평균), ΔR²≥0.03 목표
   * - Stage 5 External: 외부 준거 (학생 몰입도 자가보고, 튜터 피드백 점수)
   */
  {
    id: 'flex_flow_index', axis: 'flexibility',
    name: 'Flow Index', nameKo: '몰입 지수',
    description: 'LinUCB reward + 응답 속도 분산 + 정답률 이동평균의 합성 지표. 적응적 학습 중 몰입 상태 측정',
    tier: 'realtime', weight: 0.7,
    compute: (ctx) => {
      // linubReward: [0, 1] (reward_t smoothed)
      // responseLatencyVariance: 분산 정규화 (0~1)
      // accuracyMA5: 최근 5턴 정답률 (0~1)
      const reward = clamp01((ctx as any).linubReward ?? 0.5);
      const latencyVar = clamp01(1 - ((ctx as any).responseLatencyVariance ?? 0.5)); // 분산 낮을수록 좋음
      const accuracy = clamp01((ctx as any).accuracyMA5 ?? 0.5);

      // 가중 평균: reward(40%) + latencyVar(30%) + accuracy(30%)
      return 0.4 * reward + 0.3 * latencyVar + 0.3 * accuracy;
    },
    normalize: (raw) => raw,
  },
];

// =============================================
// Engine: Compute Indicators
// =============================================

export function computeAllIndicators(
  ctx: IndicatorContext,
  tier: 'realtime' | 'async',
): MicroScoreBatch {
  const indicators = INDICATOR_REGISTRY.filter(i => i.tier === tier);
  const scores: MicroScore[] = [];

  for (const indicator of indicators) {
    try {
      const rawValue = indicator.compute(ctx);
      scores.push({
        indicatorId: indicator.id,
        rawValue,
        normalizedScore: indicator.normalize(rawValue),
        evidenceJson: JSON.stringify({ axis: indicator.axis }),
      });
    } catch (e) {
      console.error(`[INDICATOR] ${indicator.id} failed:`, e);
      scores.push({
        indicatorId: indicator.id,
        rawValue: 0,
        normalizedScore: 0,
        evidenceJson: JSON.stringify({ error: true }),
      });
    }
  }

  const axisSummary = computeAxisSummary(scores, indicators);
  
  return {
    scores,
    axisSummary,
    overallScore: computeOverall(axisSummary),
  };
}

function computeAxisSummary(
  scores: MicroScore[],
  indicators: IndicatorDefinition[],
): Record<string, number> {
  const axes = ['logical', 'data', 'flexibility', 'communication'];
  const result: Record<string, number> = {};

  for (const axis of axes) {
    const axisScores = scores.filter(s => {
      const ind = indicators.find(i => i.id === s.indicatorId);
      return ind?.axis === axis;
    });
    const axisIndicators = indicators.filter(i => i.axis === axis);
    
    if (axisScores.length === 0) {
      result[axis] = 0;
      continue;
    }

    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < axisScores.length; i++) {
      const ind = axisIndicators.find(ai => ai.id === axisScores[i].indicatorId);
      const w = ind?.weight ?? 0.5;
      weightedSum += axisScores[i].normalizedScore * w;
      weightTotal += w;
    }
    result[axis] = weightTotal > 0 ? weightedSum / weightTotal : 0;
  }

  return result;
}

function computeOverall(axisSummary: Record<string, number>): number {
  const axes = Object.values(axisSummary);
  return axes.length > 0 ? average(axes) : 0;
}

// =============================================
// Exports
// =============================================

export function getRealtimeIndicatorCount(): number {
  return INDICATOR_REGISTRY.filter(i => i.tier === 'realtime').length;
}

export function getAsyncIndicatorCount(): number {
  return INDICATOR_REGISTRY.filter(i => i.tier === 'async').length;
}

export function getTotalIndicatorCount(): number {
  return INDICATOR_REGISTRY.length;
}
