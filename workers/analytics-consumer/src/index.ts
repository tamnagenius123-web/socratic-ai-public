/**
 * SocraticAI Analytics Consumer Worker (v23)
 * 
 * Consumes messages from socratic-analytics-queue
 * Runs 18-axis deep analysis in background context
 * 
 * Architecture:
 * - Separate Worker project (NOT part of Pages Functions)
 * - Queue consumer with DLQ for failed messages
 * - D1 shared database binding for report storage
 * - 3 retries before dead-lettering
 */

// =============================================
// Type Definitions
// =============================================

interface Env {
  DB: D1Database;
  SOONGSIL_API_KEY: string;
  GEMINI_API_KEY: string;
}

interface AnalyticsQueueMessage {
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

interface DeepAnalysisResult {
  argNodes: { type: string; content: string; turn: number; strength: number }[];
  argEdges: { sourceIdx: number; targetIdx: number; relation: string }[];
  microMetrics: Record<string, number>;
  prescriptiveFeedback: string;
  growthTrajectory: string;
  strengths: string[];
  weaknesses: string[];
}

// =============================================
// Worker Export
// =============================================

export default {
  async queue(batch: MessageBatch<AnalyticsQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const data = message.body;
      
      try {
        console.log(`[CONSUMER] Processing session: ${data.sessionId} (attempt ${message.attempts})`);
        
        const apiKey = env.SOONGSIL_API_KEY || env.GEMINI_API_KEY;
        const fallbackKey = env.SOONGSIL_API_KEY ? env.GEMINI_API_KEY : undefined;

        await runDeepAnalytics(env.DB, data, apiKey, fallbackKey);

        message.ack();
        console.log(`[CONSUMER] Completed session: ${data.sessionId}`);
      } catch (error) {
        console.error(
          `[CONSUMER] Failed session: ${data.sessionId} (attempt ${message.attempts}); retrying`,
          error,
        );
        message.retry();
      }
    }
  },
};

// =============================================
// Deep Analytics Engine (Ported from main app)
// =============================================

