// v12.0: Metacognition Coach (DEVELOP 확장 기능 4 - 메타인지 코칭 레이어)
// 학생이 자신의 사고 과정 자체를 반성하도록 유도하는 메타인지 질문을 주기적으로 삽입

import type { QuestionLayer, LayerState } from './question-layer-tracker';

export interface MetacognitionContext {
  initialClaim: string;
  currentClaim: string;
  currentLayer: QuestionLayer;
  turnNumber: number;
  layerState: LayerState;
}

/**
 * 메타인지 개입 시점 판단
 * 매 턴이 아니라, 특정 조건에서만 발동
 */
export function shouldInjectMetacognition(
  turnNumber: number,
  layerState: LayerState,
  initialClaim: string,
  currentClaim: string,
): boolean {
  // 1. 레이어 전환 직후 (새 깊이에 진입했을 때)
  const justTransitioned =
    layerState.layerHistory.length >= 2 &&
    layerState.layerHistory[layerState.layerHistory.length - 1] !==
    layerState.layerHistory[layerState.layerHistory.length - 2];

  // 2. 3턴 이상 같은 레이어 정체 시
  const stagnant =
    layerState.turnsInCurrentLayer >= 3 &&
    layerState.layerHistory.slice(-3).every(l => l === layerState.currentLayer);

  // 3. 학생이 주장을 변경했을 때
  const claimChanged =
    initialClaim !== currentClaim &&
    currentClaim.length > 0 &&
    initialClaim.length > 0;

  // 4. 세션 중간 지점 (Turn 5 또는 6)
  const midSession = turnNumber === 5 || turnNumber === 6;

  return justTransitioned || stagnant || (claimChanged && turnNumber > 3) || midSession;
}

/**
 * 메타인지 질문 생성
 */
export function generateMetacognitivePrompt(
  context: MetacognitionContext,
): string {
  // 주장 변화 감지
  const claimChanged =
    context.initialClaim !== context.currentClaim &&
    context.currentClaim.length > 0 &&
    context.initialClaim.length > 0;

  // 정체 감지
  const stagnant = context.layerState.turnsInCurrentLayer >= 3;

  if (claimChanged) {
    // 성장 인식 질문
    return `처음에 "${context.initialClaim.substring(0, 50)}..."라고 하셨는데, 지금은 "${context.currentClaim.substring(0, 50)}..."라고 하시네요. 무엇이 생각을 바꾸게 했나요?`;
  }

  if (stagnant) {
    // 어려움 인식 질문
    return `이 부분에서 계속 같은 지점을 맴돌고 있는 것 같습니다. 지금 가장 답하기 어려운 질문은 무엇인가요? 왜 어려운지 말해주실 수 있나요?`;
  }

  if (context.currentLayer === 'worldview') {
    // 사고 기원 질문
    return `왜 다른 해석이 아니라 이 해석을 선택하게 되었나요? 본인의 사고 방식 자체가 결론에 영향을 주지는 않았을까요?`;
  }

  // 기본: 과정 반성 질문
  return `지금까지 이 토론에서 가장 생각이 많이 바뀐 부분은 어디인가요? 그리고 아직 확신하지 못하는 부분은 무엇인가요?`;
}

/**
 * 메타인지 프롬프트를 액터 프롬프트에 삽입할 섹션으로 포맷
 */
export function formatMetacognitionSection(prompt: string): string {
  return `\n## 🪞 메타인지 코칭 (이번 턴에 삽입 권장)
다음 메타인지 질문을 대화에 자연스럽게 녹여내세요:
"${prompt}"

중요: 메타인지 질문은 주 소크라테스 질문과 함께 사용하거나, 이번 턴의 마무리 질문으로 활용하세요.`;
}
