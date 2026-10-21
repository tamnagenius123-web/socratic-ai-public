// SocraticAI v35.1 - Unified AI Client (DeepSeek v4 + Provider Registry)
// 3-Tier Provider Cascade: DeepSeek v4 Pro → Gemini 2.5 Flash → Legacy Fallback
// Provider Registry Pattern: Extensible, auto-fallback, AI Gateway compatible
// Thinking Mode: DeepSeek Reasoner chain-of-thought reasoning with budget control
// Pure fetch-based (no npm openai package needed).

import { estimateCredits, logTokenUsage } from './token-tracker';
import { postOpenAICompatible } from './ai-router';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  response_format?: { type: string };
  tools?: ToolDefinition[];
  tool_choice?: string | { type: string; function: { name: string } };
  // DeepSeek v4 accepts an explicit disabled state; enabled remains available
  // only for legacy callers that explicitly opt into it.
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
}

export interface ChatCompletionResponse {
  id: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      // Provider reasoning content, if one is returned.
      reasoning_content?: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    // Provider reasoning tokens, if one is returned.
    thinking_tokens?: number;
  };
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// =============================================
// Provider Registry — DeepSeek v4-first legacy cascade
// =============================================

interface AIProvider {
  name: string;
  baseUrl: string;
  model: string;
  envKeyName: string;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsStructuredOutput: boolean;
  supportsThinking: boolean;
  tier: 'primary' | 'fallback' | 'budget';
}

const PROVIDERS: AIProvider[] = [
  // DeepSeek v4 Pro (assessment/reasoning legacy fallback; no thinking opt-in)
  {
    name: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    envKeyName: 'DEEPSEEK_API_KEY',
    supportsTools: false,
    supportsJsonMode: true,
    supportsStructuredOutput: false,
    supportsThinking: false,
    tier: 'primary',
  },
  // DeepSeek v4 Flash (fast legacy fallback; no thinking opt-in)
  {
    name: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    envKeyName: 'DEEPSEEK_API_KEY',
    supportsTools: true,
    supportsJsonMode: true,
    supportsStructuredOutput: false,
    supportsThinking: false,
    tier: 'primary',
  },
  // Gemini 2.5 Flash (fallback — free tier)
  {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    envKeyName: 'GEMINI_API_KEY',
    supportsTools: false,
    supportsJsonMode: true,
    supportsStructuredOutput: false,
    supportsThinking: false,
    tier: 'fallback',
  },
  // Legacy: Sungshin Univ (backward compat — will be phased out)
  {
    name: 'sungshin',
    baseUrl: 'https://factchat-cloud.mindlogic.ai/v1/gateway',
    model: 'gpt-5.6-luna',
    envKeyName: 'SOONGSIL_API_KEY',
    supportsTools: true,
    supportsJsonMode: true,
    supportsStructuredOutput: false,
    supportsThinking: false,
    tier: 'budget',
  },
];

function getProviderByName(name: string): AIProvider | undefined {
  return PROVIDERS.find(p => p.name === name);
}

function getAvailableProviders(env?: Record<string, any>): AIProvider[] {
  if (!env) return [PROVIDERS[0]];
  return PROVIDERS.filter(p => {
    const key = env[p.envKeyName];
    return key && typeof key === 'string' && key.length > 5;
  });
}

// v34: Select the best provider for a given task
function selectProviderForTask(
  env: Record<string, any>,
  options: { useThinking?: boolean; needsTools?: boolean; preferFast?: boolean } = {}
): AIProvider[] {
  const available = getAvailableProviders(env);
  
  if (options.useThinking) {
    // No legacy provider opts into thinking; preserve the non-thinking order.
    const thinkingProviders = available.filter(p => p.supportsThinking);
    const fallbacks = available.filter(p => !p.supportsThinking);
    return [...thinkingProviders, ...fallbacks];
  }
  
  if (options.needsTools) {
    // Tools needed: prefer providers that support tools
    const toolProviders = available.filter(p => p.supportsTools);
    const others = available.filter(p => !p.supportsTools);
    return [...toolProviders, ...others];
  }
  
  if (options.preferFast) {
    // Fast mode: prefer DeepSeek v4 Flash or Gemini.
    const fast = available.filter(p => p.name === 'deepseek-v4-flash' || p.name === 'gemini');
    const rest = available.filter(p => !fast.includes(p));
    return [...fast, ...rest];
  }
  
  // Default order: DeepSeek v4 Pro → DeepSeek v4 Flash → Gemini → Sungshin.
  return available.sort((a, b) => {
    const order = ['deepseek-v4-pro', 'deepseek-v4-flash', 'gemini', 'sungshin'];
    return order.indexOf(a.name) - order.indexOf(b.name);
  });
}

