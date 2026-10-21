import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAIJSONWithEnv, callAIWithEnv } from '../src/services/ai-client';

afterEach(() => vi.unstubAllGlobals());
describe('environment-aware legacy provider fallback', () => {
  it.each(['json', 'text'] as const)('keeps each configured provider credential on its own request: %s', async (mode) => {
    const authorization: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('Authorization') || '';
      authorization.push(key);
      if (key !== '[REDACTED]') return new Response('offline provider outage', { status: 503 });
      return Response.json({ id: 'fixture-completion', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
    }));
    const env = { DEEPSEEK_API_KEY: '[REDACTED]', GEMINI_API_KEY: '[REDACTED]', SOONGSIL_API_KEY: '[REDACTED]' };
    if (mode === 'json') expect(await callAIJSONWithEnv(env, 'Test system', 'Test message')).toEqual({ ok: true });
    else expect((await callAIWithEnv(env, 'Test system', 'Test message', { preferFast: true })).content).toBe('{"ok":true}');
    expect(authorization).toEqual(['[REDACTED]', 'Bearer fixture-gemini', '[REDACTED]']);
  });
});
