import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AIJSONValidator, AIRouteLane } from '../src/services/ai-router';
import type { PinnedLaneRoutePlan } from '../src/services/learning-session-context';
import type { Bindings } from '../src/types';

const LOCAL_ROUTE_ID = 'local-e2e-openai';
const LANES: readonly AIRouteLane[] = [
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
  'background_reasoning',
];

function localPlan(): PinnedLaneRoutePlan {
  return Object.fromEntries(LANES.map((lane) => [lane, [LOCAL_ROUTE_ID]])) as unknown as PinnedLaneRoutePlan;
}

function localEnv(): Bindings {
  const db = {
    prepare: () => ({
      bind: () => ({ run: async () => ({}) }),
    }),
  } as unknown as D1Database;
  return {
    DB: db,
    JWT_SECRET: 'fixture-only',
    SOONGSIL_API_KEY: '',
    GEMINI_API_KEY: '',
    AI_LOCAL_E2E_OPT_IN: '1',
    AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/v1',
  } as Bindings;
}

function recordingLocalEnv(): { env: Bindings; attempts: unknown[][] } {
  const attempts: unknown[][] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (sql.includes('INSERT INTO ai_invocation_attempts')) attempts.push(values);
          return {};
        },
      }),
    }),
  } as unknown as D1Database;
  return { env: { ...localEnv(), DB: db }, attempts };
}