// Backwards-compat aliases (to be removed in v35)
const SOONGSIL_BASE_URL = PROVIDERS.find(p => p.name === 'sungshin')?.baseUrl || '';
const GEMINI_OPENAI_BASE_URL = PROVIDERS.find(p => p.name === 'gemini')?.baseUrl || '';
const DEFAULT_PRIMARY_MODEL = 'gpt-5.6-luna';
const DEFAULT_FALLBACK_MODEL = 'gemini-2.5-flash';

// =============================================
// Prompt Cache — Stable prefix for cost reduction
// =============================================

const SYSTEM_PROMPT_PREFIX = `You are SocraticAI, a Socratic-method AI tutor for critical reading and argumentation.
You follow the D-Plan 6-phase tutoring model: elicitation → grounding → reasoning → counterexample → revision → synthesis.
You NEVER reveal answers directly. You use probing questions to guide the student.
Your evaluation output must always be valid JSON.
`;

export function buildCachedSystemPrompt(taskSpecificSuffix: string): string {
  return SYSTEM_PROMPT_PREFIX + taskSpecificSuffix;
}

/**
 * Get primary model from environment or use default.
 */
export function getPrimaryModel(env?: Record<string, any>): string {
  return env?.AI_PRIMARY_MODEL || DEFAULT_PRIMARY_MODEL;
}

/**
 * Get fallback model from environment or use default.
 */
export function getFallbackModel(env?: Record<string, any>): string {
  return env?.AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
}

/**
 * Classify AI error for telemetry / debugging.
 */
const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

export class AIProviderTimeoutError extends Error {
  constructor() {
    super('AI provider request timed out. Please try again.');
    this.name = 'AIProviderTimeoutError';
  }
}

export function classifyAIError(error: unknown): string {
  if (error instanceof AIProviderTimeoutError) return 'timeout';
  const msg = String((error as any)?.message || '');
  const status = (error as any)?.status;
  if (status === 404 || msg.includes('model_not_found')) return 'model_not_found';
  if (status === 429 || msg.includes('quota')) return 'quota_exceeded';
  if (status === 400 && msg.includes('json')) return 'invalid_json_mode';
  if (status === 400) return 'bad_request';
  if (msg.includes('timeout') || msg.includes('TIMEOUT')) return 'timeout';
  if (msg.includes('network') || msg.includes('fetch')) return 'network_error';
  return 'unknown_error';
}

export class AIJSONParseError extends Error {
  rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = 'AIJSONParseError';
    this.rawResponse = rawResponse;
  }
}

export async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  return postOpenAICompatible(baseUrl, apiKey, request);
}

function isQuotaExceeded(error: unknown): boolean {
  return (error as any)?.status === 429 || String((error as any)?.message || '').includes('quota');
}

// =============================================
// Phase 2: Robust JSON Repair Pipeline
// =============================================

