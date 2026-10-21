// SocraticAI v13.0 - Token Usage Tracking Service
// Tracks per-call token usage, estimates credits/cost, aggregates daily stats
// Integration: ai-client.ts hooks → logTokenUsage() → DB (token_usage_log + token_usage_daily)

export interface TokenUsageRecord {
  sessionId: string;
  userId: string | null;
  turnNumber: number;
  callType: 'evaluate' | 'mentor' | 'critic' | 'researcher' | 'fallback' | 'session_report';
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  isFallback: boolean;
  isCached: boolean;
}

// 모델별 크레딧 단가 (100K 토큰당, 추정치 - 숭실대 API 관리자 확인 후 조정)
// 500 크레딧 = 1,000원 (1 크레딧 = 2원)
const MODEL_CREDIT_RATES: Record<string, { input: number; output: number }> = {
  'gpt-5.6-luna':   { input: 10, output: 25 },
  'gpt-5.6-terra':  { input: 20, output: 50 },
  'gpt-5.6-sol':    { input: 75, output: 150 },
  'gpt-5.4-mini':   { input: 20, output: 50 },
  'gpt-5.4':        { input: 75, output: 150 },
  'gpt-5.3-chat-latest': { input: 50, output: 100 },
  'gpt-5.2':        { input: 40, output: 80 },
  'gpt-5':          { input: 60, output: 120 },
  'gpt-5-mini':     { input: 15, output: 35 },
  'claude-sonnet-4-6':   { input: 45, output: 112 },
  'claude-opus-4-6':     { input: 150, output: 375 },
  'gemini-3.1-pro-preview': { input: 30, output: 60 },
  'gemini-3.1-flash-lite-preview': { input: 5, output: 15 },
  'gemini-2.5-flash': { input: 5, output: 15 },
  'grok-4':          { input: 60, output: 120 },
  'grok-4-1-fast':   { input: 40, output: 80 },
  'google/gemma-4-31b-it': { input: 8, output: 16 },
  'stepfun/step-3.7-flash': { input: 8, output: 16 },
  'inclusionai/ling-3.0-flash': { input: 8, output: 16 },
  'openai/gpt-oss-120b': { input: 12, output: 24 },
  'deepseek-v4-flash': { input: 8, output: 16 },
  'deepseek-v4-pro': { input: 20, output: 40 },
};

/**
 * Estimate credits consumed for a given model and token counts
 */
export function estimateCredits(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = MODEL_CREDIT_RATES[model] || { input: 10, output: 25 };
  return (promptTokens / 100000) * rate.input + (completionTokens / 100000) * rate.output;
}

/**
 * Convert credits to KRW (1 크레딧 = 2원)
 */
export function creditsToKRW(credits: number): number {
  return Math.round(credits * 2 * 100) / 100;
}

/**
 * Log a single LLM call's token usage to DB (non-blocking)
 */
export async function logTokenUsage(
  db: D1Database,
  record: TokenUsageRecord,
): Promise<void> {
  const estimatedCredits = estimateCredits(
    record.modelUsed,
    record.promptTokens,
    record.completionTokens,
  );

  // 1. 상세 로그 저장
  await db.prepare(`
    INSERT INTO token_usage_log 
    (session_id, user_id, turn_number, call_type, model_used,
     prompt_tokens, completion_tokens, total_tokens,
     estimated_credits, latency_ms, is_fallback, is_cached)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `).bind(
    record.sessionId, record.userId, record.turnNumber,
    record.callType, record.modelUsed,
    record.promptTokens, record.completionTokens, record.totalTokens,
    estimatedCredits, record.latencyMs, record.isFallback ? 1 : 0,
    record.isCached ? 1 : 0,
  ).run();

  // 2. 일별 집계 UPSERT
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(`
    INSERT INTO token_usage_daily 
    (user_id, date, model, total_calls, total_prompt_tokens, 
     total_completion_tokens, total_tokens, total_estimated_credits,
     fallback_count, avg_latency_ms)
    VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(user_id, date, model) DO UPDATE SET
      total_calls = total_calls + 1,
      total_prompt_tokens = total_prompt_tokens + ?4,
      total_completion_tokens = total_completion_tokens + ?5,
      total_tokens = total_tokens + ?6,
      total_estimated_credits = total_estimated_credits + ?7,
      fallback_count = fallback_count + ?8,
      avg_latency_ms = (avg_latency_ms * total_calls + ?9) / (total_calls + 1)
  `).bind(
    record.userId || 'anonymous', today, record.modelUsed,
    record.promptTokens, record.completionTokens, record.totalTokens,
    estimatedCredits, record.isFallback ? 1 : 0, record.latencyMs,
  ).run();
}

