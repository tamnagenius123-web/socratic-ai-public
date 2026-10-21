import type { Bindings } from '../types';
import type { ChatCompletionRequest, ChatCompletionResponse } from './ai-client';
import type { PinnedLaneRoutePlan } from './learning-session-context';
import providerSmokePrompt from './ai-router/prompts/provider-smoke.user.md?raw';

export type AIRouteLane =
  | 'interactive_generation'
  | 'learner_evaluation'
  | 'release_critic'
  | 'background_reasoning';

export type AIProviderName = 'ssu_mindlogic' | 'openrouter' | 'deepseek' | 'gemini' | 'local_e2e';

export type ProviderSmokeRouteId =
  | 'ssu-luna'
  | 'ssu-terra'
  | 'ssu-sol'
  | 'ssu-gemma4'
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'gemini-2.5-flash'
  | 'openrouter-step-3.7-flash'
  | 'openrouter-ling-3.0-flash'
  | 'openrouter-gpt-oss-120b';

type AssessmentFallbackRouteId =
  | 'assessment-ssu-terra'
  | 'assessment-openrouter-gpt-oss-120b';

export type AIRouteId = ProviderSmokeRouteId | AssessmentFallbackRouteId | 'local-e2e-openai';

export type AIFailureClass =
  | 'unconfigured'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'provider_unavailable'
  | 'invalid_response'
  | 'receipt_persistence'
  | 'unknown';

export interface AIRouteMetadata {
  lane: AIRouteLane;
  provider: AIProviderName;
  model: string;
  fallback: boolean;
  attemptCount: number;
  latencyMs: number;
}

export interface AIRouteUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AITextRouteResult {
  content: string;
  metadata: AIRouteMetadata;
  usage?: AIRouteUsage;
}

export interface AIJSONRouteResult<T = unknown> {
  value: T;
  metadata: AIRouteMetadata;
  usage?: AIRouteUsage;
}

/** Return null when a JSON payload does not meet the domain contract. */
export type AIJSONValidator<T> = (value: unknown) => T | null;

export interface AIRouteRequest {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Version labels are persisted as hashes-only receipt metadata. */
  promptSchemaVersion?: string;
  promptVersion?: string;
}

type CredentialKind =
  | 'actor_ssu'
  | 'actor_openrouter'
  | 'actor_gemini'
  | 'assessment_deepseek'
  | 'assessment_ssu'
  | 'assessment_openrouter'
  | 'local_e2e';

export type CredentialAlias =
  | 'AI_ACTOR_SSU_API_KEY'
  | 'SOONGSIL_API_KEY'
  | 'AI_ACTOR_OPENROUTER_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'AI_ACTOR_GEMINI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'AI_ASSESSMENT_DEEPSEEK_API_KEY'
  | 'DEEPSEEK_API_KEY'
  | 'AI_ASSESSMENT_SSU_API_KEY'
  | 'AI_ASSESSMENT_OPENROUTER_API_KEY'
  | 'AI_LOCAL_E2E_OPT_IN';

interface ResolvedCredential {
  value: string;
  alias: CredentialAlias;
}

interface RouteCapabilities {
  supportsJsonResponseFormat: boolean;
  supportsThinkingControl: boolean;
}

interface RouteDefinition {
  routeId: AIRouteId;
  lane: AIRouteLane;
  provider: AIProviderName;
  baseUrl: string;
  model: string;
  credential: CredentialKind;
  capabilities: RouteCapabilities;
}

const SSU_MINDLOGIC_BASE_URL = 'https://factchat-cloud.mindlogic.ai/v1/gateway';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const LOCAL_E2E_ROUTE_ID = 'local-e2e-openai' as const;
const LOCAL_E2E_PLACEHOLDER_BASE_URL = 'http://127.0.0.1:1/v1';
const LOCAL_E2E_CREDENTIAL_VALUE = 'local-e2e';
const LOCAL_E2E_HARNESS_BUILD = import.meta.env.VITE_LOCAL_E2E_HARNESS === '1';
const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_BODY_BYTES = 24_000;
const RECEIPT_PROMPT_SCHEMA_VERSION = 'ai-router-request-v1';
const RECEIPT_PROMPT_VERSION = 'ai-router-v2';
const GENERIC_JSON_SCHEMA_VERSION = 'generic-json-v1';
const PROVIDER_SMOKE_PROMPT_SCHEMA_VERSION = 'provider-smoke-schema-v1';
const PROVIDER_SMOKE_PROMPT_VERSION = 'provider-smoke-v1';
const RECEIPT_SQL = `INSERT INTO ai_invocation_attempts (
  id, session_context_id, session_id, turn_number, prompt_cache_namespace,
  invocation_id, invocation_kind, lane, route_id, provider, model,
  credential_alias, attempt_index, started_at, completed_at, latency_ms,
  outcome, failure_class, retryable, prompt_schema_version, prompt_version,
  prompt_sha256, response_sha256, prompt_tokens, completion_tokens,
  total_tokens, created_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)`;