export function repairJSON(raw: string): string {
  if (!raw || typeof raw !== 'string') return raw;

  let s = raw.trim();

  // Step 1: Remove BOM and zero-width chars
  s = s.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Step 2: Remove fenced code blocks
  const fencedMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch) {
    s = fencedMatch[1].trim();
  }

  // Step 3: Normalize smart/curly quotes
  s = s.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
  s = s.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");

  // Step 4: Remove control characters
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Step 5: Extract first JSON object
  const firstBrace = s.indexOf('{');
  if (firstBrace > 0) {
    s = s.substring(firstBrace);
  }

  // Step 6: Remove trailing commas
  s = s.replace(/,\s*([\]}])/g, '$1');

  // Step 7: Fix unescaped newlines inside strings
  s = s.replace(/(?<=:"[^"]*)\n(?=[^"]*")/g, '\\n');

  // Step 8: Balance braces
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    if (ch === '}') openBraces--;
    if (ch === '[') openBrackets++;
    if (ch === ']') openBrackets--;
  }
  while (openBrackets > 0) { s += ']'; openBrackets--; }
  while (openBraces > 0) { s += '}'; openBraces--; }

  // Step 9: Remove trailing text
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < s.length - 1) {
    const after = s.substring(lastBrace + 1).trim();
    if (after && !after.startsWith(',') && !after.startsWith(']')) {
      s = s.substring(0, lastBrace + 1);
    }
  }

  return s;
}

