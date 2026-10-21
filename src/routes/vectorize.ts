import { readBgeEmbeddings } from '../services/workers-embeddings';
// ============================================================
// v20 P1-A: Cloudflare Vectorize RAG Routes
// ============================================================

import { Hono } from 'hono';
import { requireAuth, getAuthUser } from '../middleware/auth';
import { LIBRARY_EMBEDDING_MODEL, libraryVectorId } from '../services/library-ingestion';

interface VectorizeBindings {
  DB: D1Database;
  VECTORIZE_INDEX?: VectorizeIndex; // v21: strict typing (was any)
  AI?: Ai; // v21: Workers AI binding for bge-base-en-v1.5 (768d)
  SOONGSIL_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

const vectorizeRoute = new Hono<{ Bindings: VectorizeBindings }>();

vectorizeRoute.use('/api/books/:bookId/vectorize', requireAuth);
vectorizeRoute.use('/api/vectorize/*', requireAuth);

/**
 * POST /api/books/:bookId/vectorize — 책 텍스트를 Vectorize로 인제스트
 */
vectorizeRoute.post('/api/books/:bookId/vectorize', async (c) => {
  const bookId = c.req.param('bookId');
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const row = await db.prepare(`
    SELECT id, is_builtin, owner_user_id, ingestion_status, vector_status,
           current_ingestion_attempt_id, visibility
    FROM books
    WHERE id = ?1
      AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
  `).bind(bookId).first<{
    id: string;
    is_builtin: number;
    owner_user_id: string | null;
    ingestion_status: string;
    vector_status: string;
    current_ingestion_attempt_id: string | null;
    visibility: string;
  }>();
  if (!row) return c.json({ error: 'Book not found' }, 404);
  if (row.is_builtin) {
    if (auth.role !== 'admin' || row.visibility !== 'builtin') {
      return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
    }
  } else if (row.owner_user_id !== auth.userId || row.visibility !== 'private') {
    return c.json({ error: '도서 인덱싱 권한이 없습니다.' }, 403);
  }
  // Bounded contract: no cleanup consumer is available in this route. A partial
  // Vectorize write therefore remains blocked until an operator reconciles its
  // cleanup job, so its deterministic vector IDs cannot overlap a later retry.
  if (row.ingestion_status === 'processing' || row.vector_status === 'processing' || row.vector_status === 'cleanup_pending') {
    return c.json({ error: 'INGESTION_ATTEMPT_CONFLICT' }, 409);
  }

  const chunkRows = await db.prepare(`
    SELECT chunk_index, content, char_start, char_end
    FROM document_chunks
    WHERE book_id = ?1
    ORDER BY chunk_index ASC
  `).bind(bookId).all<{
    chunk_index: number;
    content: string;
    char_start: number | null;
    char_end: number | null;
  }>();
  const chunks = chunkRows.results || [];
  if (chunks.length === 0) {
    return c.json({ error: '먼저 도서 근거 청크 생성을 완료해 주세요.' }, 409);
  }

  if (!c.env.VECTORIZE_INDEX) {
    return c.json({ error: 'Vectorize binding not configured. Add VECTORIZE_INDEX to wrangler.jsonc' }, 503);
  }

  let attemptId: string | null = null;
  let attemptOwnerUserId: string | null = null;
  let attemptActivated = false;
  const potentiallyWrittenVectorIds: string[] = [];

  try {
    const startedAt = Date.now();
    attemptId = `ingest_${crypto.randomUUID()}`;
    attemptOwnerUserId = row.is_builtin ? auth.userId : String(row.owner_user_id);
    const activation = await db.batch([
      db.prepare(`
        UPDATE books
        SET ingestion_status = 'processing', vector_status = 'processing',
            current_ingestion_attempt_id = ?2, updated_at = ?3
        WHERE id = ?1
          AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
          AND ingestion_status <> 'processing'
          AND vector_status NOT IN ('processing', 'cleanup_pending')
          AND (
            (is_builtin = 1 AND visibility = 'builtin' AND ?4 = 'admin')
            OR (is_builtin = 0 AND owner_user_id = ?5 AND visibility = 'private')
          )
      `).bind(bookId, attemptId, startedAt, auth.role, auth.userId),
      db.prepare(`
        INSERT INTO book_ingestion_attempts (
          id, book_id, owner_user_id, content_sha256, chunking_version,
          stage, status, created_at, updated_at
        )
        SELECT ?1, id, ?2, COALESCE(content_sha256, 'legacy'),
               COALESCE(chunking_version, 'legacy'), 'vectorize', 'processing', ?3, ?3
        FROM books
        WHERE id = ?4
          AND current_ingestion_attempt_id = ?1
          AND ingestion_status = 'processing'
          AND vector_status = 'processing'
          AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
      `).bind(attemptId, attemptOwnerUserId, startedAt, bookId),
    ]);
    if (Number(activation[0]?.meta?.changes || 0) === 0 || Number(activation[1]?.meta?.changes || 0) === 0) {
      return c.json({ error: 'INGESTION_ATTEMPT_CONFLICT' }, 409);
    }
    attemptActivated = true;

    // Reuse the canonical D1 chunks and their stable identifiers.
    const vectors: { id: string; values: number[]; metadata: Record<string, string> }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await generateEmbedding(c.env, chunk.content);
      vectors.push({
        id: libraryVectorId(bookId, Number(chunk.chunk_index)),
        values: embedding,
        metadata: {
          bookId,
          chunkIndex: String(chunk.chunk_index),
          ownerUserId: row.is_builtin ? 'builtin' : String(row.owner_user_id || ''),
          charStart: String(chunk.char_start ?? ''),
          charEnd: String(chunk.char_end ?? ''),
          text: chunk.content.substring(0, 200),
        },
      });
    }

    // Batch upsert (Vectorize accepts up to 1000 vectors per call)
    const BATCH_SIZE = 100;
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      potentiallyWrittenVectorIds.push(...batch.map((vector) => vector.id));
      await c.env.VECTORIZE_INDEX.upsert(batch);
    }

    const completedAt = Date.now();
    const finalized = await db.batch([
      db.prepare(`
        UPDATE book_ingestion_attempts
        SET stage = 'vectorize', status = 'ready', vector_count = ?2,
            embedding_model = ?3, error_code = NULL, error_message = NULL, updated_at = ?4
        WHERE id = ?1
          AND book_id = ?5
          AND owner_user_id = ?6
          AND status = 'processing'
          AND EXISTS (
            SELECT 1 FROM books
            WHERE id = ?5
              AND current_ingestion_attempt_id = ?1
              AND ingestion_status = 'processing'
              AND vector_status = 'processing'
              AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
              AND (
                (is_builtin = 1 AND owner_user_id IS NULL AND ?7 = 'admin')
                OR (is_builtin = 0 AND owner_user_id = ?8 AND visibility = 'private')
              )
          )
      `).bind(attemptId, chunks.length, LIBRARY_EMBEDDING_MODEL, completedAt, bookId, attemptOwnerUserId, auth.role, auth.userId),
      db.prepare(`
        UPDATE books
        SET ingestion_status = 'ready', vector_status = 'indexed',
            last_ingestion_error = NULL, updated_at = ?2
        WHERE id = ?1
          AND current_ingestion_attempt_id = ?3
          AND ingestion_status = 'processing'
          AND vector_status = 'processing'
          AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
          AND (
            (is_builtin = 1 AND owner_user_id IS NULL AND ?4 = 'admin')
            OR (is_builtin = 0 AND owner_user_id = ?5 AND visibility = 'private')
          )
          AND EXISTS (
            SELECT 1 FROM book_ingestion_attempts
            WHERE id = ?3
              AND book_id = ?1
              AND owner_user_id = ?6
              AND status = 'ready'
          )
      `).bind(bookId, completedAt, attemptId, auth.role, auth.userId, attemptOwnerUserId),
      db.prepare(`
        INSERT OR REPLACE INTO vector_documents
          (id, source_type, source_id, chunk_count, embedding_model, vector_index_name, status, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
        WHERE EXISTS (
          SELECT 1 FROM books
          WHERE id = ?3
            AND current_ingestion_attempt_id = ?9
            AND ingestion_status = 'ready'
            AND vector_status = 'indexed'
            AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
        )
      `).bind(
        `vdoc_book_${bookId}`, 'book', bookId,
        chunks.length, LIBRARY_EMBEDDING_MODEL, 'socratic-vector-index',
        'indexed', completedAt, attemptId,
      ),
    ]);
    if (Number(finalized[1]?.meta?.changes || 0) === 0) {
      if (potentiallyWrittenVectorIds.length > 0) {
        const staleAt = Date.now();
        try {
          await db.batch([
            prepareVectorCleanup(
              db,
              bookId,
              attemptId,
              attemptOwnerUserId,
              potentiallyWrittenVectorIds,
              'stale_ingestion_attempt_cleanup_pending',
              staleAt,
            ),
            db.prepare(`
              UPDATE book_ingestion_attempts
              SET stage = 'vectorize', status = 'failed',
                  error_code = 'stale_ingestion_attempt_cleanup_pending',
                  error_message = 'Final vectorization state was superseded after vector writes',
                  updated_at = ?2
              WHERE id = ?1
                AND book_id = ?3
                AND owner_user_id = ?4
                AND status IN ('processing', 'ready')
            `).bind(attemptId, staleAt, bookId, attemptOwnerUserId),
            db.prepare(`
              UPDATE books
              SET ingestion_status = CASE
                    WHEN lifecycle_status = 'active' OR lifecycle_status IS NULL THEN 'd1_ready'
                    ELSE ingestion_status
                  END,
                  vector_status = 'cleanup_pending',
                  last_ingestion_error = 'stale_ingestion_attempt_cleanup_pending',
                  updated_at = ?3
              WHERE id = ?1
                AND current_ingestion_attempt_id = ?2
                AND vector_status IN ('processing', 'indexed', 'failed', 'cleanup_pending')
                AND (
                  lifecycle_status = 'active'
                  OR lifecycle_status IS NULL
                  OR lifecycle_status = 'deleted'
                  OR visibility = 'quarantined'
                )
            `).bind(bookId, attemptId, staleAt),
          ]);
        } catch (staleTransitionError) {
          console.error('[VECTORIZE_INGEST] Failed to persist stale cleanup state:', staleTransitionError);
          return c.json({ error: 'Vectorize stale cleanup state could not be persisted.' }, 500);
        }
      }
      return c.json({ error: 'STALE_INGESTION_ATTEMPT' }, 409);
    }

    return c.json({ ok: true, bookId, ingestionAttemptId: attemptId, chunksIndexed: chunks.length, embeddingModel: LIBRARY_EMBEDDING_MODEL, dimensions: 768 });
  } catch (error: unknown) {
    console.error('[VECTORIZE_INGEST]', error);
    if (!attemptActivated || !attemptId || !attemptOwnerUserId) {
      return c.json({ error: 'Vectorize ingestion state could not be initialized.' }, 500);
    }
    const failedAt = Date.now();
    const hasPotentialVectorWrites = potentiallyWrittenVectorIds.length > 0;
    const failureStatements = [
      db.prepare(`
        UPDATE book_ingestion_attempts
        SET stage = 'vectorize', status = 'failed', error_code = 'vectorize_failed',
            error_message = 'Embedding or vector index unavailable', updated_at = ?2
        WHERE id = ?1
          AND book_id = ?3
          AND owner_user_id = ?4
          AND status = 'processing'
          AND EXISTS (
            SELECT 1 FROM books
            WHERE id = ?3
              AND current_ingestion_attempt_id = ?1
              AND ingestion_status = 'processing'
              AND vector_status = 'processing'
              AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
              AND (
                (is_builtin = 1 AND owner_user_id IS NULL AND ?5 = 'admin')
                OR (is_builtin = 0 AND owner_user_id = ?6 AND visibility = 'private')
              )
          )
      `).bind(attemptId, failedAt, bookId, attemptOwnerUserId, auth.role, auth.userId),
      db.prepare(`
        UPDATE books
        SET ingestion_status = 'd1_ready', vector_status = ?2,
            last_ingestion_error = 'vectorize_failed', updated_at = ?3
        WHERE id = ?1
          AND current_ingestion_attempt_id = ?4
          AND ingestion_status = 'processing'
          AND vector_status = 'processing'
          AND (lifecycle_status = 'active' OR lifecycle_status IS NULL)
          AND (
            (is_builtin = 1 AND owner_user_id IS NULL AND ?5 = 'admin')
            OR (is_builtin = 0 AND owner_user_id = ?6 AND visibility = 'private')
          )
      `).bind(bookId, hasPotentialVectorWrites ? 'cleanup_pending' : 'failed', failedAt, attemptId, auth.role, auth.userId),
    ];
    if (hasPotentialVectorWrites) {
      failureStatements.unshift(prepareVectorCleanup(
        db,
        bookId,
        attemptId,
        attemptOwnerUserId,
        potentiallyWrittenVectorIds,
        'vectorize_failed',
        failedAt,
      ));
    }

    let failure: D1Result<unknown>[];
    try {
      failure = await db.batch(failureStatements);
    } catch (transitionError) {
      console.error('[VECTORIZE_INGEST] Failed to persist cleanup state:', transitionError);
      return c.json({ error: 'Vectorize cleanup state could not be persisted.' }, 500);
    }
    if (Number(failure.at(-1)?.meta?.changes || 0) === 0) {
      return c.json({ error: 'STALE_INGESTION_ATTEMPT' }, 409);
    }
    return c.json({ error: '의미 검색 인덱스 생성에 실패했습니다. 도서 근거 청크는 보존되었습니다.' }, 502);
  }
});

