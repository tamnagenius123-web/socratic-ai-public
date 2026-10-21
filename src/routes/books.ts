// Books API Route - Full CRUD with D1
// V2: Auto-saves D1 chunks for RAG-lite on upload
import { Hono } from 'hono';
import type { Bindings, BookUploadRequest } from '../types';
import { seedBuiltinBooks, getAllBooksFromDB, getBookFromDB, addBookToDB, deleteBookFromDB, searchBooksInDB } from '../services/student-model';
import { getAllBooks } from '../data/books';
import { saveChunksToD1 } from '../services/rag-ingestion';
import { optionalAuth, getAuthUser } from '../middleware/auth';
import {
  LIBRARY_CHUNKING_VERSION,
  libraryVectorId,
  sha256Hex,
} from '../services/library-ingestion';

const booksRoute = new Hono<{ Bindings: Bindings }>();

booksRoute.use('/api/books', optionalAuth);
booksRoute.use('/api/books/*', optionalAuth);

// Get all available books (with optional search)
booksRoute.get('/api/books', async (c) => {
  const db = c.env.DB;
  const requesterUserId = getAuthUser(c)?.userId || null;

  // Ensure built-in books are seeded
  await seedBuiltinBooks(db, getAllBooks());

  const query = c.req.query('q');
  const rows = query
    ? await searchBooksInDB(db, query, requesterUserId)
    : await getAllBooksFromDB(db, requesterUserId);

  const bookList = rows.map((row) => {
    // Phase 2: Bug 1 fix - passageCount uses chunk_count (actual chunks),
    // NOT key_passages.length (which is 0 for user-uploaded books)
    const keyPassagesLen = JSON.parse(row.key_passages || '[]').length;
    const chunkCount = row.chunk_count || 0;
    // For user-uploaded books, use chunk_count; for built-in books, use max of both
    const passageCount = row.is_builtin
      ? Math.max(keyPassagesLen, chunkCount)
      : (chunkCount > 0 ? chunkCount : keyPassagesLen);

    return {
      id: row.id,
      title: row.title,
      author: row.author,
      chapter: row.chapter,
      language: row.language,
      passageCount,
      chunkCount,
      ingestionStatus: row.ingestion_status || 'legacy',
      vectorStatus: row.vector_status || 'not_indexed',
      scope: row.is_builtin ? 'builtin' : 'private',
      textPreview: (row.text || '').substring(0, 150) + '...',
      isBuiltin: !!row.is_builtin,
      createdAt: row.created_at,
    };
  });

  return c.json({ books: bookList });
});

// Get specific book details
booksRoute.get('/api/books/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const bookRow = await getBookFromDB(db, id, getAuthUser(c)?.userId || null);
  if (!bookRow) {
    return c.json({ error: 'Book not found' }, 404);
  }

  return c.json({
    id: bookRow.id,
    title: bookRow.title,
    author: bookRow.author,
    chapter: bookRow.chapter,
    language: bookRow.language,
    keyPassages: JSON.parse((bookRow.key_passages as string) || '[]'),
    textPreview: ((bookRow.text as string) || '').substring(0, 500) + '...',
    isBuiltin: !!(bookRow.is_builtin),
  });
});

