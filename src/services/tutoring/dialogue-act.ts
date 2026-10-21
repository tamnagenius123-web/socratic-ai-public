// =============================================
// v16 Dialogue Act Tagger (Mezza ArguNet 기반)
// =============================================
// 학술 근거: Stefano Mezza (2024) "Exploiting Dialogue Acts and Context
//   to Identify Argumentative Relations in Online Debates" — ArgMining 2024
//
// 2단 하이브리드 전략:
//   1단 (Fast Path): 규칙 + 소형 feature → coarse tagging (< 1ms)
//   2단 (Refine Path): ambiguous turn만 LLM JSON 분류 (선택적)
//
// 태그셋 v16 (ISO 24617-2 기반 확장):
//   claim | evidence | rebuttal | counterexample | clarification_request
//   evade_question | revision | concession | meta_reasoning | decision_statement
//   elaboration | question
// =============================================

import { callAIJSON } from '../ai-client';

export interface DialogueActResult {
  act: string;
  confidence: number;
  rationale: string;
  subActs?: string[];  // 복합 발화 시 보조 태그
}

// =============================================
// Fast Path: 규칙 기반 태깅 (< 1ms)
// =============================================
export function fastRuleTag(turn: string, prevTurns?: string[]): DialogueActResult {
  const t = turn.trim();
  const len = t.length;

  // 질문 감지
  if (/\?|인가요|인가\?|할까요|일까\?|은가요|나요\?/.test(t) && len < 80) {
    // 역질문 vs 명확화 요청
    if (/왜|어떻게|무엇|뭐가|그건/.test(t)) {
      return { act: 'question', confidence: 0.85, rationale: 'interrogative_pattern' };
    }
    return { act: 'clarification_request', confidence: 0.80, rationale: 'clarification_pattern' };
  }

  // 회피 감지
  if (/잘 모르겠|다른 이야기|그건 좀|솔직히 잘|넘어가|주제를 바꾸|그것보다/.test(t) && len < 60) {
    return { act: 'evade_question', confidence: 0.85, rationale: 'evasion_markers' };
  }

  // 양보/수정 감지
  if (/맞는 것 같|인정|그 말이 맞|수정하|바꾸|고치|다시 생각하|재고|양보/.test(t)) {
    if (/수정|바꾸|고치|다시 생각/.test(t)) {
      return { act: 'revision', confidence: 0.82, rationale: 'revision_markers' };
    }
    return { act: 'concession', confidence: 0.80, rationale: 'concession_markers' };
  }

  // 반박 감지
  if (/하지만|그러나|그렇지 않|반대로|오히려|틀렸|동의하지 않|반박/.test(t) && len > 20) {
    return { act: 'rebuttal', confidence: 0.78, rationale: 'rebuttal_markers' };
  }

  // 반례 감지
  if (/예를 들어.*반대|반례|예외|만약.*아니|그럼.*어떻게/.test(t)) {
    return { act: 'counterexample', confidence: 0.75, rationale: 'counterexample_pattern' };
  }

  // 메타인지 감지
  if (/나는.*생각했|내가.*판단한|처음에는.*지금은|방금.*깨달|돌이켜 보면/.test(t)) {
    return { act: 'meta_reasoning', confidence: 0.80, rationale: 'metacognition_markers' };
  }

  // 증거 인용 감지
  if (/텍스트|본문|작품|책|에서.*보면|에 따르면|인용|구절|장|절|페이지|에 나오|기록/.test(t) && len > 30) {
    return { act: 'evidence', confidence: 0.82, rationale: 'evidence_citation_pattern' };
  }

  // 결론/의사결정 감지
  if (/결론적으로|따라서|정리하면|결국|최종적으로|판단건대/.test(t)) {
    return { act: 'decision_statement', confidence: 0.78, rationale: 'conclusion_markers' };
  }

  // 상세화 감지 (이전 발화 연장)
  if (/더 자세히|구체적으로|부연하면|추가하면|덧붙이면|말하자면/.test(t)) {
    return { act: 'elaboration', confidence: 0.75, rationale: 'elaboration_markers' };
  }

  // 기본: 주장 (confidence 낮음 → LLM 보정 대상)
  if (len > 30) {
    return { act: 'claim', confidence: 0.55, rationale: 'default_claim_fallback' };
  }

  // 짧은 답변은 불확실
  return { act: 'claim', confidence: 0.40, rationale: 'short_ambiguous' };
}

