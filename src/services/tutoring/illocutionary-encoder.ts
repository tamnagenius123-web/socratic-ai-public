// ============================================================
// v19 Illocutionary Force Encoder + Context-Aware DA Tagger V2
// ============================================================
// 학술 근거:
//   Mezza (2024) "Exploiting Dialogue Acts and Context to Identify
//     Argumentative Relations in Online Debates" — ArgMining 2024
//   Searle (1969) Speech Act Theory
//   ISO 24617-2 Dialogue Act Annotation
//
// v18 개선:
//   1. ISO 24617-2 완전 태그셋 (21개)
//   2. 화용론적 수반력(Illocutionary Force) 분석
//   3. 컨텍스트 벡터 기반 ARC(Argumentative Relation Classification)
//   4. 어텐션 가중치 기반 이전 발화 인코딩
// ============================================================

import type { IllocutionaryForce, ARCProbDistribution } from '../math/xaif-schema';

// =============================================
// ISO 24617-2 기반 완전 DA 태그셋
// =============================================

export type DialogueActISO =
  // Assertive (주장/진술)
  | 'assertion'
  | 'opinion'
  | 'counter_assertion'
  | 'retraction'
  | 'concession'
  // Directive (지시/요청)
  | 'question_yn'
  | 'question_wh'
  | 'request'
  | 'directive'
  // Commissive (약속)
  | 'offer'
  | 'promise'
  // Expressive (감정/태도)
  | 'thanking'
  | 'apology'
  | 'evaluation_positive'
  | 'evaluation_negative'
  // Meta-communicative
  | 'clarification_request'
  | 'elaboration'
  | 'meta_reasoning'
  // Socratic 확장 (SocraticAI 도메인)
  | 'evade_question'
  | 'challenge_evidence'
  | 'claim_revision'
  | 'self_correction';

export type IllocutionaryCategory =
  | 'assertive'
  | 'directive'
  | 'commissive'
  | 'expressive'
  | 'declarative';

// =============================================
// 컨텍스트 벡터 (ArguNet 어텐션 메커니즘)
// =============================================

export interface DialogueContextVector {
  prevDATags: number[];             // 최근 5턴 DA 태그 벡터 (14차원)
  avgIllocutionaryStrength: number;
  challengePressureIndex: number;   // 튜터의 도전 압력
  revisionTendency: number;        // 0=유지, 1=수정
  currentState: string;
  turnProgress: number;            // turnNumber / maxTurns
}

export function buildDialogueContextVector(
  prevTurns: { role: string; content: string; daTag?: string }[],
  currentState: string,
  turnNumber: number,
  maxTurns: number,
): DialogueContextVector {
  const DA_TAG_MAP: Record<string, number> = {
    'assertion': 0, 'opinion': 1, 'counter_assertion': 2, 'retraction': 3,
    'concession': 4, 'question_yn': 5, 'question_wh': 6, 'request': 7,
    'elaboration': 8, 'meta_reasoning': 9, 'evade_question': 10,
    'challenge_evidence': 11, 'claim_revision': 12, 'self_correction': 13,
  };

  const recentTurns = prevTurns.slice(-5);
  const prevDATags = new Array(14).fill(0);

  let challengePressure = 0;
  let revisionCount = 0;
  let totalWeight = 0;

  recentTurns.forEach((turn, idx) => {
    const weight = (idx + 1) / recentTurns.length; // 최근일수록 높은 가중치
    totalWeight += weight;

    if (turn.daTag && DA_TAG_MAP[turn.daTag] !== undefined) {
      prevDATags[DA_TAG_MAP[turn.daTag]] += weight;
    }

    if (turn.role === 'assistant' && /반례|도전|반박|왜|근거|그렇다면/.test(turn.content)) {
      challengePressure += weight;
    }

    if (turn.daTag === 'claim_revision' || turn.daTag === 'retraction') {
      revisionCount++;
    }
  });

  if (totalWeight > 0) {
    for (let i = 0; i < prevDATags.length; i++) {
      prevDATags[i] /= totalWeight;
    }
    challengePressure /= totalWeight;
  }

  return {
    prevDATags,
    avgIllocutionaryStrength: prevDATags.reduce((a: number, b: number) => a + b, 0) / Math.max(1, prevDATags.length),
    challengePressureIndex: challengePressure,
    revisionTendency: recentTurns.length > 0 ? revisionCount / recentTurns.length : 0,
    currentState,
    turnProgress: turnNumber / maxTurns,
  };
}

