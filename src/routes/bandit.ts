/**
 * LinUCB Contextual Bandit API Routes
 * - POST /api/bandit/choose — Select arm given context
 * - POST /api/bandit/update — Update arm after reward observation
 *
 * Context vector (d=8):
 * [0] mastery (BKT pKnow)
 * [1] engagement (input speed signal)
 * [2] flow_index
 * [3-6] domain one-hot (top-4)
 * [7] reserved
 *
 * Arms (15 total): d{1-5}_t{d|a|c}
 * (difficulty 1-5 × type: definition/application/counterexample)
 */

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { LinUCB, createDefaultArms, type LinUCBArm } from '../services/analytics/bandit/linucb';
import { getAuthUser, requireAuth } from '../middleware/auth';

const banditRoute = new Hono<{ Bindings: Bindings }>();

type SessionOwnerRow = { user_id: string | null };
const CONTEXT_DIMENSION = 8;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_ARM_ID_LENGTH = 64;

banditRoute.use('*', requireAuth);

async function authorizeSessionOwner(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<{ error?: 'SESSION_NOT_FOUND' | 'SESSION_OWNER_REQUIRED' | 'AUTHORIZATION_UNAVAILABLE' }> {
  try {
    const session = await db.prepare(
      'SELECT user_id FROM sessions WHERE id = ?1'
    ).bind(sessionId).first<SessionOwnerRow>();
    if (!session) return { error: 'SESSION_NOT_FOUND' };
    if (session.user_id !== userId) return { error: 'SESSION_OWNER_REQUIRED' };
    return {};
  } catch (error) {
    console.error('[BANDIT_AUTHORIZATION]', error);
    return { error: 'AUTHORIZATION_UNAVAILABLE' };
  }
}

// Request/Response schemas
interface ChooseRequest {
  sessionId: string;
  context: number[]; // d=8
  alpha?: number;
}

interface ChooseResponse {
  success: boolean;
  armId: string;
  timestamp: number;
}

interface UpdateRequest {
  sessionId: string;
  armId: string;
  context: number[];
  reward: number; // typically 0-1 scale
}

interface UpdateResponse {
  success: boolean;
  armId: string;
  timestamp: number;
  error?: string;
}

function isRequestObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isValidContext(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== CONTEXT_DIMENSION) return false;
  if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 1)) {
    return false;
  }
  const domain = value.slice(3, 7);
  return domain.every((entry) => entry === 0 || entry === 1) && domain.reduce((sum, entry) => sum + entry, 0) === 1;
}

function hasValidArmState(matrix: unknown, vector: unknown): matrix is number[][] {
  return Array.isArray(matrix)
    && matrix.length === CONTEXT_DIMENSION
    && matrix.every((row) => Array.isArray(row)
      && row.length === CONTEXT_DIMENSION
      && row.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))
    && Array.isArray(vector)
    && vector.length === CONTEXT_DIMENSION
    && vector.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * POST /api/bandit/choose
 * Select arm with highest UCB given context
 *
 * Request body:
 * {
 *   sessionId: string,
 *   context: number[] (length 8),
 *   alpha?: number (default 0.5)
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   armId: string,
 *   timestamp: number
 * }
 */
banditRoute.post('/choose', async (c) => {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ success: false, error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

  let body: unknown;
  try {
    body = await c.req.json() as unknown;
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400);
  }
  if (!isRequestObject(body)) {
    return c.json({ success: false, error: 'Request body must be an object', code: 'INVALID_BODY' }, 400);
  }

  try {
    const { sessionId, context, alpha = 0.5 } = body;

    // Validate
    if (!isBoundedIdentifier(sessionId, MAX_SESSION_ID_LENGTH) || !isValidContext(context)) {
      return c.json(
        {
          success: false,
          error: 'Invalid request: bounded sessionId and normalized context (length 8) required',
        },
        400
      );
    }
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha > 2) {
      return c.json({ success: false, error: 'alpha must be a finite number in (0, 2]', code: 'INVALID_ALPHA' }, 400);
    }

    // Initialize LinUCB
    const linucb = new LinUCB(8, alpha);
    const arms = createDefaultArms();

    const db = c.env.DB;
    if (!db) return c.json({ success: false, error: 'Database unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
    const authorization = await authorizeSessionOwner(db, sessionId, auth.userId);
    if (authorization.error === 'SESSION_NOT_FOUND') {
      return c.json({ success: false, error: 'Session not found', code: authorization.error }, 404);
    }
    if (authorization.error === 'SESSION_OWNER_REQUIRED') {
      return c.json({ success: false, error: 'Forbidden', code: authorization.error }, 403);
    }
    if (authorization.error) {
      return c.json({ success: false, error: 'Authorization unavailable', code: authorization.error }, 503);
    }

    // Load session-specific arm state if exists
    const loadedArms = await loadSessionArms(db, sessionId, arms);

    // Choose arm
    const selectedArmId = linucb.chooseArm(loadedArms, { values: context });

    const response: ChooseResponse = {
      success: true,
      armId: selectedArmId,
      timestamp: Date.now(),
    };

    return c.json(response);
  } catch (err) {
    console.error('[BANDIT_CHOOSE]', err);
    return c.json(
      {
        success: false,
        error: 'Bandit selection unavailable',
        code: 'BANDIT_CHOOSE_UNAVAILABLE',
      },
      503
    );
  }
});

