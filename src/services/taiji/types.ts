// SocraticAI v35 — Taiji Engine Type Definitions
// 태극 엔진 공통 인터페이스 (T1.3.1~T1.3.5)

/**
 * 더블 게이트 검사 결과
 * 마스터리 >= 0.65 AND 몰입 >= 0.70 AND 학년 >= 6을 모두 만족할 때만 ready=true
 */
export interface SingularityGateResult {
  ready: boolean;
  reason?: string; // mastery_0.45_below_0.65, engagement_0.60_below_0.70, grade_below_6
}

/**
 * 반례 생성 요청
 */
export interface CounterSimulationRequest {
  studentClaim: string;
  currentNodeId?: string;
  masteryScore: number;
  engagementScore: number;
  gradeLevel: number;
  contextMetadata?: {
    domainKeywords?: string[];
    previousCounterClaims?: string[];
  };
}

/**
 * 반례 생성 결과
 * DeepSeek thinking mode로 생성되어 최고 품질의 반례 보장
 */
export interface CounterExample {
  counterClaim: string;
  premises: string[];
  targetFallacy: string;
  confidence: number;
  waltonSchemeId?: string; // 반례가 대응하는 Walton 스키마 ID
}

/**
 * Chinn-Brewer 저항 분류 결과
 */
export type ChinnBrewerClassification =
  | 'ignore'
  | 'reject'
  | 'exclude'
  | 'abeyance'
  | 'reinterpret'
  | 'peripheral'
  | 'theory_change'
  | 'uncertain';

export interface ResistanceClassification {
  classification: ChinnBrewerClassification;
  confidence: number;
  reasoning?: string; // 내부 근거 (저장하지 않음)
}

/**
 * 태극 세션 상태
 */
export interface TaijiSessionState {
  sessionId: string;
  userId: string;
  currentNodeId: string;
  turn: number;
  lastCounterExampleId?: string;
  lastClassification?: ChinnBrewerClassification;
  lastClassificationAt?: number;
  suspendedUntil?: number; // Unix ms, 저항 감지 시 10분 유예
  createdAt: number;
  updatedAt: number;
}

/**
 * API 요청: POST /api/taiji/counterpoint
 */
export interface CounterpointRequest {
  sessionId: string;
  claimAttributionId: string;
  fromNodeId: string;
  toNodeId: string;
}

/**
 * API 응답: POST /api/taiji/counterpoint
 */
export interface CounterpointResponse {
  counterpoint?: {
    claim: string;
    premises: string[];
    targetFallacy: string;
    confidence: number;
  };
  locked?: {
    reason: string;
    resumeAfter?: number; // Unix ms
  };
  gateStatus: {
    passed: boolean;
    failureReason?: string;
  };
  classification?: {
    type: ChinnBrewerClassification;
    confidence: number;
  };
  actionStatus: {
    available: boolean;
    action?: 'continue' | 'suspend' | 'reinforce' | 'clarify' | 'unavailable';
    reason?: string;
  };
  idempotent?: boolean;
}