export function robustJSONParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) { console.error('[JSON_REPAIR] direct parse failed:', e); }

  const repaired = repairJSON(raw);
  try {
    return JSON.parse(repaired) as T;
  } catch (e) { console.error('[JSON_REPAIR] repaired parse failed:', e); }

  const jsonMatch = raw.match(/```json?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      return JSON.parse(repairJSON(jsonMatch[1].trim())) as T;
    } catch (e) { console.error('[JSON_REPAIR] fenced parse failed:', e); }
  }

  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(repairJSON(objMatch[0])) as T;
    } catch (e) { console.error('[JSON_REPAIR] object extract failed:', e); }
  }

  throw new AIJSONParseError(
    `Failed to parse AI response as JSON after repair: ${raw.substring(0, 200)}`,
    raw,
  );
}

// =============================================
// callAI - Main entry point with DeepSeek-first cascade
// =============================================

export interface TokenTrackingContext {
  db: D1Database;
  sessionId: string;
  userId: string | null;
  turnNumber: number;
  callType: 'evaluate' | 'mentor' | 'critic' | 'researcher' | 'fallback' | 'session_report';
}

let _trackingCtx: TokenTrackingContext | null = null;
let _requestId: string = '';

export function setTokenTrackingContext(ctx: TokenTrackingContext | null): void {
  _trackingCtx = ctx;
  if (ctx) {
    _requestId = `${ctx.sessionId}_${ctx.turnNumber}_${Date.now()}`;
  }
}

export function getTokenTrackingContext(): TokenTrackingContext | null {
  return _trackingCtx;
}

let _requestTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCredits: number; callCount: number; models: string[] } = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCredits: 0, callCount: 0, models: [] };

export function resetRequestTokenUsage(): void {
  _requestTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCredits: 0, callCount: 0, models: [] };
  _trackingCtx = null;
}

export function getRequestTokenUsage() {
  return { ..._requestTokenUsage };
}

// =============================================
// v34: New callAI with backward compatibility
// =============================================
// Signature: callAI(soongsilApiKey, geminiApiKey, systemPrompt, userMessage, options)
// The first arg is now treated as an assessment DeepSeek or legacy SSU key depending on format.
// This maintains backward compatibility with all existing call sites.

export async function callAI(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  systemPrompt: string,
  userMessage: string,
  options: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    tools?: ToolDefinition[];
    toolChoice?: string | { type: string; function: { name: string } };
    env?: Record<string, any>;
    // Legacy callers may request deeper reasoning; v4 routes keep thinking disabled.
    useThinking?: boolean;
    thinkingBudget?: number;
    preferFast?: boolean;
  } = {},
): Promise<{ content: string; toolCalls?: ToolCall[]; usage?: ChatCompletionResponse['usage']; provider?: string; model?: string; thinkingContent?: string }> {

  if (import.meta.env.VITE_LOCAL_E2E_HARNESS === '1') {
    throw new Error('External AI providers are disabled in a local E2E harness build');
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const env = options.env || {};
  
  // Build provider list with DeepSeek v4 priority.
  const providersToTry: { name: string; baseUrl: string; apiKey: string; model: string; supportsTools: boolean; supportsThinking: boolean }[] = [];

  // Detect DeepSeek API key from env or first argument
  const deepseekKey = env.DEEPSEEK_API_KEY;
  const soongsilKey = soongsilApiKey;
  const geminiKey = geminiApiKey || env.GEMINI_API_KEY;

  // Tier 1 — DeepSeek v4 (primary legacy compatibility path)
  if (deepseekKey) {
    if (options.useThinking !== false && !options.preferFast) {
      // DeepSeek v4 Pro. Do not request provider thinking in this compatibility path.
      providersToTry.push({
        name: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        apiKey: deepseekKey,
        model: 'deepseek-v4-pro',
        supportsTools: false,
        supportsThinking: false,
      });
    }
    // DeepSeek v4 Flash (fast, non-thinking)
    providersToTry.push({
      name: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: deepseekKey,
      model: 'deepseek-v4-flash',
      supportsTools: true,
      supportsThinking: false,
    });
  }

  // Tier 2: Gemini (fallback)
  if (geminiKey) {
    providersToTry.push({
      name: 'gemini',
      baseUrl: GEMINI_OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: geminiKey,
      model: getFallbackModel(env),
      supportsTools: false,
      supportsThinking: false,
    });
  }

  // Tier 3: Legacy Sungshin (backward compat)
  if (soongsilKey && soongsilKey !== deepseekKey) {
    providersToTry.push({
      name: 'sungshin',
      baseUrl: SOONGSIL_BASE_URL || 'https://factchat-cloud.mindlogic.ai/v1/gateway',
      apiKey: soongsilKey,
      model: getPrimaryModel(env),
      supportsTools: true,
      supportsThinking: false,
    });
  }

  if (providersToTry.length === 0) {
    throw new Error('No AI provider API keys configured (DEEPSEEK_API_KEY, GEMINI_API_KEY, or SOONGSIL_API_KEY required)');
  }

  let lastError: unknown = null;

  for (let i = 0; i < providersToTry.length; i++) {
    const provider = providersToTry[i];
    const isFallback = i > 0;
    const startTime = Date.now();

    const request: ChatCompletionRequest = {
      model: provider.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    };

    // Legacy thinking is only sent if a future provider explicitly enables it.
    if (provider.supportsThinking && options.useThinking !== false) {
      request.thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget ?? 8192,
      };
      // DeepSeek reasoner with thinking requires temperature=0 for some modes
      // But we allow user override
    }

    if (options.jsonMode) {
      request.response_format = { type: 'json_object' };
    }

    if (options.tools && options.tools.length > 0 && provider.supportsTools) {
      request.tools = options.tools;
      if (options.toolChoice) {
        request.tool_choice = options.toolChoice;
      }
    }

    try {
      if (isFallback) {
        console.warn(`[AI_ROUTER] Falling back to ${provider.name} (${provider.model})...`);
      }

      const result = await callOpenAICompatible(provider.baseUrl, provider.apiKey, request);
      const choice = result.choices[0];
      const latencyMs = Date.now() - startTime;

      if (result.usage) {
        _trackTokenUsage(provider.model, result.usage, latencyMs, isFallback, false);
      }

      return {
        content: choice.message.content || '',
        toolCalls: choice.message.tool_calls,
        usage: result.usage,
        provider: provider.name,
        model: provider.model,
        // v34: Include thinking/reasoning content
        thinkingContent: choice.message.reasoning_content || undefined,
      };
    } catch (error: unknown) {
      const errorClass = classifyAIError(error);
      console.error(`[AI_ROUTER] ${provider.name} (${provider.model}) error [${errorClass}]:`, (error as any)?.message || error);
      lastError = error;
    }
  }

  throw lastError || new Error('All AI providers failed');
}

// v13.0: Internal token tracking helper
function _trackTokenUsage(
  model: string,
  usage: NonNullable<ChatCompletionResponse['usage']>,
  latencyMs: number,
  isFallback: boolean,
  isCached: boolean,
  callTypeOverride?: TokenTrackingContext['callType'],
): void {
  _requestTokenUsage.promptTokens += usage.prompt_tokens;
  _requestTokenUsage.completionTokens += usage.completion_tokens;
  _requestTokenUsage.totalTokens += usage.total_tokens;
  _requestTokenUsage.callCount += 1;
  if (!_requestTokenUsage.models.includes(model)) {
    _requestTokenUsage.models.push(model);
  }
  _requestTokenUsage.estimatedCredits += estimateCredits(model, usage.prompt_tokens, usage.completion_tokens);

  const ctx = _trackingCtx;
  const callType = callTypeOverride || ctx?.callType || 'fallback';
  if (ctx?.db) {
    logTokenUsage(ctx.db, {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      turnNumber: ctx.turnNumber,
      callType,
      modelUsed: model,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      latencyMs,
      isFallback,
      isCached,
    }).catch((e: unknown) => console.warn('[TOKEN_TRACKER] DB write failed:', e));
  }

  console.log(`[TOKEN] ${callType} | ${model} | prompt=${usage.prompt_tokens} compl=${usage.completion_tokens} total=${usage.total_tokens} | ${latencyMs}ms${isFallback ? ' [FALLBACK]' : ''}`);
}

/** Records usage returned by the typed lane router in the legacy request-level
 * telemetry accumulator without reintroducing a positional provider call. */
export function recordRoutedAIUsage(result: {
  metadata: { model: string; latencyMs: number; fallback: boolean };
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}, callType: TokenTrackingContext['callType']): void {
  if (!result.usage) return;
  _trackTokenUsage(result.metadata.model, {
    prompt_tokens: result.usage.promptTokens,
    completion_tokens: result.usage.completionTokens,
    total_tokens: result.usage.totalTokens,
  }, result.metadata.latencyMs, result.metadata.fallback, false, callType);
}

// =============================================
// callAIJSON - Parse JSON response with robust repair
// =============================================

export async function callAIJSON<T>(
  soongsilApiKey: string,
  geminiApiKey: string | undefined,
  systemPrompt: string,
  userMessage: string,
  options: {
    temperature?: number;
    maxTokens?: number;
    env?: Record<string, any>;
    useThinking?: boolean;
    thinkingBudget?: number;
    preferFast?: boolean;
  } = {},
): Promise<T> {
  const result = await callAI(soongsilApiKey, geminiApiKey, systemPrompt, userMessage, {
    ...options,
    jsonMode: true,
    // For JSON mode, prefer fast non-thinking by default (unless explicitly requested)
    useThinking: options.useThinking ?? false,
    preferFast: options.preferFast ?? true,
  });

  return robustJSONParse<T>(result.content);
}

// =============================================
// v34: Convenience wrapper — env-based callAI
// =============================================
// New simplified interface for v34+ code that uses env directly

export async function callAIWithEnv(
  env: Record<string, any>,
  systemPrompt: string,
  userMessage: string,
  options: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    useThinking?: boolean;
    thinkingBudget?: number;
    preferFast?: boolean;
    tools?: ToolDefinition[];
    toolChoice?: string | { type: string; function: { name: string } };
  } = {},
): Promise<{ content: string; provider?: string; model?: string; thinkingContent?: string; toolCalls?: ToolCall[]; usage?: ChatCompletionResponse['usage'] }> {
  // DeepSeek is read from env inside callAI; this positional key belongs to Sungshin.
  const primaryKey = env.SOONGSIL_API_KEY || '';
  const fallbackKey = env.GEMINI_API_KEY;
  
  return callAI(primaryKey, fallbackKey, systemPrompt, userMessage, {
    ...options,
    env,
  });
}

export async function callAIJSONWithEnv<T>(
  env: Record<string, any>,
  systemPrompt: string,
  userMessage: string,
  options: {
    temperature?: number;
    maxTokens?: number;
    useThinking?: boolean;
    thinkingBudget?: number;
    preferFast?: boolean;
  } = {},
): Promise<T> {
  // DeepSeek is read from env inside callAI; this positional key belongs to Sungshin.
  const primaryKey = env.SOONGSIL_API_KEY || '';
  const fallbackKey = env.GEMINI_API_KEY;
  
  return callAIJSON<T>(primaryKey, fallbackKey, systemPrompt, userMessage, {
    ...options,
    env,
  });
}

// =============================================
// Exports
// =============================================

export type { ChatMessage, ToolDefinition, ToolCall, AIProvider };
export { PROVIDERS, getAvailableProviders, getProviderByName, selectProviderForTask };
