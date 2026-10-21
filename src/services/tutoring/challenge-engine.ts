// v14.0: Challenge Engine — Flow Channel 기반 동적 난이도 조절
// Level 1(입문) → Level 2(기초) → Level 3(심화) → Level 4(마스터)
// 학생 수준에 따라 허용 액션, 메타인지, 다중 관점 등을 자동 조절

import type { TutorAction, DeepEvaluation, StudentModel } from './types';

// =============================================
// Types
// =============================================
export type ChallengeLevel = 1 | 2 | 3 | 4;

export interface ChallengeState {
  currentLevel: ChallengeLevel;
  history: { turn: number; level: ChallengeLevel; reason: string }[];
  consecutiveSuccess: number;    // 연속 성공 턴 수
  consecutiveStruggle: number;   // 연속 어려움 턴 수
}

interface LevelConfig {
  name: string;
  description: string;
  allowedActions: TutorAction[];
  maxTokens: number;
  metacognitionEnabled: boolean;
  multiPerspectiveEnabled: boolean;
}

// =============================================
// Factory
// =============================================
export function createDefaultChallengeState(): ChallengeState {
  return {
    currentLevel: 1,
    history: [],
    consecutiveSuccess: 0,
    consecutiveStruggle: 0,
  };
}

// =============================================
// Level Configuration
// =============================================
const LEVEL_CONFIG: Record<ChallengeLevel, LevelConfig> = {
  1: {
    name: '입문',
    description: '명료화 + 근거 질문 중심',
    allowedActions: ['ask_clarification', 'ask_evidence', 'request_text_reference', 'give_hint'],
    maxTokens: 300,
    metacognitionEnabled: false,
    multiPerspectiveEnabled: false,
  },
  2: {
    name: '기초',
    description: '약한 반례 + 추론 연결',
    allowedActions: ['ask_clarification', 'ask_evidence', 'ask_reasoning', 'ask_counterexample', 'request_text_reference'],
    maxTokens: 400,
    metacognitionEnabled: false,
    multiPerspectiveEnabled: false,
  },
  3: {
    name: '심화',
    description: '전제 해체 + 귀류법',
    allowedActions: ['ask_reasoning', 'ask_counterexample', 'narrow_scope', 'ask_revision'],
    maxTokens: 500,
    metacognitionEnabled: true,
    multiPerspectiveEnabled: false,
  },
  4: {
    name: '마스터',
    description: '메타인지 + 다중 관점 압박',
    allowedActions: ['ask_counterexample', 'narrow_scope', 'ask_revision', 'move_to_synthesis'],
    maxTokens: 600,
    metacognitionEnabled: true,
    multiPerspectiveEnabled: true,
  },
};

// =============================================
// Level Determination
// =============================================
/**
 * v16: Flow Channel + Cognitive Load 기반 적응형 난이도 결정
 *
 * 학술 근거:
 *   - Csikszentmihalyi Flow Channel Theory (1990)
 *   - Sweller Cognitive Load Theory (1988)
 *   - Nature Scientific Reports (2025): DKT + CLE 이중 스트림
 *
 * 수학적 모델:
 *   Flow Zone: |D(question) - A(student)| ≤ Δ (Δ=150 ELO)
 *   Boredom: A - D > Δ → Level Up
 *   Anxiety: D - A > Δ → Level Down
 *   Cognitive Load: CL = (5-avgScore)/5 + turnFatigue
 *   if CL > 0.7 → 강제 Level Down (인지 과부하 방지)
 *
 * 상향 조건: avgScore >= 3.5 && 연속 성공 >= 2 && helpLevel <= 1
 * 하향 조건: avgScore < 2.0 || (helpLevel >= 3 && 연속 어려움 >= 2)
 * 인지 과부하: cogLoadEstimate > 0.7 → 강제 하향
 * revision 성공 보너스: significant growth after revision → +1 level
 */