// Upload a new book
booksRoute.post('/api/books/upload', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '도서 등록은 로그인 후 사용할 수 있습니다.' }, 401);
    const body = await c.req.json<BookUploadRequest>();
    const { title, author, text } = body;

    if (!title || !author || !text) {
      return c.json({ error: 'title, author, and text are required' }, 400);
    }

    // Validate text size (max 500KB for D1)
    if (text.length > 500000) {
      return c.json({ error: 'Text too large. Maximum 500KB allowed.' }, 400);
    }

    // 🔴 Phase 3: Null Guard + Retry for "0 passages" defense
    // Architecture Principle 3: Text extraction validation before D1 INSERT
    const normalizedText = (text || '').replace(/\s+/g, ' ').trim();
    if (normalizedText.length < 50) {
      return c.json({ 
        error: '텍스트가 너무 짧습니다. 최소 50자 이상의 본문이 필요합니다.',
        textLength: normalizedText.length,
      }, 400);
    }

    const db = c.env.DB;
    const bookId = 'book_' + crypto.randomUUID();
    const attemptId = 'ingest_' + crypto.randomUUID();
    const now = Date.now();
    const contentSha256 = await sha256Hex(normalizedText);

    await db.prepare(`
      INSERT INTO book_ingestion_attempts (
        id, book_id, owner_user_id, content_sha256, chunking_version,
        stage, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'upload', 'processing', ?6, ?6)
    `).bind(
      attemptId,
      bookId,
      auth.userId,
      contentSha256,
      LIBRARY_CHUNKING_VERSION,
      now,
    ).run();

    await addBookToDB(db, {
      id: bookId,
      title,
      author,
      chapter: body.chapter || '',
      language: body.language || 'ko',
      text: normalizedText,
      keyPassages: body.keyPassages || [],
      ownerUserId: auth.userId,
    });
    await db.prepare(`
      UPDATE books
      SET content_sha256 = ?2, chunking_version = ?3,
          ingestion_status = 'processing', vector_status = 'not_indexed'
      WHERE id = ?1 AND owner_user_id = ?4
    `).bind(bookId, contentSha256, LIBRARY_CHUNKING_VERSION, auth.userId).run();

    // V2: Auto-save D1 chunks for RAG-lite retrieval
    // 🔴 Phase 3: Retry + DLQ pattern for chunk generation
    let chunkCount = 0;
    let chunkError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        chunkCount = await saveChunksToD1(db, bookId, normalizedText);
        if (chunkCount > 0) break; // Success
        console.warn(`[BOOKS] Chunk generation attempt ${attempt + 1} returned 0 chunks`);
      } catch (chunkErr) {
        chunkError = chunkErr;
        console.warn(`[BOOKS] D1 chunk save attempt ${attempt + 1} failed:`, chunkErr);
        if (attempt < 2) await new Promise(r => setTimeout(r, 500 * (attempt + 1))); // Backoff
      }
    }

    // Phase 2: If 0 passages after retries, mark as failed instead of deleting
    if (chunkCount === 0) {
      const errorMsg = `0 chunks after 3 retries. textLen=${normalizedText.length}, error=${chunkError}`;
      console.error(`[BOOKS] ${errorMsg} for book ${bookId}`);

      // Phase 2: Mark as failed rather than deleting (prevents orphan issues)
      try {
        await db.prepare(
          `UPDATE books SET ingestion_status = 'failed', last_ingestion_error = ?2, chunk_count = 0 WHERE id = ?1`
        ).bind(bookId, errorMsg).run();
        await db.prepare(`
          UPDATE book_ingestion_attempts
          SET stage = 'chunking', status = 'failed', error_code = 'zero_chunks',
              error_message = ?2, updated_at = ?3
          WHERE id = ?1
        `).bind(attemptId, errorMsg.substring(0, 1000), Date.now()).run();
      } catch (metaErr) {
        // Fallback: delete if ingestion columns don't exist
        console.warn('[BOOKS] Failed to mark ingestion_status (pre-migration?). Deleting book:', metaErr);
        try { await deleteBookFromDB(db, bookId, auth.userId); } catch (delErr) {
          console.warn(`[BOOKS] Failed to auto-delete 0-passage book ${bookId}:`, delErr);
        }
      }

      return c.json({
        error: '도서 텍스트 파싱에 실패했습니다. 텍스트 형식을 확인 후 다시 시도해주세요.',
        textLength: normalizedText.length,
      }, 400);
    }

    // D1 chunks are available, but semantic indexing is a separate explicit state.
    try {
      const completedAt = Date.now();
      await db.batch([
        db.prepare(`
          UPDATE books
          SET chunk_count = ?2, ingestion_status = 'd1_ready', vector_status = 'not_indexed',
              last_ingestion_error = NULL, updated_at = ?3
          WHERE id = ?1 AND owner_user_id = ?4
        `).bind(bookId, chunkCount, completedAt, auth.userId),
        db.prepare(`
          UPDATE book_ingestion_attempts
          SET stage = 'd1_chunking', status = 'd1_ready', chunk_count = ?2, updated_at = ?3
          WHERE id = ?1
        `).bind(attemptId, chunkCount, completedAt),
      ]);
    } catch (metaErr) {
      // Non-critical: columns may not exist pre-migration
      console.warn('[BOOKS] Failed to update chunk_count/ingestion_status (pre-migration?):', metaErr);
    }

    return c.json({
      success: true,
      bookId,
      chunkCount,
      ingestionStatus: 'd1_ready',
      vectorStatus: 'not_indexed',
      message: `도서 본문과 근거 청크가 등록되었습니다. (${chunkCount}개)`,
    });
  } catch (error) {
    console.error('Book upload error:', error);
    return c.json({ error: '도서 등록 처리에 실패했습니다.' }, 500);
  }
});

