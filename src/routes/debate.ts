// ============================================================
// v23: Debate Arena Routes
// v23 Changes:
//   - DO Worker proxy pattern (when DEBATE_WORKER_URL is set)
//   - D1 REST fallback maintained
//   - Type safety: DebateRoomRow, DebateTurnRow (no more `any`)
//   - Room close/archive API
//   - Pagination support
//   - Rate limiting (5 turns/minute per room)
//   - Error handling for AI agent failures
// ============================================================

import { Hono, type Context } from 'hono';
import { callAIJSON } from '../services/ai-client';
import type { DebateRoomRow, DebateTurnMutationRow, DebateTurnRow } from '../types/d1-rows';
import { getAuthUser, requireAuth } from '../middleware/auth';

interface DebateBindings {
  DB: D1Database;
  JWT_SECRET: string;
  SOONGSIL_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEBATE_WORKER_URL?: string; // v23: DO Worker URL for proxy
  DEBATE_RUNTIME_SERVICE_TOKEN?: string;
}

const debateRoute = new Hono<{ Bindings: DebateBindings }>();
type DebateContext = Context<{ Bindings: DebateBindings }>;
type DebateParticipantRow = { id: string };
type OrgMembershipRow = { role: string };
type RoomStatusRow = { status: string };
type D1WriteResult = { meta?: { changes?: number } };
type StoreClosureStatus = 'CLOSED' | 'UNKNOWN';
type RuntimeConfig = { url: string; serviceToken: string };
const MAX_TURN_MUTATION_ID_LENGTH = 128;

function isRequestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function changedExactlyOnce(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as D1WriteResult).meta?.changes === 1;
}

function isTurnMutationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TURN_MUTATION_ID_LENGTH
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

async function contentSha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveRuntimeConfig(c: DebateContext): RuntimeConfig | Response | null {
  const url = c.env.DEBATE_WORKER_URL?.trim();
  if (!url) return null;
  const serviceToken = c.env.DEBATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    return c.json({
      error: 'Debate runtime service authentication is unavailable',
      code: 'DEBATE_RUNTIME_CONFIGURATION_UNAVAILABLE',
    }, 503);
  }
  return { url, serviceToken };
}

function runtimeServiceHeaders(serviceToken: string, headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set('Authorization', `Bearer ${serviceToken}`);
  return result;
}

async function compensateRuntimeInit(
  db: D1Database,
  runtime: RuntimeConfig,
  roomId: string,
): Promise<{ d1Status: StoreClosureStatus; runtimeStatus: StoreClosureStatus }> {
  let d1Status: StoreClosureStatus = 'UNKNOWN';
  let runtimeStatus: StoreClosureStatus = 'UNKNOWN';

  try {
    await db.prepare(
      'UPDATE debate_rooms SET status = ?2, closed_at = ?3 WHERE id = ?1'
    ).bind(roomId, 'closed', Date.now()).run();
    const room = await db.prepare('SELECT status FROM debate_rooms WHERE id = ?1')
      .bind(roomId).first<RoomStatusRow>();
    if (room?.status === 'closed') d1Status = 'CLOSED';
  } catch (error) {
    console.error('[DEBATE_RUNTIME_INIT_COMPENSATION]', error);
  }

  try {
    const response = await fetch(`${runtime.url}/room/${roomId}/close`, {
      method: 'POST',
      headers: runtimeServiceHeaders(runtime.serviceToken),
    });
    if (response.status === 200 || response.status === 201) {
      const payload = await response.json() as unknown;
      if (isRequestObject(payload)
        && payload.ok === true
        && payload.status === 'closed'
        && payload.roomId === roomId) {
        runtimeStatus = 'CLOSED';
      }
    }
  } catch (error) {
    console.error('[DEBATE_RUNTIME_INIT_RUNTIME_COMPENSATION]', error);
  }

  return { d1Status, runtimeStatus };
}

function runtimeInitFailure(
  c: DebateContext,
  roomId: string,
  compensation: { d1Status: StoreClosureStatus; runtimeStatus: StoreClosureStatus },
): Response {
  const universallyClosed = compensation.d1Status === 'CLOSED' && compensation.runtimeStatus === 'CLOSED';
  return c.json({
    ok: false,
    roomId,
    status: universallyClosed ? 'closed' : 'UNKNOWN',
    error: universallyClosed
      ? 'Debate runtime initialization failed; both stores acknowledged closure.'
      : 'Debate runtime initialization failed and not all stores acknowledged closure.',
    code: universallyClosed ? 'DEBATE_RUNTIME_INIT_UNAVAILABLE' : 'DEBATE_RUNTIME_INIT_UNCERTAIN',
    d1Status: compensation.d1Status,
    runtimeStatus: compensation.runtimeStatus,
  }, 503);
}

