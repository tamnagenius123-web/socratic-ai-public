// =============================================
// v21 P0-4: D1 Batch Chunk Utility
// =============================================
// Cloudflare D1 has a limit of 100 queries per batch.
// This utility splits statements into safe chunks.
// =============================================

/**
 * Execute D1 prepared statements in batched chunks.
 * Prevents D1 batch limit exceeded errors (max 100 per batch).
 * @param db - D1Database instance
 * @param statements - Array of D1PreparedStatement to execute
 * @param chunkSize - Max statements per batch (default 50, safe margin below 100 limit)
 */
export async function batchExecute(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize: number = 50,
): Promise<D1Result[][]> {
  if (statements.length === 0) return [];
  const results: D1Result[][] = [];
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    const batchResult = await db.batch(chunk);
    results.push(batchResult);
  }
  return results;
}

/**
 * Fire-and-forget batch execution (catches errors silently).
 * Useful for non-critical side-effect writes.
 */
export async function batchExecuteSafe(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize: number = 50,
): Promise<void> {
  if (statements.length === 0) return;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    await db.batch(chunk).catch((e) => {
      console.warn(`[D1_BATCH] Chunk ${i / chunkSize} failed:`, e);
    });
  }
}