/**
 * POST /api/bandit/update
 * Update arm after observing reward
 *
 * Request body:
 * {
 *   sessionId: string,
 *   armId: string,
 *   context: number[] (length 8),
 *   reward: number (0-1 scale)
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   armId: string,
 *   timestamp: number,
 *   error?: string
 * }
 */
banditRoute.post('/update', async (c) => {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ success: false, error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

  let body: unknown;
  try {
    body = await c.req.json() as unknown;
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body', code: 'INVALID_JSON' }, 400);
  }
  if (!isRequestObject(body)) {
    return c.json({ success: false, error: 'Request body must be an object', code: 'INVALID_BODY' }, 400);
  }

  try {
    const { sessionId, armId, context, reward } = body;

    // Validate
    if (!isBoundedIdentifier(sessionId, MAX_SESSION_ID_LENGTH)
      || !isBoundedIdentifier(armId, MAX_ARM_ID_LENGTH)
      || !isValidContext(context)
      || typeof reward !== 'number') {
      return c.json(
        {
          success: false,
          error: 'Invalid request: bounded sessionId/armId, normalized context, and reward required',
        },
        400
      );
    }
    if (!Number.isFinite(reward) || reward < 0 || reward > 1) {
      return c.json({ success: false, error: 'reward must be a finite number between 0 and 1', code: 'INVALID_REWARD' }, 400);
    }

    // Initialize LinUCB
    const linucb = new LinUCB(8, 0.5);
    const arms = createDefaultArms();

    // Load session-specific arm state
    const db = c.env.DB;
    if (!db) return c.json({ success: false, error: 'Database unavailable', code: 'DATABASE_UNAVAILABLE' }, 503);
    const authorization = await authorizeSessionOwner(db, sessionId, auth.userId);
    if (authorization.error === 'SESSION_NOT_FOUND') {
      return c.json({ success: false, error: 'Session not found', code: authorization.error }, 404);
    }
    if (authorization.error === 'SESSION_OWNER_REQUIRED') {
      return c.json({ success: false, error: 'Forbidden', code: authorization.error }, 403);
    }
    if (authorization.error) {
      return c.json({ success: false, error: 'Authorization unavailable', code: authorization.error }, 503);
    }
    const loadedArms = await loadSessionArms(db, sessionId, arms);

    // Find and update arm
    const armToUpdate = loadedArms.find(a => a.id === armId);
    if (!armToUpdate) {
      return c.json(
        {
          success: false,
          error: `Arm ${armId} not found`,
        },
        404
      );
    }

    const updatedArm = linucb.update(armToUpdate, context, reward);
    if (!hasValidArmState(updatedArm.A, updatedArm.b)) {
      console.error('[BANDIT_UPDATED_STATE_INVALID]', { sessionId, armId });
      return c.json({ success: false, error: 'Updated bandit state is invalid', code: 'BANDIT_UPDATED_STATE_INVALID' }, 503);
    }

    // Save updated arm state
    await saveSessionArm(db, sessionId, updatedArm);

    const response: UpdateResponse = {
      success: true,
      armId,
      timestamp: Date.now(),
    };

    return c.json(response);
  } catch (err) {
    console.error('[BANDIT_UPDATE]', err);
    return c.json(
      {
        success: false,
        error: 'Bandit update unavailable',
        code: 'BANDIT_UPDATE_UNAVAILABLE',
      },
      503
    );
  }
});

interface D1Result {
  results: Array<{
    arm_id: string;
    A_matrix_json: string;
    b_vector_json: string;
  }>;
}

interface D1Database {
  prepare(query: string): {
    bind(...params: unknown[]): {
      all(): Promise<D1Result>;
      run(): Promise<unknown>;
      first<T>(): Promise<T | null>;
    };
  };
}

/**
 * Helper: Load session-specific arm state from DB, or use defaults
 */
async function loadSessionArms(
  db: D1Database,
  sessionId: string,
  defaultArms: LinUCBArm[]
): Promise<LinUCBArm[]> {
  const rows = (await db
      .prepare('SELECT arm_id, A_matrix_json, b_vector_json FROM linucb_session_arms WHERE session_id = ?')
      .bind(sessionId)
      .all()) as D1Result;

  const armMap = new Map<string, LinUCBArm>();

  for (const row of rows.results) {
    try {
      const matrix = JSON.parse(row.A_matrix_json) as unknown;
      const vector = JSON.parse(row.b_vector_json) as unknown;
      if (!hasValidArmState(matrix, vector)) {
        throw new Error('BANDIT_STATE_SHAPE_INVALID');
      }
      armMap.set(row.arm_id, {
        id: row.arm_id,
        A: matrix,
        b: vector as number[],
      });
    } catch (error) {
      console.error('[BANDIT_STATE_CORRUPT]', { sessionId, armId: row.arm_id, error });
      throw new Error('BANDIT_STATE_CORRUPT');
    }
  }

  // Return arms, preferring loaded state over defaults. An empty result is a valid new session.
  return defaultArms.map(arm => armMap.get(arm.id) || arm);
}

/**
 * Helper: Save single arm state to DB
 */
async function saveSessionArm(
  db: D1Database,
  sessionId: string,
  arm: LinUCBArm
): Promise<void> {
  await db
      .prepare(
        `INSERT OR REPLACE INTO linucb_session_arms
         (session_id, arm_id, A_matrix_json, b_vector_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(sessionId, arm.id, JSON.stringify(arm.A), JSON.stringify(arm.b), Date.now())
      .run();
}

export default banditRoute;
