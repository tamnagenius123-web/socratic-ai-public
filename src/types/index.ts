// Types for SocraticAI Application v14.0
// With User Management & Analytics System + Token Tracking + Intelligence Layer
import type { LearnerSourceAttribution } from '../services/source-attribution';
import type { AIRouteMetadata } from '../services/ai-router';
export type {
  LearningSessionContextErrorCode,
  PinnedLaneRoutePlan,
  SessionExecutionContext,
} from '../services/learning-session-context';

// v13.0: D-Plan 6-state phases (legacy thesis/opening/defense/conclusion removed)
export type Phase = 'elicitation' | 'grounding' | 'reasoning' | 'counterexample' | 'revision' | 'synthesis';
// Persisted legacy Sparring sessions still use these values; modern Phase stays strict.
export type LegacyPhase = 'thesis' | 'opening' | 'defense' | 'synthesis' | 'conclusion';
export type SessionPhase = Phase | LegacyPhase;
export type UserRole = 'student' | 'instructor' | 'admin';

export interface RadarScores {
  defense: number;
  consistency: number;
  evidence: number;
  relevance: number;
  clarity: number;
}

export interface Weakness {
  detected: boolean;
  description: string;
  prompt: string;
}

export interface Credibility {
  level: string;
  tier: number;
}

export interface Message {
  role: 'user' | 'ai';
  content: string;
  turn: number;
  timestamp: number;
}

// =============================================
// User Types
// =============================================

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  studentId: string | null;
  grade: number | null;
  role: UserRole;
  createdAt: number;
  lastLogin: number | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export interface UserPublic {
  id: string;
  username: string;
  email: string;
  studentId: string | null;
  grade: number | null;
  role: UserRole;
  createdAt: number;
  lastLogin: number | null;
  isActive: boolean;
}

export interface JWTPayload {
  sub: string;       // user id
  username: string;
  email: string;
  studentId: string | null;
  role: UserRole;
  iat: number;
  exp: number;
  iss: string;
}

export interface AuthRegisterRequest {
  username: string;
  email: string;
  password: string;
  studentId?: string;
  grade?: number;
}

export interface AuthLoginRequest {
  email: string;
  password: string;
}

// =============================================
// Session Types
// =============================================

export interface SessionState {
  id: string;
  userId: string | null;  // linked to user
  bookId: string;
  bookTitle: string;
  bookChapter: string;
  topic: string;
  createdAt: number;

  // Initial radar scores for report comparison
  initialRadarScores: RadarScores;

  // Phase & Turn
  currentTurn: number;
  maxTurns: number;
  currentPhase: SessionPhase;

  // Student Model
  coreClaim: string;
  currentClaim: string;
  evidenceUsed: string[];
  weaknessPattern: string[];

  // Hint System
  hintLevel: 0 | 1 | 2;
  hintRequestCount: number;
  consecutiveNoEvidence: number;

  // Evaluation
  radarScores: RadarScores;
  previousRadarScores: RadarScores;

  // Survival Metrics
  textualEvidenceCited: number;
  logicalFallaciesAvoided: number;
  fallaciesDetected: number;

  // Stats
  avgLogic: number;
  rating: string;
  dialecticPace: number;
  credibility: Credibility;

  // Conversation
  conversationHistory: Message[];
  turnStartTimes: number[];

  // Weakness
  currentWeakness: Weakness | null;

  // Last question type used (to prevent repeat)
  lastQuestionType: string;

  // Completion & Abandonment tracking
  isCompleted: boolean;
  isAbandoned: boolean;
  abandonedAt: number | null;
  abandonedTurn: number | null;
  endedAt: number | null;

  // D-Plan v12 State (sparring-training 통합)
  tutorState: string;           // 'elicitation' | 'grounding' | ... | 'synthesis'
  studentModelRaw: string;      // JSON serialized StudentModel
  layerStateJson: string;       // JSON serialized LayerState
  initialClaimV12: string;      // 메타인지 비교용 초기 주장

  // v14.0: Intelligence Layer
  thoughtProfileJson: string;   // JSON serialized ThoughtProfile
  challengeStateJson: string;   // JSON serialized ChallengeState
}

export interface ExtendedEvaluationMetrics {
  core: {
    claim_clarity: number;
    evidence_use: number;
    reasoning_strength: number;
    consistency: number;
    relevance: number;
    persuasion: number;
    revision_quality: number;
  };
  micro: {
    question_understanding: number;
    text_alignment: number;
    warrant_explicitness: number;
    counterexample_handling: number;
    stakeholder_awareness: number;
    tradeoff_recognition: number;
    feasibility_judgment: number;
    self_correction: number;
    topic_focus: number;
    specificity: number;
    evidence_precision: number;
    evidence_diversity: number;
    assumption_awareness: number;
    rebuttal_quality: number;
    synthesis_quality: number;
    causal_reasoning: number;
    normative_reasoning: number;
    citation_reliability: number;
  };
  derived: {
    comprehension_index: number;
    judgment_index: number;
    persuasion_index: number;
    evidence_index: number;
    reasoning_index: number;
    consistency_index: number;
    revision_index: number;
    relevance_index: number;
  };
}

