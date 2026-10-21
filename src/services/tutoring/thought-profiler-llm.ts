// =============================================
// v16 LLM-Enhanced Thought Profiler
// =============================================
// G-02 Fix: regex 기반 → LLM 하이브리드
// 전략: fast heuristic 1차 추정 + LLM 보정 2차 추정
// 비용: 추가 ~300-500 토큰 × ~0.01원/turn (ambiguous turn만)
// =============================================

import { callAIJSON } from '../ai-client';
import type { DeepEvaluation } from './types';
import type { ThoughtProfile } from './thought-profiler';

export interface ThoughtSignal {
  absolutist: number;   // 0-1
  binary: number;       // 0-1
  vagueness: number;    // 0-1
  intuition: number;    // 0-1
  revisionReadiness: number;  // 0-1 (v16 추가: 수정 의지)
  evidenceDiscipline: number; // 0-1 (v16 추가: 근거 훈련도)
  reasoning: string;
}

// =============================================
// LLM 보정 실행 조건 판단
// =============================================
export function shouldRunThoughtLLM(
  turnNumber: number,
  studentMessage: string,
  evaluation: DeepEvaluation,
): boolean {
  // 짧은 답변 (모호할 확률 높음)
  if (studentMessage.length < 30 && studentMessage.length > 5) return true;

  // 평가 점수가 극단적 (너무 낮거나 높으면 프로파일링 중요)
  const avgScore = (evaluation.claim_clarity + evaluation.evidence_use +
    evaluation.reasoning_strength + evaluation.consistency + evaluation.relevance) / 5;
  if (avgScore < 2.0 || avgScore > 4.5) return true;

  // 수정 거부 의심 (일관성 낮은데 점수 변동 없음)
  if (evaluation.consistency < 2 && evaluation.relevance > 3) return true;

  // 3턴마다 한 번은 보정 (비용 제어)
  if (turnNumber % 3 === 0) return true;

  return false;
}

// =============================================
// LLM 기반 사고 신호 추론
// =============================================
export async function inferThoughtSignal(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  studentMessage: string,
  contextWindow: string[],
  evaluation: DeepEvaluation,
  env?: Record<string, any>,
): Promise<ThoughtSignal> {
  const systemPrompt = `당신은 교육 심리학 전문 사고 패턴 분석기입니다.

학생의 발화를 분석하여 각 축을 0-1 스케일로 채점하세요:
- absolutist: **맥락을 고려**한 절대화 점수. "모든 사람은 죽는다"=일반 전제(0.1), "항상 이것만이 정답이다"=절대화(0.9)
- binary: **대조 분석**(높은 사고)과 **이분법**(낮은 사고)을 구분
- vagueness: 핵심 용어의 조작적 정의 유무
- intuition: 텍스트 근거 vs 개인 의견 비율
- revisionReadiness: 반론 수용 및 주장 수정 의지 (높을수록 유연)
- evidenceDiscipline: 근거 기반 논증 훈련도 (높을수록 숙련)
- reasoning: 판단 근거 (한 문장)

JSON으로만 응답하세요.`;

  const userPrompt = JSON.stringify({
    studentMessage,
    contextWindow: contextWindow.slice(-4),
    evaluation: {
      weaknessTags: evaluation.weakness_tags || [],
      evidenceUse: evaluation.evidence_use,
      claimClarity: evaluation.claim_clarity,
      reasoningStrength: evaluation.reasoning_strength,
    },
  });

  try {
    return await callAIJSON<ThoughtSignal>(
      soongsilApiKey,
      geminiApiKey,
      systemPrompt,
      userPrompt,
      { temperature: 0.2, maxTokens: 300, ...(env ? { env } : {}) },
    );
  } catch (e) { console.error("[P1-004] Caught:", e);
    // 폴백: 평가 점수에서 역추산
    return {
      absolutist: 0.3,
      binary: 0.3,
      vagueness: evaluation.claim_clarity < 2 ? 0.7 : 0.2,
      intuition: evaluation.evidence_use < 2 ? 0.8 : 0.3,
      revisionReadiness: 0.5,
      evidenceDiscipline: Math.max(0, evaluation.evidence_use / 5),
      reasoning: 'LLM fallback - score-based estimate',
    };
  }
}

// =============================================
// Merge: regex 프로파일 + LLM 신호
// =============================================
const MERGE_WEIGHT = 0.6; // LLM 가중치 (0.6 = LLM 우선)

export function mergeThoughtSignals(
  regexProfile: ThoughtProfile,
  llmSignal: ThoughtSignal | null,
  turnNumber: number,
): ThoughtProfile {
  if (!llmSignal) return regexProfile;

  const w = MERGE_WEIGHT;
  return {
    absolutistTendency: regexProfile.absolutistTendency * (1 - w) + llmSignal.absolutist * w,
    binaryThinking: regexProfile.binaryThinking * (1 - w) + llmSignal.binary * w,
    definitionalVagueness: regexProfile.definitionalVagueness * (1 - w) + llmSignal.vagueness * w,
    intuitionOverText: regexProfile.intuitionOverText * (1 - w) + llmSignal.intuition * w,
    lastUpdatedTurn: turnNumber,
    sampleSize: regexProfile.sampleSize,
  };
}
