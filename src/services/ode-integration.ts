import { readBgeEmbeddings } from './workers-embeddings';
// ============================================================
// SocraticAI v35 — OpenDebateEvidence (ODE) Integration
//
// Reference: Roush et al. (2024) "OpenDebateEvidence"
// NeurIPS 2024 Track on Datasets and Benchmarks
// Dataset: 3.5M+ documents (US competitive debate community)
// HuggingFace: https://huggingface.co/datasets/Yusuf5/OpenCaselist
//
// Implemented pipeline code: Ingest → Embed → Store (Vectorize) → Retrieve.
// Runtime readiness and indexed-data presence are reported separately by the API.
// ============================================================

import type { Bindings } from '../types';

export interface ODEDocument {
  id: string;
  text: string;
  topic: string;
  category: string;
  source: string;
  qualityScore: number;
}

export interface ODERetrievalResult {
  text: string;
  source: string;
  relevanceScore: number;
  category: string;
  topic?: string;
}

// SocraticAI 카테고리 매핑 (ODE topics → Korean categories)
export const ODE_CATEGORY_MAP: Record<string, string> = {
  'Politics': '정치',
  'Economy': '경제',
  'Technology': '기술',
  'Education': '교육',
  'Environment': '환경',
  'Healthcare': '보건',
  'International Relations': '국제관계',
  'Ethics': '윤리',
  'Science': '과학',
  'Law': '법학',
  'Social Policy': '사회정책',
  'Defense': '국방',
  'Media': '미디어',
  'Philosophy': '철학',
  'Energy': '에너지',
};

// Phase 2: Batch ingestion into Vectorize
export async function ingestODEBatch(
  env: { AI: Ai; VECTORIZE_INDEX: VectorizeIndex },
  documents: ODEDocument[],
  batchSize = 100
): Promise<{ ingested: number; errors: number }> {
  let ingested = 0;
  let errors = 0;

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    const texts = batch.map(d => d.text.substring(0, 512)); // Truncate for embedding

    try {
      // Generate embeddings using Workers AI (bge-base-en-v1.5, 768d)
      const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
        text: texts,
      });

      const completedEmbeddings = readBgeEmbeddings(embeddings, batch.length);

      // Prepare vectors for Vectorize
      const vectors = batch.map((doc, idx) => ({
        id: doc.id,
        values: completedEmbeddings[idx],
        metadata: {
          topic: doc.topic,
          category: doc.category,
          source: 'ODE',
          quality: doc.qualityScore,
          textPreview: doc.text.substring(0, 200),
        },
      }));

      await env.VECTORIZE_INDEX.insert(vectors);
      ingested += batch.length;
      console.log(`[ODE] Ingested ${ingested} / ${documents.length}`);
    } catch (error) {
      console.error(`[ODE] Batch ${i}-${i + batchSize} error:`, error);
      errors += batch.length;
    }
  }

  return { ingested, errors };
}

// Phase 3: RAG retrieval with ODE integration
export async function retrieveODEChunks(
  env: { AI: Ai; VECTORIZE_INDEX: VectorizeIndex },
  query: string,
  options?: {
    topK?: number;
    categoryFilter?: string;
    minQuality?: number;
  }
): Promise<ODERetrievalResult[]> {
  const topK = options?.topK || 3;
  
  // Generate query embedding. Retrieval failures intentionally propagate so callers can
  // distinguish an outage from a valid zero-result search.
    const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query],
    });

    // Build filter
    const filter: Record<string, string> = { source: 'ODE' };
    if (options?.categoryFilter) {
      filter.category = options.categoryFilter;
    }

    // Query Vectorize
    const results = await env.VECTORIZE_INDEX.query(readBgeEmbeddings(queryEmbedding, 1)[0], {
      topK,
      filter,
      returnMetadata: 'all',
    });

  return results.matches
      .filter(m => !options?.minQuality || ((m.metadata?.quality as number) || 0) >= options.minQuality)
      .map(match => ({
        text: (match.metadata?.textPreview as string) || '',
        source: 'OpenDebateEvidence',
        relevanceScore: match.score,
        category: (match.metadata?.category as string) || '',
        topic: (match.metadata?.topic as string) || undefined,
      }));
}

// Integrated RAG: Book chunks + ODE
export async function retrieveHybridRAG(
  db: D1Database,
  env: { AI: Ai; VECTORIZE_INDEX: VectorizeIndex },
  query: string,
  options?: {
    bookId?: string;
    includeODE?: boolean;
    topK?: number;
  }
): Promise<ODERetrievalResult[]> {
  const results: ODERetrievalResult[] = [];

  // Book-based RAG (existing)
  try {
    const bookQuery = options?.bookId
      ? `SELECT chunk_text, relevance_score FROM document_chunks WHERE book_id = ?1 ORDER BY relevance_score DESC LIMIT ?2`
      : `SELECT chunk_text, relevance_score FROM document_chunks ORDER BY relevance_score DESC LIMIT ?1`;

    const bookResults = options?.bookId
      ? await db.prepare(bookQuery).bind(options.bookId, options?.topK || 3).all()
      : await db.prepare(bookQuery).bind(options?.topK || 3).all();

    for (const row of (bookResults?.results || []) as Record<string, unknown>[]) {
      results.push({
        text: row.chunk_text as string,
        source: 'Book',
        relevanceScore: row.relevance_score as number || 0.5,
        category: 'book',
      });
    }
  } catch (error) {
    console.error('[RAG] Book retrieval error:', error);
  }

  // ODE-based RAG
  if (options?.includeODE) {
    const odeResults = await retrieveODEChunks(env, query, {
      topK: options?.topK || 3,
    });
    results.push(...odeResults);
  }

  // Sort by relevance
  return results.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
}