async function runDeepAnalytics(
  db: D1Database,
  data: AnalyticsQueueMessage,
  apiKey: string,
  fallbackKey?: string,
): Promise<void> {
  const transcript = data.conversationHistory
    .map(m => `[Turn ${m.turn}] ${m.role === 'ai' ? 'AI' : '학생'}: ${m.content}`)
    .join('\n');

  const radarStr = data.radarScores
    ? Object.entries(data.radarScores).map(([k, v]) => `${k}=${v}`).join(', ')
    : 'N/A';

  const systemPrompt = `당신은 논증 분석 전문가입니다. 소크라테스식 독서 토론 대화를 심층 분석하여 논증 구조와 세부 역량 지표를 추출합니다.

## 분석 항목

### 1. 논증 그래프 (ArgTech)
학생의 주장(claim), 근거(evidence), 반박(rebuttal), 추론 보증(warrant)을 노드로 추출하고 관계를 연결하세요.

### 2. 마이크로 지표 (각 0-100점, 총 18축)
question_understanding, text_alignment, warrant_explicitness, counterexample_handling,
stakeholder_awareness, tradeoff_recognition, feasibility_judgment, self_correction,
topic_focus, specificity, evidence_precision, evidence_diversity, assumption_awareness,
rebuttal_quality, synthesis_quality, causal_reasoning, normative_reasoning, citation_reliability

### 3. 처방적 피드백, 성장 궤적, 강점/약점 목록
한국어로 응답하세요. 반드시 JSON으로 응답하세요.`;

  const userPrompt = `## 세션 정보
토픽: ${data.topic || 'N/A'}
도서: ${data.bookTitle || 'N/A'}
초기 주장: ${data.coreClaim || 'N/A'}
최종 주장: ${data.currentClaim || 'N/A'}
5축 레이더: ${radarStr}
평균 논리 점수: ${data.avgLogic || 0}%
근거 인용 횟수: ${data.totalEvidenceCited || 0}
약점 패턴: ${(data.weaknessPattern || []).join(', ') || '없음'}

## 전체 대화 기록
${transcript}

## 응답 형식
{
  "argNodes": [{"type": "claim|evidence|rebuttal|warrant", "content": "내용", "turn": 1, "strength": 0-100}],
  "argEdges": [{"sourceIdx": 0, "targetIdx": 1, "relation": "supports|attacks|refines|warrants"}],
  "microMetrics": {"question_understanding": 0-100, ...18개 전부},
  "prescriptiveFeedback": "처방적 피드백",
  "growthTrajectory": "성장 궤적 서술",
  "strengths": ["강점 1", ...],
  "weaknesses": ["약점 1", ...]
}`;

  try {
    const result = await callAI(apiKey, fallbackKey, systemPrompt, userPrompt);
    
    // Normalize nodes and edges
    const nodes = (result.argNodes || []).map((n: DeepAnalysisResult['argNodes'][0], i: number) => ({
      id: `node_${i}`,
      type: ['claim', 'evidence', 'rebuttal', 'warrant'].includes(n.type) ? n.type : 'claim',
      content: n.content || '',
      turn: n.turn || 0,
      strength: Math.max(0, Math.min(100, n.strength || 50)),
    }));

    const edges = (result.argEdges || []).map((e: DeepAnalysisResult['argEdges'][0]) => ({
      source: `node_${e.sourceIdx}`,
      target: `node_${e.targetIdx}`,
      relation: ['supports', 'attacks', 'refines', 'warrants'].includes(e.relation) ? e.relation : 'supports',
    }));

    // Save to D1 (batch-safe: single INSERT OR REPLACE)
    await db.prepare(`
      INSERT OR REPLACE INTO session_deep_reports 
        (id, session_id, status, arg_graph_json, micro_metrics, prescriptive_feedback, growth_trajectory, strengths_json, weaknesses_json, created_at, completed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).bind(
      `report_${data.sessionId}`,
      data.sessionId,
      'completed',
      JSON.stringify({ nodes, edges }),
      JSON.stringify(result.microMetrics || {}),
      result.prescriptiveFeedback || '',
      result.growthTrajectory || '',
      JSON.stringify(result.strengths || []),
      JSON.stringify(result.weaknesses || []),
      Date.now(),
      Date.now(),
    ).run();
  } catch (error) {
    // Mark as failed
    await db.prepare(`
      UPDATE session_deep_reports SET status = 'failed', completed_at = ?2
      WHERE session_id = ?1
    `).bind(data.sessionId, Date.now()).run().catch(() => {});
    
    throw error; // Re-throw for retry mechanism
  }
}

// =============================================
// AI Client (Simplified for Worker)
// =============================================

async function callAI(
  primaryKey: string,
  fallbackKey: string | undefined,
  systemPrompt: string,
  userPrompt: string,
): Promise<DeepAnalysisResult> {
  const keys = [primaryKey, fallbackKey].filter(Boolean) as string[];
  
  for (const key of keys) {
    try {
      // Try Soongsil API Gateway format
      const isGemini = key.startsWith('AIza');
      
      if (isGemini) {
        return await callGemini(key, systemPrompt, userPrompt);
      } else {
        return await callOpenAICompatible(key, systemPrompt, userPrompt);
      }
    } catch (e) {
      console.warn(`[CONSUMER_AI] API call failed, trying next key...`, e);
    }
  }
  
  throw new Error('All AI API keys failed');
}

async function callOpenAICompatible(apiKey: string, system: string, user: string): Promise<DeepAnalysisResult> {
  const res = await fetch('https://api.soongsil.ac.kr/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const json = await res.json() as { choices: { message: { content: string } }[] };
  return JSON.parse(json.choices[0].message.content);
}

async function callGemini(apiKey: string, system: string, user: string): Promise<DeepAnalysisResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json',
        },
      }),
    },
  );

  if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
  const json = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  return JSON.parse(json.candidates[0].content.parts[0].text);
}