// =============================================
// 화용론적 수반력 분석기
// =============================================

export function analyzeIllocutionaryForce(
  text: string,
  daTag: DialogueActISO,
): IllocutionaryForce {
  // 완충 표현 탐지
  const hedgingPattern = /아마|것 같|~일 수|추정|가능성|불확실|아닐 수도/;
  const hedging = hedgingPattern.test(text) ? 0.7 : 0.1;

  // 확신 수준
  const certaintyHigh = /반드시|확실히|분명히|틀림없이|당연히/.test(text);
  const certaintyLow = hedgingPattern.test(text) || /아마도|혹시|어쩌면/.test(text);
  const certainty = certaintyHigh ? 0.9 : certaintyLow ? 0.2 : 0.5;

  // 극성
  const negativeWords = /아니|없|부족|잘못|오류|틀렸|반대|거부/.test(text);
  const positiveWords = /맞|옳|동의|수용|좋|올바|인정/.test(text);
  const polarity: 'positive' | 'negative' | 'neutral' = negativeWords ? 'negative' : positiveWords ? 'positive' : 'neutral';

  // 카테고리 + 강도 결정
  const categoryMap: Record<DialogueActISO, { cat: IllocutionaryCategory; strength: number }> = {
    'assertion': { cat: 'assertive', strength: 0.8 },
    'opinion': { cat: 'assertive', strength: 0.5 },
    'counter_assertion': { cat: 'assertive', strength: 0.9 },
    'retraction': { cat: 'assertive', strength: 0.3 },
    'concession': { cat: 'assertive', strength: 0.4 },
    'question_yn': { cat: 'directive', strength: 0.6 },
    'question_wh': { cat: 'directive', strength: 0.7 },
    'request': { cat: 'directive', strength: 0.8 },
    'directive': { cat: 'directive', strength: 0.9 },
    'offer': { cat: 'commissive', strength: 0.6 },
    'promise': { cat: 'commissive', strength: 0.8 },
    'thanking': { cat: 'expressive', strength: 0.5 },
    'apology': { cat: 'expressive', strength: 0.6 },
    'evaluation_positive': { cat: 'expressive', strength: 0.7 },
    'evaluation_negative': { cat: 'expressive', strength: 0.7 },
    'clarification_request': { cat: 'directive', strength: 0.6 },
    'elaboration': { cat: 'assertive', strength: 0.4 },
    'meta_reasoning': { cat: 'assertive', strength: 0.6 },
    'evade_question': { cat: 'assertive', strength: 0.3 },
    'challenge_evidence': { cat: 'directive', strength: 0.9 },
    'claim_revision': { cat: 'assertive', strength: 0.5 },
    'self_correction': { cat: 'assertive', strength: 0.6 },
  };

  const mapping = categoryMap[daTag] || { cat: 'assertive' as IllocutionaryCategory, strength: 0.5 };

  return {
    category: mapping.cat,
    strength: Math.round((mapping.strength * (1 - hedging * 0.3)) * 1000) / 1000,
    certainty,
    polarity,
    hedging,
  };
}

// =============================================
// ARC 분류 (Argumentative Relation Classification)
// Mezza (2024): DA 태그 + 컨텍스트 → 논증 관계
// =============================================

/**
 * v18 Legacy ARC (규칙 기반 — 하위 호환용)
 */
export function inferARCFromContext(
  act: DialogueActISO,
  context: DialogueContextVector,
): { relation: 'support' | 'attack' | 'neutral'; confidence: number } {
  // v19에서는 확률적 ARC를 우선 사용하되 fallback으로 유지
  const prob = inferARCProbabilistic(act, context, analyzeIllocutionaryForce('', act));
  return { relation: prob.selected, confidence: Math.max(prob.support, prob.attack, prob.neutral) };
}