function runtimeTurnUnknown(
  c: DebateContext,
  turnMutationId: string,
  d1Status: 'UNKNOWN',
  code: string = 'DEBATE_RUNTIME_TURN_UNCERTAIN',
): Response {
  return c.json({
    error: 'Debate runtime turn state is uncertain',
    status: 'UNKNOWN',
    code,
    d1Status,
    turnMutationId,
  }, 503);
}

function isFinalRuntimeTurn(
  payload: Record<string, unknown>,
  roomId: string,
  turnMutationId: string,
  userId: string,
  participantId: string,
  content: string,
): boolean {
  return Number.isInteger(payload.turnNumber)
    && (payload.turnNumber as number) > 0
    && payload.ok === true
    && payload.roomId === roomId
    && payload.turnMutationId === turnMutationId
    && payload.userId === userId
    && payload.participantId === participantId
    && payload.content === content;
}

function runtimeMutationIdFromRequest(c: DebateContext, body: Record<string, unknown>): string | Response {
  const bodyMutationId = body.turnMutationId;
  const headerMutationId = c.req.header('X-Debate-Turn-Mutation-Id');
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!isTurnMutationId(bodyMutationId)
    || headerMutationId !== bodyMutationId
    || idempotencyKey !== bodyMutationId) {
    return c.json({
      error: 'Runtime debate turns require matching body and idempotency mutation identifiers',
      code: 'INVALID_TURN_MUTATION',
    }, 400);
  }
  return bodyMutationId;
}

function isRuntimeMutationId(value: string | Response): value is string {
  return typeof value === 'string';
}

async function getDebateTurnMutation(db: D1Database, mutationId: string): Promise<DebateTurnMutationRow | null> {
  return db.prepare(
    `SELECT mutation_id, room_id, user_id, participant_id, content_sha256, status,
            turn_number, student_turn_id, runtime_result_json, created_at, updated_at, completed_at
       FROM debate_turn_mutations WHERE mutation_id = ?1`
  ).bind(mutationId).first<DebateTurnMutationRow>();
}

async function markDebateMutationUnknown(
  db: D1Database,
  mutation: DebateTurnMutationRow,
): Promise<void> {
  try {
    await db.prepare(
      `UPDATE debate_turn_mutations
         SET status = 'unknown', updated_at = ?2
       WHERE mutation_id = ?1 AND status IN ('pending', 'unknown')`
    ).bind(mutation.mutation_id, Date.now()).run();
  } catch (error) {
    console.error('[DEBATE_MUTATION_MARK_UNKNOWN]', error);
  }
}

