/** Only completed, finite 768-dimensional BGE batches may reach Vectorize. */
export function readBgeEmbeddings(result: unknown, expectedCount: number): number[][] {
  if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data)
    || result.data.length !== expectedCount) throw new Error('Embedding service returned an incomplete batch');
  return result.data.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.length !== 768
      || !vector.every((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Embedding service returned an invalid vector');
    }
    return vector;
  });
}
