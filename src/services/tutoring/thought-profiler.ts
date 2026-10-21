// v14.0: Thought Profiler — 학생 사고 성향 4축 추적
// 절대화(absolutist), 이분법(binary), 정의모호(vagueness), 직관우선(intuition)
// EMA(지수 이동 평균)으로 턴별 갱신 → 프롬프트에 반영

import type { DeepEvaluation } from './types';

// =============================================
// Interfaces
// =============================================
export interface ThoughtProfile {
  absolutistTendency: number;       // 0-1: "항상", "절대" 등 절대화 빈도
  binaryThinking: number;           // 0-1: 이분법적 사고 빈도
  definitionalVagueness: number;    // 0-1: 핵심 용어 미정의 빈도
  intuitionOverText: number;        // 0-1: 텍스트 근거 없이 직관 의존 빈도
  lastUpdatedTurn: number;
  sampleSize: number;               // 누적 측정 턴 수
}

// =============================================
// Factory
// =============================================
export function createDefaultThoughtProfile(): ThoughtProfile {
  return {
    absolutistTendency: 0,
    binaryThinking: 0,
    definitionalVagueness: 0,
    intuitionOverText: 0,
    lastUpdatedTurn: 0,
    sampleSize: 0,
  };
}

// =============================================
// Core Update (EMA)
// =============================================
const EMA_ALPHA = 0.3; // 최근 턴에 가중치

function ema(prev: number, newVal: number, alpha: number): number {
  return alpha * newVal + (1 - alpha) * prev;
}

/**
 * 학생 발화와 평가 결과를 분석하여 사고 프로파일 업데이트
 */
export function updateThoughtProfile(
  current: ThoughtProfile,
  studentMessage: string,
  evaluation: DeepEvaluation,
  turnNumber: number,
): ThoughtProfile {
  const absolutistScore = detectAbsolutistLanguage(studentMessage);
  const binaryScore = detectBinaryThinking(studentMessage);
  const vaguenessScore = detectDefinitionalVagueness(studentMessage, evaluation);
  const intuitionScore = detectIntuitionOverText(evaluation);

  // 첫 턴이면 초기값으로 직접 설정
  if (current.sampleSize === 0) {
    return {
      absolutistTendency: absolutistScore,
      binaryThinking: binaryScore,
      definitionalVagueness: vaguenessScore,
      intuitionOverText: intuitionScore,
      lastUpdatedTurn: turnNumber,
      sampleSize: 1,
    };
  }

  return {
    absolutistTendency: ema(current.absolutistTendency, absolutistScore, EMA_ALPHA),
    binaryThinking: ema(current.binaryThinking, binaryScore, EMA_ALPHA),
    definitionalVagueness: ema(current.definitionalVagueness, vaguenessScore, EMA_ALPHA),
    intuitionOverText: ema(current.intuitionOverText, intuitionScore, EMA_ALPHA),
    lastUpdatedTurn: turnNumber,
    sampleSize: current.sampleSize + 1,
  };
}

// =============================================
// Detection Functions
// =============================================

function detectAbsolutistLanguage(message: string): number {
  const totalChars = message.length;
  if (totalChars < 10) return 0;

  const absolutistPatterns = [
    /항상|언제나|절대|반드시|모든|전부|전혀|절대로|무조건|틀림없이/g,
    /누구나|어디서나|언제든|아무도|전혀 없/g,
  ];

  let matchCount = 0;
  for (const pattern of absolutistPatterns) {
    const matches = message.match(pattern);
    matchCount += matches ? matches.length : 0;
  }

  // 정규화: 100자당 절대화 표현 수 → 0-1 스케일
  return Math.min(1, matchCount / (totalChars / 100) * 0.3);
}