export interface EvaluationResult {
  radarScores: RadarScores;
  evidenceFound: boolean;
  fallacyDetected: boolean;
  fallacyType: string | null;
  currentClaimUpdate: string;
  weaknessDescription: string;
  weaknessPrompt: string;
  diagnosis: string;
  reasoningGap?: string;
  missingPiece?: string;
  recommendedMove?: string;
  extendedMetrics?: ExtendedEvaluationMetrics;
  weaknessTags?: string[];
}

export interface TutorResponse {
  aiReply: string;
  questionType: string;
}

export interface ChatRequest {
  sessionId: string;
  message: string;
}

export interface ChatResponse {
  aiReply: string;

  evaluation: {
    radarScores: RadarScores;
    avgLogic: number;
    rating: string;
    reasoningGap?: string;
    missingPiece?: string;
    recommendedMove?: string;
  };

  // Responses are emitted only after a provider-backed evaluation succeeds.
  evaluationSource?: 'ai';
  evaluationExtended?: ExtendedEvaluationMetrics | null;
  aiRouting?: {
    learnerEvaluation: AIRouteMetadata;
    interactiveGeneration: AIRouteMetadata;
    releaseCritic: AIRouteMetadata;
  };

  session: {
    currentTurn: number;
    maxTurns: number;
    currentPhase: SessionPhase;
    tutorState?: string;
    hintLevel: number;
    textualEvidenceCited: number;
    logicalFallaciesAvoided: number;
    fallaciesDetected: number;
    dialecticPace: number;
    credibility: Credibility;
  };

  discourse: {
    topic: string;
    coreClaim: string;
    currentClaim: string;
  };

  weakness: Weakness | null;

  isSessionEnd: boolean;
  sessionReport?: SessionReport;
  reportStatus?: 'not_applicable' | 'ready' | 'unavailable';
  deepReportStatus?: 'not_applicable' | 'processing' | 'unavailable';

  // v13.0: Token usage metadata
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCredits: number;
    estimatedCostKRW: number;
    llmCalls: number;
    models: string[];
  };

  // v14.0: Intelligence layer metadata
  v14?: {
    thoughtProfile?: {
      absolutistTendency: number;
      binaryThinking: number;
      definitionalVagueness: number;
      intuitionOverText: number;
      sampleSize: number;
    };
    challengeLevel?: number;
    challengeReason?: string;
  };

  // Existing extension fields
  criticMetadata?: Record<string, unknown> | null;
  researchMetadata?: Record<string, unknown> | null;
  ctaSuggestions?: string[];
  grounding?: {
    manifestSha256: string;
    sources: Array<{
      sourceId: string;
      chunkIndex: number;
      charStart: number | null;
      charEnd: number | null;
      contentSha256: string;
    }>;
  };
  attribution?: LearnerSourceAttribution;
}

export interface SessionReport {
  topic: string;
  bookTitle: string;
  coreClaim: string;
  finalClaim: string;
  radarChange: {
    axis: string;
    from: number;
    to: number;
    change: number;
  }[];
  strengths: string;
  improvements: string;
  nextRecommendation: string;
  totalTurns: number;
  totalEvidenceCited: number;
  avgLogic: number;
  finalRating: string;
  summary?: string; // Gemini 3-sentence summary
  initialRadarScores?: RadarScores; // Initial radar scores at session start
  // v8.0+: Deep report extensions
  microAnalysis?: Record<string, number>;
  /** Context-bound LLM synthesis is advisory and never a measured evaluation. */
  microAnalysisStatus?: 'PROVISIONAL_UNCALIBRATED' | 'UNAVAILABLE';
  detailedStrengths?: string[];
  detailedWeaknesses?: string[];
  growthTrajectory?: string;
  prescriptiveFeedback?: { immediate: string[]; nextSession: string[]; longTerm: string[] };
  turnByTurnGrowth?: { earlyPhase: string; midPhase: string; latePhase: string };
}

export type SparringStartMode = 'initial_claim' | 'deep_reading_question';

export interface SessionStartRequest {
  bookId?: string;
  growthFollowUpLaunchId?: string;
  topic?: string;
  studentName?: string;
  startMode?: SparringStartMode;
}

export interface SessionStartResponse {
  growthFollowUp?: Awaited<ReturnType<typeof import('../services/growth-follow-up').readFollowUpLink>>;
  sessionId: string;
  topic: string;
  openingMessage: string;
  bookTitle: string;
  bookChapter: string;
  maxTurns: number;
  phases: Phase[];
  startMode: SparringStartMode;
  startModeLabel: string;
  grounding?: {
    manifestSha256: string;
    sourceIds: string[];
  };
  context: {
    id: string;
    kind: 'GROWTH_LAB';
  };
}

export interface HintRequest {
  mutationKey: string;
  expectedTurn: number;
  sessionId: string;
}