// Delete a book
booksRoute.delete('/api/books/:id', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '도서 삭제는 로그인 후 사용할 수 있습니다.' }, 401);
    const id = c.req.param('id');
    const db = c.env.DB;

    const book = await getBookFromDB(db, id, auth.userId);
    if (!book || book.is_builtin) {
      return c.json({ error: 'Book not found or cannot delete built-in books' }, 404);
    }
    const chunkCount = Number(book.chunk_count || 0);

    const deletion = await deleteBookFromDB(db, id, auth.userId);
    if (!deletion.deleted) {
      return c.json({ error: 'Book not found or cannot delete built-in books' }, 400);
    }

    const vectorizationInFlight = String(book.ingestion_status) === 'processing'
      || String(book.vector_status) === 'processing';
    // The row above is necessarily a pre-deletion snapshot. Vectorization may
    // activate and even finalize before deleteBookFromDB() linearizes the
    // quarantine, so lifecycle flags from that snapshot cannot prove that no
    // vectors exist. Stable per-chunk IDs make an unconditional, idempotent
    // delete the conservative choice whenever the book has persisted chunks.
    const requiresVectorCleanup = vectorizationInFlight || chunkCount > 0;
    let vectorCleanupPending = requiresVectorCleanup;
    if (requiresVectorCleanup && !vectorizationInFlight && c.env.VECTORIZE_INDEX) {
      try {
        const vectorIds = Array.from({ length: chunkCount }, (_, index) => libraryVectorId(id, index));
        for (let index = 0; index < vectorIds.length; index += 1000) {
          await c.env.VECTORIZE_INDEX.deleteByIds(vectorIds.slice(index, index + 1000));
        }
        vectorCleanupPending = false;
      } catch (error) {
        vectorCleanupPending = true;
        console.error('[BOOKS] Vector cleanup queued for operator reconciliation:', error);
      }
    }

    const cleanupNow = Date.now();
    if (deletion.cleanupJobId) {
      await db.batch([
        db.prepare(`
          UPDATE vector_cleanup_jobs
          SET status = ?2, attempts = attempts + ?3, last_error = ?4,
              updated_at = ?5, completed_at = ?6
          WHERE id = ?1
        `).bind(
          deletion.cleanupJobId,
          vectorCleanupPending ? 'pending' : 'completed',
          requiresVectorCleanup ? 1 : 0,
          vectorCleanupPending
            ? (vectorizationInFlight
                ? 'in_flight_vectorize_reconciliation_required'
                : 'vector_binding_or_delete_unavailable')
            : null,
          cleanupNow,
          vectorCleanupPending ? null : cleanupNow,
        ),
        db.prepare(`
          UPDATE vector_documents
          SET status = ?2, updated_at = ?3
          WHERE source_type = 'book' AND source_id = ?1
        `).bind(id, vectorCleanupPending ? 'cleanup_pending' : 'deleted', cleanupNow),
        db.prepare(`
          UPDATE books SET vector_status = ?2, updated_at = ?3
          WHERE id = ?1 AND owner_user_id = ?4
        `).bind(id, vectorCleanupPending ? 'cleanup_pending' : 'deleted', cleanupNow, auth.userId),
      ]);
    }

    return c.json({
      success: true,
      vectorCleanupPending,
      message: vectorCleanupPending
        ? '도서는 삭제되었지만 검색 인덱스 정리가 지연되고 있습니다.'
        : '도서가 삭제되었습니다.',
    });
  } catch (error) {
    console.error('[BOOKS] Delete error:', error);
    return c.json({
      error: '도서 삭제 중 오류가 발생했습니다.',
    }, 500);
  }
});

export default booksRoute;
