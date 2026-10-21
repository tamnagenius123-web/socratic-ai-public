// =============================================
// v17 Micro-Indicator Scoring Engine
// =============================================
// DeepSkill 4축 × 24 지표 실시간 채점
// 학술 근거:
//   - Reed (2023) xAIF 마이크로 분석
//   - Park et al. (2024) Adaptive Socratic Tutor 4-axis competency
//   - Mezza (2024) Dialogue-Act ↔ Argument Relation Classification
//
// BUG-005 Fix: session_micro_scores 테이블에 실제 INSERT 수행
// =============================================

import type { DeepEvaluation } from './types';
import type { DialogueActResult } from './dialogue-act';
import type { AIFGraph, MissingEdge } from '../math/aif-pipeline';
import type { ThoughtProfile } from './thought-profiler';

export interface MicroScore {
  indicatorId: string;
  rawValue: number;
  normalizedScore: number;  // 0-1
  evidenceJson: string;
}

export interface MicroScoreBatch {
  scores: MicroScore[];
  axisSummary: {
    logical: number;
    data: number;
    flexibility: number;
    communication: number;
  };
  overallScore: number;
}

// =============================================
// Main: Compute All Micro-Indicator Scores for a Turn
// =============================================
export function computeMicroScores(input: {
  evaluation: DeepEvaluation;
  dialogueAct?: DialogueActResult;
  aifGraph?: AIFGraph;
  thoughtProfile?: ThoughtProfile;
  studentMessage: string;
  turnNumber: number;
  conversationHistory: { role: string; content: string }[];
  challengeLevel: number;
}): MicroScoreBatch {
  const { evaluation, dialogueAct, aifGraph, thoughtProfile, studentMessage, turnNumber, conversationHistory } = input;
  const scores: MicroScore[] = [];

  // =============================================
  // Axis 1: 논리적 구조화 (Logical Structuring)
  // =============================================

  // ls_claim_clarity — 주장 명확성 (evaluation.claim_clarity 1-5 → 0-1)
  scores.push({
    indicatorId: 'ls_claim_clarity',
    rawValue: evaluation.claim_clarity,
    normalizedScore: clamp01((evaluation.claim_clarity - 1) / 4),
    evidenceJson: JSON.stringify({ source: 'evaluation', claim: evaluation.claim?.substring(0, 100) }),
  });

  // ls_premise_sufficiency — 전제 충분성 (AIF graph에서 premise 노드 비율)
  const premiseNodes = aifGraph?.iNodes.filter(n => n.type === 'premise' && n.author === 'student') || [];
  const claimNodes = aifGraph?.iNodes.filter(n => n.type === 'claim' && n.author === 'student') || [];
  const premiseRatio = claimNodes.length > 0 ? Math.min(1, premiseNodes.length / claimNodes.length) : 0;
  scores.push({
    indicatorId: 'ls_premise_sufficiency',
    rawValue: premiseRatio,
    normalizedScore: premiseRatio,
    evidenceJson: JSON.stringify({ premises: premiseNodes.length, claims: claimNodes.length }),
  });

  // ls_circular_logic — 순환논리 탐지 (AIF missing edges에서 circular_logic 여부)
  const circularFound = aifGraph?.metadata.missingEdges.some(e => e.missingType === 'circular_logic') ? 1 : 0;
  scores.push({
    indicatorId: 'ls_circular_logic',
    rawValue: circularFound,
    normalizedScore: 1 - circularFound,  // 역수: 순환논리 없으면 1.0
    evidenceJson: JSON.stringify({ circularDetected: circularFound === 1 }),
  });

  // ls_hasty_generalization — 성급한 일반화 (절대화 성향에서 추정)
  const absolutist = thoughtProfile?.absolutistTendency || 0;
  scores.push({
    indicatorId: 'ls_hasty_generalization',
    rawValue: absolutist,
    normalizedScore: 1 - clamp01(absolutist),  // 역수
    evidenceJson: JSON.stringify({ absolutistTendency: absolutist }),
  });

  // ls_hidden_assumption — 숨겨진 가정 탐지율 (meta_reasoning DA가 있으면 높음)
  const metaAct = dialogueAct?.act === 'meta_reasoning' ? 1 : 0;
  const implicitAssumptions = evaluation.student_implicit_assumptions?.length || 0;
  scores.push({
    indicatorId: 'ls_hidden_assumption',
    rawValue: metaAct + (implicitAssumptions > 0 ? 0.5 : 0),
    normalizedScore: clamp01(metaAct * 0.6 + (implicitAssumptions > 0 ? 0.4 : 0)),
    evidenceJson: JSON.stringify({ metaReasoning: metaAct, implicitAssumptions }),
  });

  // ls_synthesis_quality — 종합 품질 (reasoning_strength + consistency)
  const synthScore = (evaluation.reasoning_strength + evaluation.consistency) / 10;
  scores.push({
    indicatorId: 'ls_synthesis_quality',
    rawValue: synthScore,
    normalizedScore: clamp01(synthScore),
    evidenceJson: JSON.stringify({ reasoning: evaluation.reasoning_strength, consistency: evaluation.consistency }),
  });

  // =============================================
  // Axis 2: 데이터 리터러시 (Data Literacy)
  // =============================================

  // dl_evidence_density — 근거 밀도
  const evidenceCount = evaluation.evidence_detected?.length || 0;
  scores.push({
    indicatorId: 'dl_evidence_density',
    rawValue: evidenceCount,
    normalizedScore: clamp01(evidenceCount / 3),  // 3개 이상이면 1.0
    evidenceJson: JSON.stringify({ evidenceDetected: evidenceCount }),
  });

  // dl_citation_specificity — 인용 구체성
  const hasCitation = /\d+[쪽페이지장절권편부]|p\.\s*\d+|page\s*\d+|장\s*\d+/i.test(studentMessage);
  const hasQuote = /["""].*["""]|「.*」|『.*』/.test(studentMessage);
  const citSpec = (hasCitation ? 0.6 : 0) + (hasQuote ? 0.4 : 0);
  scores.push({
    indicatorId: 'dl_citation_specificity',
    rawValue: citSpec,
    normalizedScore: clamp01(citSpec),
    evidenceJson: JSON.stringify({ hasCitation, hasQuote }),
  });

  // dl_causal_distinction — 상관-인과 구분
  const hasCausalMarker = /때문에|따라서|왜냐하면|그러므로|인과/.test(studentMessage);
  const hasCorrelMarker = /관련|연관|상관|경향/.test(studentMessage);
  const causalScore = hasCausalMarker && hasCorrelMarker ? 1.0 : hasCausalMarker ? 0.5 : 0;
  scores.push({
    indicatorId: 'dl_causal_distinction',
    rawValue: causalScore,
    normalizedScore: clamp01(causalScore),
    evidenceJson: JSON.stringify({ hasCausalMarker, hasCorrelMarker }),
  });

  // dl_uncertainty_marking — 불확실성 표기
  const uncertaintyMarker = /아마|~일 수|~것 같|추정|가능성|불확실|확실하지 않/.test(studentMessage);
  scores.push({
    indicatorId: 'dl_uncertainty_marking',
    rawValue: uncertaintyMarker ? 1 : 0,
    normalizedScore: uncertaintyMarker ? 0.8 : 0.2,
    evidenceJson: JSON.stringify({ uncertaintyMarked: uncertaintyMarker }),
  });

  // dl_bias_awareness — 데이터 편향 인지
  const biasAware = /편향|선입견|내 관점에서|주관|한쪽 면만/.test(studentMessage);
  scores.push({
    indicatorId: 'dl_bias_awareness',
    rawValue: biasAware ? 1 : 0,
    normalizedScore: biasAware ? 0.9 : 0.1,
    evidenceJson: JSON.stringify({ biasAwareness: biasAware }),
  });

  // dl_quant_reasoning — 정량적 추론
  const quantPattern = /\d+%|\d+명|\d+개|\d+배|\d+\/\d+|통계|수치|비율|백분율/.test(studentMessage);
  scores.push({
    indicatorId: 'dl_quant_reasoning',
    rawValue: quantPattern ? 1 : 0,
    normalizedScore: quantPattern ? 0.8 : 0.1,
    evidenceJson: JSON.stringify({ quantitativePresent: quantPattern }),
  });

  // =============================================
  // Axis 3: 인지적 유연성 (Cognitive Flexibility)
  // =============================================

  // cf_revision_speed — 주장 수정 속도
  const isRevision = dialogueAct?.act === 'revision';
  scores.push({
    indicatorId: 'cf_revision_speed',
    rawValue: isRevision ? 1 : 0,
    normalizedScore: isRevision ? 0.9 : 0.3,
    evidenceJson: JSON.stringify({ isRevision, turnNumber }),
  });

  // cf_counterexample_acceptance — 반례 수용도
  const prevTutorHadCounter = conversationHistory.length > 0 &&
    /반례|반대|예외|만약|그렇다면/.test(conversationHistory[conversationHistory.length - 1]?.content || '');
  const accepted = prevTutorHadCounter && (isRevision || dialogueAct?.act === 'concession');
  scores.push({
    indicatorId: 'cf_counterexample_acceptance',
    rawValue: accepted ? 1 : 0,
    normalizedScore: accepted ? 0.9 : prevTutorHadCounter ? 0.2 : 0.5,
    evidenceJson: JSON.stringify({ prevTutorHadCounter, accepted }),
  });

  // cf_openness_score — 개방성 지수 (binary thinking 역수)
  const openness = 1 - (thoughtProfile?.binaryThinking || 0);
  scores.push({
    indicatorId: 'cf_openness_score',
    rawValue: openness,
    normalizedScore: clamp01(openness),
    evidenceJson: JSON.stringify({ binaryThinking: thoughtProfile?.binaryThinking || 0 }),
  });

  // cf_self_correction — 자기 교정
  const selfCorrected = /수정하겠|바꿔|다시 생각해 보니|틀렸던 것 같|재고하면/.test(studentMessage);
  scores.push({
    indicatorId: 'cf_self_correction',
    rawValue: selfCorrected ? 1 : 0,
    normalizedScore: selfCorrected ? 0.9 : 0.2,
    evidenceJson: JSON.stringify({ selfCorrected }),
  });

  // cf_defense_intensity — 방어적 태도 지수 (역수)
  const defensive = dialogueAct?.act === 'evade_question' || /그건 아니|절대 아니|그건 맞지 않/.test(studentMessage);
  scores.push({
    indicatorId: 'cf_defense_intensity',
    rawValue: defensive ? 1 : 0,
    normalizedScore: defensive ? 0.1 : 0.8,
    evidenceJson: JSON.stringify({ defensive }),
  });

  // cf_alternative_framing — 대안 프레임 생성
  const altFrame = /다른 관점|반대로|한편으로는|다른 시각|alternative|또 다른/.test(studentMessage);
  scores.push({
    indicatorId: 'cf_alternative_framing',
    rawValue: altFrame ? 1 : 0,
    normalizedScore: altFrame ? 0.9 : 0.2,
    evidenceJson: JSON.stringify({ alternativeFraming: altFrame }),
  });

  // =============================================
  // Axis 4: 비즈니스 커뮤니케이션 (Business Communication)
  // =============================================

  // bc_conclusion_first — 결론 선행
  const sentences = studentMessage.split(/[.?!。]+/).filter(s => s.trim().length > 5);
  const firstSentenceHasClaim = sentences.length > 0 && /주장|생각|판단|결론|결과/.test(sentences[0]);
  scores.push({
    indicatorId: 'bc_conclusion_first',
    rawValue: firstSentenceHasClaim ? 1 : 0,
    normalizedScore: firstSentenceHasClaim ? 0.8 : 0.3,
    evidenceJson: JSON.stringify({ conclusionFirst: firstSentenceHasClaim }),
  });

  // bc_mece_compliance — MECE 여부 (중복 없는 구조화)
  const hasMECE = /첫째|둘째|셋째|1\)|2\)|3\)|한편|다른 한편|반면/.test(studentMessage);
  scores.push({
    indicatorId: 'bc_mece_compliance',
    rawValue: hasMECE ? 1 : 0,
    normalizedScore: hasMECE ? 0.8 : 0.2,
    evidenceJson: JSON.stringify({ structuredPoints: hasMECE }),
  });

  // bc_stakeholder_framing — 이해관계자 구조화
  const stakeHolder = /입장에서|관점에서|~에게는|~에 대해/.test(studentMessage);
  scores.push({
    indicatorId: 'bc_stakeholder_framing',
    rawValue: stakeHolder ? 1 : 0,
    normalizedScore: stakeHolder ? 0.8 : 0.2,
    evidenceJson: JSON.stringify({ stakeholderFraming: stakeHolder }),
  });

  // bc_tradeoff_explicit — 트레이드오프 명시
  const tradeoff = /장단점|한계|대신|그러나|반면에|trade.off|장점.*단점|단점.*장점/.test(studentMessage);
  scores.push({
    indicatorId: 'bc_tradeoff_explicit',
    rawValue: tradeoff ? 1 : 0,
    normalizedScore: tradeoff ? 0.8 : 0.2,
    evidenceJson: JSON.stringify({ tradeoffExplicit: tradeoff }),
  });

  // bc_actionability — 실행가능성
  const actionable = /해야|하면 좋겠|실행|구체적으로|행동으로|~하기 위해/.test(studentMessage);
  scores.push({
    indicatorId: 'bc_actionability',
    rawValue: actionable ? 1 : 0,
    normalizedScore: actionable ? 0.7 : 0.2,
    evidenceJson: JSON.stringify({ actionable }),
  });

  // bc_concision — 간결성 (길이 대비 핵심 밀도)
  const wordCount = studentMessage.length;
  const concision = wordCount > 300 ? 0.3 : wordCount > 150 ? 0.6 : wordCount > 30 ? 0.9 : 0.5;
  scores.push({
    indicatorId: 'bc_concision',
    rawValue: wordCount,
    normalizedScore: clamp01(concision),
    evidenceJson: JSON.stringify({ wordCount }),
  });

  // =============================================
  // Axis Summary
  // =============================================
  const axisScores = computeAxisSummary(scores);

  return {
    scores,
    axisSummary: axisScores,
    overallScore: (axisScores.logical + axisScores.data + axisScores.flexibility + axisScores.communication) / 4,
  };
}

