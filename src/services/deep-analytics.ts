// Deep Analytics Engine (V2 - Async Queue Architecture)
// Architecture Task 2: Heavy analysis offloaded to async background processing
// 
// Design:
// 1. PRODUCER (chat.ts): When session ends (10 turns), enqueue {sessionId} to Queue
//    and create a 'processing' row in session_deep_reports
// 2. CONSUMER (this file / analytics-worker.ts): Dequeue, run full 18-axis analysis,
//    update DB status to 'completed' or 'failed'
// 3. FRONTEND (html.ts): Poll GET /api/session/:id/deep-report every 5s until completed
//
// Supports both Queue-based execution AND direct ctx.waitUntil() fallback

import { callAIJSON } from './ai-client';
import type { Message } from '../types';

// =============================================
// Type Definitions
// =============================================

export interface DeepAnalyticsResult {
  argGraph: {
    nodes: ArgNode[];
    edges: ArgEdge[];
  };
  microMetrics: Record<string, number>;
  prescriptiveFeedback: string;
  growthTrajectory: string;
  strengths: string[];
  weaknesses: string[];
  status: 'completed' | 'failed';
}

interface ArgNode {
  id: string;
  type: 'claim' | 'evidence' | 'rebuttal' | 'warrant';
  content: string;
  turn: number;
  strength: number; // 0-100
}

interface ArgEdge {
  source: string;
  target: string;
  relation: 'supports' | 'attacks' | 'refines' | 'warrants';
}

export interface DeepReportRow {
  id: string;
  session_id: string;
  status: 'processing' | 'completed' | 'failed';
  arg_graph_json: string | null;
  micro_metrics: string | null;
  prescriptive_feedback: string | null;
  growth_trajectory: string | null;
  strengths_json: string | null;
  weaknesses_json: string | null;
  created_at: number;
  completed_at: number | null;
}

// =============================================
// Queue Message Types
// =============================================

export interface AnalyticsQueueMessage {
  sessionId: string;
  userId: string | null;
  topic: string;
  bookTitle: string;
  coreClaim: string;
  currentClaim: string;
  radarScores: Record<string, number>;
  avgLogic: number;
  totalEvidenceCited: number;
  weaknessPattern: string[];
  conversationHistory: { role: string; content: string; turn: number }[];
}

// =============================================
// Producer: Create Processing Row + Enqueue
// =============================================

/**
 * Initialize a deep report as 'processing' in D1.
 * Called from chat.ts when session ends.
 */