function validPayload(value: unknown): { ok: true } | null {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true ? { ok: true } : null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('development-local OpenAI-compatible router', () => {
  it('uses the loopback mock route for every context-bound Training lane', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fixture = recordingLocalEnv();
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Response.json({
        id: 'local-e2e-completion',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }));

    const router = createAIRouter(fixture.env, {
      mode: 'context_bound',
      pinnedRoutePlan: localPlan(),
      invocationScope: {
        sessionContextId: 'local-context',
        sessionId: 'local-session',
        turnNumber: 1,
        promptCacheNamespace: 'local-training',
      },
    });

    const results = await Promise.all(LANES.map((lane) => router.completeValidatedJSON(
      lane,
      { userPrompt: `deterministic ${lane}` },
      validPayload as AIJSONValidator<{ ok: true }>,
    )));

    expect(results.map((result) => result.value)).toEqual(LANES.map(() => ({ ok: true })));
    expect(results.map((result) => result.metadata)).toEqual(LANES.map((lane) => expect.objectContaining({
      lane,
      provider: 'local_e2e',
      model: 'local-e2e',
      fallback: false,
      attemptCount: 1,
    })));
    expect(requestedUrls).toEqual(LANES.map(() => 'http://127.0.0.1:8788/v1/chat/completions'));
    expect(fixture.attempts).toHaveLength(LANES.length);
    expect(fixture.attempts.map((attempt) => attempt.slice(7, 12))).toEqual(LANES.map((lane) => [
      lane,
      'local-e2e-openai',
      'local_e2e',
      'local-e2e',
      'AI_LOCAL_E2E_OPT_IN',
    ]));
    expect(JSON.stringify(fixture.attempts)).not.toContain('127.0.0.1:8788');
  });

  it.each([
    ['a missing opt-in', { AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/v1' }],
    ['an opt-in value other than exactly 1', { AI_LOCAL_E2E_OPT_IN: 'true', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/v1' }],
    ['a missing base URL', { AI_LOCAL_E2E_OPT_IN: '1' }],
    ['an HTTPS base URL', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'https://127.0.0.1:8788/v1' }],
    ['a non-loopback host', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://example.test:8788/v1' }],
    ['a different IPv4 loopback address', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.2:8788/v1' }],
    ['localhost rather than a literal loopback address', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://localhost:8788/v1' }],
    ['a URL without an explicit port', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1/v1' }],
    ['a URL with userinfo', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://user@127.0.0.1:8788/v1' }],
    ['a URL with a query', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/v1?mock=1' }],
    ['a URL with a fragment', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/v1#mock' }],
    ['a URL outside the OpenAI v1 root', { AI_LOCAL_E2E_OPT_IN: '1', AI_LOCAL_E2E_BASE_URL: 'http://127.0.0.1:8788/not-v1' }],
  ])('rejects %s before an external-provider fetch can begin', async (_name, invalid) => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);
    const base = localEnv();
    const { AI_LOCAL_E2E_OPT_IN: _ignoredOptIn, AI_LOCAL_E2E_BASE_URL: _ignoredBaseUrl, ...withoutLocalConfig } = base;
    const env = {
      ...withoutLocalConfig,
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
      ...invalid,
    } as Bindings;

    await expect(createAIRouter(env).completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'must not leave the local harness' },
      validPayload as AIJSONValidator<{ ok: true }>,
    )).rejects.toMatchObject({ name: 'AIRouteUnavailableError', failureClass: 'unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the local pair in a normal build before an external-provider fetch can begin', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);
    const env = { ...localEnv(), AI_ACTOR_SSU_API_KEY: '[REDACTED]' } as Bindings;

    await expect(createAIRouter(env).completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'must not leave a normal build' },
      validPayload as AIJSONValidator<{ ok: true }>,
    )).rejects.toMatchObject({ name: 'AIRouteUnavailableError', failureClass: 'unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://[::1]:8788/v1',
    'http://127.0.0.1:8789/v1',
  ])('rejects a local endpoint that is outside the fixed route identity: %s', async (baseUrl) => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);
    const env = { ...localEnv(), AI_LOCAL_E2E_BASE_URL: baseUrl } as Bindings;

    await expect(createAIRouter(env).completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'fixed local route identity' },
      validPayload as AIJSONValidator<{ ok: true }>,
    )).rejects.toMatchObject({ name: 'AIRouteUnavailableError', failureClass: 'unconfigured' });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a valid local route when it is absent from the frozen context plan', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);
    const productionPlan = {
      interactive_generation: ['ssu-luna'],
      learner_evaluation: ['deepseek-v4-pro'],
      release_critic: ['deepseek-v4-flash'],
      background_reasoning: ['deepseek-v4-pro'],
    } as unknown as PinnedLaneRoutePlan;
    const router = createAIRouter(localEnv(), {
      mode: 'context_bound',
      pinnedRoutePlan: productionPlan,
      invocationScope: {
        sessionContextId: 'production-context',
        sessionId: 'production-session',
        turnNumber: 1,
        promptCacheNamespace: 'frozen-production-plan',
      },
    });

    await expect(router.completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'must remain within the frozen plan' },
      validPayload as AIJSONValidator<{ ok: true }>,
    )).rejects.toMatchObject({ name: 'AIRouteUnavailableError', failureClass: 'unconfigured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks ordinary router providers throughout a local harness build when the local pair is absent', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Response.json({ id: 'provider-completion', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
    }));
    const env = {
      ...localEnv(),
      AI_LOCAL_E2E_OPT_IN: undefined,
      AI_LOCAL_E2E_BASE_URL: undefined,
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
    } as Bindings;

    await expect(createAIRouter(env).completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'normal provider selection' },
      validPayload as AIJSONValidator<{ ok: true }>,
    )).rejects.toMatchObject({ name: 'AIRouteUnavailableError', failureClass: 'unconfigured' });

    expect(requestedUrls).toEqual([]);
  });

  it('blocks the legacy provider cascade throughout a local harness build', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { callAI } = await import('../src/services/ai-client');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);

    await expect(callAI(
      'real-provider-must-not-run',
      'real-provider-must-not-run',
      'system',
      'user',
      { env: { DEEPSEEK_API_KEY: '[REDACTED]' } },
    )).rejects.toThrow('External AI providers are disabled in a local E2E harness build');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks provider smoke routes throughout a local harness build', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter } = await import('../src/services/ai-router');
    const fetch = vi.fn(async () => Response.json({ id: 'unexpected', choices: [] }));
    vi.stubGlobal('fetch', fetch);
    const fixture = recordingLocalEnv();
    const env = {
      ...fixture.env,
      AI_ACTOR_SSU_API_KEY: '[REDACTED]',
    } as Bindings;

    await expect(createAIRouter(env).smoke('ssu-luna')).resolves.toMatchObject({
      provider: 'ssu_mindlogic',
      status: 'unavailable',
      failureClass: 'unconfigured',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.attempts).toHaveLength(1);
    expect(fixture.attempts[0]?.[11]).toBe('unconfigured');
  });

  it('reports a valid local harness as local_only even after local receipts exist', async () => {
    vi.stubEnv('VITE_LOCAL_E2E_HARNESS', '1');
    vi.resetModules();
    const { createAIRouter, getAIRoutingRuntimeHealth } = await import('../src/services/ai-router');
    const fixture = recordingLocalEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      id: 'local-health-completion',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    })));

    await createAIRouter(fixture.env).completeValidatedJSON(
      'interactive_generation',
      { userPrompt: 'local receipt must not imply provider readiness' },
      validPayload as AIJSONValidator<{ ok: true }>,
    );
    expect(fixture.attempts).toHaveLength(1);

    const health = await getAIRoutingRuntimeHealth(fixture.env);

    expect(health.status).toBe('local_only');
    expect(health.requiredPrimaryRoutes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        routeId: 'local-e2e-openai',
        provider: 'local_e2e',
        model: 'local-e2e',
        credentialAlias: 'AI_LOCAL_E2E_OPT_IN',
        status: 'local_only',
      }),
    ]));
  });
});
