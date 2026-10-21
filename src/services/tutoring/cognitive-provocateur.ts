// v12.0: Cognitive Provocateur (DEVELOP 확장 기능 2 - 인지 도전 생성기)
// 학생에게 인지적 불균형(cognitive disequilibrium)을 의도적으로 유발

import type { DeepEvaluation } from './types';
import type { QuestionLayer } from './question-layer-tracker';

export type ProvocationType =
  | 'paradox'            // 역설: 학생의 논리가 스스로를 부정하는 지점
  | 'thought_experiment' // 사고 실험: "만약 ~라면?"
  | 'devil_advocate'     // 악마의 변호인: 반대 입장 전면 채택
  | 'reductio'           // 귀류법: 학생의 전제를 극단까지 밀어붙임
  | 'analogy_break'      // 유비 파괴: 학생의 비유가 성립하지 않는 경우 제시
  | 'perspective_shift'; // 관점 전환: 다른 사상가 시점에서 보기

export interface CognitiveChallenge {
  type: ProvocationType;
  challenge: string;          // 도전 질문/시나리오
  expectedDiscomfort: number; // 0-100: 예상 인지적 불편함
  prerequisiteLayer: QuestionLayer; // 최소 레이어 요구
}

/**
 * 학생의 현재 논증에 맞는 인지 도전을 생성
 */
export function generateCognitiveChallenge(
  studentClaim: string,
  evaluation: DeepEvaluation,
  currentLayer: QuestionLayer,
): CognitiveChallenge[] {
  const challenges: CognitiveChallenge[] = [];

  // 1. 역설 감지: 일관성이 낮거나 추론 갭이 있는 경우
  if (evaluation.consistency <= 3 || evaluation.reasoning_gap) {
    challenges.push({
      type: 'paradox',
      challenge: `학생의 "${studentClaim.substring(0, 60)}..." 주장이 자신의 다른 전제와 충돌합니다. "아까 말씀하신 것과 방금 말씀이 서로 충돌하지 않나요?"`,
      expectedDiscomfort: 80,
      prerequisiteLayer: 'structure',
    });
  }

  // 2. 귀류법: 주장이 명확한 경우 극단으로 밀어붙임
  if (evaluation.claim_clarity >= 3) {
    challenges.push({
      type: 'reductio',
      challenge: `학생의 전제를 극단까지 확장하면 어떤 결론에 도달하는지 보여주세요. "그 논리대로라면, [극단적 결론]도 참이어야 합니다. 이걸 받아들이시겠어요?"`,
      expectedDiscomfort: 70,
      prerequisiteLayer: 'assumption',
    });
  }

  // 3. 사고 실험: 모든 레이어에서 사용 가능
  challenges.push({
    type: 'thought_experiment',
    challenge: `"만약 정반대의 상황이라면? 당신의 주장이 그 상황에서도 여전히 유효한지 점검해보세요."`,
    expectedDiscomfort: 65,
    prerequisiteLayer: 'surface',
  });

  // 4. 관점 전환: 구조/가정 레이어 이상에서 사용
  challenges.push({
    type: 'perspective_shift',
    challenge: `"이 주제를 전혀 다른 입장에 있는 사람 — 예를 들어 정반대 견해를 가진 사람 — 은 당신의 주장에 어떻게 반박할까요?"`,
    expectedDiscomfort: 60,
    prerequisiteLayer: 'structure',
  });

  // 5. 악마의 변호인: 증거 사용이 있는 경우
  if (evaluation.evidence_use >= 3) {
    challenges.push({
      type: 'devil_advocate',
      challenge: `"제가 잠깐 반대 입장을 취해볼게요. 당신이 제시한 근거는 사실 반대 결론도 지지할 수 있지 않나요?"`,
      expectedDiscomfort: 75,
      prerequisiteLayer: 'structure',
    });
  }

  // 레이어 필터링: 현재 레이어에서 사용 가능한 도전만 반환
  const layerOrder: QuestionLayer[] = ['surface', 'structure', 'assumption', 'worldview'];
  const currentLayerIndex = layerOrder.indexOf(currentLayer);

  return challenges.filter(c => {
    const prereqIndex = layerOrder.indexOf(c.prerequisiteLayer);
    return prereqIndex <= currentLayerIndex;
  }).sort((a, b) => b.expectedDiscomfort - a.expectedDiscomfort);
}

/**
 * 가장 적합한 도전 1개를 선택하여 프롬프트 문자열로 반환
 */
export function selectTopChallenge(
  challenges: CognitiveChallenge[],
  usedTypes: ProvocationType[],
): CognitiveChallenge | null {
  if (challenges.length === 0) return null;

  // 이미 사용한 타입 제외
  const unused = challenges.filter(c => !usedTypes.includes(c.type));
  if (unused.length > 0) return unused[0];

  // 모두 사용했으면 가장 강한 도전 재사용
  return challenges[0];
}

/**
 * 도전을 프롬프트 섹션으로 포맷
 */
export function formatChallengeForPrompt(challenge: CognitiveChallenge): string {
  const typeNames: Record<ProvocationType, string> = {
    paradox: '역설 지적',
    thought_experiment: '사고 실험',
    devil_advocate: '악마의 변호인',
    reductio: '귀류법',
    analogy_break: '유비 파괴',
    perspective_shift: '관점 전환',
  };

  return `## ⚡ 이번 턴의 인지 도전 (${typeNames[challenge.type]})
${challenge.challenge}

이 도전을 자연스러운 소크라테스 질문으로 변환하여 전달하세요.
직접적으로 "이건 모순이다"라고 선언하지 말고, 학생이 스스로 발견하도록 유도하세요.`;
}
