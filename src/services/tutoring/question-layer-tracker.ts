// v12.0: Question Layer Tracker (DEVELOP 확장 기능 1 - 다층 소크라테스 대화 엔진)
// 4-Layer Questioning Model: surface → structure → assumption → worldview

import type { DeepEvaluation } from './types';

export type QuestionLayer = 'surface' | 'structure' | 'assumption' | 'worldview';

export interface LayerState {
  currentLayer: QuestionLayer;
  layerHistory: QuestionLayer[];
  surfaceCleared: boolean;
  structureCleared: boolean;
  assumptionCleared: boolean;
  turnsInCurrentLayer: number;
  layerTransitionTurns: number[];
}

/**
 * 초기 레이어 상태 생성
 */
export function createLayerState(): LayerState {
  return {
    currentLayer: 'surface',
    layerHistory: ['surface'],
    surfaceCleared: false,
    structureCleared: false,
    assumptionCleared: false,
    turnsInCurrentLayer: 0,
    layerTransitionTurns: [],
  };
}

/**
 * 학생의 응답 질적 수준에 따라 레이어 전환을 결정
 *
 * 규칙:
 * 1. 학생이 현재 레이어의 기대를 충족하면 다음 레이어로 전환
 * 2. 같은 레이어에서 3턴 이상 정체하면 측면 전환
 */
export function determineNextLayer(
  currentLayer: QuestionLayer,
  evaluation: DeepEvaluation,
  turnsInCurrentLayer: number,
  turnNumber: number,
): { nextLayer: QuestionLayer; reason: string; shouldTransition: boolean } {
  const avgScore = (
    evaluation.claim_clarity +
    evaluation.evidence_use +
    evaluation.reasoning_strength +
    evaluation.consistency +
    evaluation.relevance
  ) / 5;

  // 현재 레이어에서 충분한 수준 달성 → 다음 레이어
  if (avgScore >= 3.5 && turnsInCurrentLayer >= 1) {
    const progression: Record<QuestionLayer, QuestionLayer> = {
      surface: 'structure',
      structure: 'assumption',
      assumption: 'worldview',
      worldview: 'worldview',
    };
    const nextLayer = progression[currentLayer];
    return {
      nextLayer,
      reason: `학생이 ${currentLayer} 레이어를 충분히 통과 (avg=${avgScore.toFixed(1)}) → ${nextLayer}로 전환`,
      shouldTransition: nextLayer !== currentLayer,
    };
  }

  // 3턴 이상 정체 → 측면 전환
  if (turnsInCurrentLayer >= 3) {
    const lateral: Record<QuestionLayer, QuestionLayer> = {
      surface: 'structure',
      structure: 'assumption',
      assumption: 'structure',
      worldview: 'assumption',
    };
    const nextLayer = lateral[currentLayer];
    return {
      nextLayer,
      reason: `${currentLayer}에서 ${turnsInCurrentLayer}턴 정체 → ${nextLayer}로 측면 전환`,
      shouldTransition: nextLayer !== currentLayer,
    };
  }

  return {
    nextLayer: currentLayer,
    reason: '현재 레이어 유지',
    shouldTransition: false,
  };
}

/**
 * 레이어별 질문 전략 문자열 반환
 */
export function getLayerStrategy(layer: QuestionLayer): string {
  const strategies: Record<QuestionLayer, string> = {
    surface: `[Layer 1: 표층] 학생의 주장을 정확히 정의하게 하세요.
- "정확히 무엇을 주장하시는 건가요?"
- "그 주장의 범위는? 모든 경우인가요, 특정 경우인가요?"
- "반대 입장은 무엇이 될까요?"`,

    structure: `[Layer 2: 구조층] 논증의 구조를 드러내게 하세요.
- "그 결론에 도달하기 위해 어떤 추론 단계를 밟았나요?"
- "근거와 결론 사이에 빠진 단계는 없나요?"
- "그 근거가 다른 결론도 지지할 수 있지 않나요?"`,

    assumption: `[Layer 3: 가정층] 숨겨진 전제를 해체하세요.
- "그 추론이 성립하려면 어떤 전제가 필요한데, 이건 당연한 건가요?"
- "만약 그 전제가 틀리다면 어떻게 되죠?"
- "다른 문화/시대에서도 같은 전제가 성립할까요?"`,

    worldview: `[Layer 4: 세계관층] 사고 프레임 자체를 반성하게 하세요.
- "왜 다른 해석이 아니라 이 해석을 선택했나요?"
- "당신의 사고 방식 자체가 결론에 영향을 준 건 아닌가요?"
- "이 토론을 처음 시작할 때와 지금의 생각이 어떻게 달라졌나요?"`,
  };
  return strategies[layer];
}

/**
 * LayerState 직렬화/역직렬화
 */
export function serializeLayerState(state: LayerState): string {
  return JSON.stringify(state);
}

export function deserializeLayerState(json: string): LayerState {
  try {
    return JSON.parse(json) as LayerState;
  } catch (e) { console.error("[P1-004] Caught:", e);
    return createLayerState();
  }
}

/**
 * LayerState 업데이트
 */
export function updateLayerState(
  state: LayerState,
  nextLayer: QuestionLayer,
  turnNumber: number,
): LayerState {
  const updated = { ...state };
  if (nextLayer !== state.currentLayer) {
    updated.currentLayer = nextLayer;
    updated.layerHistory = [...state.layerHistory, nextLayer];
    updated.turnsInCurrentLayer = 1;
    updated.layerTransitionTurns = [...state.layerTransitionTurns, turnNumber];

    // 클리어 플래그 업데이트
    if (state.currentLayer === 'surface') updated.surfaceCleared = true;
    if (state.currentLayer === 'structure') updated.structureCleared = true;
    if (state.currentLayer === 'assumption') updated.assumptionCleared = true;
  } else {
    updated.turnsInCurrentLayer = state.turnsInCurrentLayer + 1;
    updated.layerHistory = [...state.layerHistory, nextLayer];
  }

  return updated;
}