function detectBinaryThinking(message: string): number {
  const binaryPatterns = [
    /아니면|둘 중 하나|이거 아니면|맞거나 틀리거나|흑백|양자택일/g,
    /좋거나 나쁘거나|옳거나 그르거나|맞든 틀리든/g,
  ];

  let score = 0;
  for (const pattern of binaryPatterns) {
    if (pattern.test(message)) score += 0.3;
    // Reset lastIndex for reuse
    pattern.lastIndex = 0;
  }

  // "하지만", "그러나", "다만" 등 양보절이 있으면 감점 (뉘앙스 있는 사고)
  const nuanceMarkers = /하지만|그러나|다만|반면|한편|물론|어느 정도|때에 따라/g;
  const nuanceCount = (message.match(nuanceMarkers) || []).length;
  score -= nuanceCount * 0.15;

  return Math.max(0, Math.min(1, score));
}

function detectDefinitionalVagueness(
  message: string,
  evaluation: DeepEvaluation,
): number {
  // 평가기가 정의 부족/추상어 과다를 지적한 경우
  const tags = evaluation.weakness_tags || [];
  if (tags.includes('추상어 과다')) return 0.8;
  if (evaluation.claim_clarity < 2) return 0.6;
  if (evaluation.reasoning_gap?.includes('정의')) return 0.5;
  // 짧은 답변에서 핵심 용어가 없으면 vague
  if (message.length < 30 && evaluation.claim_clarity <= 2) return 0.4;
  return 0.1;
}

function detectIntuitionOverText(evaluation: DeepEvaluation): number {
  const tags = evaluation.weakness_tags || [];
  if (tags.includes('텍스트 미참조')) return 0.9;
  if (tags.includes('근거 부족')) return 0.7;
  if (evaluation.evidence_use < 2) return 0.7;
  if ((evaluation.evidence_detected || []).length === 0) return 0.6;
  return Math.max(0, 1 - evaluation.evidence_use / 5);
}

// =============================================
// Prompt Injection
// =============================================

/**
 * ThoughtProfile을 프롬프트 주입 텍스트로 변환
 * sampleSize < 2이면 데이터 부족으로 비삽입
 */
export function formatThoughtProfileForPrompt(profile: ThoughtProfile): string {
  if (profile.sampleSize < 2) return '';

  const insights: string[] = [];

  if (profile.absolutistTendency > 0.5) {
    insights.push('절대화 성향 높음 → "예외가 있을 수 있는지" 방향의 질문이 효과적');
  }
  if (profile.binaryThinking > 0.5) {
    insights.push('이분법적 사고 → "제3의 가능성"이나 "스펙트럼"으로 유도');
  }
  if (profile.definitionalVagueness > 0.5) {
    insights.push('정의 생략 성향 → 핵심 용어 정의를 먼저 요구');
  }
  if (profile.intuitionOverText > 0.6) {
    insights.push('직관 우선 → 텍스트 근거를 반드시 요구하는 질문 사용');
  }

  if (insights.length === 0) return '';

  return `\n## 학생 사고 성향 분석 (ThoughtProfile)\n${insights.map(i => `- ${i}`).join('\n')}\n위 성향을 고려하여 이번 턴의 질문을 조정하세요.\n`;
}

/**
 * ThoughtProfile을 디버그 요약 문자열로 변환
 */
export function summarizeThoughtProfile(profile: ThoughtProfile): string {
  if (profile.sampleSize === 0) return 'no_data';
  const parts: string[] = [];
  if (profile.absolutistTendency > 0.4) parts.push(`abs=${(profile.absolutistTendency * 100).toFixed(0)}%`);
  if (profile.binaryThinking > 0.4) parts.push(`bin=${(profile.binaryThinking * 100).toFixed(0)}%`);
  if (profile.definitionalVagueness > 0.4) parts.push(`vag=${(profile.definitionalVagueness * 100).toFixed(0)}%`);
  if (profile.intuitionOverText > 0.4) parts.push(`int=${(profile.intuitionOverText * 100).toFixed(0)}%`);
  return parts.length > 0 ? parts.join(',') : 'balanced';
}