// =============================================
// Admin Dashboard Query Functions
// =============================================

// PATCH-003: BUG-001 fix — safe default on query failure + pre-computed cutoff date
export async function getGlobalTokenSummary(
  db: D1Database,
  days: number = 30,
): Promise<any> {
  try {
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    return await db.prepare(`
      SELECT 
        date,
        model,
        SUM(total_tokens) as tokens,
        SUM(total_estimated_credits) as credits,
        SUM(total_calls) as calls,
        SUM(fallback_count) as fallbacks
      FROM token_usage_daily
      WHERE date >= ?1
      GROUP BY date, model
      ORDER BY date DESC
    `).bind(cutoffDate).all();
  } catch (e) {
    console.warn('[TOKEN_SUMMARY] Query failed, returning empty:', e);
    return { results: [] };
  }
}

export async function getUserTokenSummary(
  db: D1Database,
  userId: string,
  days: number = 30,
): Promise<any> {
  // PATCH-NEW-001: Fix D1 date binding — pre-compute cutoff date string
  // D1 doesn't support string concatenation in date() via bound parameters
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
  return db.prepare(`
    SELECT 
      user_id,
      SUM(total_tokens) as total_tokens,
      SUM(total_estimated_credits) as total_credits,
      SUM(total_calls) as total_calls,
      AVG(avg_latency_ms) as avg_latency,
      SUM(fallback_count) as total_fallbacks
    FROM token_usage_daily
    WHERE user_id = ?1 AND date >= ?2
    GROUP BY user_id
  `).bind(userId, cutoffDate).first();
}

export async function getTopConsumers(
  db: D1Database,
  limit: number = 20,
): Promise<any> {
  return db.prepare(`
    SELECT 
      user_id,
      SUM(total_tokens) as total_tokens,
      SUM(total_estimated_credits) as total_credits,
      SUM(total_calls) as total_calls,
      COUNT(DISTINCT date) as active_days
    FROM token_usage_daily
    WHERE date >= date('now', '-30 days')
    GROUP BY user_id
    ORDER BY total_tokens DESC
    LIMIT ?1
  `).bind(limit).all();
}

export async function getSessionTokenUsage(
  db: D1Database,
  sessionId: string,
): Promise<any> {
  return db.prepare(`
    SELECT 
      call_type,
      model_used,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(estimated_credits) as estimated_credits,
      COUNT(*) as call_count,
      AVG(latency_ms) as avg_latency,
      SUM(is_fallback) as fallback_count,
      SUM(is_cached) as cached_count
    FROM token_usage_log
    WHERE session_id = ?1
    GROUP BY call_type, model_used
    ORDER BY total_tokens DESC
  `).bind(sessionId).all();
}

/**
 * Get today's total cost for cost alerting
 */
export async function getTodayCostSummary(
  db: D1Database,
): Promise<{ totalCredits: number; totalKRW: number; totalCalls: number }> {
  const today = new Date().toISOString().split('T')[0];
  const result = await db.prepare(`
    SELECT 
      COALESCE(SUM(total_estimated_credits), 0) as credits,
      COALESCE(SUM(total_calls), 0) as calls
    FROM token_usage_daily
    WHERE date = ?1
  `).bind(today).first<{ credits: number; tokens: number; calls: number }>();

  return {
    totalCredits: result?.credits || 0,
    totalKRW: creditsToKRW(result?.credits || 0),
    totalCalls: result?.calls || 0,
  };
}