const ROUTES = {
  'ssu-luna': {
    routeId: 'ssu-luna',
    lane: 'interactive_generation',
    provider: 'ssu_mindlogic',
    baseUrl: SSU_MINDLOGIC_BASE_URL,
    model: 'gpt-5.6-luna',
    credential: 'actor_ssu',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'ssu-terra': {
    routeId: 'ssu-terra',
    lane: 'interactive_generation',
    provider: 'ssu_mindlogic',
    baseUrl: SSU_MINDLOGIC_BASE_URL,
    model: 'gpt-5.6-terra',
    credential: 'actor_ssu',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'ssu-sol': {
    routeId: 'ssu-sol',
    lane: 'interactive_generation',
    provider: 'ssu_mindlogic',
    baseUrl: SSU_MINDLOGIC_BASE_URL,
    model: 'gpt-5.6-sol',
    credential: 'actor_ssu',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'ssu-gemma4': {
    routeId: 'ssu-gemma4',
    lane: 'interactive_generation',
    provider: 'ssu_mindlogic',
    baseUrl: SSU_MINDLOGIC_BASE_URL,
    model: 'google/gemma-4-31B-it',
    credential: 'actor_ssu',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'deepseek-v4-flash': {
    routeId: 'deepseek-v4-flash',
    lane: 'release_critic',
    provider: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-flash',
    credential: 'assessment_deepseek',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: true },
  },
  'deepseek-v4-pro': {
    routeId: 'deepseek-v4-pro',
    lane: 'learner_evaluation',
    provider: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    model: 'deepseek-v4-pro',
    credential: 'assessment_deepseek',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: true },
  },
  'gemini-2.5-flash': {
    routeId: 'gemini-2.5-flash',
    lane: 'interactive_generation',
    provider: 'gemini',
    baseUrl: GEMINI_OPENAI_BASE_URL,
    model: 'gemini-2.5-flash',
    credential: 'actor_gemini',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'openrouter-step-3.7-flash': {
    routeId: 'openrouter-step-3.7-flash',
    lane: 'interactive_generation',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: 'stepfun/step-3.7-flash',
    credential: 'actor_openrouter',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'openrouter-ling-3.0-flash': {
    routeId: 'openrouter-ling-3.0-flash',
    lane: 'interactive_generation',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: 'inclusionai/ling-3.0-flash',
    credential: 'actor_openrouter',
    // Ling rejects OpenAI response_format. JSON calls use strict local decoding.
    capabilities: { supportsJsonResponseFormat: false, supportsThinkingControl: false },
  },
  'openrouter-gpt-oss-120b': {
    routeId: 'openrouter-gpt-oss-120b',
    lane: 'interactive_generation',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: 'openai/gpt-oss-120b',
    credential: 'actor_openrouter',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'assessment-ssu-terra': {
    routeId: 'assessment-ssu-terra',
    lane: 'learner_evaluation',
    provider: 'ssu_mindlogic',
    baseUrl: SSU_MINDLOGIC_BASE_URL,
    model: 'gpt-5.6-terra',
    credential: 'assessment_ssu',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  'assessment-openrouter-gpt-oss-120b': {
    routeId: 'assessment-openrouter-gpt-oss-120b',
    lane: 'learner_evaluation',
    provider: 'openrouter',
    baseUrl: OPENROUTER_BASE_URL,
    model: 'openai/gpt-oss-120b',
    credential: 'assessment_openrouter',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
  [LOCAL_E2E_ROUTE_ID]: {
    routeId: LOCAL_E2E_ROUTE_ID,
    lane: 'interactive_generation',
    provider: 'local_e2e',
    baseUrl: LOCAL_E2E_PLACEHOLDER_BASE_URL,
    model: 'local-e2e',
    credential: 'local_e2e',
    capabilities: { supportsJsonResponseFormat: true, supportsThinkingControl: false },
  },
} as const satisfies Record<AIRouteId, RouteDefinition>;

const INTERACTIVE_ROUTE_IDS: readonly AIRouteId[] = [
  'ssu-luna',
  'openrouter-step-3.7-flash',
  'openrouter-ling-3.0-flash',
  'openrouter-gpt-oss-120b',
  'gemini-2.5-flash',
];

const ASSESSMENT_EVALUATION_ROUTE_IDS: readonly AIRouteId[] = [
  'deepseek-v4-pro',
  'assessment-ssu-terra',
  'assessment-openrouter-gpt-oss-120b',
];

const ASSESSMENT_CRITIC_ROUTE_IDS: readonly AIRouteId[] = [
  'deepseek-v4-flash',
  'assessment-ssu-terra',
  'assessment-openrouter-gpt-oss-120b',
];

const LANE_ROUTE_IDS: Record<AIRouteLane, readonly AIRouteId[]> = {
  interactive_generation: [...INTERACTIVE_ROUTE_IDS, LOCAL_E2E_ROUTE_ID],
  learner_evaluation: [...ASSESSMENT_EVALUATION_ROUTE_IDS, LOCAL_E2E_ROUTE_ID],
  release_critic: [...ASSESSMENT_CRITIC_ROUTE_IDS, LOCAL_E2E_ROUTE_ID],
  background_reasoning: [...ASSESSMENT_EVALUATION_ROUTE_IDS, LOCAL_E2E_ROUTE_ID],
};

const ROUTING_LANES: readonly AIRouteLane[] = [
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
  'background_reasoning',
];

const SMOKE_ROUTE_IDS: readonly ProviderSmokeRouteId[] = [
  'ssu-luna',
  'ssu-terra',
  'ssu-sol',
  'ssu-gemma4',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'gemini-2.5-flash',
  'openrouter-step-3.7-flash',
  'openrouter-ling-3.0-flash',
  'openrouter-gpt-oss-120b',
];

export class AIRouteUnavailableError extends Error {
  readonly code = 'AI_ROUTE_UNAVAILABLE' as const;

  constructor(
    readonly lane: AIRouteLane,
    readonly attemptedRoutes: number,
    readonly failureClass: AIFailureClass,
    readonly retryable: boolean,
  ) {
    super(`No configured ${lane} route produced a valid response.`);
    this.name = 'AIRouteUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class AIProviderTimeoutError extends Error {
  constructor() {
    super('Provider request timed out.');
    this.name = 'AIProviderTimeoutError';
  }
}

class AIProviderRequestError extends Error {
  constructor(readonly status: number) {
    super(`Provider returned HTTP ${status}.`);
    this.name = 'AIProviderRequestError';
  }
}

class AIProviderResponseError extends Error {
  constructor() {
    super('Provider response did not satisfy the chat completion contract.');
    this.name = 'AIProviderResponseError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptySecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type LocalE2EConfiguration =
  | { status: 'disabled' }
  | { status: 'invalid' }
  | { status: 'valid'; baseUrl: string };

const LOCAL_E2E_FIXED_BASE_URL = 'http://127.0.0.1:8788/v1';

function localE2EConfiguration(env: Bindings): LocalE2EConfiguration {
  const optInPresent = env.AI_LOCAL_E2E_OPT_IN !== undefined;
  const baseUrlPresent = env.AI_LOCAL_E2E_BASE_URL !== undefined;
  if (!optInPresent && !baseUrlPresent) return { status: 'disabled' };
  if (!LOCAL_E2E_HARNESS_BUILD || env.AI_LOCAL_E2E_OPT_IN !== '1' || typeof env.AI_LOCAL_E2E_BASE_URL !== 'string') {
    return { status: 'invalid' };
  }

  try {
    const parsed = new URL(env.AI_LOCAL_E2E_BASE_URL);
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname.toLowerCase() !== '127.0.0.1'
      || !parsed.port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.pathname !== '/v1' && parsed.pathname !== '/v1/')
      || `${parsed.origin}/v1` !== LOCAL_E2E_FIXED_BASE_URL
    ) {
      return { status: 'invalid' };
    }
    return { status: 'valid', baseUrl: `${parsed.origin}/v1` };
  } catch {
    return { status: 'invalid' };
  }
}

function localE2ERoute(baseUrl: string): RouteDefinition {
  return { ...ROUTES[LOCAL_E2E_ROUTE_ID], baseUrl };
}

function routesForEnvironment(env: Bindings, lane: AIRouteLane): RouteDefinition[] {
  const local = localE2EConfiguration(env);
  if (local.status === 'valid') return [localE2ERoute(local.baseUrl)];
  if (LOCAL_E2E_HARNESS_BUILD || local.status === 'invalid') return [];
  return routesForLane(lane);
}

function resolveCredential(env: Bindings, credential: CredentialKind): ResolvedCredential | null {
  switch (credential) {
    case 'actor_ssu':
      return hasNonEmptySecret(env.AI_ACTOR_SSU_API_KEY)
        ? { value: env.AI_ACTOR_SSU_API_KEY, alias: 'AI_ACTOR_SSU_API_KEY' }
        : hasNonEmptySecret(env.SOONGSIL_API_KEY)
          ? { value: env.SOONGSIL_API_KEY, alias: 'SOONGSIL_API_KEY' }
          : null;
    case 'actor_openrouter':
      return hasNonEmptySecret(env.AI_ACTOR_OPENROUTER_API_KEY)
        ? { value: env.AI_ACTOR_OPENROUTER_API_KEY, alias: 'AI_ACTOR_OPENROUTER_API_KEY' }
        : hasNonEmptySecret(env.OPENROUTER_API_KEY)
          ? { value: env.OPENROUTER_API_KEY, alias: 'OPENROUTER_API_KEY' }
          : null;
    case 'actor_gemini':
      return hasNonEmptySecret(env.AI_ACTOR_GEMINI_API_KEY)
        ? { value: env.AI_ACTOR_GEMINI_API_KEY, alias: 'AI_ACTOR_GEMINI_API_KEY' }
        : hasNonEmptySecret(env.GEMINI_API_KEY)
          ? { value: env.GEMINI_API_KEY, alias: 'GEMINI_API_KEY' }
          : null;
    case 'assessment_deepseek':
      return hasNonEmptySecret(env.AI_ASSESSMENT_DEEPSEEK_API_KEY)
        ? { value: env.AI_ASSESSMENT_DEEPSEEK_API_KEY, alias: 'AI_ASSESSMENT_DEEPSEEK_API_KEY' }
        : hasNonEmptySecret(env.DEEPSEEK_API_KEY)
          ? { value: env.DEEPSEEK_API_KEY, alias: 'DEEPSEEK_API_KEY' }
          : null;
    case 'assessment_ssu':
      return hasNonEmptySecret(env.AI_ASSESSMENT_SSU_API_KEY)
        ? { value: env.AI_ASSESSMENT_SSU_API_KEY, alias: 'AI_ASSESSMENT_SSU_API_KEY' }
        : null;
    case 'assessment_openrouter':
      return hasNonEmptySecret(env.AI_ASSESSMENT_OPENROUTER_API_KEY)
        ? { value: env.AI_ASSESSMENT_OPENROUTER_API_KEY, alias: 'AI_ASSESSMENT_OPENROUTER_API_KEY' }
        : null;
    case 'local_e2e':
      return localE2EConfiguration(env).status === 'valid'
        ? { value: LOCAL_E2E_CREDENTIAL_VALUE, alias: 'AI_LOCAL_E2E_OPT_IN' }
        : null;
  }
}

function normalizeFailure(error: unknown): AIFailureClass {
  if (error instanceof AIInvocationReceiptPersistenceError) return 'receipt_persistence';
  if (error instanceof AIProviderTimeoutError) return 'timeout';
  if (error instanceof AIProviderResponseError || error instanceof SyntaxError) return 'invalid_response';
  if (error instanceof AIProviderRequestError) {
    if (error.status === 401 || error.status === 403) return 'unauthorized';
    if (error.status === 404) return 'not_found';
    if (error.status === 429) return 'rate_limited';
    if (error.status === 400 || error.status === 422) return 'bad_request';
    if (error.status >= 500) return 'provider_unavailable';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (error instanceof TypeError) return 'network';
  return 'unknown';
}

function mayTryFallback(failureClass: AIFailureClass): boolean {
  // Credential, request-shape, and route-definition failures are deterministic
  // for this request. Do not conceal them by silently spending a second route.
  return failureClass !== 'unconfigured'
    && failureClass !== 'unauthorized'
    && failureClass !== 'bad_request'
    && failureClass !== 'not_found';
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (totalBytes < MAX_PROVIDER_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_PROVIDER_BODY_BYTES - totalBytes;
      const fragment = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(fragment);
      totalBytes += fragment.byteLength;
      if (fragment.byteLength < value.byteLength) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The provider stream has already closed or been detached.
    }
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !Array.isArray(value.choices)) return false;
  return value.choices.every((choice) => (
    isPlainObject(choice)
    && isPlainObject(choice.message)
    && (typeof choice.message.content === 'string' || choice.message.content === null)
    && typeof choice.finish_reason === 'string'
  ));
}

/**
 * The sole outbound OpenAI-compatible transport. Legacy ai-client calls are
 * delegated here as well so provider HTTP requests do not spread through the
 * application surface.
 */
export async function postOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const body = await readBoundedResponseBody(response);
    if (!response.ok) throw new AIProviderRequestError(response.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new AIProviderResponseError();
    }
    if (!isChatCompletionResponse(parsed)) throw new AIProviderResponseError();
    return parsed;
  } catch (error) {
    if (controller.signal.aborted) throw new AIProviderTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function responseUsage(response: ChatCompletionResponse): AIRouteUsage | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens) || !Number.isFinite(totalTokens)) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function responseContent(response: ChatCompletionResponse): string {
  const choice = response.choices[0];
  if (!choice || choice.finish_reason !== 'stop') {
    throw new AIProviderResponseError();
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AIProviderResponseError();
  }
  return content;
}

function makeRequest(route: RouteDefinition, input: AIRouteRequest, jsonMode: boolean): ChatCompletionRequest {
  const messages: ChatCompletionRequest['messages'] = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.userPrompt });
  return {
    model: route.model,
    messages,
    temperature: input.temperature ?? 0.7,
    max_tokens: input.maxTokens ?? 800,
    ...(jsonMode && route.capabilities.supportsJsonResponseFormat
      ? { response_format: { type: 'json_object' } }
      : {}),
    // DeepSeek v4 routes are explicitly non-thinking for bounded smoke,
    // evaluation, critic, and background calls.
    ...(route.capabilities.supportsThinkingControl ? { thinking: { type: 'disabled' as const } } : {}),
  };
}

function routeDefinition(routeId: AIRouteId): RouteDefinition {
  return ROUTES[routeId];
}

function routesForLane(lane: AIRouteLane): RouteDefinition[] {
  return LANE_ROUTE_IDS[lane].map(routeDefinition);
}

/** Context-bound execution cannot accept an unreceipted provider result. */
export class AIInvocationReceiptPersistenceError extends Error {
  readonly code = 'AI_INVOCATION_RECEIPT_PERSISTENCE_FAILED' as const;
  readonly failureClass = 'receipt_persistence' as const;
  readonly retryable = false;

  constructor() {
    super('AI_INVOCATION_RECEIPT_PERSISTENCE_FAILED');
    this.name = 'AIInvocationReceiptPersistenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Receipt failures may cross a Worker/module boundary without their prototype. */
export function isAIInvocationReceiptPersistenceError(
  error: unknown,
): error is AIInvocationReceiptPersistenceError {
  if (error instanceof AIInvocationReceiptPersistenceError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'AI_INVOCATION_RECEIPT_PERSISTENCE_FAILED';
}

export function isAIRouteAllowedForLane(routeId: unknown, lane: AIRouteLane): routeId is AIRouteId {
  return typeof routeId === 'string' && (LANE_ROUTE_IDS[lane] as readonly string[]).includes(routeId);
}

export function configuredAIRouteIdsForLane(env: Bindings, lane: AIRouteLane): AIRouteId[] {
  return routesForEnvironment(env, lane)
    .filter((route) => resolveCredential(env, route.credential) !== null)
    .map((route) => route.routeId);
}

export interface AIRoutingLaneReadiness {
  status: 'configured_unverified' | 'unconfigured';
  configuredRouteIds: AIRouteId[];
}

export interface AIRoutingReadiness {
  interactiveGeneration: AIRoutingLaneReadiness;
  learnerEvaluation: AIRoutingLaneReadiness;
  releaseCritic: AIRoutingLaneReadiness;
  backgroundReasoning: AIRoutingLaneReadiness;
}

export interface AIRouteReceiptFreshness {
  lane: AIRouteLane;
  routeId: AIRouteId | null;
  provider: AIProviderName | null;
  model: string | null;
  credentialAlias: CredentialAlias | null;
  status: 'fresh' | 'stale' | 'unconfigured' | 'local_only';
  lastSuccessAt: string | null;
}

export interface AIRoutingRuntimeHealth {
  status: 'verified' | 'stale' | 'unconfigured' | 'schema_missing' | 'unavailable' | 'local_only';
  freshnessWindowMs: number;
  checkedAt: string;
  requiredPrimaryRoutes: AIRouteReceiptFreshness[];
  nonReadinessLanes: readonly {
    lane: 'background_reasoning';
    reason: 'background_scenario_generation_is_non_critical';
  }[];
}

const ROUTING_RECEIPT_FRESHNESS_MS = 15 * 60 * 1_000;
const READINESS_LANES: readonly AIRouteLane[] = [
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
];
const NON_READINESS_LANES = [{
  lane: 'background_reasoning' as const,
  reason: 'background_scenario_generation_is_non_critical' as const,
}];

function laneReadiness(env: Bindings, lane: AIRouteLane): AIRoutingLaneReadiness {
  const configuredRouteIds = configuredAIRouteIdsForLane(env, lane);
  return {
    status: configuredRouteIds.length > 0 ? 'configured_unverified' : 'unconfigured',
    configuredRouteIds,
  };
}

export function describeAIRouting(env: Bindings): AIRoutingReadiness {
  return {
    interactiveGeneration: laneReadiness(env, 'interactive_generation'),
    learnerEvaluation: laneReadiness(env, 'learner_evaluation'),
    releaseCritic: laneReadiness(env, 'release_critic'),
    backgroundReasoning: laneReadiness(env, 'background_reasoning'),
  };
}

function firstConfiguredRoute(env: Bindings, lane: AIRouteLane): RouteDefinition | null {
  return routesForEnvironment(env, lane).find((route) => resolveCredential(env, route.credential) !== null) || null;
}

interface RequiredRouteIdentity {
  lane: AIRouteLane;
  route: RouteDefinition | null;
  credential: ResolvedCredential | null;
}

interface ReceiptIdentityRow {
  lane: string;
  route_id: string;
  provider: string;
  model: string;
  credential_alias: string;
  completed_at: number | string | null;
}

function receiptIdentityKey(
  lane: string,
  routeId: string,
  provider: string,
  model: string,
  credentialAlias: string,
): string {
  return [lane, routeId, provider, model, credentialAlias].join('\u0000');
}

function requiredRouteIdentity(env: Bindings, lane: AIRouteLane): RequiredRouteIdentity {
  const route = firstConfiguredRoute(env, lane);
  return {
    lane,
    route,
    credential: route ? resolveCredential(env, route.credential) : null,
  };
}

/**
 * Runtime readiness is evidence-based: a route being configured does not make
 * it ready. A missing receipt table fails closed so a partially applied D1
 * migration cannot present an optimistic health result.
 */
export async function getAIRoutingRuntimeHealth(env: Bindings): Promise<AIRoutingRuntimeHealth> {
  const checkedAtMs = Date.now();
  const local = localE2EConfiguration(env);
  if (local.status === 'valid') {
    const route = localE2ERoute(local.baseUrl);
    return {
      status: 'local_only',
      freshnessWindowMs: ROUTING_RECEIPT_FRESHNESS_MS,
      checkedAt: new Date(checkedAtMs).toISOString(),
      requiredPrimaryRoutes: READINESS_LANES.map((lane) => ({
        lane,
        routeId: route.routeId,
        provider: route.provider,
        model: route.model,
        credentialAlias: 'AI_LOCAL_E2E_OPT_IN',
        status: 'local_only',
        lastSuccessAt: null,
      })),
      nonReadinessLanes: NON_READINESS_LANES,
    };
  }
  // Background scenario generation is intentionally non-readiness-critical:
  // learners can still use Sparring/Training core even if optional scenario
  // construction is unavailable.
  const required = READINESS_LANES.map((lane) => requiredRouteIdentity(env, lane));

  let rows: ReceiptIdentityRow[];
  try {
    const result = await env.DB.prepare(
      `SELECT lane, route_id, provider, model, credential_alias,
              MAX(completed_at) AS completed_at
       FROM ai_invocation_attempts
       WHERE outcome = 'success'
       GROUP BY lane, route_id, provider, model, credential_alias`,
    ).all<ReceiptIdentityRow>();
    rows = result.results || [];
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return {
      status: message.includes('no such table') || message.includes('ai_invocation_attempts')
        ? 'schema_missing'
        : 'unavailable',
      freshnessWindowMs: ROUTING_RECEIPT_FRESHNESS_MS,
      checkedAt: new Date(checkedAtMs).toISOString(),
      requiredPrimaryRoutes: required.map(({ lane, route, credential }) => ({
        lane,
        routeId: route?.routeId || null,
        provider: route?.provider || null,
        model: route?.model || null,
        credentialAlias: credential?.alias || null,
        status: route && credential ? 'stale' : 'unconfigured',
        lastSuccessAt: null,
      })),
      nonReadinessLanes: NON_READINESS_LANES,
    };
  }

  const latestByIdentity = new Map<string, number>();
  for (const row of rows) {
    const completedAt = Number(row.completed_at);
    if (Number.isFinite(completedAt) && completedAt > 0) {
      latestByIdentity.set(
        receiptIdentityKey(row.lane, row.route_id, row.provider, row.model, row.credential_alias),
        completedAt,
      );
    }
  }

  const requiredPrimaryRoutes = required.map(({ lane, route, credential }): AIRouteReceiptFreshness => {
    if (!route || !credential) {
      return {
        lane,
        routeId: null,
        provider: null,
        model: null,
        credentialAlias: null,
        status: 'unconfigured',
        lastSuccessAt: null,
      };
    }
    const completedAt = latestByIdentity.get(receiptIdentityKey(
      lane,
      route.routeId,
      route.provider,
      route.model,
      credential.alias,
    ));
    const fresh = completedAt !== undefined && checkedAtMs - completedAt <= ROUTING_RECEIPT_FRESHNESS_MS;
    return {
      lane,
      routeId: route.routeId,
      provider: route.provider,
      model: route.model,
      credentialAlias: credential.alias,
      status: fresh ? 'fresh' : 'stale',
      lastSuccessAt: completedAt ? new Date(completedAt).toISOString() : null,
    };
  });
  const hasUnconfiguredRoute = requiredPrimaryRoutes.some((route) => route.status === 'unconfigured');
  const hasStaleRoute = requiredPrimaryRoutes.some((route) => route.status === 'stale');
  return {
    status: hasUnconfiguredRoute ? 'unconfigured' : hasStaleRoute ? 'stale' : 'verified',
    freshnessWindowMs: ROUTING_RECEIPT_FRESHNESS_MS,
    checkedAt: new Date(checkedAtMs).toISOString(),
    requiredPrimaryRoutes,
    nonReadinessLanes: NON_READINESS_LANES,
  };
}

export function isProviderSmokeRouteId(value: unknown): value is ProviderSmokeRouteId {
  return typeof value === 'string' && (SMOKE_ROUTE_IDS as readonly string[]).includes(value);
}

export interface ProviderSmokeResult {
  provider: AIProviderName;
  model: string;
  status: 'ready' | 'unavailable';
  failureClass: AIFailureClass | null;
  latencyMs: number;
  timestamp: string;
}

type InvocationKind = 'route' | 'smoke';

interface InvocationReceiptContext {
  invocationId: string;
  invocationKind: InvocationKind;
  promptSchemaVersion: string;
  promptVersion: string;
  promptSha256: string;
  sessionContextId: string | null;
  sessionId: string | null;
  turnNumber: number | null;
  promptCacheNamespace: string | null;
}

export interface AIRouterInvocationScope {
  sessionContextId: string;
  sessionId: string;
  turnNumber: number;
  promptCacheNamespace: string;
}

export interface LegacyAIRouterOptions {
  mode: 'legacy';
  pinnedRoutePlan?: never;
  invocationScope?: never;
}

export interface ContextBoundAIRouterOptions {
  mode: 'context_bound';
  pinnedRoutePlan: PinnedLaneRoutePlan;
  invocationScope: AIRouterInvocationScope;
}

export type AIRouterOptions = LegacyAIRouterOptions | ContextBoundAIRouterOptions;

export class AIRouterConfigurationError extends Error {
  readonly code = 'AI_ROUTER_CONTEXT_OPTIONS_INVALID' as const;

  constructor() {
    super('AI_ROUTER_CONTEXT_OPTIONS_INVALID');
    this.name = 'AIRouterConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface AttemptReceipt {
  context: InvocationReceiptContext;
  lane: AIRouteLane;
  route: RouteDefinition;
  credentialAlias: CredentialAlias | 'unconfigured';
  attemptIndex: number;
  startedAt: number;
  completedAt: number;
  outcome: 'success' | 'failure';
  failureClass: AIFailureClass | null;
  retryable: boolean;
  responseContent?: string;
  usage?: AIRouteUsage;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createInvocationReceiptContext(
  input: AIRouteRequest,
  invocationKind: InvocationKind,
  invocationScope?: AIRouterInvocationScope,
): Promise<InvocationReceiptContext> {
  return {
    invocationId: crypto.randomUUID(),
    invocationKind,
    promptSchemaVersion: input.promptSchemaVersion || (invocationKind === 'smoke'
      ? PROVIDER_SMOKE_PROMPT_SCHEMA_VERSION
      : RECEIPT_PROMPT_SCHEMA_VERSION),
    promptVersion: input.promptVersion || (invocationKind === 'smoke'
      ? PROVIDER_SMOKE_PROMPT_VERSION
      : RECEIPT_PROMPT_VERSION),
    promptSha256: await sha256Hex(`${input.systemPrompt || ''}\n---\n${input.userPrompt}`),
    sessionContextId: invocationScope?.sessionContextId ?? null,
    sessionId: invocationScope?.sessionId ?? null,
    turnNumber: invocationScope?.turnNumber ?? null,
    promptCacheNamespace: invocationScope?.promptCacheNamespace ?? null,
  };
}

function hasOwnProperty(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function isValidInvocationScope(value: unknown): value is AIRouterInvocationScope {
  if (!isPlainObject(value)) return false;
  const turnNumber = value.turnNumber;
  return typeof value.sessionContextId === 'string'
    && value.sessionContextId.trim().length > 0
    && typeof value.sessionId === 'string'
    && value.sessionId.trim().length > 0
    && typeof turnNumber === 'number'
    && Number.isSafeInteger(turnNumber)
    && turnNumber >= 0
    && typeof value.promptCacheNamespace === 'string'
    && value.promptCacheNamespace.trim().length > 0;
}

function isValidPinnedLaneRoutePlan(value: unknown): value is PinnedLaneRoutePlan {
  if (!isPlainObject(value)) return false;
  return ROUTING_LANES.every((lane) => {
    const routeIds = value[lane];
    if (!Array.isArray(routeIds)) return false;

    const uniqueRouteIds = new Set<string>();
    return routeIds.every((routeId) => {
      if (!isAIRouteAllowedForLane(routeId, lane) || uniqueRouteIds.has(routeId)) return false;
      uniqueRouteIds.add(routeId);
      return true;
    });
  });
}

function normalizeAIRouterOptions(options: unknown): AIRouterOptions {
  if (options === undefined) return { mode: 'legacy' };
  if (!isPlainObject(options)) throw new AIRouterConfigurationError();

  const hasPinnedRoutePlan = hasOwnProperty(options, 'pinnedRoutePlan');
  const hasInvocationScope = hasOwnProperty(options, 'invocationScope');
  if (options.mode === 'legacy' && !hasPinnedRoutePlan && !hasInvocationScope) {
    return { mode: 'legacy' };
  }
  if (
    options.mode === 'context_bound'
    && hasPinnedRoutePlan
    && hasInvocationScope
    && isValidPinnedLaneRoutePlan(options.pinnedRoutePlan)
    && isValidInvocationScope(options.invocationScope)
  ) {
    return {
      mode: 'context_bound',
      pinnedRoutePlan: options.pinnedRoutePlan,
      invocationScope: options.invocationScope,
    };
  }
  throw new AIRouterConfigurationError();
}

export class AIRouter {
  private readonly options: AIRouterOptions;

  constructor(
    private readonly env: Bindings,
    options?: AIRouterOptions,
  ) {
    this.options = normalizeAIRouterOptions(options);
  }

  async complete(lane: AIRouteLane, input: AIRouteRequest): Promise<AITextRouteResult> {
    return this.completeWithDecoder(lane, input, false, (content) => content);
  }

  async completeJSON(lane: AIRouteLane, input: AIRouteRequest): Promise<AIJSONRouteResult> {
    // A plain JSON parse has no domain validation, so it cannot claim a domain
    // schema version in durable success receipts.
    return this.completeWithDecoder(
      lane,
      { ...input, promptSchemaVersion: GENERIC_JSON_SCHEMA_VERSION },
      true,
      (content) => JSON.parse(content) as unknown,
    );
  }

  async completeValidatedJSON<T>(
    lane: AIRouteLane,
    input: AIRouteRequest,
    validate: AIJSONValidator<T>,
  ): Promise<AIJSONRouteResult<T>> {
    return this.completeWithDecoder(lane, input, true, (content) => {
      const parsed = JSON.parse(content) as unknown;
      try {
        const validated = validate(parsed);
        if (validated === null) throw new AIProviderResponseError();
        return validated;
      } catch (error) {
        if (error instanceof AIProviderResponseError) throw error;
        throw new AIProviderResponseError();
      }
    }) as Promise<AIJSONRouteResult<T>>;
  }

  async smoke(routeId: ProviderSmokeRouteId): Promise<ProviderSmokeResult> {
    const route = routeDefinition(routeId);
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    const credential = LOCAL_E2E_HARNESS_BUILD
      ? null
      : resolveCredential(this.env, route.credential);
    const input: AIRouteRequest = {
      userPrompt: providerSmokePrompt,
      temperature: 0,
      maxTokens: 128,
      promptSchemaVersion: PROVIDER_SMOKE_PROMPT_SCHEMA_VERSION,
      promptVersion: PROVIDER_SMOKE_PROMPT_VERSION,
    };
    const receiptContext = await createInvocationReceiptContext(input, 'smoke', this.options.invocationScope);
    if (!credential) {
      const completedAt = Date.now();
      await this.persistAttempt({
        context: receiptContext,
        lane: route.lane,
        route,
        credentialAlias: 'unconfigured',
        attemptIndex: 1,
        startedAt,
        completedAt,
        outcome: 'failure',
        failureClass: 'unconfigured',
        retryable: false,
      });
      return {
        provider: route.provider,
        model: route.model,
        status: 'unavailable',
        failureClass: 'unconfigured',
        latencyMs: completedAt - startedAt,
        timestamp,
      };
    }

    let receivedContent: string | undefined;
    try {
      const response = await postOpenAICompatible(
        route.baseUrl,
        credential.value,
        makeRequest(route, input, false),
      );
      const content = responseContent(response);
      receivedContent = content;
      const completedAt = Date.now();
      if (content.trim() !== 'READY') throw new AIProviderResponseError();
      await this.persistAttempt({
        context: receiptContext,
        lane: route.lane,
        route,
        credentialAlias: credential.alias,
        attemptIndex: 1,
        startedAt,
        completedAt,
        outcome: 'success',
        failureClass: null,
        retryable: false,
        responseContent: content,
        usage: responseUsage(response),
      });
      return {
        provider: route.provider,
        model: route.model,
        status: 'ready',
        failureClass: null,
        latencyMs: completedAt - startedAt,
        timestamp,
      };
    } catch (error) {
      if (error instanceof AIInvocationReceiptPersistenceError) throw error;
      const completedAt = Date.now();
      const failureClass = normalizeFailure(error);
      await this.persistAttempt({
        context: receiptContext,
        lane: route.lane,
        route,
        credentialAlias: credential.alias,
        attemptIndex: 1,
        startedAt,
        completedAt,
        outcome: 'failure',
        failureClass,
        retryable: mayTryFallback(failureClass),
        responseContent: receivedContent,
      });
      return {
        provider: route.provider,
        model: route.model,
        status: 'unavailable',
        failureClass,
        latencyMs: completedAt - startedAt,
        timestamp,
      };
    }
  }

  private async completeWithDecoder<T>(
    lane: AIRouteLane,
    input: AIRouteRequest,
    jsonMode: boolean,
    decode: (content: string) => T,
  ): Promise<T extends string ? AITextRouteResult : AIJSONRouteResult> {
    const routes = this.routesForLane(lane);
    let attemptedRoutes = 0;
    let failureClass: AIFailureClass = 'unconfigured';
    let retryable = false;
    const receiptContext = await createInvocationReceiptContext(input, 'route', this.options.invocationScope);

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index];
      const credential = resolveCredential(this.env, route.credential);
      if (!credential) continue;
      attemptedRoutes += 1;
      const startedAt = Date.now();
      let receivedContent: string | undefined;
      try {
        const response = await postOpenAICompatible(route.baseUrl, credential.value, makeRequest(route, input, jsonMode));
        const content = responseContent(response);
        receivedContent = content;
        const decoded = decode(content);
        const completedAt = Date.now();
        const usage = responseUsage(response);
        await this.persistAttempt({
          context: receiptContext,
          lane,
          route,
          credentialAlias: credential.alias,
          attemptIndex: attemptedRoutes,
          startedAt,
          completedAt,
          outcome: 'success',
          failureClass: null,
          retryable: false,
          responseContent: content,
          usage,
        });
        const metadata: AIRouteMetadata = {
          lane,
          provider: route.provider,
          model: route.model,
          fallback: index > 0,
          attemptCount: attemptedRoutes,
          latencyMs: completedAt - startedAt,
        };
        const result = jsonMode
          ? { value: decoded, metadata, usage }
          : { content: String(decoded), metadata, usage };
        return result as T extends string ? AITextRouteResult : AIJSONRouteResult;
      } catch (error) {
        if (error instanceof AIInvocationReceiptPersistenceError) throw error;
        failureClass = normalizeFailure(error);
        retryable = mayTryFallback(failureClass);
        await this.persistAttempt({
          context: receiptContext,
          lane,
          route,
          credentialAlias: credential.alias,
          attemptIndex: attemptedRoutes,
          startedAt,
          completedAt: Date.now(),
          outcome: 'failure',
          failureClass,
          retryable,
          responseContent: receivedContent,
        });
        console.warn(`[AI_ROUTER] lane=${lane} route=${route.routeId} failure=${failureClass}`);
        if (!retryable) break;
      }
    }

    throw new AIRouteUnavailableError(lane, attemptedRoutes, failureClass, retryable);
  }

  private async persistAttempt(receipt: AttemptReceipt): Promise<void> {
    let responseSha256: string | null = null;
    try {
      responseSha256 = receipt.responseContent === undefined
        ? null
        : await sha256Hex(receipt.responseContent);
      await this.env.DB.prepare(RECEIPT_SQL).bind(
        crypto.randomUUID(),
        receipt.context.sessionContextId,
        receipt.context.sessionId,
        receipt.context.turnNumber,
        receipt.context.promptCacheNamespace,
        receipt.context.invocationId,
        receipt.context.invocationKind,
        receipt.lane,
        receipt.route.routeId,
        receipt.route.provider,
        receipt.route.model,
        receipt.credentialAlias,
        receipt.attemptIndex,
        receipt.startedAt,
        receipt.completedAt,
        receipt.completedAt - receipt.startedAt,
        receipt.outcome,
        receipt.failureClass,
        receipt.retryable ? 1 : 0,
        receipt.context.promptSchemaVersion,
        receipt.context.promptVersion,
        receipt.context.promptSha256,
        responseSha256,
        receipt.usage?.promptTokens ?? null,
        receipt.usage?.completionTokens ?? null,
        receipt.usage?.totalTokens ?? null,
        receipt.completedAt,
      ).run();
    } catch {
      if (this.options.mode === 'context_bound') {
        throw new AIInvocationReceiptPersistenceError();
      }
      // Legacy telemetry is best-effort for compatibility only.
      console.warn('[AI_ROUTER] attempt receipt persistence failed');
    }
  }

  private routesForLane(lane: AIRouteLane): RouteDefinition[] {
    const pinnedRoutePlan = this.options.pinnedRoutePlan;
    const pinnedRouteIds = pinnedRoutePlan?.[lane];
    if (pinnedRoutePlan && (!isValidPinnedLaneRoutePlan(pinnedRoutePlan) || !Array.isArray(pinnedRouteIds))) {
      throw new AIRouterConfigurationError();
    }

    const local = localE2EConfiguration(this.env);
    if (local.status === 'valid') {
      if (pinnedRouteIds && !pinnedRouteIds.includes(LOCAL_E2E_ROUTE_ID)) return [];
      return [localE2ERoute(local.baseUrl)];
    }
    if (LOCAL_E2E_HARNESS_BUILD || local.status === 'invalid') return [];
    if (!pinnedRoutePlan) return routesForLane(lane);
    return pinnedRouteIds!.map(routeDefinition);
  }
}

export function createAIRouter(env: Bindings, options?: AIRouterOptions): AIRouter {
  return new AIRouter(env, options);
}