// =============================================
// v19: 확률적 ARC 분류기 (Softmax 기반)
// Mezza (2024) ArguNet 근사 구현
// =============================================

const DA_LIST: DialogueActISO[] = [
  'assertion','opinion','counter_assertion','retraction','concession',
  'question_yn','question_wh','request','directive','offer','promise',
  'thanking','apology','evaluation_positive','evaluation_negative',
  'clarification_request','elaboration','meta_reasoning',
  'evade_question','challenge_evidence','claim_revision',
];

/**
 * 32차원 특성 벡터 구성: DA one-hot(21) + context(6) + illocutionary(5) = 32
 */
function buildARCFeatureVector(
  act: DialogueActISO,
  context: DialogueContextVector,
  illoForce: IllocutionaryForce,
): number[] {
  const daOneHot = new Array(21).fill(0);
  const idx = DA_LIST.indexOf(act);
  if (idx >= 0) daOneHot[idx] = 1;

  return [
    ...daOneHot,                              // 21차원
    context.challengePressureIndex,            // 1
    context.revisionTendency,                  // 1
    context.turnProgress,                      // 1
    context.avgIllocutionaryStrength,          // 1
    illoForce.strength,                        // 1
    illoForce.certainty,                       // 1
    illoForce.hedging,                         // 1
    illoForce.polarity === 'negative' ? 1 : 0, // 1
    illoForce.polarity === 'positive' ? 1 : 0, // 1
    illoForce.category === 'assertive' ? 1 : 0, // 1
    illoForce.category === 'directive' ? 1 : 0, // 1
  ]; // 총 32차원
}

// 학습된 가중치 (초기값: 휴리스틱 기반)
const ARC_WEIGHTS = {
  support: new Array(32).fill(0),
  attack: new Array(32).fill(0),
  neutral: new Array(32).fill(0),
};
// 초기 휴리스틱 가중치 설정
ARC_WEIGHTS.attack[2] = 2.0;  // counter_assertion
ARC_WEIGHTS.attack[18] = 1.5; // evade_question
ARC_WEIGHTS.attack[19] = 2.5; // challenge_evidence
ARC_WEIGHTS.attack[21] = 1.0; // challengePressureIndex 높으면 attack 가능성 높음
ARC_WEIGHTS.support[3] = 1.5;  // retraction
ARC_WEIGHTS.support[4] = 1.5;  // concession
ARC_WEIGHTS.support[20] = 2.0; // claim_revision
ARC_WEIGHTS.support[22] = 1.5; // revisionTendency
ARC_WEIGHTS.neutral[0] = 0.5;  // assertion은 neutral 경향
ARC_WEIGHTS.neutral[1] = 0.5;  // opinion은 neutral 경향
ARC_WEIGHTS.neutral[16] = 0.8; // elaboration은 neutral

function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxLogit));
  const sumExps = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sumExps);
}

function shannonEntropy(probs: number[]): number {
  return -probs.reduce((sum, p) =>
    p > 0 ? sum + p * Math.log2(p) : sum, 0
  );
}

/**
 * v19 확률적 ARC 분류: DA + Context + Illocutionary Force → Softmax
 * Mezza (2024): 확률 분포로 불확실성 표현
 */
export function inferARCProbabilistic(
  act: DialogueActISO,
  context: DialogueContextVector,
  illoForce: IllocutionaryForce,
): ARCProbDistribution {
  const features = buildARCFeatureVector(act, context, illoForce);

  const logits = [
    features.reduce((sum, f, i) => sum + f * ARC_WEIGHTS.support[i], 0),
    features.reduce((sum, f, i) => sum + f * ARC_WEIGHTS.attack[i], 0),
    features.reduce((sum, f, i) => sum + f * ARC_WEIGHTS.neutral[i], 0),
  ];

  const probs = softmax(logits);
  const [pSupport, pAttack, pNeutral] = probs;
  const entropy = shannonEntropy(probs);

  const selected = pSupport >= pAttack && pSupport >= pNeutral ? 'support'
    : pAttack >= pNeutral ? 'attack' : 'neutral';

  return {
    support: Math.round(pSupport * 1000) / 1000,
    attack: Math.round(pAttack * 1000) / 1000,
    neutral: Math.round(pNeutral * 1000) / 1000,
    selected,
    entropy: Math.round(entropy * 1000) / 1000,
  };
}