// =============================================
// Refine Path: LLM 기반 정밀 태깅
// =============================================
export async function refinedLLMTag(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  turn: string,
  prevTurns: string[],
  env?: Record<string, any>,
): Promise<DialogueActResult> {
  const systemPrompt = `당신은 ISO 24617-2 스타일의 대화행위 분류 전문가입니다.
학생의 발화를 분석하여 아래 태그 중 하나를 선택하세요:

- claim: 새로운 주장/의견 제시
- evidence: 텍스트/데이터 근거 인용
- rebuttal: 상대 주장에 대한 반박
- counterexample: 반례 제시
- clarification_request: 명확화/설명 요청
- evade_question: 질문 회피, 주제 전환
- revision: 이전 주장 수정/재구성
- concession: 양보, 상대 의견 수용
- meta_reasoning: 자기 사고 과정 성찰
- decision_statement: 최종 결론/의사결정
- elaboration: 기존 주장 상세화
- question: 역질문

JSON으로만 응답: {"act":"태그","confidence":0.0-1.0,"rationale":"판단 근거"}`;

  const userPrompt = `이전 맥락: ${prevTurns.slice(-3).join(' | ')}
학생 발화: "${turn}"`;

  try {
    return await callAIJSON<DialogueActResult>(
      soongsilApiKey,
      geminiApiKey,
      systemPrompt,
      userPrompt,
      { temperature: 0.1, maxTokens: 150, ...(env ? { env } : {}) },
    );
  } catch (e) { console.error("[P1-004] Caught:", e);
    return fastRuleTag(turn, prevTurns);
  }
}

// =============================================
// Main: 하이브리드 DA 태깅
// =============================================
export async function classifyDialogueAct(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  turn: string,
  prevTurns: string[],
  env?: Record<string, any>,
): Promise<DialogueActResult> {
  // 1단: 규칙 기반 빠른 태깅
  const fast = fastRuleTag(turn, prevTurns);

  // confidence >= 0.80이면 LLM 호출 불필요 (비용 절약)
  if (fast.confidence >= 0.80) return fast;

  // 2단: LLM 정밀 보정 (ambiguous turn만)
  return refinedLLMTag(soongsilApiKey, geminiApiKey, turn, prevTurns, env);
}

// =============================================
// Socratic Pressure Move Selector
// =============================================
// 딥스킬식 "꼬리 물기 압박 질문" 엔진
// 학생의 약한 고리를 잡고 계속 파고드는 상태기계
// =============================================
export type PressureMove =
  | 'evidence_probe'
  | 'warrant_probe'
  | 'counterexample_probe'
  | 'scope_lock'
  | 'revision_push'
  | 'definition_demand';

export function selectPressureMove(input: {
  dialogueAct: string;
  topViolations: string[];
  weakIndicators: string[];
  revisionDebt: number | null;  // null means no attributable measurement
}): PressureMove {
  // 회피 → 범위 잠금 (도망치지 마)
  if (input.dialogueAct === 'evade_question') return 'scope_lock';

  // 근거 없는 주장 → 근거 탐색
  if (input.topViolations.includes('evidence_grounding') ||
      input.topViolations.includes('missing_evidence')) return 'evidence_probe';

  // 추론 보증 부족 → 워런트 탐색
  if (input.topViolations.includes('warrant_explicitness') ||
      input.topViolations.includes('missing_premise')) return 'warrant_probe';

  // 정의 모호 → 정의 요구
  if (input.weakIndicators.includes('ls_claim_clarity') ||
      input.weakIndicators.includes('definitional_vagueness')) return 'definition_demand';

  // 반례 수용 미흡 → 반례 압박
  if (input.weakIndicators.includes('cf_counterexample_acceptance')) return 'counterexample_probe';

  // 수정 부채 높음 → 수정 압박
  if (input.revisionDebt !== null && input.revisionDebt > 0.6) return 'revision_push';

  // 기본: 워런트 탐색 (가장 생산적)
  return 'warrant_probe';
}

export const PRESSURE_TEMPLATES: Record<PressureMove, string> = {
  evidence_probe: '지금 결론을 유지하려면 텍스트나 데이터에서 직접 근거 1개를 집어 설명해 보세요.',
  warrant_probe: '그 근거가 왜 그 결론을 지지하는지, 중간 추론 한 단계를 생략하지 말고 말해 보세요.',
  counterexample_probe: '당신 주장에 가장 치명적인 반례 하나를 스스로 제시해 보세요.',
  scope_lock: '새 질문으로 피하지 말고, 방금 주장의 찬반 입장을 한 문장으로 확정하세요.',
  revision_push: '반례를 반영해 원래 주장을 더 약하지만 더 정확한 형태로 수정해 보세요.',
  definition_demand: '방금 사용한 핵심 용어의 의미를 먼저 정의해 주세요. 정의 없이는 논의를 이어갈 수 없습니다.',
};
