// D-Plan: Hint Ladder
// Scaffolding-based hints (NOT information provision)
// H0-H5: Progressive support without giving answers

import type { HintLadderLevel, StudentModel } from './types';

// =============================================
// Hint Level Output Policy
// =============================================
export interface HintOutput {
  level: HintLadderLevel;
  levelName: string;
  instruction: string; // Instruction for AI to follow when generating hint
  example: string;     // Example of appropriate hint
}

// =============================================
// Get Hint Policy for Level
// =============================================
export function getHintPolicy(level: HintLadderLevel): HintOutput {
  const policies: Record<HintLadderLevel, HintOutput> = {
    0: {
      level: 0,
      levelName: '질문만',
      instruction: '힌트 없이 질문만 던지세요. 방향 제시, 예시 금지.',
      example: '당신의 주장을 뒷받침하는 근거를 말해보세요.',
    },
    1: {
      level: 1,
      levelName: '사고 축 제시',
      instruction: '어떤 방향으로 생각해야 하는지 축만 제시하세요. 구체적 장면이나 답은 주지 마세요.',
      example: '그 생각을 뒷받침하는 장면이 있는지부터 떠올려보세요.',
    },
    2: {
      level: 2,
      levelName: '장면 범위 제시',
      instruction: '관련 장면의 범위를 알려주세요. 구체적 문장이나 해석은 주지 마세요.',
      example: '주인공과 여우의 대화 장면을 다시 떠올려보세요.',
    },
    3: {
      level: 3,
      levelName: '핵심 표현 힌트',
      instruction: '텍스트의 핵심 키워드나 표현을 힌트로 주세요. 전체 문장을 인용하지 마세요.',
      example: '"길들인다", "책임진다" 같은 표현이 나온 부분을 기준으로 생각해보세요.',
    },
    4: {
      level: 4,
      levelName: '답변 구조 틀',
      instruction: '답변의 구조 틀을 제시하세요. 내용은 채우지 마세요.',
      example: '"나는 A라고 본다. 왜냐하면 B 장면에서 C가 드러나기 때문이다." 형식으로 답해보세요.',
    },
    5: {
      level: 5,
      levelName: '정답 직전 가이드',
      instruction: '방향을 거의 알려주되 최종 연결은 학생이 하게 하세요.',
      example: '이 해석은 "관계가 생기면 책임도 생긴다"는 방향으로 정리할 수 있습니다. 그 근거 장면을 직접 연결해보세요.',
    },
  };

  return policies[level] || policies[0];
}

// =============================================
// Calculate Effective Hint Level with Safety Guards
// =============================================
export function calculateEffectiveHintLevel(
  model: StudentModel,
  turnNumber: number,
  priorAcceptedRevisionAttempts: number | null = null,
): HintLadderLevel {
  let level = model.helpLevel;

  // Safety: First 2 turns → max H2
  if (turnNumber <= 2) {
    level = Math.min(2, level) as HintLadderLevel;
  }

  // Accepted attempts pace support; UNKNOWN cannot unlock higher scaffolding.
  const attempts = Number.isSafeInteger(priorAcceptedRevisionAttempts) && Number(priorAcceptedRevisionAttempts) >= 0
    ? priorAcceptedRevisionAttempts : null;
  // Preserve H4+ and answer-leakage safeguards without trusting legacy inferences.
  if (level >= 4 && (attempts === null || attempts < 1)) {
    level = 3;
  }

  // Safety: H5 requires at least 2 revision attempts or turn >= 7
  if (level >= 5 && (attempts === null || attempts < 2) && turnNumber < 7) {
    level = 4;
  }

  return level as HintLadderLevel;
}

// =============================================
// Build Hint Prompt for AI
// =============================================
export function buildHintPrompt(
  level: HintLadderLevel,
  topic: string,
  currentClaim: string,
  weaknessDescription: string,
  bookTextSnippet: string,
): string {
  const policy = getHintPolicy(level);

  return `당신은 소크라테스식 독서 토론 튜터입니다.

힌트 레벨: H${level} (${policy.levelName})
규칙: ${policy.instruction}
예시: "${policy.example}"

절대 원칙:
- 정답을 직접 제시하지 마세요.
- 학생이 스스로 찾도록 유도하세요.
- 한국어 존댓말을 사용하세요.
- 최대 2문장으로 작성하세요.

현재 상황:
- 주제: ${topic}
- 학생 주장: ${currentClaim || '아직 없음'}
- 학생 약점: ${weaknessDescription || '없음'}
${level >= 2 ? `\n참고 텍스트:\n${bookTextSnippet.substring(0, 500)}` : ''}

위 규칙에 맞는 힌트 하나를 작성하세요.`;
}

// =============================================
// Should Give Hint (vs normal question)
// =============================================
export function shouldGiveHint(
  action: string,
  helpLevel: HintLadderLevel,
): boolean {
  return action === 'give_hint' || helpLevel >= 3;
}
