import { describe, expect, it, vi } from 'vitest';
import { ingestODEBatch, retrieveODEChunks } from '../src/services/ode-integration';

const vector = () => Array.from({ length: 768 }, (_, index) => index / 768);
function bindings(result: unknown) {
  const insert = vi.fn().mockResolvedValue({});
  const query = vi.fn().mockResolvedValue({ matches: [] });
  return { insert, query, env: {
    AI: { run: vi.fn().mockResolvedValue(result) } as unknown as Ai,
    VECTORIZE_INDEX: { insert, query } as unknown as VectorizeIndex,
  } };
}
const document = { id: 'doc-a', text: 'A source paragraph.', topic: 'education', category: 'society', source: 'fixture', qualityScore: 0.5 };
const invalidResponses = [
  ['absent completion', { request_id: 'pending' }],
  ['empty completion', { data: [] }],
  ['767 dimensions', { data: [Array(767).fill(1)] }],
  ['769 dimensions', { data: [Array(769).fill(1)] }],
  ['extra vector', { data: [vector(), vector()] }],
  ['non-numeric vector', { data: [Array(768).fill('not-a-number')] }],
  ['non-finite vector', { data: [Array(768).fill(NaN)] }],
] as const;
describe('Workers embedding completion boundary', () => {
  it.each(invalidResponses)('does not insert or query %s', async (_label, response) => {
    const { env, insert, query } = bindings(response);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await ingestODEBatch(env, [document])).toEqual({ ingested: 0, errors: 1 });
      expect(insert).not.toHaveBeenCalled();
      await expect(retrieveODEChunks(env, 'source question')).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
  it('passes completed embeddings and numeric quality metadata to Vectorize', async () => {
    const values = vector();
    const { env, insert, query } = bindings({ data: [values] });
    expect(await ingestODEBatch(env, [document])).toEqual({ ingested: 1, errors: 0 });
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ id: 'doc-a', values, metadata: expect.objectContaining({ quality: 0.5 }) })]);
    expect(await retrieveODEChunks(env, 'source question')).toEqual([]);
    expect(query).toHaveBeenCalledWith(values, expect.objectContaining({ returnMetadata: 'all' }));
  });
});
