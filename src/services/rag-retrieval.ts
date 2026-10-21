// RAG Retrieval Service (V2 - Hybrid: Vectorize + Local Fallback)
// Architecture Task 1: True RAG with Cloudflare Vectorize
//
// Strategy:
// 1. If Vectorize binding available → semantic vector search (True RAG)
// 2. Fallback → local chunking + keyword scoring (RAG-lite, V1)
//
// Both paths return a string of relevant text chunks for prompt injection

import { getEmbeddings } from './rag-ingestion';

// =============================================
// True RAG: Vectorize-based Semantic Search
// =============================================

interface VectorizeMatch {
  id: string;
  score: number;
  metadata: {
    bookId: string;
    chunkIndex: number;
    content: string;
    charStart: number;
    charEnd: number;
  };
}

/**
 * Retrieve relevant chunks using Cloudflare Vectorize (True RAG)
 * Embeds the query, searches the vector index, returns top-K results
 */
export async function retrieveFromVectorize(
  vectorizeIndex: unknown,
  query: string,
  bookId: string,
  apiKey: string,
  options: {
    topK?: number;
    scoreThreshold?: number;
    baseUrl?: string;
    model?: string;
  } = {},
): Promise<string> {
  const topK = options.topK || 3;
  const scoreThreshold = options.scoreThreshold || 0.3;

  // Step 1: Embed the query
  const [queryEmbedding] = await getEmbeddings(
    [query],
    apiKey,
    { baseUrl: options.baseUrl, model: options.model },
  );

  // Step 2: Query Vectorize
  const results = await vectorizeIndex.query(queryEmbedding, {
    topK,
    filter: { bookId },
    returnMetadata: true,
  });

  if (!results?.matches || results.matches.length === 0) {
    return '';
  }

  // Step 3: Filter by score threshold and sort by chunk order
  const matches: VectorizeMatch[] = results.matches
    .filter((m: unknown) => m.score >= scoreThreshold)
    .sort((a: unknown, b: unknown) => (a.metadata?.chunkIndex || 0) - (b.metadata?.chunkIndex || 0));

  if (matches.length === 0) return '';

  // Step 4: Join chunks with separators
  return matches
    .map((m: unknown) => (m.metadata?.content || '').trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
}

// =============================================
// Hybrid Retrieval: Auto-select Vectorize or Fallback
// =============================================

/**
 * Smart retrieval: tries Vectorize first, falls back to keyword search
 * This is the main entry point used by chat.ts
 */
export async function smartRetrieve(
  bookText: string,
  query: string,
  options: {
    vectorizeIndex?: unknown;
    bookId?: string;
    apiKey?: string;
    topK?: number;
    chunkSize?: number;
    baseUrl?: string;
  } = {},
): Promise<string> {
  const topK = options.topK || 3;

  // Try True RAG if Vectorize binding is available
  if (options.vectorizeIndex && options.apiKey && options.bookId) {
    try {
      const result = await retrieveFromVectorize(
        options.vectorizeIndex,
        query,
        options.bookId,
        options.apiKey,
        { topK, baseUrl: options.baseUrl },
      );
      if (result && result.length > 50) {
        return result;
      }
      // If Vectorize returned too little, fall through to local
      console.warn('[RAG] Vectorize returned insufficient results, falling back to local');
    } catch (error) {
      console.warn('[RAG] Vectorize query failed, falling back to local:', error);
    }
  }

  // Fallback: Local keyword-based retrieval
  return retrieveRelevantChunks(bookText, query, topK, options.chunkSize || 500);
}

// =============================================
// RAG-lite: Local Keyword-based Retrieval (V1)
// =============================================

interface TextChunk {
  index: number;
  content: string;
  score: number;
}

/**
 * Chunk text into overlapping segments for pseudo-RAG retrieval
 */
export function chunkText(text: string, chunkSize: number = 500, overlap: number = 100): string[] {
  if (!text || text.length <= chunkSize) return [text];
  
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.substring(start, end));
    start += chunkSize - overlap;
  }
  
  return chunks;
}

/**
 * Score chunks based on keyword relevance to the student's answer
 * Uses TF-based scoring with Korean morpheme awareness
 */
function scoreChunk(chunk: string, query: string): number {
  const queryTokens = query
    .replace(/[^\w가-힣]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  
  if (queryTokens.length === 0) return 0;
  
  let score = 0;
  const lowerChunk = chunk.toLowerCase();
  
  for (const token of queryTokens) {
    const lowerToken = token.toLowerCase();
    // Count occurrences
    let pos = 0;
    while ((pos = lowerChunk.indexOf(lowerToken, pos)) !== -1) {
      score += 1;
      pos += lowerToken.length;
    }
  }
  
  // Normalize by chunk length
  return score / Math.max(1, chunk.length / 100);
}

/**
 * Retrieve top-K relevant text chunks using keyword matching (RAG-lite)
 * This reduces token usage by ~90% compared to sending the full book text
 */
export function retrieveRelevantChunks(
  bookText: string,
  query: string,
  topK: number = 3,
  chunkSize: number = 500,
): string {
  if (!bookText || !query) return bookText?.substring(0, 1500) || '';
  
  const chunks = chunkText(bookText, chunkSize, 100);
  
  const scored: TextChunk[] = chunks.map((content, index) => ({
    index,
    content,
    score: scoreChunk(content, query),
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Take top-K chunks
  const topChunks = scored.slice(0, topK);
  
  // Sort by original order for coherence
  topChunks.sort((a, b) => a.index - b.index);
  
  // Join with separator
  return topChunks.map(c => c.content.trim()).join('\n\n---\n\n');
}