// =============================================
// v20 P0-E: Adapter-aware ARC Inference Path
// OpenDebateEvidence / LoRA adapter 연동 파이프라인
// =============================================

export interface ARCAdapterPrediction {
  support: number;
  attack: number;
  neutral: number;
  adapterId: string;
  source: 'adapter' | 'heuristic';
}

/**
 * v20 P0-E: adapter-aware ARC inference
 * 외부 adapter inference endpoint가 설정되면 그것을 사용하고,
 * 없으면 기존 heuristic softmax로 fallback
 */
export async function inferARCWithAdapter(
  payload: {
    act: DialogueActISO;
    context: DialogueContextVector;
    illoForce: IllocutionaryForce;
    utterance: string;
  },
  env: { ARGUNET_ADAPTER_URL?: string; ARGUNET_ADAPTER_TOKEN?: string },
): Promise<ARCAdapterPrediction> {
  // Adapter URL이 설정되지 않았으면 heuristic fallback
  if (!env.ARGUNET_ADAPTER_URL) {
    const h = inferARCProbabilistic(payload.act, payload.context, payload.illoForce);
    return { ...h, adapterId: 'heuristic-v19', source: 'heuristic' };
  }

  try {
    const res = await fetch(env.ARGUNET_ADAPTER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.ARGUNET_ADAPTER_TOKEN ? { authorization: `Bearer ${env.ARGUNET_ADAPTER_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        act: payload.act,
        context: {
          challengePressureIndex: payload.context.challengePressureIndex,
          revisionTendency: payload.context.revisionTendency,
          turnProgress: payload.context.turnProgress,
        },
        illocutionaryForce: payload.illoForce,
        utterance: payload.utterance.substring(0, 500),
      }),
    });

    if (!res.ok) {
      console.warn(`[ARC_ADAPTER] HTTP ${res.status}, falling back to heuristic`);
      const h = inferARCProbabilistic(payload.act, payload.context, payload.illoForce);
      return { ...h, adapterId: 'heuristic-fallback', source: 'heuristic' };
    }

    const result = await res.json() as { support: number; attack: number; neutral: number; adapterId?: string };
    return {
      support: result.support || 0.33,
      attack: result.attack || 0.33,
      neutral: result.neutral || 0.34,
      adapterId: result.adapterId || 'external-adapter',
      source: 'adapter',
    };
  } catch (e) {
    console.warn('[ARC_ADAPTER] Fetch failed, falling back to heuristic:', e);
    const h = inferARCProbabilistic(payload.act, payload.context, payload.illoForce);
    return { ...h, adapterId: 'heuristic-error-fallback', source: 'heuristic' };
  }
}

// =============================================
// ISO → Legacy DA 태그 매핑 (하위 호환)
// =============================================

export function mapToLegacyAct(isoAct: DialogueActISO): string {
  const mapping: Record<DialogueActISO, string> = {
    'assertion': 'claim',
    'opinion': 'claim',
    'counter_assertion': 'counterexample',
    'retraction': 'revision',
    'concession': 'concession',
    'question_yn': 'clarification_request',
    'question_wh': 'question',
    'request': 'clarification_request',
    'directive': 'clarification_request',
    'offer': 'meta_reasoning',
    'promise': 'meta_reasoning',
    'thanking': 'elaboration',
    'apology': 'elaboration',
    'evaluation_positive': 'claim',
    'evaluation_negative': 'rebuttal',
    'clarification_request': 'clarification_request',
    'elaboration': 'elaboration',
    'meta_reasoning': 'meta_reasoning',
    'evade_question': 'evade_question',
    'challenge_evidence': 'rebuttal',
    'claim_revision': 'revision',
    'self_correction': 'revision',
  };
  return mapping[isoAct] || isoAct;
}

// =============================================
// v2 DialogueActResult (확장형)
// =============================================

export interface DialogueActResultV2 {
  act: DialogueActISO;
  legacyAct: string;
  confidence: number;
  source: 'fast_rule' | 'llm';
  illocutionaryForce: IllocutionaryForce;
  contextVector: DialogueContextVector;
  arcClassification?: {
    relation: 'support' | 'attack' | 'neutral';
    confidence: number;
  };
  // v19: 확률적 ARC 분포
  arcProbDistribution?: ARCProbDistribution;
}

// =============================================
// v2 Fast Rule Tagger (ISO 24617-2 완전 태그셋)
// =============================================

function fastRuleTagV2(
  text: string,
  context: DialogueContextVector,
): { act: DialogueActISO; confidence: number; source: 'fast_rule' } {
  const t = text.trim();

  // 자기교정
  if (/수정하겠|바꿔|다시 생각해 보니|틀렸던 것 같|재고하면/.test(t)) {
    return { act: 'self_correction', confidence: 0.95, source: 'fast_rule' };
  }
  // 회피
  if (/그건 다른 문제|주제가 다르|관련 없|그건 제 얘기가 아닌|넘어가|잘 모르겠/.test(t)) {
    return { act: 'evade_question', confidence: 0.90, source: 'fast_rule' };
  }
  // 반례 도전
  if (/반례|그렇다면 왜|예외가|모순/.test(t)) {
    return { act: 'counter_assertion', confidence: 0.88, source: 'fast_rule' };
  }
  // 메타 인지
  if (/내 논리에서|내가 생각하는 방식|사고 과정|논증 구조|돌이켜 보면/.test(t)) {
    return { act: 'meta_reasoning', confidence: 0.87, source: 'fast_rule' };
  }
  // 양보/수정
  if (/맞는 것 같|인정|그 말이 맞|양보/.test(t)) {
    return { act: 'concession', confidence: 0.85, source: 'fast_rule' };
  }
  if (/수정|바꾸|고치|다시 생각/.test(t)) {
    return { act: 'claim_revision', confidence: 0.85, source: 'fast_rule' };
  }
  // 반박
  if (/하지만|그러나|그렇지 않|반대로|오히려|틀렸|동의하지 않|반박/.test(t) && t.length > 20) {
    return { act: 'counter_assertion', confidence: 0.82, source: 'fast_rule' };
  }
  // 질문 (Y/N vs WH)
  if (/\?|인가요|인가\?|할까요|일까\?|은가요|나요\?/.test(t) && t.length < 80) {
    if (/왜|어떻게|무엇|뭐가|어떤|언제|어디/.test(t)) {
      return { act: 'question_wh', confidence: 0.86, source: 'fast_rule' };
    }
    return { act: 'question_yn', confidence: 0.84, source: 'fast_rule' };
  }
  // 증거 인용
  if (/텍스트|본문|작품|책|에서.*보면|에 따르면|인용|구절|페이지/.test(t) && t.length > 30) {
    return { act: 'assertion', confidence: 0.83, source: 'fast_rule' };
  }
  // 결론
  if (/결론적으로|따라서|정리하면|결국|최종적으로/.test(t)) {
    return { act: 'assertion', confidence: 0.82, source: 'fast_rule' };
  }
  // 상세화
  if (/더 자세히|구체적으로|부연하면|추가하면|덧붙이면/.test(t)) {
    return { act: 'elaboration', confidence: 0.80, source: 'fast_rule' };
  }

  // 기본: 주장
  return { act: 'assertion', confidence: t.length > 30 ? 0.55 : 0.40, source: 'fast_rule' };
}

/**
 * Deterministic fallback used by the tutoring hot path when the optional
 * dialogue-act refinement lane is unavailable. It deliberately carries its
 * source as `fast_rule` rather than presenting an unverified LLM judgment.
 */
export function classifyDialogueActV2RuleBased(
  studentMessage: string,
  prevTurns: { role: string; content: string; daTag?: string }[],
  currentState: string,
  turnNumber: number,
  maxTurns: number = 10,
): DialogueActResultV2 {
  const contextVector = buildDialogueContextVector(prevTurns, currentState, turnNumber, maxTurns);
  const fastResult = fastRuleTagV2(studentMessage, contextVector);
  const illocutionaryForce = analyzeIllocutionaryForce(studentMessage, fastResult.act);
  const arcProbDistribution = inferARCProbabilistic(fastResult.act, contextVector, illocutionaryForce);
  return {
    act: fastResult.act,
    legacyAct: mapToLegacyAct(fastResult.act),
    confidence: fastResult.confidence,
    source: 'fast_rule',
    illocutionaryForce,
    contextVector,
    arcClassification: {
      relation: arcProbDistribution.selected,
      confidence: Math.max(arcProbDistribution.support, arcProbDistribution.attack, arcProbDistribution.neutral),
    },
    arcProbDistribution,
  };
}

// =============================================
// v2 하이브리드 DA 분류기 (Main Entry)
// =============================================

export async function classifyDialogueActV2(
  apiKey: string,
  geminiApiKey: string | undefined,
  studentMessage: string,
  prevTurns: { role: string; content: string; daTag?: string }[],
  currentState: string,
  turnNumber: number,
  maxTurns: number = 10,
): Promise<DialogueActResultV2> {
  // Step 1: 컨텍스트 벡터
  const contextVector = buildDialogueContextVector(prevTurns, currentState, turnNumber, maxTurns);

  // Step 2: Fast Rule
  const fastResult = fastRuleTagV2(studentMessage, contextVector);

  if (fastResult.confidence >= 0.85) {
    const illoForce = analyzeIllocutionaryForce(studentMessage, fastResult.act);
    const arcProb = inferARCProbabilistic(fastResult.act, contextVector, illoForce);
    return {
      act: fastResult.act,
      legacyAct: mapToLegacyAct(fastResult.act),
      confidence: fastResult.confidence,
      source: 'fast_rule',
      illocutionaryForce: illoForce,
      contextVector,
      arcClassification: { relation: arcProb.selected, confidence: Math.max(arcProb.support, arcProb.attack, arcProb.neutral) },
      arcProbDistribution: arcProb,
    };
  }

  // Step 3: LLM Refine (ambiguous case)
  try {
    const { callAIJSON } = await import('../ai-client');
    const systemPrompt = `You are a dialogue act classifier following ISO 24617-2 and Mezza (2024) ArguNet specifications.
Classify the student utterance considering:
1. Illocutionary force (assertive/directive/commissive/expressive)
2. Dialogue context (revision tendency: ${contextVector.revisionTendency.toFixed(2)}, challenge pressure: ${contextVector.challengePressureIndex.toFixed(2)})
3. Return ONLY JSON: {"act": "<ISO_ACT>", "confidence": 0.0-1.0}
Valid acts: assertion, opinion, counter_assertion, retraction, concession, question_yn, question_wh, request, elaboration, meta_reasoning, evade_question, challenge_evidence, claim_revision, self_correction`;

    const result = await callAIJSON<{ act: string; confidence: number }>(
      apiKey, geminiApiKey, systemPrompt,
      `Previous context: ${JSON.stringify(prevTurns.slice(-2).map(t => ({ role: t.role, content: t.content.substring(0, 80) })))}\nStudent: "${studentMessage.substring(0, 300)}"`,
      { temperature: 0.1, maxTokens: 100 },
    );

    const act = (result.act as DialogueActISO) || 'assertion';
    const illoForce = analyzeIllocutionaryForce(studentMessage, act);
    const arcProb = inferARCProbabilistic(act, contextVector, illoForce);
    return {
      act,
      legacyAct: mapToLegacyAct(act),
      confidence: result.confidence || 0.6,
      source: 'llm',
      illocutionaryForce: illoForce,
      contextVector,
      arcClassification: { relation: arcProb.selected, confidence: Math.max(arcProb.support, arcProb.attack, arcProb.neutral) },
      arcProbDistribution: arcProb,
    };
  } catch (e) { console.error("[P1-004] Caught:", e);
    // LLM 실패 시 Fast Rule 결과 반환
    const illoForce = analyzeIllocutionaryForce(studentMessage, fastResult.act);
    return {
      act: fastResult.act,
      legacyAct: mapToLegacyAct(fastResult.act),
      confidence: fastResult.confidence,
      source: 'fast_rule',
      illocutionaryForce: illoForce,
      contextVector,
    };
  }
}
