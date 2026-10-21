/**
 * Metacognition Routes
 * POST /api/metacognition/record — Attempt to record a confidence submission
 * GET /api/metacognition/calibration/:userId — Retrieve calibration status
 * v35 Feature: Stealth Assessment (T1.5.2)
 */

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { getAuthUser, optionalAuth } from '../middleware/auth';

const metacognitionRoute = new Hono<{ Bindings: Bindings }>();

// Resolve the token without short-circuiting so this route can return a stable
// machine-readable AUTH_REQUIRED response instead of the legacy auth payload.
metacognitionRoute.use('/api/metacognition/*', optionalAuth);

type RecordCalibrationRequest = {
  sessionId: string;
  problemId?: string;
  confidence: number;
};

function parseCalibrationRequest(value: unknown): RecordCalibrationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const problemId = typeof input.problemId === 'string' ? input.problemId.trim() : undefined;
  const confidence = typeof input.confidence === 'number' ? input.confidence : Number.NaN;
  if (!sessionId || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { sessionId, problemId, confidence };
}

const VERIFICATION_UNAVAILABLE = {
  status: 'verification_unavailable' as const,
  code: 'VERIFICATION_UNAVAILABLE' as const,
  metricsAvailable: false as const,
  message:
    'Server-side answer verification is not available for this item. No calibration record was written.',
};

/**
 * POST /api/metacognition/record
 * Do not accept a client-provided correctness value. There is no authoritative
 * answer join in this route, so this endpoint fails closed until one exists.
 */
metacognitionRoute.post('/api/metacognition/record', async (c) => {
  try {
    let payload: unknown;
    try {
      payload = await c.req.json<unknown>();
    } catch {
      return c.json(
        { status: 'invalid_json', code: 'INVALID_JSON', error: 'Request body must be valid JSON.' },
        400,
      );
    }

    const parsed = parseCalibrationRequest(payload);
    if (!parsed) {
      return c.json(
        { status: 'invalid_request', code: 'INVALID_REQUEST', error: 'Invalid calibration request.' },
        400,
      );
    }
    const auth = getAuthUser(c);
    if (!auth) {
      return c.json(
        { status: 'auth_required', code: 'AUTH_REQUIRED', error: 'Authentication required.' },
        401,
      );
    }

    if (!c.env.DB) {
      return c.json(
        { status: 'unavailable', code: 'DATABASE_UNAVAILABLE', error: 'Calibration is temporarily unavailable.' },
        503,
      );
    }

    let sessionRows: Record<string, unknown>[];
    try {
      const result = await c.env.DB.prepare(`
        SELECT id, user_id FROM sessions WHERE id = ?1
        UNION ALL
        SELECT id, user_id FROM training_sessions WHERE id = ?2
      `)
        .bind(parsed.sessionId, parsed.sessionId)
        .all();
      sessionRows = (result.results || []) as Record<string, unknown>[];
    } catch (error) {
      console.error('POST /api/metacognition/record ownership query error:', error);
      return c.json(
        { status: 'unavailable', code: 'DATABASE_UNAVAILABLE', error: 'Calibration is temporarily unavailable.' },
        503,
      );
    }

    if (sessionRows.length === 0) {
      return c.json({ status: 'not_found', code: 'SESSION_NOT_FOUND', error: 'Session not found.' }, 404);
    }
    if (!sessionRows.some((row) => row.user_id === auth.userId)) {
      return c.json({ status: 'forbidden', code: 'SESSION_ACCESS_DENIED', error: 'Access denied.' }, 403);
    }

    // Keep the request parsing and auth boundary in place, but never persist a
    // client boolean as correctness or derive a calibration metric from it.
    void parsed;
    return c.json(VERIFICATION_UNAVAILABLE, 503);
  } catch (error) {
    console.error('POST /api/metacognition/record error:', error);
    return c.json(
      { status: 'unavailable', code: 'METACOGNITION_UNAVAILABLE', error: 'Calibration is temporarily unavailable.' },
      503,
    );
  }
});

/**
 * GET /api/metacognition/calibration/:userId
 * Do not expose legacy calibration rows: their correctness may have originated
 * from the old client-controlled contract and cannot be treated as ground truth.
 */
metacognitionRoute.get('/api/metacognition/calibration/:userId', async (c) => {
  try {
    const { userId } = c.req.param();
    const auth = getAuthUser(c);
    if (!auth) {
      return c.json(
        { status: 'auth_required', code: 'AUTH_REQUIRED', error: 'Authentication required.' },
        401,
      );
    }
    if (userId !== auth.userId) {
      return c.json({ status: 'forbidden', code: 'USER_ACCESS_DENIED', error: 'Access denied.' }, 403);
    }

    return c.json({
      ...VERIFICATION_UNAVAILABLE,
      userId,
      recordCount: null,
      brierScore: null,
      calibrationQuality: null,
      miscalibrationType: null,
      records: null,
      curve: null,
    });
  } catch (error) {
    console.error('GET /api/metacognition/calibration error:', error);
    return c.json(
      { status: 'unavailable', code: 'METACOGNITION_UNAVAILABLE', error: 'Calibration is temporarily unavailable.' },
      503,
    );
  }
});

export default metacognitionRoute;