function prepareVectorCleanup(
  db: D1Database,
  bookId: string,
  attemptId: string,
  ownerUserId: string,
  vectorIds: string[],
  errorCode: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO vector_cleanup_jobs (
      id, book_id, owner_user_id, vector_count, ingestion_attempt_id,
      vector_id_start, vector_id_end, status, attempts, last_error, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, ?8, ?9, ?9)
    ON CONFLICT(book_id, ingestion_attempt_id, vector_id_start, vector_id_end)
    WHERE ingestion_attempt_id IS NOT NULL
      AND vector_id_start IS NOT NULL
      AND vector_id_end IS NOT NULL
    DO UPDATE SET status = 'pending', last_error = excluded.last_error,
                  updated_at = excluded.updated_at, completed_at = NULL
  `).bind(
    `vcleanup_${crypto.randomUUID()}`,
    bookId,
    ownerUserId,
    vectorIds.length,
    attemptId,
    vectorIds[0],
    vectorIds.at(-1),
    errorCode,
    now,
  );
}

/**
 * POST /api/vectorize/query — 벡터 검색 수행
 */
vectorizeRoute.post('/api/vectorize/query', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  if (!c.env.VECTORIZE_INDEX) {
    return c.json({ error: 'Vectorize binding not configured' }, 503);
  }

  const body = await c.req.json<{ query: string; topK?: number }>();
  if (!body.query) return c.json({ error: 'query is required' }, 400);

  try {
    const startMs = Date.now();
    const queryEmbedding = await generateEmbedding(c.env, body.query);
    const requestedTopK = Math.max(1, Math.min(8, Number(body.topK || 3)));
    const results = await c.env.VECTORIZE_INDEX.query(queryEmbedding, {
      topK: Math.min(40, requestedTopK * 5),
      returnMetadata: 'all',
    });
    const latencyMs = Date.now() - startMs;

    const allowedRows = await db.prepare(`
      SELECT b.id FROM books b
      WHERE (b.lifecycle_status = 'active' OR b.lifecycle_status IS NULL)
        AND b.ingestion_status = 'ready'
        AND b.vector_status = 'indexed'
        AND b.current_ingestion_attempt_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM book_ingestion_attempts bia
          WHERE bia.id = b.current_ingestion_attempt_id
            AND bia.book_id = b.id
            AND bia.status = 'ready'
            AND bia.stage = 'vectorize'
        )
        AND (
          (b.is_builtin = 1 AND b.visibility = 'builtin')
          OR (b.owner_user_id = ?1 AND b.visibility = 'private')
        )
    `).bind(auth.userId).all<{ id: string }>();
    const allowedBookIds = new Set((allowedRows.results || []).map((row) => String(row.id)));
    const authorizedMatches = (results.matches || [])
      .filter((match: { metadata?: Record<string, unknown> }) => allowedBookIds.has(String(match.metadata?.bookId || '')))
      .slice(0, requestedTopK);

    // Log the query
    await db.prepare(
      `INSERT INTO vector_query_log (id, user_id, query_text, top_k, latency_ms, hit_count, retrieval_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      `vq_${crypto.randomUUID()}`,
      auth.userId,
      body.query.substring(0, 500),
      requestedTopK,
      latencyMs,
      authorizedMatches.length,
      JSON.stringify(authorizedMatches.map((m: { id: string; score: number }) => ({ id: m.id, score: m.score }))),
      Date.now(),
    ).run().catch(() => {});

    return c.json({
      ok: true,
      latencyMs,
      matches: authorizedMatches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata,
      })),
    });
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Vector query failed';
    console.error('[VECTORIZE_QUERY]', error);
    return c.json({ error: errMsg }, 500);
  }
});

/**
 * v21 P0-2: Workers AI bge-base-en-v1.5 (768d) — matches Vectorize index dimensions.
 * Fails closed if the configured Workers AI embedding service is unavailable.
 */
async function generateEmbedding(env: VectorizeBindings, text: string): Promise<number[]> {
  // v21: Use Workers AI bge-base-en-v1.5 (768 dimensions, matches Vectorize index)
  if (env.AI) {
    try {
      const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
        text: [text.substring(0, 512)],
      });
      if (result) {
        return readBgeEmbeddings(result, 1)[0];
      }
    } catch (error) {
      console.error('[EMBEDDING] Workers AI failed:', error);
      throw new Error('Embedding service unavailable');
    }
  }
  throw new Error('Embedding service unavailable');
}

export { vectorizeRoute };
