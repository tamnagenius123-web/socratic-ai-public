// D-Plan: Deep-Skill Tutoring Core Types v14.0
// Student Model, State Machine, Action Selector, Hint Ladder
// v14.0: ThoughtProfile + ChallengeState + TutorTurnResultExtended

import type { ThoughtProfile } from './thought-profiler';
import type { ChallengeState } from './challenge-engine';
import type { AIRouteMetadata } from '../ai-router';

// =============================================
// Weakness Tags
// =============================================
export type WeaknessTag =
  | '근거 부족'
  | '추상어 과다'
  | '결론만 제시'
  | '추론 비약'
  | '텍스트 미참조'
  | '모순 발생'
  | '질문 이탈'
  | '반례 미고려';

// =============================================
// Tutor Actions
// =============================================
export type TutorAction =
  | 'ask_evidence'
  | 'ask_reasoning'
  | 'ask_clarification'
  | 'ask_counterexample'
  | 'narrow_scope'
  | 'give_hint'
  | 'request_text_reference'
  | 'ask_revision'
  | 'move_to_synthesis';

// =============================================
// Tutoring State Machine
// =============================================
export type TutorState =
  | 'elicitation'
  | 'grounding'
  | 'reasoning'
  | 'counterexample'
  | 'revision'
  | 'synthesis'
  | 'completed';

// =============================================
// Hint Ladder
// =============================================
export type HintLadderLevel = 0 | 1 | 2 | 3 | 4 | 5;

// =============================================
// Deep Evaluation Result (1-5 scale) - v12.0 확장
// =============================================
export interface DeepEvaluation {
  claim_clarity: number;     // 1-5
  evidence_use: number;      // 1-5
  reasoning_strength: number; // 1-5
  consistency: number;       // 1-5
  relevance: number;         // 1-5
  next_action: TutorAction;
  hint_level: HintLadderLevel;
  weakness_tags: WeaknessTag[];
  diagnosis: string;
  claim: string;
  // Authoritative only after exact membership validation against the turn manifest.
  // evidence_detected remains descriptive evaluator output, never a citation record.
  evidence_source_ids?: string[];
  evidence_detected: string[];
  reasoning_gap: string;

  // 🆕 v12.0: 수정안 D - 질적 분석 필드
  student_implicit_assumptions?: string[];  // 학생의 암묵적 전제들
  alternative_interpretations?: string[];   // 학생이 간과한 대안적 해석
  reasoning_chain_weakest_link?: string;    // 논리 체인에서 가장 약한 고리
  cognitive_level?: 'recall' | 'comprehension' | 'application' | 'analysis' | 'synthesis' | 'evaluation';
  misconceptions?: string[];                // 감지된 오개념
  student_growth_since_last_turn?: 'regressed' | 'stagnant' | 'marginal' | 'significant';
}

// =============================================
// Student Model (D-Plan Core)
// =============================================
export interface StudentModel {
  sessionId: string;
  topic: string;
  sessionGoal: string;
  currentClaim: string;
  evidenceUsed: string[];
  referencedChunkIds: string[];
  reasoningStrength: number;       // 1-5 running average
  consistencyRisk: number;         // 0-5 higher = more risk
  relevanceLevel: number;          // 1-5
  helpLevel: HintLadderLevel;      // 0-5 current scaffolding level
  weaknessPatterns: WeaknessTag[];
  repeatedWeaknessCounts: Record<string, number>;
  lastTutorAction: TutorAction | null;
  lastDiagnosis: string;
  /** Historical inferred value, retained for readback; never proof of learning. */
  revisionCount: number;
  evidenceUsageCount: number;
  offTopicCount: number;
  contradictionCount: number;
  progressNotes: string[];
  updatedAt: string;
}

// =============================================
// Turn Processing Context
// =============================================
export interface TurnContext {
  sessionId: string;
  currentState: TutorState;
  studentModel: StudentModel;
  evaluation: DeepEvaluation;
  bookText: string;
  conversationHistory: { role: string; content: string }[];
  turnNumber: number;
  maxTurns: number;
}

// =============================================
// Tutor Turn Result
// =============================================
export interface TutorTurnResult {
  state: TutorState;
  action: TutorAction;
  hintLevel: HintLadderLevel;
  evaluation: DeepEvaluation;
  studentModel: StudentModel;
  tutorResponse: string;
  questionType: string;
  // Safe route observability only. Credentials and provider error bodies never
  // cross the learner-facing boundary.
  aiRouting: {
    learnerEvaluation: AIRouteMetadata;
    interactiveGeneration: AIRouteMetadata;
    releaseCritic: AIRouteMetadata;
  };
  // v10.0+: Extended results
  aifGraph?: {
    totalNodes: number;
    totalEdges: number;
    argumentStrength: number;
    missingEdges: number;
  };
  criticVerdict?: {
    passed: boolean;
    leakageScore: number;
    bloomLevel: string;
    engagementScore?: number;
    isGenericQuestion?: boolean;
    intellectualTension?: number;
  };
  // v14.0: Intelligence layer results
  thoughtProfile?: ThoughtProfile;
  challengeState?: ChallengeState;
  // Must be dispatched only after the route commits its canonical accepted turn.
  runAcceptedSideEffects: () => Promise<void>;
}

// =============================================
// Session Goal Templates
// =============================================
export const SESSION_GOALS: Record<string, string> = {
  elicitation: '핵심 주장을 명확하게 표현하기',
  grounding: '주장을 텍스트 장면과 연결하기',
  reasoning: '근거가 결론으로 이어지는 이유를 설명하기',
  counterexample: '반례와 예외를 검토하기',
  revision: '이전 답변을 더 강한 형태로 재구성하기',
  synthesis: '전체 논의를 자기 언어로 정리하기',
};
