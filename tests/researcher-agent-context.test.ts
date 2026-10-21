import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIRouter } from '../src/services/ai-router';
import { AIInvocationReceiptPersistenceError } from '../src/services/ai-router';

const legacyCall = vi.hoisted(() => vi.fn());

vi.mock('../src/services/ai-client', () => ({
  callAIJSON: legacyCall,
}));

const { runResearcherAgent } = await import('../src/services/math/researcher-agent');

const approvedSources = [{
  sourceId: 'chunk-1',
  content: 'The source supports the claim because it gives a direct reason.',
  contentSha256: 'source-sha-1',
  charStart: 100,
  charEnd: 161,
}];

function span(quote: string, startOffset: number, overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'chunk-1',
    sourceSha256: 'source-sha-1',
    quote,
    startOffset,
    endOffset: startOffset + quote.length,
    ...overrides,
  };
}

function context() {
  return {
    sessionId: 'session-1',
    studentMessage: 'I think the source supports the claim because it says so.',
    topic: 'Source interpretation',
    bookText: approvedSources[0].content,
    approvedEvidenceSources: approvedSources,
  };
}

function routedFactCheck(payload: Record<string, unknown>) {
  return vi.fn(async (
    lane: string,
    _input: unknown,
    validate: (value: unknown) => unknown,
  ) => {
    expect(lane).toBe('background_reasoning');
    return { value: validate(payload) };
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  legacyCall.mockReset();
});

describe('context-bound Researcher', () => {
  it('returns a verified result only with a source-bound exact supporting span', async () => {
    const quote = approvedSources[0].content;
    const completeValidatedJSON = routedFactCheck({
      claimVerified: true,
      confidence: 0.8,
      supportingEvidence: [span(quote, 0)],
      contradictingEvidence: [],
      missingContext: [],
    });
    const router = { completeValidatedJSON } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(completeValidatedJSON).toHaveBeenCalledTimes(1);
    expect(legacyCall).not.toHaveBeenCalled();
    expect(result.factCheckResult).toMatchObject({
      status: 'verified',
      claimVerified: true,
      confidence: 0.8,
      supportingEvidence: [{
        sourceId: 'chunk-1',
        sourceSha256: 'source-sha-1',
        quote,
        startOffset: 0,
        endOffset: quote.length,
      }],
    });
  });

  it.each([
    ['a tiny substring', {
      claimVerified: true,
      confidence: 0.9,
      supportingEvidence: [span('e', 2)],
      contradictingEvidence: [],
      missingContext: [],
    }],
    ['an unknown source id', {
      claimVerified: true,
      confidence: 0.9,
      supportingEvidence: [span('The source supports the claim because it gives a direct reason.', 0, { sourceId: 'other-chunk' })],
      contradictingEvidence: [],
      missingContext: [],
    }],
    ['a polarity mismatch', {
      claimVerified: true,
      confidence: 0.9,
      supportingEvidence: [],
      contradictingEvidence: [span('The source supports the claim because it gives a direct reason.', 0)],
      missingContext: [],
    }],
    ['the same canonical span in both polarities', {
      claimVerified: true,
      confidence: 0.9,
      supportingEvidence: [span('The source supports the claim because it gives a direct reason.', 0)],
      contradictingEvidence: [span('The source supports the claim because it gives a direct reason.', 0)],
      missingContext: [],
    }],
    ['a duplicate span within one polarity', {
      claimVerified: true,
      confidence: 0.9,
      supportingEvidence: [
        span('The source supports the claim because it gives a direct reason.', 0),
        span('The source supports the claim because it gives a direct reason.', 0),
      ],
      contradictingEvidence: [],
      missingContext: [],
    }],
  ])('returns UNGRADABLE unavailable for %s', async (_caseName, payload) => {
    const router = { completeValidatedJSON: routedFactCheck(payload) } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toEqual(expect.objectContaining({
      status: 'unavailable',
      claimVerified: null,
      supportingEvidence: [],
      contradictingEvidence: [],
    }));
  });

  it.each([-0.1, 1.1])('returns UNGRADABLE unavailable for out-of-range confidence %s', async (confidence) => {
    const router = {
      completeValidatedJSON: routedFactCheck({
        claimVerified: true,
        confidence,
        supportingEvidence: [span('The source supports the claim because it gives a direct reason.', 0)],
        contradictingEvidence: [],
        missingContext: [],
      }),
    } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toEqual(expect.objectContaining({
      status: 'unavailable',
      claimVerified: null,
      confidence: 0,
    }));
  });

  it('returns UNGRADABLE unavailable for overlapping spans in one polarity', async () => {
    const source = approvedSources[0].content;
    const router = {
      completeValidatedJSON: routedFactCheck({
        claimVerified: true,
        confidence: 0.9,
        supportingEvidence: [
          span(source.slice(0, 16), 0),
          span(source.slice(8, 24), 8),
        ],
        contradictingEvidence: [],
        missingContext: [],
      }),
    } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toEqual(expect.objectContaining({
      status: 'unavailable',
      claimVerified: null,
      supportingEvidence: [],
      contradictingEvidence: [],
    }));
  });

  it('returns UNGRADABLE unavailable for overlapping spans across polarities', async () => {
    const source = approvedSources[0].content;
    const router = {
      completeValidatedJSON: routedFactCheck({
        claimVerified: true,
        confidence: 0.9,
        supportingEvidence: [span(source.slice(0, 16), 0)],
        contradictingEvidence: [span(source.slice(8, 24), 8)],
        missingContext: [],
      }),
    } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toEqual(expect.objectContaining({
      status: 'unavailable',
      claimVerified: null,
      supportingEvidence: [],
      contradictingEvidence: [],
    }));
  });

  it('accepts adjacent source spans across polarities when the verdict has supporting evidence', async () => {
    const source = approvedSources[0].content;
    const router = {
      completeValidatedJSON: routedFactCheck({
        claimVerified: true,
        confidence: 0.9,
        supportingEvidence: [span(source.slice(0, 16), 0)],
        contradictingEvidence: [span(source.slice(16, 32), 16)],
        missingContext: [],
      }),
    } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toMatchObject({
      status: 'verified',
      claimVerified: true,
      supportingEvidence: [{ startOffset: 0, endOffset: 16 }],
      contradictingEvidence: [{ startOffset: 16, endOffset: 32 }],
    });
  });

  it('returns unavailable when the scoped route is ordinarily unavailable', async () => {
    const completeValidatedJSON = vi.fn(async () => {
      throw new Error('route unavailable');
    });
    const router = { completeValidatedJSON } as unknown as AIRouter;

    const result = await runResearcherAgent(router, context());

    expect(result.factCheckResult).toMatchObject({
      status: 'unavailable',
      claimVerified: null,
    });
  });

  it('rethrows an invocation receipt persistence failure instead of translating it to unavailable', async () => {
    const completeValidatedJSON = vi.fn(async () => {
      throw new AIInvocationReceiptPersistenceError();
    });
    const router = { completeValidatedJSON } as unknown as AIRouter;

    await expect(runResearcherAgent(router, context())).rejects.toBeInstanceOf(
      AIInvocationReceiptPersistenceError,
    );
  });
});