async function reserveDebateRuntimeMutation(
  c: DebateContext,
  params: {
    roomId: string;
    userId: string;
    participantId: string;
    contentHash: string;
    turnMutationId: string;
  },
): Promise<{ mutation: DebateTurnMutationRow; created: boolean } | Response> {
  const { DB: db } = c.env;
  let existing: DebateTurnMutationRow | null;
  try {
    existing = await getDebateTurnMutation(db, params.turnMutationId);
  } catch (error) {
    console.error('[DEBATE_MUTATION_READ]', error);
    return runtimeTurnUnknown(c, params.turnMutationId, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_RESERVATION_UNAVAILABLE');
  }
  if (existing) {
    if (existing.room_id !== params.roomId
      || existing.user_id !== params.userId
      || existing.participant_id !== params.participantId
      || existing.content_sha256 !== params.contentHash) {
      return c.json({ error: 'Turn mutation conflicts with a prior request', code: 'TURN_MUTATION_CONFLICT' }, 409);
    }
    return { mutation: existing, created: false };
  }

  const now = Date.now();
  try {
    const results = await db.batch([
      db.prepare(
        `UPDATE debate_rooms
           SET status = 'turn_pending'
         WHERE id = ?1 AND status = 'open'`
      ).bind(params.roomId),
      db.prepare(
        `INSERT INTO debate_turn_mutations (
           mutation_id, room_id, user_id, participant_id, content_sha256, status, created_at, updated_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6
          WHERE EXISTS (
            SELECT 1 FROM debate_rooms r WHERE r.id = ?2 AND r.status = 'turn_pending'
          )
            AND NOT EXISTS (
            SELECT 1 FROM debate_turn_mutations m
             WHERE m.room_id = ?2 AND m.status IN ('pending', 'unknown')
          )`
      ).bind(
        params.turnMutationId,
        params.roomId,
        params.userId,
        params.participantId,
        params.contentHash,
        now,
      ),
    ]);
    if (!changedExactlyOnce(results[0]) || !changedExactlyOnce(results[1])) {
      const [room, activeMutation] = await Promise.all([
        db.prepare('SELECT status FROM debate_rooms WHERE id = ?1').bind(params.roomId).first<RoomStatusRow>(),
        db.prepare(
          `SELECT mutation_id FROM debate_turn_mutations
            WHERE room_id = ?1 AND status IN ('pending', 'unknown') LIMIT 1`
        ).bind(params.roomId).first<{ mutation_id: string }>(),
      ]);
      if (room?.status === 'closed') return c.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, 404);
      if (activeMutation) return c.json({ error: 'Another turn mutation is already pending', code: 'DEBATE_TURN_ALREADY_PENDING' }, 409);
      return runtimeTurnUnknown(c, params.turnMutationId, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_RESERVATION_UNAVAILABLE');
    }
    const mutation = await getDebateTurnMutation(db, params.turnMutationId);
    if (!mutation) return runtimeTurnUnknown(c, params.turnMutationId, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_RESERVATION_UNAVAILABLE');
    return { mutation, created: true };
  } catch (error) {
    console.error('[DEBATE_MUTATION_RESERVATION]', error);
    return runtimeTurnUnknown(c, params.turnMutationId, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_RESERVATION_UNAVAILABLE');
  }
}

async function finalizeDebateRuntimeMutation(
  db: D1Database,
  mutation: DebateTurnMutationRow,
  runtimePayload: Record<string, unknown>,
): Promise<boolean> {
  const now = Date.now();
  const turnNumber = runtimePayload.turnNumber as number;
  const studentTurnId = typeof runtimePayload.studentTurnId === 'string' ? runtimePayload.studentTurnId : null;
  const resultJson = JSON.stringify(runtimePayload);
  try {
    const results = await db.batch([
      db.prepare(
      `UPDATE debate_turn_mutations
           SET status = 'complete', turn_number = ?2, student_turn_id = ?3,
               runtime_result_json = ?4, updated_at = ?5, completed_at = ?5
         WHERE mutation_id = ?1 AND room_id = ?6 AND user_id = ?7 AND participant_id = ?8
           AND content_sha256 = ?9 AND status IN ('pending', 'unknown')
           AND EXISTS (
             SELECT 1 FROM debate_rooms r
              WHERE r.id = ?6 AND r.status = 'turn_pending'
                AND EXISTS (
                  SELECT 1 FROM debate_turn_mutations active
                   WHERE active.mutation_id = ?1 AND active.room_id = r.id
                     AND active.user_id = ?7 AND active.participant_id = ?8
                     AND active.content_sha256 = ?9
                     AND active.status IN ('pending', 'unknown')
                )
           )`
      ).bind(
        mutation.mutation_id,
        turnNumber,
        studentTurnId,
        resultJson,
        now,
        mutation.room_id,
        mutation.user_id,
        mutation.participant_id,
        mutation.content_sha256,
      ),
      db.prepare(
        `UPDATE debate_rooms
           SET status = 'open'
         WHERE id = ?1 AND status = 'turn_pending'
           AND EXISTS (
             SELECT 1 FROM debate_turn_mutations m
              WHERE m.mutation_id = ?2 AND m.room_id = ?1
                AND m.user_id = ?3 AND m.participant_id = ?4 AND m.content_sha256 = ?5
                AND m.status = 'complete'
           )`
      ).bind(
        mutation.room_id,
        mutation.mutation_id,
        mutation.user_id,
        mutation.participant_id,
        mutation.content_sha256,
      ),
    ]);
    return changedExactlyOnce(results[0]) && changedExactlyOnce(results[1]);
  } catch (error) {
    console.error('[DEBATE_MUTATION_FINALIZATION]', error);
    return false;
  }
}

function completedMutationResponse(c: DebateContext, mutation: DebateTurnMutationRow): Response {
  if (!mutation.runtime_result_json) {
    return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_REPLAY_UNAVAILABLE');
  }
  try {
    const payload = JSON.parse(mutation.runtime_result_json) as unknown;
    if (!isRequestObject(payload) || payload.ok !== true || payload.roomId !== mutation.room_id
      || payload.turnMutationId !== mutation.mutation_id) {
      return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_REPLAY_UNAVAILABLE');
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_REPLAY_UNAVAILABLE');
  }
}

async function authorizeDebateRoom(c: DebateContext, roomId: string): Promise<{ room: DebateRoomRow; participantId: string } | Response> {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

  try {
    const room = await c.env.DB.prepare(
      'SELECT * FROM debate_rooms WHERE id = ?1'
    ).bind(roomId).first<DebateRoomRow>();
    const participant = await c.env.DB.prepare(
      `SELECT id FROM debate_participants
       WHERE room_id = ?1 AND user_id = ?2 AND participant_type = 'human' AND left_at IS NULL
       LIMIT 1`
    ).bind(roomId, auth.userId).first<DebateParticipantRow>();
    if (!room) return c.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, 404);
    if (!participant) return c.json({ error: 'Forbidden', code: 'ROOM_MEMBERSHIP_REQUIRED' }, 403);
    return { room, participantId: participant.id };
  } catch (error) {
    console.error('[DEBATE_AUTHORIZATION]', error);
    return c.json({ error: 'Authorization unavailable', code: 'AUTHORIZATION_UNAVAILABLE' }, 503);
  }
}

function isAuthorizedRoomResult(value: { room: DebateRoomRow; participantId: string } | Response): value is { room: DebateRoomRow; participantId: string } {
  return 'room' in value;
}

async function authorizeDebateOrg(c: DebateContext, orgId: string | null): Promise<Response | null> {
  if (!orgId) return null;
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

  try {
    const membership = await c.env.DB.prepare(
      'SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2'
    ).bind(orgId, auth.userId).first<OrgMembershipRow>();
    if (!membership) return c.json({ error: 'Forbidden', code: 'ORG_MEMBERSHIP_REQUIRED' }, 403);
    return null;
  } catch (error) {
    console.error('[DEBATE_ORG_AUTHORIZATION]', error);
    return c.json({ error: 'Authorization unavailable', code: 'AUTHORIZATION_UNAVAILABLE' }, 503);
  }
}

// Simple in-memory rate limiter (per-room, 5 turns/minute)
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(roomId: string, limit: number = 5, windowMs: number = 60000): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(roomId) || [];
  const valid = timestamps.filter(t => now - t < windowMs);
  if (valid.length >= limit) return false;
  valid.push(now);
  rateLimitMap.set(roomId, valid);
  return true;
}

/**
 * GET /api/debate/rooms — 토론방 목록 조회 (페이지네이션 지원)
 */
debateRoute.get('/api/debate/rooms', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  const page = Number.parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(Number.parseInt(c.req.query('limit') || '20', 10), 50);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1) {
    return c.json({ error: 'Invalid pagination', code: 'INVALID_PAGINATION' }, 400);
  }
  const offset = (page - 1) * limit;

  try {
    const rooms = await db.prepare(
      `SELECT r.* FROM debate_rooms r
       WHERE r.host_user_id = ?1
          OR EXISTS (
            SELECT 1 FROM debate_participants p
            WHERE p.room_id = r.id AND p.user_id = ?1 AND p.participant_type = 'human' AND p.left_at IS NULL
          )
       ORDER BY r.created_at DESC LIMIT ?2 OFFSET ?3`
    ).bind(auth.userId, limit, offset).all<DebateRoomRow>();
    
    const countResult = await db.prepare(
      `SELECT COUNT(*) as total FROM debate_rooms r
       WHERE r.host_user_id = ?1
          OR EXISTS (
            SELECT 1 FROM debate_participants p
            WHERE p.room_id = r.id AND p.user_id = ?1 AND p.participant_type = 'human' AND p.left_at IS NULL
          )`
    ).bind(auth.userId).first<{ total: number }>();
    
    return c.json({ 
      rooms: rooms.results || [], 
      pagination: {
        page,
        limit,
        total: countResult?.total || 0,
        totalPages: Math.ceil((countResult?.total || 0) / limit),
      },
    });
  } catch (error: unknown) {
    console.error('[DEBATE] Room list error:', error);
    return c.json({ error: 'Room list unavailable', code: 'DEBATE_LIST_UNAVAILABLE' }, 503);
  }
});

