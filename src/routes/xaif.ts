// ============================================================
// v20 P0-D: xAIF JSON-LD Export Route
// ============================================================
// 외부 표준 인터페이스로 JSON-LD를 application/ld+json으로 노출
// export 로그를 D1에 저장하여 사용 추적
// ============================================================

import { Hono, type Context } from 'hono';
import type { Bindings } from '../types';
import { getAuthUser, requireAuth } from '../middleware/auth';

const xaifRoute = new Hono<{ Bindings: Bindings }>();
type XaifContext = Context<{ Bindings: Bindings }>;

type SessionOwnerRow = { user_id: string | null };

async function authorizeSessionExport(
  c: XaifContext,
  sessionId: string,
): Promise<Response | null> {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

  try {
    const session = await c.env.DB.prepare(
      `SELECT user_id FROM sessions WHERE id = ?1`
    ).bind(sessionId).first<SessionOwnerRow>();
    if (!session) return c.json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' }, 404);
    if (session.user_id === auth.userId || auth.role === 'admin') return null;

    // The session schema has no org_id, so an instructor's organization authority
    // cannot be established from this record. Do not silently treat it as access.
    if (auth.role === 'instructor' || auth.role === 'teacher') {
      return c.json({ error: 'Authorization relationship is not provable', code: 'AUTHORIZATION_UNGRADABLE' }, 503);
    }
    return c.json({ error: 'Forbidden', code: 'SESSION_OWNER_REQUIRED' }, 403);
  } catch (error) {
    console.error('[XAIF_AUTHORIZATION]', error);
    return c.json({ error: 'Authorization unavailable', code: 'AUTHORIZATION_UNAVAILABLE' }, 503);
  }
}

/**
 * GET /api/session/:sessionId/xaif/jsonld/:turnNumber
 * JSON-LD export endpoint — application/ld+json Content-Type
 */
xaifRoute.get('/api/session/:sessionId/xaif/jsonld/:turnNumber', requireAuth, async (c) => {
  const { sessionId, turnNumber } = c.req.param();
  const parsedTurnNumber = Number(turnNumber);
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  if (!Number.isInteger(parsedTurnNumber) || parsedTurnNumber < 1) {
    return c.json({ error: 'Invalid turn number', code: 'INVALID_TURN_NUMBER' }, 400);
  }

  const denied = await authorizeSessionExport(c, sessionId);
  if (denied) return denied;

  try {
    const row = await db.prepare(
      `SELECT jsonld_text FROM xaif_jsonld_cache WHERE session_id = ?1 AND turn_number = ?2`
    ).bind(sessionId, parsedTurnNumber).first<{ jsonld_text: string }>();

    if (!row) return c.json({ error: 'JSON-LD not found for this session/turn' }, 404);

    // Export log 저장 (사용 추적)
    await db.prepare(
      `INSERT INTO jsonld_export_log (id, session_id, turn_number, export_type, consumer, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      `jle_${sessionId}_t${parsedTurnNumber}_${Date.now()}`,
      sessionId,
      parsedTurnNumber,
      'application/ld+json',
      c.req.header('user-agent')?.substring(0, 200) || 'unknown',
      Date.now(),
    ).run();

    return new Response(row.jsonld_text, {
      headers: {
        'content-type': 'application/ld+json; charset=utf-8',
        'content-disposition': `inline; filename="${sessionId}_t${turnNumber}.jsonld"`,
        'cache-control': 'private, no-store',
        'pragma': 'no-cache',
      },
    });
  } catch (e) {
    console.error('[JSONLD_EXPORT]', e);
    return c.json({ error: 'Export unavailable', code: 'JSONLD_EXPORT_UNAVAILABLE' }, 503);
  }
});

/**
 * GET /api/session/:sessionId/xaif/jsonld
 * 세션 전체 JSON-LD 목록 (메타데이터만)
 */
xaifRoute.get('/api/session/:sessionId/xaif/jsonld', requireAuth, async (c) => {
  const { sessionId } = c.req.param();
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const denied = await authorizeSessionExport(c, sessionId);
  if (denied) return denied;

  try {
    const rows = await db.prepare(
      `SELECT turn_number, created_at, LENGTH(jsonld_text) as size_bytes
       FROM xaif_jsonld_cache
       WHERE session_id = ?1
       ORDER BY turn_number ASC`
    ).bind(sessionId).all();

    return c.json({
      sessionId,
      totalTurns: rows.results?.length || 0,
      turns: (rows.results || []).map((r: Record<string, unknown>) => ({
        turnNumber: r.turn_number,
        exportUrl: `/api/session/${sessionId}/xaif/jsonld/${r.turn_number}`,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
      })),
    }, 200, { 'cache-control': 'private, no-store', 'pragma': 'no-cache' });
  } catch (e) {
    console.error('[JSONLD_LIST]', e);
    return c.json({ error: 'Export metadata unavailable', code: 'JSONLD_LIST_UNAVAILABLE' }, 503);
  }
});

export { xaifRoute };
