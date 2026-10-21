// ============================================================
// SocraticAI v35 — ODE (OpenDebateEvidence) API Routes
// ============================================================

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, requireRole } from '../middleware/auth';
import { retrieveODEChunks, ODE_CATEGORY_MAP, ingestODEBatch, type ODEDocument } from '../services/ode-integration';

export const odeRoute = new Hono<{ Bindings: Bindings }>();

function isODEDocument(value: unknown): value is ODEDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Record<string, unknown>;
  return typeof document.id === 'string' && document.id.length > 0
    && document.id.length <= 200
    && typeof document.text === 'string' && document.text.length > 0 && document.text.length <= 50_000
    && typeof document.topic === 'string' && document.topic.length > 0 && document.topic.length <= 200
    && typeof document.category === 'string' && Object.prototype.hasOwnProperty.call(ODE_CATEGORY_MAP, document.category)
    && typeof document.source === 'string' && document.source.length > 0 && document.source.length <= 500
    && typeof document.qualityScore === 'number' && Number.isFinite(document.qualityScore)
    && document.qualityScore >= 0 && document.qualityScore <= 1;
}

// GET /api/ode/search — Search ODE via Vectorize RAG
odeRoute.get('/api/ode/search', requireAuth, async (c) => {
  const query = c.req.query('q');
  const category = c.req.query('category');
  const parsedTopK = Number.parseInt(c.req.query('topK') || '5', 10);
  const topK = Number.isFinite(parsedTopK) ? Math.max(1, Math.min(parsedTopK, 20)) : 5;

  if (!query || query.length > 500) {
    return c.json({ error: '검색어(q)를 입력하세요.' }, 400);
  }
  if (category && !Object.prototype.hasOwnProperty.call(ODE_CATEGORY_MAP, category)) {
    return c.json({ error: '지원하지 않는 ODE 카테고리입니다.' }, 400);
  }

  if (!c.env.AI || !c.env.VECTORIZE_INDEX) {
    return c.json({
      error: 'ODE 검색은 Workers AI + Vectorize 바인딩이 필요합니다.',
      _note: 'Cloudflare Paid Plan 필요',
    }, 503);
  }

  try {
    const results = await retrieveODEChunks(
      { AI: c.env.AI, VECTORIZE_INDEX: c.env.VECTORIZE_INDEX },
      query,
      { topK, categoryFilter: category }
    );

    return c.json({
      query,
      category: category || 'all',
      results,
      count: results.length,
      source: 'OpenDebateEvidence (NeurIPS 2024)',
    });
  } catch (error) {
    console.error('[ODE] Search error:', error);
    return c.json({ error: 'ode_search_failed' }, 500);
  }
});

// GET /api/ode/categories — List available categories
odeRoute.get('/api/ode/categories', async (c) => {
  return c.json({
    categories: ODE_CATEGORY_MAP,
    count: Object.keys(ODE_CATEGORY_MAP).length,
    source: 'OpenDebateEvidence',
    _note: 'Roush et al. (2024), NeurIPS 2024',
  });
});

// GET /api/ode/status — Report configuration without claiming indexed-data readiness.
odeRoute.get('/api/ode/status', async (c) => {
  const hasAI = !!c.env.AI;
  const hasVectorize = !!c.env.VECTORIZE_INDEX;

  return c.json({
    status: hasAI && hasVectorize ? 'configured_unverified' : 'unconfigured',
    bindings: {
      ai: hasAI,
      vectorize: hasVectorize,
    },
    version: '35.0.0',
    pipeline: {
      dataProcessing: 'implemented_unverified',
      embeddingVectorize: hasAI && hasVectorize ? 'configured_unverified' : 'unconfigured',
      ragRetrieval: hasAI && hasVectorize ? 'implemented_unverified' : 'unconfigured',
      indexedDocumentCount: null,
      lastSuccessfulQueryAt: null,
    },
    readiness: 'UNKNOWN',
    _note: 'Binding presence is configuration evidence, not proof that data is indexed or retrievable.',
    reference: {
      paper: 'Roush et al. (2024) "OpenDebateEvidence: A Massive-Scale Argument Mining and Summarization Dataset"',
      venue: 'NeurIPS 2024 Track on Datasets and Benchmarks',
      dataset: 'https://huggingface.co/datasets/Yusuf5/OpenCaselist',
    },
  });
});

// POST /api/ode/ingest — Ingest ODE batch (Admin only)
odeRoute.post('/api/ode/ingest', requireAuth, requireRole('admin'), async (c) => {
  let documents: unknown;
  try {
    const body = await c.req.json<{ documents?: unknown }>();
    documents = body.documents;
  } catch (error) {
    console.warn('[ODE] Invalid ingest JSON:', error);
    return c.json({ error: 'ode_ingest_invalid_json' }, 400);
  }

  if (!documents || !Array.isArray(documents) || documents.length === 0) {
    return c.json({ error: '인제스트할 문서 배열(documents)이 필요합니다.' }, 400);
  }
  if (documents.length > 100) {
    return c.json({ error: '한 번에 최대 100개 문서만 인제스트할 수 있습니다.' }, 413);
  }
  if (!documents.every(isODEDocument)) {
    return c.json({ error: 'ODE 문서 스키마 또는 카테고리가 올바르지 않습니다.' }, 400);
  }

  if (!c.env.AI || !c.env.VECTORIZE_INDEX) {
    return c.json({ error: '인제스트는 Workers AI + Vectorize 바인딩이 필요합니다.' }, 503);
  }

  try {
    const result = await ingestODEBatch(
      { AI: c.env.AI, VECTORIZE_INDEX: c.env.VECTORIZE_INDEX },
      documents
    );

    const status = result.errors === 0 ? 'completed' : result.ingested > 0 ? 'partial' : 'failed';
    const httpStatus = status === 'completed' ? 200 : status === 'partial' ? 207 : 502;
    return c.json({
      status,
      ingested: result.ingested,
      errors: result.errors,
      total_attempted: documents.length,
    }, httpStatus);
  } catch (error) {
    console.error('[ODE] Ingest error:', error);
    return c.json({ error: 'ode_ingest_failed' }, 500);
  }
});