function computeAxisSummary(scores: MicroScore[]): { logical: number; data: number; flexibility: number; communication: number } {
  const axisMap: Record<string, string> = {
    ls_: 'logical', dl_: 'data', cf_: 'flexibility', bc_: 'communication',
  };

  const sums: Record<string, { total: number; count: number }> = {
    logical: { total: 0, count: 0 },
    data: { total: 0, count: 0 },
    flexibility: { total: 0, count: 0 },
    communication: { total: 0, count: 0 },
  };

  for (const s of scores) {
    const prefix = s.indicatorId.substring(0, 3);
    const axis = axisMap[prefix];
    if (axis && sums[axis]) {
      sums[axis].total += s.normalizedScore;
      sums[axis].count++;
    }
  }

  return {
    logical: sums.logical.count > 0 ? sums.logical.total / sums.logical.count : 0,
    data: sums.data.count > 0 ? sums.data.total / sums.data.count : 0,
    flexibility: sums.flexibility.count > 0 ? sums.flexibility.total / sums.flexibility.count : 0,
    communication: sums.communication.count > 0 ? sums.communication.total / sums.communication.count : 0,
  };
}

// =============================================
// Persist Micro Scores to D1 (BUG-005 Fix)
// =============================================
export async function persistMicroScores(
  db: D1Database,
  sessionId: string,
  turnNumber: number,
  batch: MicroScoreBatch,
): Promise<void> {
  if (!db) return;
  try {
    for (const score of batch.scores) {
      await db.prepare(
        `INSERT OR REPLACE INTO session_micro_scores
         (session_id, turn_number, indicator_id, raw_value, normalized_score, evidence_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(
        sessionId, turnNumber, score.indicatorId,
        score.rawValue, score.normalizedScore,
        score.evidenceJson, Date.now(),
      ).run().catch(() => {});
    }
  } catch (e) {
    console.warn('[MICRO_SCORE] Persist failed:', e);
  }
}

// =============================================
// Compute Talent Snapshot from Session Scores
// =============================================
export function computeTalentMetrics(axisSummary: {
  logical: number; data: number; flexibility: number; communication: number;
}): {
  hipoScore: number;
  decisionRigorIndex: number;
  revisionMaturity: number;
  evidenceDiscipline: number;
} {
  // Hi-Po Score: weighted composite (DeepSkill formula)
  const hipoScore = (
    axisSummary.logical * 0.30 +
    axisSummary.data * 0.25 +
    axisSummary.flexibility * 0.25 +
    axisSummary.communication * 0.20
  ) * 100;

  // Decision Rigor: logical + data heavy
  const decisionRigorIndex = (axisSummary.logical * 0.5 + axisSummary.data * 0.5) * 100;

  // Revision Maturity: flexibility + communication
  const revisionMaturity = (axisSummary.flexibility * 0.6 + axisSummary.communication * 0.4) * 100;

  // Evidence Discipline: data + logical evidence components
  const evidenceDiscipline = (axisSummary.data * 0.7 + axisSummary.logical * 0.3) * 100;

  return {
    hipoScore: Math.round(hipoScore * 10) / 10,
    decisionRigorIndex: Math.round(decisionRigorIndex * 10) / 10,
    revisionMaturity: Math.round(revisionMaturity * 10) / 10,
    evidenceDiscipline: Math.round(evidenceDiscipline * 10) / 10,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
