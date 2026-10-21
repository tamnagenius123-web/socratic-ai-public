// ============================================================
// v23: D1 Row Type Definitions — Zero `any` Initiative
// All D1 query results MUST use these interfaces instead of `any`
// ============================================================

// =============================================
// Debate Arena Tables
// =============================================

/** Current library list/search projection; distinct from the historical BookRow. */
export interface LibraryBookListRow {
  id: string;
  title: string;
  author: string;
  chapter: string;
  language: string;
  key_passages: string;
  text: string;
  is_builtin: number;
  created_at: number;
  chunk_count: number;
  ingestion_status: string;
  vector_status: string;
  lifecycle_status: string;
  owner_user_id: string | null;
  visibility: string;
}

export interface StudentGrowthProfileRow {
  user_id: string;
  total_sessions: number | null;
  total_turns: number | null;
  elo_evidence: number | null;
  elo_reasoning: number | null;
  elo_defense: number | null;
  elo_clarity: number | null;
  elo_consistency: number | null;
  thought_profile_json: string | null;
  chronic_weaknesses: string | null;
  milestones: string | null;
  recent_session_scores: string | null;
  created_at: number;
  updated_at: number;
}

export interface TutorServiceHookRow {
  id: string;
  hook_key: string;
  description: string | null;
  config_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface DebateRoomRow {
  id: string;
  org_id: string | null;
  host_user_id: string | null;
  topic: string;
  status: 'open' | 'turn_pending' | 'closed' | 'archived';
  mode: string;
  created_at: number;
}

export interface DebateParticipantRow {
  id: string;
  room_id: string;
  participant_type: 'human' | 'ai';
  role: string;
  user_id: string | null;
  display_name: string;
  joined_at: number;
}

export interface DebateTurnRow {
  id: string;
  room_id: string;
  participant_id: string;
  turn_number: number;
  content: string;
  role: string;
  moderation_json: string | null;
  created_at: number;
}

export interface DebateTurnMutationRow {
  mutation_id: string;
  room_id: string;
  user_id: string;
  participant_id: string;
  content_sha256: string;
  status: 'pending' | 'complete' | 'unknown';
  turn_number: number | null;
  student_turn_id: string | null;
  runtime_result_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// =============================================
// Badge / ZKP Tables
// =============================================

export interface CognitiveBadgeRow {
  id: string;
  user_id: string;
  session_id: string;
  proof_id: string;
  badge_type: string;
  process_score: number;
  trajectory_hash: string;
  issued_at: number;
  revoked_at: number | null;
}

export interface ZKPProofRow {
  id: string;
  user_id: string;
  session_id: string;
  proof_system: string;
  public_input_json: string;
  proof_json: string;
  verifier_status: 'verified' | 'pending' | 'failed';
  created_at: number;
}

export interface BadgeWithProofRow extends CognitiveBadgeRow {
  verifier_status: string;
  proof_system: string;
  proof_json?: string;
  public_input_json?: string;
}

// =============================================
// Process Evaluation Tables
// =============================================

export interface ProcessEvaluationRow {
  id?: string;
  session_id: string;
  process_score: number;
  snapshot_json: string | null;
  logical_score?: number;
  data_score?: number;
  flexibility_score?: number;
  communication_score?: number;
  overall_score?: number;
  created_at: number;
}

export interface ProcessSnapshotRow {
  id?: string;
  session_id: string;
  turn_number: number;
  logical_score: number;
  data_score: number;
  flexibility_score: number;
  communication_score: number;
  overall_score: number;
  created_at: number;
}

// =============================================
// Teacher Dashboard Tables
// =============================================

export interface ClassProgressRow {
  username: string;
  user_id: string;
  session_count: number;
  avg_logical: number | null;
  avg_data: number | null;
  avg_flexibility: number | null;
  avg_communication: number | null;
  avg_overall: number | null;
  last_active: number | null;
}

export interface WeakIndicatorRow {
  indicator_id: string;
  avg_score: number | null;
  sample_count: number;
}

export interface TalentTrendRow {
  id: string;
  org_id: string;
  period_type: string;
  period_start: number;
  [key: string]: unknown;
}

export interface DialogueActEventRow {
  turn_number: number;
  act_code: string;
  confidence: number;
}

export interface MicroScoreRow {
  turn_number: number;
  indicator_id: string;
  normalized_score: number;
  session_id?: string;
}

// =============================================
// Analytics Tables
// =============================================

export interface SessionRow {
  id: string;
  user_id: string | null;
  book_id: string;
  book_title: string;
  topic: string;
  created_at: number;
  is_completed: boolean;
  is_abandoned: boolean;
  current_turn: number;
  avg_logic: number | null;
  [key: string]: unknown;
}

export interface AdminSessionRow {
  id: string;
  user_id: string | null;
  book_title: string;
  topic: string;
  current_turn: number;
  avg_logic: number | null;
  is_completed: number | boolean;
  created_at: number;
  username?: string;
}

export interface TokenUsageRow {
  total_tokens: number;
  estimated_credits: number;
  tokens?: number;
  credits?: number;
}

export interface TopConsumerRow {
  user_id: string;
  username: string;
  tokens: number;
  credits: number;
}

export interface AttritionRow {
  turn: number;
  count: number;
}

export interface WeaknessPatternRow {
  pattern: string;
  count: number;
}

export interface BookRow {
  id: string;
  title: string;
  author: string;
  chapter: string | null;
  language: string;
  full_text: string | null;
  key_passages_json: string | null;
  created_at: number;
  is_builtin: number | boolean;
}

// =============================================
// Vectorize / RAG Tables
// =============================================

export interface VectorDocumentRow {
  id: string;
  source_type: string;
  source_id: string;
  chunk_count: number;
  embedding_model: string;
  vector_index_name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface VectorQueryLogRow {
  id: string;
  user_id: string | null;
  query_text: string;
  top_k: number;
  latency_ms: number;
  hit_count: number;
  retrieval_json: string;
  created_at: number;
}

export interface VectorizeMatchResult {
  id: string;
  score: number;
  metadata?: Record<string, string>;
}

// =============================================
// ZKP Provider Types
// =============================================

export interface ZKPProviderResponse {
  proofSystem: string;
  proof: {
    pi_a?: string[];
    pi_b?: string[][];
    pi_c?: string[];
    commitment?: string;
    merkleRoot?: string;
    merkleProof?: string[];
    nullifierHash?: string;
  };
  publicSignals: string[];
  verified: boolean;
  error?: string;
}

// =============================================
// ELO / Rankings
// =============================================

export interface RankingRow {
  user_id: string;
  username: string;
  elo_rating: number;
  total_sessions: number;
  avg_score: number;
  best_score: number;
}

export interface EvalProgressRow {
  session_id: string;
  turn_number: number;
  claim_clarity: number;
  evidence_use: number;
  reasoning_strength: number;
  consistency: number;
  relevance: number;
}

export interface ByBookRow {
  book_id: string;
  book_title: string;
  total_sessions: number;
  avg_score: number;
}

export interface ByUserRow {
  user_id: string;
  username: string;
  total_sessions: number;
  avg_score: number;
}

// =============================================
// v24: Extended Row Types for Zero-Any Initiative
// =============================================

// admin.ts — User session detail rows
export interface AdminUserSessionRow {
  id: string;
  topic: string;
  book_title: string;
  book_chapter: string;
  created_at: number;
  current_turn: number;
  max_turns: number;
  avg_logic: number | null;
  rating: string | null;
  is_completed: number | boolean;
  is_abandoned: number | boolean;
  abandoned_turn: number | null;
  ended_at: number | null;
  core_claim: string | null;
  textual_evidence_cited: number;
  radar_scores: string | null;
}

// admin.ts — Token summary row
export interface TokenSummaryRow {
  tokens: number;
  credits: number;
  date?: string;
}

// admin.ts — Top consumer row (extended)
export interface TopConsumerDetailRow {
  user_id: string;
  username: string;
  total_tokens: number;
  total_credits: number;
  total_sessions?: number;
}

// admin.ts — Session token usage detail
export interface SessionTokenUsageDetailRow {
  total_tokens: number;
  estimated_credits: number;
  model_name?: string;
  created_at?: number;
}

// analytics.ts — Attrition range row
export interface AttritionRangeRow {
  range: string;
  cnt: number;
}

// analytics.ts — Recent session row
export interface RecentSessionRow {
  id: string;
  book_title: string;
  created_at: number;
  is_completed: number | boolean;
  current_turn: number;
  avg_logic: number | null;
}

// analytics.ts — Weakness pattern session row
export interface WeaknessPatternSessionRow {
  weakness_pattern: string;
}

// analytics.ts — Progress eval row
export interface ProgressEvalRow {
  session_id: string;
  turn: number;
  defense_score: number;
  consistency_score: number;
  evidence_score: number;
  relevance_score: number;
  clarity_score: number;
  avg_score: number;
  created_at: number;
  topic: string;
  book_title: string;
}

// analytics.ts — Completion rate rows
export interface CompletionByBookRow {
  book_title: string;
  total: number;
  completed: number;
}

export interface CompletionByUserRow {
  user_id: string;
  username: string | null;
  student_id: string | null;
  total: number;
  completed: number;
}

// analytics.ts — Attrition by turn row
export interface AttritionByTurnRow {
  abandoned_turn: number;
  cnt: number;
}

// analytics.ts — At risk user row
export interface AtRiskUserRow {
  user_id: string;
  username: string | null;
  student_id: string | null;
  abandoned_count: number;
}

// analytics.ts — Phase attrition row
export interface PhaseAttritionRow {
  current_phase: string;
  cnt: number;
}

// analytics.ts — Ranking row (extended)
export interface PerformanceRankingRow {
  user_id: string;
  username: string | null;
  student_id: string | null;
  grade: number | null;
  total_sessions: number;
  completed_sessions: number;
  avg_logic: number | null;
  best_logic: number | null;
  total_evidence: number;
}

// analytics.ts — Top performer row
export interface TopPerformerRow {
  user_id: string;
  username: string | null;
  avg_logic: number | null;
  sessions: number;
}

// analytics.ts — Response diversity session row
export interface DiversitySessionRow {
  id: string;
  topic: string;
  avg_logic: number | null;
  rating: string | null;
  textual_evidence_cited: number;
  current_turn: number;
  radar_scores: string | null;
  weakness_pattern: string | null;
}

// analytics.ts — Evaluation detail row
export interface EvalDetailRow {
  turn: number;
  defense_score: number;
  consistency_score: number;
  evidence_score: number;
  relevance_score: number;
  clarity_score: number;
  evidence_found: number | boolean;
  fallacy_detected: number | boolean;
  feedback: string | null;
}

// analytics.ts — Radar averages row
export interface RadarAveragesRow {
  defense: number | null;
  consistency: number | null;
  evidence: number | null;
  relevance: number | null;
  clarity: number | null;
}

// dashboard.ts — Weakness count row
export interface WeaknessCountRow {
  weakness: string;
  count: number;
}

// dashboard.ts — Sparring session preview row
export interface SparringSessionPreviewRow {
  id: string;
  book_title: string;
  topic: string;
  avg_logic: number | null;
  rating: string | null;
  current_turn: number;
  max_turns: number;
  is_completed: number | boolean;
  created_at: number;
  radar_scores: string | null;
  has_evaluation?: number | boolean;
}

// dashboard.ts — Radar over time row
export interface RadarOverTimeRow {
  avg_logic: number | null;
  radar_scores: string | null;
  created_at: number;
}

// training.ts — Training message row
export interface TrainingMessageRow {
  role: string;
  content: string;
  turn?: number;
  timestamp?: number;
}

// training.ts — Question bank row
export interface QuestionBankRow {
  id: string;
  category: string;
  question_type: string;
  scenario: string;
  challenge: string;
  expected_tensions: string;
  difficulty: string;
  times_used: number;
  avg_score: number | null;
  created_at: number;
}

// training.ts — Training evaluation (from orchestrator)
export interface TrainingEvaluation {
  claim_clarity: number;
  evidence_use: number;
  reasoning_strength: number;
  consistency: number;
  relevance: number;
  weakness_tags: string[];
  diagnosis: string;
  evidence_source_ids?: string[];
  evidence_detected: string[];
}

// v24: Scenario session row
export interface ScenarioSessionRow {
  id: string;
  user_id: string | null;
  domain: string;
  sub_domain: string | null;
  difficulty: number;
  scenario_json: string;
  data_context_json: string | null;
  status: string;
  current_turn: number;
  final_scores_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// v24: Scenario turn row
export interface ScenarioTurnRow {
  id: string;
  session_id: string;
  turn_number: number;
  user_response: string;
  evaluation_json: string | null;
  next_challenge_json: string | null;
  academic_refs_json: string | null;
  difficulty_at_turn: number | null;
  created_at: number;
}

// v24: Category hierarchy row
export interface CategoryHierarchyRow {
  id: string;
  parent_id: string | null;
  name_ko: string;
  name_en: string;
  icon: string;
  level: number;
  sort_order: number;
  is_active: number | boolean;
  created_at: number;
}

// ===== v26: Talent Snapshot Row =====
export interface TalentSnapshotRow {
  id?: number;
  org_id: string;
  user_id: string;
  username?: string;
  logical_structuring: number;
  data_literacy: number;
  cognitive_flexibility: number;
  business_communication: number;
  hipo_score: number;
  risk_flags_json?: string;
  snapshot_date?: string;
  [key: string]: unknown;
}

// ===== v26: Chat/History Row types =====
export interface ChatLayerState {
  currentLayer: string;
  layerHistory: string[];
  turnsInCurrentLayer: number;
}

export interface SparringSessionListRow {
  id: string;
  book_title?: string;
  topic?: string;
  created_at: string;
  is_completed?: number;
  current_turn?: number;
  avg_logic?: number;
  [key: string]: unknown;
}

export interface TrainingSessionListRow {
  id: string;
  category?: string;
  difficulty?: string;
  question?: string;
  created_at: string;
  is_completed?: number;
  current_turn?: number;
  avg_score?: number;
  [key: string]: unknown;
}

export interface AifNodeRow {
  id?: number;
  node_id?: string;
  text?: string;
  node_type?: string;
  [key: string]: unknown;
}

export interface AifEdgeRow {
  id?: number;
  source_id?: string;
  target_id?: string;
  relation_type?: string;
  [key: string]: unknown;
}

// ===== v26: ArguNet DA Classification =====
export interface DialogueActClassification {
  actType: 'question' | 'claim' | 'evidence' | 'rebuttal' | 'concession' | 'clarification' | 'challenge' | 'counter_claim';
  confidence: number;
  illocutionaryForce: number;
  contextEmbedding?: number[];
  argunetScore?: number;
  llmClassified?: boolean;   // v27: true if classified by LLM
  reasoning?: string;        // v27: LLM classification reasoning
}

// ===== v26: oAMF Pipeline types =====
export interface OAMFProcessResult {
  tokens: string[];
  dialogueActs: DialogueActClassification[];
  arguments: ArgumentNode[];
  relations: ArgumentRelation[];
  xaifGraph: Record<string, unknown>;
}

export interface ArgumentNode {
  id: string;
  text: string;
  type: 'claim' | 'premise' | 'evidence' | 'conclusion';
  confidence: number;
  toulminRole?: 'claim' | 'data' | 'warrant' | 'backing' | 'qualifier' | 'rebuttal';
}

export interface ArgumentRelation {
  sourceId: string;
  targetId: string;
  type: 'support' | 'attack' | 'rebuttal' | 'undercut';
  strength: number;
}

// ===== v26: BKT/LinUCB Hybrid Engine =====
export interface BKTState {
  conceptId: string;
  pKnown: number;
  pLearn: number;
  pGuess: number;
  pSlip: number;
  pForget: number;
  lastUpdated: string;
}

export interface LinUCBArm {
  armId: string;
  theta: number[];
  A: number[][];
  b: number[];
  pullCount: number;
  totalReward: number;
}

export interface HybridKTState {
  userId: string;
  bktStates: Record<string, BKTState>;
  linucbArms: Record<string, LinUCBArm>;
  alpha: number;
  lastAction?: string;
  lastReward?: number;
}

// ===== v26: DDA Engine =====
export interface DDAState {
  currentDifficulty: number;
  successRate: number;
  avgResponseTime: number;
  consecutiveCorrect: number;
  consecutiveWrong: number;
  adjustmentHistory: Array<{ from: number; to: number; reason: string }>;
}

// ===== v26: User Auth Row =====
export interface UserAuthRow {
  id: string;
  username: string;
  email: string;
  password_hash?: string;
  role: string;
  org_id?: string;
  student_id?: string;
  grade?: number;
  created_at?: string;
  deleted_at?: string | null;
  [key: string]: unknown;
}