export async function initDeepReport(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  const now = Date.now();
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO session_deep_reports (id, session_id, status, created_at)
      VALUES (?1, ?2, 'processing', ?3)
    `).bind(`report_${sessionId}`, sessionId, now).run();
  } catch (error) {
    console.error('[DEEP_ANALYTICS] Failed to init deep report row:', error);
  }
}

/**
 * Enqueue a deep analytics job. If Queue binding unavailable, returns false.
 */
export async function enqueueDeepAnalytics(
  queue: Queue<AnalyticsQueueMessage> | undefined, // v23: properly typed Queue binding
  message: AnalyticsQueueMessage,
): Promise<boolean> {
  if (!queue) {
    console.warn('[DEEP_ANALYTICS] Queue binding not available');
    return false;
  }

  try {
    await queue.send(message);
    return true;
  } catch (error) {
    console.error('[DEEP_ANALYTICS] Queue send failed:', error);
    return false;
  }
}

// =============================================
// Consumer: Run Deep Analysis
// =============================================

/**
 * Run deep analytics - the main analysis function
 * Can be called from Queue consumer OR ctx.waitUntil()
 */
export async function runDeepAnalytics(
  db: D1Database,
  sessionId: string,
  conversationHistory: Message[] | { role: string; content: string; turn: number }[],
  sessionContext: {
    topic?: string;
    bookTitle?: string;
    coreClaim?: string;
    currentClaim?: string;
    radarScores?: Record<string, number>;
    avgLogic?: number;
    totalEvidenceCited?: number;
    weaknessPattern?: string[];
  },
  apiKey: string,
  fallbackApiKey?: string,
): Promise<DeepAnalyticsResult> {
  try {
    // Build conversation transcript
    const transcript = conversationHistory
      .map(m => `[Turn ${m.turn}] ${m.role === 'ai' ? 'AI' : '학생'}: ${m.content}`)
      .join('\n');

    const radarStr = sessionContext.radarScores
      ? Object.entries(sessionContext.radarScores).map(([k, v]) => `${k}=${v}`).join(', ')
      : 'N/A';

    // Comprehensive analysis call with 18+ metrics
    const result = await callAIJSON<{
      argNodes: { type: string; content: string; turn: number; strength: number }[];
      argEdges: { sourceIdx: number; targetIdx: number; relation: string }[];
      microMetrics: Record<string, number>;
      prescriptiveFeedback: string;
      growthTrajectory: string;
      strengths: string[];
      weaknesses: string[];
    }>(
      apiKey,
      fallbackApiKey,
      `당신은 논증 분석 전문가입니다. 소크라테스식 독서 토론 대화를 심층 분석하여 논증 구조와 세부 역량 지표를 추출합니다.

## 분석 항목

### 1. 논증 그래프 (ArgTech)
학생의 주장(claim), 근거(evidence), 반박(rebuttal), 추론 보증(warrant)을 노드로 추출하고 관계를 연결하세요.

### 2. 마이크로 지표 (각 0-100점, 총 18축)
- question_understanding: 질문 이해도
- text_alignment: 텍스트 정합성
- warrant_explicitness: 추론 보증 명시성
- counterexample_handling: 반례 대응력
- stakeholder_awareness: 이해관계자 인식
- tradeoff_recognition: 트레이드오프 인식
- feasibility_judgment: 실현가능성 판단
- self_correction: 자기수정 능력
- topic_focus: 주제 집중도
- specificity: 구체성
- evidence_precision: 근거 정확도
- evidence_diversity: 근거 다양성
- assumption_awareness: 전제 인식
- rebuttal_quality: 반론 품질
- synthesis_quality: 종합 품질
- causal_reasoning: 인과 추론
- normative_reasoning: 규범 추론
- citation_reliability: 인용 신뢰도

### 3. 처방적 피드백
다음 세션에서 반드시 개선해야 할 핵심 3가지를 한국어로 상세히 작성하세요.

### 4. 성장 궤적
초기(1-2턴) → 중간(5-6턴) → 최종(9-10턴)으로 학생의 사고가 어떻게 변화했는지 서술하세요.

### 5. 강점/약점 목록
각각 2-4개, 구체적 턴 번호와 함께 한국어로 서술하세요.

한국어로 응답하세요. 반드시 JSON으로 응답하세요.`,
      `## 세션 정보
토픽: ${sessionContext.topic || 'N/A'}
도서: ${sessionContext.bookTitle || 'N/A'}
초기 주장: ${sessionContext.coreClaim || 'N/A'}
최종 주장: ${sessionContext.currentClaim || 'N/A'}
5축 레이더: ${radarStr}
평균 논리 점수: ${sessionContext.avgLogic || 0}%
근거 인용 횟수: ${sessionContext.totalEvidenceCited || 0}
약점 패턴: ${(sessionContext.weaknessPattern || []).join(', ') || '없음'}

## 전체 대화 기록
${transcript}

## 응답 형식
{
  "argNodes": [{"type": "claim|evidence|rebuttal|warrant", "content": "내용", "turn": 1, "strength": 0-100}],
  "argEdges": [{"sourceIdx": 0, "targetIdx": 1, "relation": "supports|attacks|refines|warrants"}],
  "microMetrics": {"question_understanding": 0-100, "text_alignment": 0-100, ...18개 전부},
  "prescriptiveFeedback": "처방적 피드백 (3가지 상세 서술)",
  "growthTrajectory": "성장 궤적 서술",
  "strengths": ["강점 1", "강점 2", ...],
  "weaknesses": ["약점 1", "약점 2", ...]
}`,
      { temperature: 0.3, maxTokens: 3000 },
    );

    // Normalize result
    const nodes: ArgNode[] = (result.argNodes || []).map((n, i) => ({
      id: `node_${i}`,
      type: (['claim', 'evidence', 'rebuttal', 'warrant'].includes(n.type) ? n.type : 'claim') as ArgNode['type'],
      content: n.content || '',
      turn: n.turn || 0,
      strength: Math.max(0, Math.min(100, n.strength || 50)),
    }));

    const edges: ArgEdge[] = (result.argEdges || []).map(e => ({
      source: `node_${e.sourceIdx}`,
      target: `node_${e.targetIdx}`,
      relation: (['supports', 'attacks', 'refines', 'warrants'].includes(e.relation) ? e.relation : 'supports') as ArgEdge['relation'],
    }));

    const analytics: DeepAnalyticsResult = {
      argGraph: { nodes, edges },
      microMetrics: result.microMetrics || {},
      prescriptiveFeedback: result.prescriptiveFeedback || '',
      growthTrajectory: result.growthTrajectory || '',
      strengths: result.strengths || [],
      weaknesses: result.weaknesses || [],
      status: 'completed',
    };

    // Save completed result to DB
    await saveDeepReport(db, sessionId, analytics);

    return analytics;
  } catch (error) {
    console.error('[DEEP_ANALYTICS] Analysis failed:', error);

    // Mark as failed in DB
    try {
      await db.prepare(`
        UPDATE session_deep_reports SET status = 'failed', completed_at = ?2
        WHERE session_id = ?1
      `).bind(sessionId, Date.now()).run();
    } catch (e) { console.error('[P1-004] ignored:', e); }

    return {
      argGraph: { nodes: [], edges: [] },
      microMetrics: {},
      prescriptiveFeedback: '',
      growthTrajectory: '',
      strengths: [],
      weaknesses: [],
      status: 'failed',
    };
  }
}

// =============================================
// DB Operations
// =============================================

async function saveDeepReport(
  db: D1Database,
  sessionId: string,
  analytics: DeepAnalyticsResult,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO session_deep_reports 
        (id, session_id, status, arg_graph_json, micro_metrics, prescriptive_feedback, growth_trajectory, strengths_json, weaknesses_json, created_at, completed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(
      `report_${sessionId}`,
      sessionId,
      'completed',
      JSON.stringify(analytics.argGraph),
      JSON.stringify(analytics.microMetrics),
      analytics.prescriptiveFeedback,
      analytics.growthTrajectory,
      JSON.stringify(analytics.strengths),
      JSON.stringify(analytics.weaknesses),
      Date.now(),
      Date.now(),
    ).run();
  } catch (dbErr) {
    console.error('[DEEP_ANALYTICS] DB save error:', dbErr);
  }
}

/**
 * Get the deep report status/data for a session
 */
export async function getDeepReport(
  db: D1Database,
  sessionId: string,
): Promise<DeepReportRow | null> {
  try {
    const row = await db.prepare(
      'SELECT * FROM session_deep_reports WHERE session_id = ?1'
    ).bind(sessionId).first<DeepReportRow>();
    return row || null;
  } catch (e) { console.error("[P1-004] Caught:", e);
    return null;
  }
}