export function determineChallengeLevel(
  current: ChallengeState,
  evaluation: DeepEvaluation,
  turnNumber: number,
  studentModel: Partial<StudentModel>,
  studentElo?: number,
): ChallengeState {
  const avgScore = (
    evaluation.claim_clarity +
    evaluation.evidence_use +
    evaluation.reasoning_strength +
    evaluation.consistency +
    evaluation.relevance
  ) / 5;

  const helpLevel = studentModel.helpLevel || 0;
  // Attempt counts and AI-reported growth do not establish a difficulty bonus.

  // v16: Flow Channel 파라미터
  const DELTA = 150;
  const BASE_DIFFICULTY: Record<ChallengeLevel, number> = { 1: 850, 2: 1000, 3: 1150, 4: 1300 };
  const ability = studentElo || eloFromAvgScore(avgScore);
  const currentDifficulty = BASE_DIFFICULTY[current.currentLevel];
  const gap = currentDifficulty - ability;

  // v16: 인지 부하 추정 (Sweller CLT)
  const maxTurns = 10;
  const turnFatigue = Math.min(0.3, turnNumber / maxTurns * 0.3);
  const cogLoadEstimate = (5 - avgScore) / 5 + turnFatigue;

  let nextLevel = current.currentLevel;
  let reason = 'flow_maintained';

  // 인지 과부하 시 강제 하향
  if (cogLoadEstimate > 0.7 && current.currentLevel > 1) {
    nextLevel = (current.currentLevel - 1) as ChallengeLevel;
    reason = `cognitive_overload (CL=${cogLoadEstimate.toFixed(2)})`;
  }
  // Boredom Zone → Level Up (상향 조건)
  else if (avgScore >= 3.5 && current.consecutiveSuccess >= 2 && helpLevel <= 1) {
    if (ability - currentDifficulty > DELTA || current.consecutiveSuccess >= 3) {
      nextLevel = Math.min(4, current.currentLevel + 1) as ChallengeLevel;
      reason = `boredom_zone (gap=${(ability - currentDifficulty).toFixed(0)}, avgScore=${avgScore.toFixed(1)})`;
    } else {
      nextLevel = Math.min(4, current.currentLevel + 1) as ChallengeLevel;
      reason = `avgScore ${avgScore.toFixed(1)} + ${current.consecutiveSuccess} consecutive success`;
    }
  }
  // Anxiety Zone → Level Down (하향 조건)
  else if (avgScore < 2.0 || (helpLevel >= 3 && current.consecutiveStruggle >= 2)) {
    nextLevel = Math.max(1, current.currentLevel - 1) as ChallengeLevel;
    reason = gap > DELTA
      ? `anxiety_zone (gap=${gap.toFixed(0)})`
      : `avgScore ${avgScore.toFixed(1)} or helpLevel ${helpLevel} + struggle`;
  }
  // Difficulty continues to use the observed rubric above, without a revision-success shortcut.

  // 연속 카운터 업데이트
  const isSuccess = avgScore >= 3.0;
  const newConsecutiveSuccess = isSuccess ? current.consecutiveSuccess + 1 : 0;
  const newConsecutiveStruggle = !isSuccess ? current.consecutiveStruggle + 1 : 0;

  return {
    currentLevel: nextLevel,
    history: [
      ...current.history.slice(-9),
      { turn: turnNumber, level: nextLevel, reason },
    ],
    consecutiveSuccess: newConsecutiveSuccess,
    consecutiveStruggle: newConsecutiveStruggle,
  };
}

function eloFromAvgScore(avg: number): number {
  return 600 + avg * 160; // 1→760, 3→1080, 5→1400
}

// =============================================
// Action Filter
// =============================================
/**
 * 현재 ChallengeLevel에서 허용되지 않는 액션을 필터하여 가장 가까운 허용 액션으로 대체
 */
export function filterActionByChallenge(
  action: TutorAction,
  level: ChallengeLevel,
): TutorAction {
  const config = LEVEL_CONFIG[level];
  if (config.allowedActions.includes(action)) return action;

  // 허용 액션 중 가장 가까운 것으로 대체
  // 우선순위: ask_evidence → ask_reasoning → ask_clarification
  const fallbackPriority: TutorAction[] = [
    'ask_evidence', 'ask_reasoning', 'ask_clarification',
    'ask_counterexample', 'request_text_reference', 'narrow_scope',
    'give_hint', 'ask_revision', 'move_to_synthesis',
  ];
  for (const fb of fallbackPriority) {
    if (config.allowedActions.includes(fb)) return fb;
  }
  return config.allowedActions[0] || 'ask_evidence';
}

// =============================================
// Prompt Injection
// =============================================
export function getChallengeConstraints(level: ChallengeLevel): string {
  const config = LEVEL_CONFIG[level];
  return `
## Challenge Level: ${level} (${config.name})
- 허용 질문 유형: ${config.allowedActions.join(', ')}
- 메타인지 질문: ${config.metacognitionEnabled ? '활성화' : '비활성화'}
- 다중 관점: ${config.multiPerspectiveEnabled ? '활성화' : '비활성화'}
- 최대 응답 길이: ${config.maxTokens} 토큰
${level >= 3 ? '- 전제 해체, 귀류법 등 고급 전략 사용 가능' : ''}
${level >= 4 ? '- "스토아주의자/회의주의자/실용주의자"의 관점 삽입 가능' : ''}
`;
}

// =============================================
// Accessors
// =============================================
export function getLevelConfig(level: ChallengeLevel): LevelConfig {
  return LEVEL_CONFIG[level];
}

export function isMetacognitionEnabled(level: ChallengeLevel): boolean {
  return LEVEL_CONFIG[level].metacognitionEnabled;
}

export function isMultiPerspectiveEnabled(level: ChallengeLevel): boolean {
  return LEVEL_CONFIG[level].multiPerspectiveEnabled;
}