export interface HintResponse {
  hintLevel: number;
  hintLevelName?: string;
  hintMessage: string;
  hintLevelChanged: boolean;
  sources?: { title: string; url: string; snippet: string; source: string; relevanceScore: number }[];
  searchSummary?: string;
}

// Book upload request (supports pre-parsed text from client-side PDF/EPUB)
export interface BookUploadParsedRequest {
  title: string;
  author: string;
  chapter?: string;
  language?: string;
  text: string;           // Pure string text (parsed on client side)
  sourceType?: 'txt' | 'pdf' | 'epub';   // Original file type
  keyPassages?: { verse: string; text: string }[];
}

// Book upload request
export interface BookUploadRequest {
  title: string;
  author: string;
  chapter?: string;
  language?: string;
  text: string;
  keyPassages?: { verse: string; text: string }[];
}

// =============================================
// Analytics Types
// =============================================

export interface AnalyticsOverview {
  totalUsers: number;
  activeUsers: number;
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  completionRate: number;
  avgCompletionTurn: number;
  avgLogicScore: number;
  attritionPoints: Record<string, number>;
  weeklyActivity: Record<string, number>;
  opsMetrics?: {
    avgDropoffTurn: number;
    evidenceFailRate: number;
    consistencyFailRate: number;
    hintSuccessRate: null;
    hintEfficacyStatus: 'UNKNOWN';
    learningEvidence: import('../services/learning-evidence-metrics').SparringLearningEvidenceMetrics;
    topWeaknesses: { pattern: string; count: number }[];
    failureReasons: { reason: string; count: number }[];
  };
}

export interface UserStats {
  userId: string;
  username: string;
  studentId: string | null;
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  completionRate: number;
  avgScore: number;
  radarScores: RadarScores;
  recentSessions: {
    id: string;
    book: string;
    startedAt: number;
    completed: boolean;
    turns: number;
    avgScore: number;
  }[];
  weaknesses: string[];
  improvements: string[];
  group: string;  // A, B, C, D, E
}

export interface CitationSource {
  sourceId: string;
  title: string;
  snippet?: string;
  score?: number;
}

export interface NormalizedEvaluation {
  claim_clarity: number;
  evidence_use: number;
  reasoning_strength: number;
  consistency: number;
  relevance: number;
  weakness_tags: string[];
  diagnosis: string;
  extended_metrics?: {
    core: Record<string, number>;
    micro: Record<string, number>;
    derived: Record<string, number>;
  };
}

export interface TutorServiceHook {
  id: string;
  hookKey: string;
  description: string;
  configJson: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// v21: Analytics queue message type
export interface AnalyticsMessage {
  type: string;
  sessionId: string;
  userId?: string | null;
  data: Record<string, unknown>;
  timestamp: number;
}

// Cloudflare Bindings - D1 + Secrets + v23 Infrastructure
export type Bindings = {
  // Development-only deterministic OpenAI-compatible browser harness. The
  // router rejects partial or malformed local configuration before any fetch.
  AI_LOCAL_E2E_OPT_IN?: string;
  AI_LOCAL_E2E_BASE_URL?: string;
  // Explicit lane credentials. Actor and assessment credentials must not be
  // interchanged by a route policy.
  AI_ACTOR_SSU_API_KEY?: string;
  AI_ACTOR_OPENROUTER_API_KEY?: string;
  AI_ACTOR_GEMINI_API_KEY?: string;
  AI_ASSESSMENT_DEEPSEEK_API_KEY?: string;
  // Assessment-only transient fallbacks. These are intentionally separate
  // from actor keys so an evaluator or critic can never resolve an actor secret.
  AI_ASSESSMENT_SSU_API_KEY?: string;
  AI_ASSESSMENT_OPENROUTER_API_KEY?: string;
  // Backward-compatible aliases for older routes only. New tutoring routes use
  // the explicit lane credentials above.
  SOONGSIL_API_KEY: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  GEMINI_API_KEY: string;
  JWT_SECRET: string;
  DB: D1Database;
  // v21: Vectorize RAG binding
  VECTORIZE_INDEX?: VectorizeIndex;
  // v21: Analytics queue binding
  ANALYTICS_QUEUE?: Queue<AnalyticsMessage>;
  // v21: Workers AI binding (bge-base-en-v1.5 for 768d embeddings)
  AI?: Ai;
  // v20: Adapter-aware ARC inference
  ARGUNET_ADAPTER_URL?: string;
  ARGUNET_ADAPTER_TOKEN?: string;
  // v23: ZKP Provider
  ZKP_HMAC_SECRET?: string;       // ZKP HMAC signing key (production: Cloudflare Secret)
  ZKP_PROVIDER_URL?: string;      // ZKP proof provider Worker URL
  // v23: Durable Objects Debate Worker
  DEBATE_WORKER_URL?: string;     // DO Worker REST endpoint URL
  // Shared secret for authenticated Page-to-Debate-Worker service calls.
  DEBATE_RUNTIME_SERVICE_TOKEN?: string;
  // Private Worker secret. Growth Cycle refuses HMAC-protected mutations when absent.
  GROWTH_CYCLE_HMAC_SECRET?: string;
};
