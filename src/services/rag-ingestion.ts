// RAG Ingestion Service - Text Chunking & Vectorize Upsert
// Architecture Task 1: True RAG with Cloudflare Vectorize
// 
// Flow:
// 1. Split book text into overlapping chunks (500-1000 chars, 20% overlap)
// 2. Embed each chunk using embedding API (Soongsil Gateway or Gemini)
// 3. Upsert vectors into Cloudflare Vectorize index
//
// Note: Vectorize binding must be added to wrangler.jsonc as VECTORIZE_INDEX

import {
  LIBRARY_CHUNK_SIZE,
  LIBRARY_CHUNK_OVERLAP_RATIO,
  libraryVectorId,
} from './library-ingestion';

// =============================================
// Text Chunking (Sentence-aware overlapping)
// =============================================

const DEFAULT_CHUNK_SIZE = LIBRARY_CHUNK_SIZE;
const DEFAULT_OVERLAP_RATIO = LIBRARY_CHUNK_OVERLAP_RATIO;

/**
 * Split text into overlapping chunks, preferring sentence boundaries
 */
export function chunkTextForIngestion(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlapRatio: number = DEFAULT_OVERLAP_RATIO,
): { content: string; charStart: number; charEnd: number }[] {
  if (!text || text.length === 0) return [];
  
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= chunkSize) {
    return [{ content: normalized, charStart: 0, charEnd: normalized.length }];
  }

  const overlap = Math.floor(chunkSize * overlapRatio);
  const step = chunkSize - overlap;
  const chunks: { content: string; charStart: number; charEnd: number }[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    
    // Try to end at a sentence boundary (. ! ? 。 ！ ？)
    if (end < normalized.length) {
      const searchWindow = normalized.substring(Math.max(start + step, end - 100), end);
      const sentenceEnd = searchWindow.search(/[.!?。！？]\s/);
      if (sentenceEnd !== -1) {
        end = Math.max(start + step, end - 100) + sentenceEnd + 1;
      }
    }

    chunks.push({
      content: normalized.substring(start, end).trim(),
      charStart: start,
      charEnd: end,
    });

    start += step;
    if (start + overlap >= normalized.length) break;
  }

  return chunks;
}

// =============================================
// Embedding API (via Soongsil Gateway - OpenAI compatible)
// =============================================

const SOONGSIL_BASE_URL = 'https://factchat-cloud.mindlogic.ai/v1/gateway';
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Get embeddings using OpenAI-compatible API (Soongsil Gateway or Gemini)
 * Soongsil Gateway supports text-embedding-3-small via OpenAI compatibility
 */
export async function getEmbeddings(
  texts: string[],
  apiKey: string,
  options: { 
    baseUrl?: string;
    model?: string;
  } = {},
): Promise<number[][]> {
  const baseUrl = options.baseUrl || SOONGSIL_BASE_URL;
  const model = options.model || 'text-embedding-3-small';
  
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error: ${response.status} - ${errorText}`);
  }

  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data)
    || result.data.length !== texts.length) throw new Error('Invalid embedding response');
  return result.data.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('embedding' in item) || !Array.isArray(item.embedding)
      || !item.embedding.length || !item.embedding.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('Invalid embedding response');
    }
    return item.embedding as number[];
  });
}

// =============================================
// Vectorize Operations
// =============================================

/**
 * Ingest a book's text into Vectorize
 * Call this when a new book is added or for initial migration
 */
export async function ingestBookToVectorize(
  vectorizeIndex: VectorizeIndex, // VectorizeIndex binding
  bookId: string,
  bookText: string,
  apiKey: string,
  options: {
    chunkSize?: number;
    overlapRatio?: number;
    batchSize?: number;
    baseUrl?: string;
    model?: string;
  } = {},
): Promise<{ totalChunks: number; upsertedVectors: number }> {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlapRatio = options.overlapRatio || DEFAULT_OVERLAP_RATIO;
  const batchSize = options.batchSize || 20; // Vectorize batch limit

  // Step 1: Chunk the text
  const chunks = chunkTextForIngestion(bookText, chunkSize, overlapRatio);
  if (chunks.length === 0) {
    return { totalChunks: 0, upsertedVectors: 0 };
  }

  let upsertedCount = 0;

  // Step 2: Process in batches (embedding + upsert)
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    
    // Embed batch
    const embeddings = await getEmbeddings(
      batch.map(c => c.content),
      apiKey,
      { baseUrl: options.baseUrl, model: options.model },
    );

    // Build vectors for Vectorize
    const vectors: VectorizeVector[] = batch.map((chunk, j) => ({
      id: libraryVectorId(bookId, i + j),
      values: embeddings[j],
      metadata: {
        bookId,
        chunkIndex: i + j,
        content: chunk.content,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
      },
    }));

    // Upsert to Vectorize
    await vectorizeIndex.upsert(vectors);
    upsertedCount += vectors.length;
  }

  return { totalChunks: chunks.length, upsertedVectors: upsertedCount };
}

/**
 * Delete all vectors for a specific book
 */
export async function deleteBookVectors(
  vectorizeIndex: VectorizeIndex,
  bookId: string,
  totalChunks: number,
): Promise<void> {
  const ids = Array.from({ length: totalChunks }, (_, i) => libraryVectorId(bookId, i));
  // Vectorize delete supports batch
  if (ids.length > 0) {
    await vectorizeIndex.deleteByIds(ids);
  }
}

// =============================================
// D1 Chunk Storage (for fallback/debugging)
// =============================================

/**
 * Save chunks to D1 document_chunks table for debugging/fallback
 */
export async function saveChunksToD1(
  db: D1Database,
  bookId: string,
  bookText: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<number> {
  const chunks = chunkTextForIngestion(bookText, chunkSize);
  if (chunks.length === 0) return 0;

  // Delete existing chunks for this book
  await db.prepare('DELETE FROM document_chunks WHERE book_id = ?1').bind(bookId).run();

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO document_chunks (id, book_id, chunk_index, content, char_start, char_end, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `);

  // Batch insert in groups of 50
  const BATCH_SIZE = 50;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await db.batch(
      batch.map((chunk, j) =>
        stmt.bind(
          libraryVectorId(bookId, i + j),
          bookId,
          i + j,
          chunk.content,
          chunk.charStart,
          chunk.charEnd,
          now,
        )
      )
    );
  }

  return chunks.length;
}