/**
 * POST /api/debate/rooms — 토론방 생성
 */
debateRoute.post('/api/debate/rooms', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);

  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  const runtime = resolveRuntimeConfig(c);
  if (runtime instanceof Response) return runtime;
  let body: unknown;
  try {
    body = await c.req.json() as unknown;
  } catch {
    return c.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400);
  }
  if (!isRequestObject(body)) {
    return c.json({ error: 'Request body must be an object', code: 'INVALID_BODY' }, 400);
  }
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const orgId = typeof body.orgId === 'string' ? body.orgId.trim() : '';
  if (!topic || topic.length > 1000) return c.json({ error: 'topic is required and must be at most 1000 characters', code: 'INVALID_TOPIC' }, 400);
  if (body.orgId !== undefined && !orgId) return c.json({ error: 'Invalid organization id', code: 'INVALID_ORG_ID' }, 400);

  const orgDenied = await authorizeDebateOrg(c, orgId || null);
  if (orgDenied) return orgDenied;

  const roomId = `room_${crypto.randomUUID()}`;
  const createdAt = Date.now();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO debate_rooms (id, org_id, host_user_id, topic, status, mode, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(roomId, orgId || null, auth.userId, topic, 'open', 'critic_advocate_moderator', createdAt),
      db.prepare(
        `INSERT INTO debate_participants (id, room_id, participant_type, role, user_id, display_name, joined_at)
         VALUES (?1, ?2, 'human', 'host', ?3, 'Host', ?4)`
      ).bind(`${roomId}_human_${auth.userId}`, roomId, auth.userId, createdAt),
      ...['critic', 'advocate', 'moderator'].map((role) => db.prepare(
        `INSERT INTO debate_participants (id, room_id, participant_type, role, display_name, joined_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(`${roomId}_ai_${role}`, roomId, 'ai', role, `AI ${role.charAt(0).toUpperCase() + role.slice(1)}`, createdAt)),
    ]);
  } catch (error) {
    console.error('[DEBATE_CREATE]', error);
    return c.json({ error: 'Room creation unavailable', code: 'DEBATE_CREATE_UNAVAILABLE' }, 503);
  }

  // A configured runtime is the owner of room execution. Do not advertise a
  // D1-only room as usable when that initialization cannot be verified.
  if (runtime) {
    try {
      const response = await fetch(`${runtime.url}/room/${roomId}/init`, {
        method: 'POST',
        headers: runtimeServiceHeaders(runtime.serviceToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ roomId, topic }),
      });
      const finalInitStatus = response.status === 200 || response.status === 201;
      const runtimePayload = finalInitStatus ? await response.json() as unknown : null;
      if (!finalInitStatus
        || !isRequestObject(runtimePayload)
        || runtimePayload.ok !== true
        || runtimePayload.roomId !== roomId) {
        const compensation = await compensateRuntimeInit(db, runtime, roomId);
        return runtimeInitFailure(c, roomId, compensation);
      }
    } catch (error) {
      console.error('[DEBATE_RUNTIME_INIT]', error);
      const compensation = await compensateRuntimeInit(db, runtime, roomId);
      return runtimeInitFailure(c, roomId, compensation);
    }
  }

  return c.json({ ok: true, roomId, topic, mode: 'critic_advocate_moderator' });
});

/**
 * GET /api/debate/rooms/:roomId — 토론방 정보 조회
 */
debateRoute.get('/api/debate/rooms/:roomId', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const roomId = c.req.param('roomId');
  const authorization = await authorizeDebateRoom(c, roomId);
  if (!isAuthorizedRoomResult(authorization)) return authorization;
  const runtime = resolveRuntimeConfig(c);
  if (runtime instanceof Response) return runtime;

  // D1 is canonical for a closed/compensated room; do not surface a stale
  // runtime snapshot as an apparently open room.
  if (authorization.room.status === 'open' && runtime) {
    try {
      const resp = await fetch(`${runtime.url}/room/${roomId}/status`, {
        headers: runtimeServiceHeaders(runtime.serviceToken),
      });
      if (!resp.ok) {
        return c.json({ error: 'Debate runtime status is unavailable', status: 'UNKNOWN', code: 'DEBATE_RUNTIME_STATUS_UNAVAILABLE' }, 503);
      }
      const runtimePayload = await resp.json() as unknown;
      if (!isRequestObject(runtimePayload) || runtimePayload.roomId !== roomId) {
        return c.json({ error: 'Debate runtime status is invalid', status: 'UNKNOWN', code: 'DEBATE_RUNTIME_STATUS_UNAVAILABLE' }, 503);
      }
      // Preserve a meaningful upstream 202/207 rather than allowing the Hono
      // JSON helper to normalize a non-final runtime response to 200.
      return new Response(JSON.stringify(runtimePayload), {
        status: resp.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      console.error('[DEBATE_RUNTIME_STATUS]', error);
      return c.json({ error: 'Debate runtime status is unavailable', status: 'UNKNOWN', code: 'DEBATE_RUNTIME_STATUS_UNAVAILABLE' }, 503);
    }
  }

  try {
    const participants = await db.prepare('SELECT * FROM debate_participants WHERE room_id = ?1').bind(roomId).all();
    const turns = await db.prepare('SELECT * FROM debate_turns WHERE room_id = ?1 ORDER BY turn_number ASC').bind(roomId).all<DebateTurnRow>();
    return c.json({ room: authorization.room, participants: participants.results || [], turns: turns.results || [] });
  } catch (error) {
    console.error('[DEBATE_ROOM_READ]', error);
    return c.json({ error: 'Room unavailable', code: 'DEBATE_ROOM_UNAVAILABLE' }, 503);
  }
});

/**
 * GET /api/debate/rooms/:roomId/turns/:turnMutationId
 * Read a caller-owned runtime mutation after a lost response. This never
 * invokes the runtime and deliberately omits the content digest.
 */
debateRoute.get('/api/debate/rooms/:roomId/turns/:turnMutationId', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const roomId = c.req.param('roomId');
  const turnMutationId = c.req.param('turnMutationId');
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  if (!isTurnMutationId(turnMutationId)) {
    return c.json({ error: 'Invalid turn mutation id', code: 'INVALID_TURN_MUTATION' }, 400);
  }
  const authorization = await authorizeDebateRoom(c, roomId);
  if (!isAuthorizedRoomResult(authorization)) return authorization;

  try {
    const mutation = await getDebateTurnMutation(db, turnMutationId);
    if (!mutation
      || mutation.room_id !== roomId
      || mutation.user_id !== auth.userId
      || mutation.participant_id !== authorization.participantId) {
      return c.json({ error: 'Turn mutation not found', code: 'TURN_MUTATION_NOT_FOUND' }, 404);
    }
    return c.json({
      roomId,
      turnMutationId: mutation.mutation_id,
      status: mutation.status,
      turnNumber: mutation.turn_number,
      studentTurnId: mutation.student_turn_id,
      completedAt: mutation.completed_at,
      updatedAt: mutation.updated_at,
      replayAvailable: mutation.status === 'complete' && Boolean(mutation.runtime_result_json),
    });
  } catch (error) {
    console.error('[DEBATE_MUTATION_STATUS]', error);
    return c.json({ error: 'Turn mutation status is unavailable', code: 'DEBATE_MUTATION_STATUS_UNAVAILABLE' }, 503);
  }
});

/**
 * POST /api/debate/rooms/:roomId/turns — 토론 턴 추가
 */
debateRoute.post('/api/debate/rooms/:roomId/turns', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const roomId = c.req.param('roomId');
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  const authorization = await authorizeDebateRoom(c, roomId);
  if (!isAuthorizedRoomResult(authorization)) return authorization;
  const runtime = resolveRuntimeConfig(c);
  if (runtime instanceof Response) return runtime;
  if (authorization.room.status === 'closed') {
    return c.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, 404);
  }
  if (!runtime && authorization.room.status !== 'open') {
    return c.json({
      error: 'Room turn state is not final',
      status: 'UNKNOWN',
      code: 'DEBATE_TURN_STATE_PENDING',
    }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json() as unknown;
  } catch {
    return c.json({ error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400);
  }
  if (!isRequestObject(body)) {
    return c.json({ error: 'Request body must be an object', code: 'INVALID_BODY' }, 400);
  }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > 12000) return c.json({ error: 'content is required and must be at most 12000 characters', code: 'INVALID_CONTENT' }, 400);

  try {
  if (runtime) {
    const requestedMutationId = runtimeMutationIdFromRequest(c, body);
    if (!isRuntimeMutationId(requestedMutationId)) return requestedMutationId;
    const contentHash = await contentSha256(content);

    // Only a new open-room mutation consumes rate-limit capacity. Exact
    // retries must be permitted while the canonical room is turn_pending.
    if (authorization.room.status === 'open' && !checkRateLimit(roomId)) {
      return c.json({ error: 'Rate limit exceeded. Max 5 turns per minute.' }, 429);
    }

    const reservation = await reserveDebateRuntimeMutation(c, {
      roomId,
      userId: auth.userId,
      participantId: authorization.participantId,
      contentHash,
      turnMutationId: requestedMutationId,
    });
    if (reservation instanceof Response) return reservation;
    const { mutation } = reservation;

    // A prior fully finalized mutation is a durable page-side replay; do not
    // call the runtime or create a second logical turn.
    if (mutation.status === 'complete') return completedMutationResponse(c, mutation);

    // A close that won the race is canonical. Do not resume a pending worker
    // mutation and never make a closed room eligible for finalization.
    let canonicalRoom: RoomStatusRow | null;
    try {
      canonicalRoom = await db.prepare('SELECT status FROM debate_rooms WHERE id = ?1')
        .bind(roomId).first<RoomStatusRow>();
    } catch (error) {
      console.error('[DEBATE_RUNTIME_TURN_CANONICAL_READ]', error);
      await markDebateMutationUnknown(db, mutation);
      return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN');
    }
    if (canonicalRoom?.status === 'closed') {
      return c.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, 404);
    }

    try {
      const resp = await fetch(`${runtime.url}/room/${roomId}/turn`, {
        method: 'POST',
        headers: runtimeServiceHeaders(runtime.serviceToken, {
          'Content-Type': 'application/json',
          'Idempotency-Key': mutation.mutation_id,
          'X-Debate-Turn-Mutation-Id': mutation.mutation_id,
        }),
        body: JSON.stringify({ content, participantId: auth.userId, turnMutationId: mutation.mutation_id }),
      });
      if (!resp.ok) {
        await markDebateMutationUnknown(db, mutation);
        return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN');
      }
      const runtimePayload = await resp.json() as unknown;
      if (!isRequestObject(runtimePayload)) {
        await markDebateMutationUnknown(db, mutation);
        return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN');
      }

      if (resp.status === 202 || resp.status === 207) {
        await markDebateMutationUnknown(db, mutation);
        return new Response(JSON.stringify({
          ...runtimePayload,
          status: 'UNKNOWN',
          code: 'DEBATE_RUNTIME_TURN_PENDING',
          // A concurrent close may already have replaced turn_pending in D1.
          // Do not report that transient state without a fresh canonical read.
          d1Status: 'UNKNOWN',
          turnMutationId: mutation.mutation_id,
        }), {
          status: resp.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }

      if ((resp.status !== 200 && resp.status !== 201)
        || !isFinalRuntimeTurn(
          runtimePayload,
          roomId,
          mutation.mutation_id,
          auth.userId,
          authorization.participantId,
          content,
        )) {
        await markDebateMutationUnknown(db, mutation);
        return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN');
      }

      if (!await finalizeDebateRuntimeMutation(db, mutation, runtimePayload)) {
        await markDebateMutationUnknown(db, mutation);
        return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN', 'DEBATE_RUNTIME_TURN_FINALIZATION_UNCERTAIN');
      }

      return new Response(JSON.stringify(runtimePayload), {
        status: resp.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      console.error('[DEBATE_RUNTIME_TURN]', error);
      await markDebateMutationUnknown(db, mutation);
      return runtimeTurnUnknown(c, mutation.mutation_id, 'UNKNOWN');
    }
  }

  // D1 serves turns only when no Durable Object runtime is configured.
  const room = authorization.room;

  if (!checkRateLimit(roomId)) {
    return c.json({ error: 'Rate limit exceeded. Max 5 turns per minute.' }, 429);
  }

  // Do not accept a local turn if it cannot be completed by the configured AI path.
  const apiKey = c.env.SOONGSIL_API_KEY || c.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({
      ok: false,
      status: 'unavailable',
      error: 'Debate AI provider is unavailable',
      code: 'DEBATE_AI_PROVIDER_UNAVAILABLE',
    }, 503);
  }

  const existingTurns = await db.prepare(
    'SELECT role, content FROM debate_turns WHERE room_id = ?1 ORDER BY turn_number DESC LIMIT 10'
  ).bind(roomId).all<DebateTurnRow>();
  const history = (existingTurns.results || []).reverse().map((t: DebateTurnRow) => `[${t.role}]: ${t.content}`).join('\n');

  // This is the sole local accepted-turn reservation: the room must still be
  // canonically open at the instant the student turn is inserted.
  const studentTurnId = `turn_${crypto.randomUUID()}`;
  const acceptedAt = Date.now();
  let acceptedTurnRow: { id: string; turn_number: number } | null;
  try {
    acceptedTurnRow = await db.prepare(
      `INSERT INTO debate_turns (id, room_id, participant_id, turn_number, content, role, created_at)
       SELECT
         ?1,
         r.id,
         (SELECT p.id FROM debate_participants p
          WHERE p.room_id = r.id AND p.user_id = ?2 AND p.participant_type = 'human' AND p.left_at IS NULL
          LIMIT 1),
         COALESCE((SELECT MAX(t.turn_number) + 1 FROM debate_turns t WHERE t.room_id = r.id), 1),
         ?3,
         'student',
         ?4
       FROM debate_rooms r
       WHERE r.id = ?5
         AND r.status = 'open'
         AND EXISTS (
           SELECT 1 FROM debate_participants p
           WHERE p.room_id = r.id AND p.user_id = ?2 AND p.participant_type = 'human' AND p.left_at IS NULL
         )
       RETURNING id, turn_number`
    ).bind(studentTurnId, auth.userId, content, acceptedAt, roomId).first<{ id: string; turn_number: number }>();
  } catch (error) {
    console.error('[DEBATE_TURN_RESERVATION]', error);
    return c.json({
      error: 'Debate turn reservation state is uncertain',
      status: 'UNKNOWN',
      code: 'DEBATE_TURN_RESERVATION_UNKNOWN',
      studentTurnId,
    }, 503);
  }
  if (!acceptedTurnRow) {
    const canonical = await db.prepare('SELECT status FROM debate_rooms WHERE id = ?1')
      .bind(roomId).first<RoomStatusRow>();
    if (canonical?.status === 'closed') return c.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, 404);
    return c.json({ error: 'Debate turn was not accepted', code: 'DEBATE_TURN_NOT_ACCEPTED' }, 409);
  }
  const persistedStudentTurnId = acceptedTurnRow.id;
  const nextTurn = acceptedTurnRow.turn_number;

  // Generate multi-agent responses
  const agentResponses: Record<string, string> = {};
  const roles = [
    { role: 'critic', prompt: `You are a critical debater. Challenge the student's argument and find weaknesses. Topic: ${room.topic}\n\nHistory:\n${history}\n\nStudent: ${content}\n\nRespond as a thoughtful critic in Korean (2-3 sentences):` },
    { role: 'advocate', prompt: `You are a supportive debater. Strengthen or build upon the student's argument. Topic: ${room.topic}\n\nHistory:\n${history}\n\nStudent: ${content}\n\nRespond as a supportive advocate in Korean (2-3 sentences):` },
    { role: 'moderator', prompt: `You are a neutral moderator. Summarize the key points and guide the discussion forward. Topic: ${room.topic}\n\nHistory:\n${history}\n\nStudent: ${content}\n\nRespond as a balanced moderator in Korean (2-3 sentences):` },
  ];
  const responses = await Promise.allSettled(
    roles.map(async ({ role, prompt }) => {
      const result = await callAIJSON<{ reply: string }>(
        apiKey, c.env.GEMINI_API_KEY,
        'You are an AI debate participant. Always respond in JSON: {"reply":"your response"}',
        prompt,
        { temperature: 0.7, maxTokens: 300 },
      );
      const reply = typeof result.reply === 'string' ? result.reply.trim() : '';
      if (!reply) throw new Error(`EMPTY_${role.toUpperCase()}_REPLY`);
      return { role, reply };
    })
  );

  let turnOffset = 1;
  try {
    for (const res of responses) {
      if (res.status !== 'fulfilled') continue;
      const { role, reply } = res.value;
      await db.prepare(
        `INSERT INTO debate_turns (id, room_id, participant_id, turn_number, content, role, moderation_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        `turn_${crypto.randomUUID()}`, roomId, `${roomId}_ai_${role}`,
        nextTurn + turnOffset, reply, role,
        JSON.stringify({ source: 'ai', model: 'auto' }),
        Date.now(),
      ).run();
      agentResponses[role] = reply;
      turnOffset++;
    }
  } catch (error) {
    console.error('[DEBATE_AI_TURN_PERSISTENCE]', error);
    return c.json({
      ok: false,
      status: 'partial',
      error: 'One or more AI turns could not be persisted',
      code: 'DEBATE_AI_TURN_PERSISTENCE_UNAVAILABLE',
      studentTurnId: persistedStudentTurnId,
      turnNumber: nextTurn,
      agentResponses,
    }, 503);
  }

  const failedRoles = responses.flatMap((result, index) => result.status === 'rejected' ? [roles[index].role] : []);
  if (failedRoles.length > 0) {
    return c.json({
      ok: false,
      status: 'partial',
      error: 'One or more debate AI responses are unavailable',
      code: 'DEBATE_AI_PROVIDER_PARTIAL',
      studentTurnId: persistedStudentTurnId,
      turnNumber: nextTurn,
      agentResponses,
      unavailableRoles: failedRoles,
    }, 202);
  }

  return c.json({
    ok: true,
    studentTurnId: persistedStudentTurnId,
    turnNumber: nextTurn,
    studentContent: content,
    agentResponses,
  });
  } catch (error) {
    console.error('[DEBATE_TURN]', error);
    return c.json({ error: 'Turn submission unavailable', code: 'DEBATE_TURN_UNAVAILABLE' }, 503);
  }
});

/**
 * POST /api/debate/rooms/:roomId/close — 토론방 종료/아카이브 (v23)
 */
debateRoute.post('/api/debate/rooms/:roomId/close', requireAuth, async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'Database not available' }, 500);
  const roomId = c.req.param('roomId');
  const authorization = await authorizeDebateRoom(c, roomId);
  if (!isAuthorizedRoomResult(authorization)) return authorization;
  const auth = getAuthUser(c);
  if (!auth?.userId || authorization.room.host_user_id !== auth.userId) {
    return c.json({ error: 'Forbidden', code: 'ROOM_HOST_REQUIRED' }, 403);
  }

  try {
    const now = Date.now();
    // D1 is canonical. Mark an interrupted lifecycle as UNKNOWN in the same
    // transaction so it can never later satisfy the open-room finalizer.
    await db.batch([
      db.prepare(
        'UPDATE debate_rooms SET status = ?2, closed_at = ?3 WHERE id = ?1'
      ).bind(roomId, 'closed', now),
      db.prepare(
        `UPDATE debate_turn_mutations
           SET status = 'unknown', updated_at = ?2
         WHERE room_id = ?1 AND status = 'pending'`
      ).bind(roomId, now),
    ]);
  } catch (error: unknown) {
    console.error('[DEBATE_CLOSE]', error);
    return c.json({
      ok: false,
      error: 'Failed to close room metadata',
      code: 'DEBATE_CLOSE_UNAVAILABLE',
    }, 503);
  }

  const runtime = resolveRuntimeConfig(c);
  if (runtime instanceof Response) {
    return c.json({
      ok: false,
      roomId,
      status: 'partial',
      error: 'Room is closed in D1 but runtime service authentication is unavailable',
      code: 'DEBATE_RUNTIME_CONFIGURATION_UNAVAILABLE',
      d1Status: 'CLOSED',
      runtimeStatus: 'UNKNOWN',
    }, 503);
  }

  if (runtime) {
    try {
      const response = await fetch(`${runtime.url}/room/${roomId}/close`, {
        method: 'POST',
        headers: runtimeServiceHeaders(runtime.serviceToken),
      });
      const finalCloseStatus = response.status === 200 || response.status === 201;
      const runtimePayload = finalCloseStatus ? await response.json() as unknown : null;
      if (!finalCloseStatus
        || !isRequestObject(runtimePayload)
        || runtimePayload.ok !== true
        || runtimePayload.status !== 'closed'
        || runtimePayload.roomId !== roomId) {
        return c.json({
          ok: false,
          roomId,
          status: 'partial',
          error: 'Room is closed in D1 but the debate runtime close is unavailable',
          code: 'DEBATE_RUNTIME_CLOSE_UNAVAILABLE',
        }, 503);
      }
    } catch (error) {
      console.error('[DEBATE_RUNTIME_CLOSE]', error);
      return c.json({
        ok: false,
        roomId,
        status: 'partial',
        error: 'Room is closed in D1 but the debate runtime close is unavailable',
        code: 'DEBATE_RUNTIME_CLOSE_UNAVAILABLE',
      }, 503);
    }
  }

  return c.json({ ok: true, roomId, status: 'closed' });
});

export { debateRoute };
