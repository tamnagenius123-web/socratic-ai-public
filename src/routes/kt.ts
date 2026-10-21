/**
 * Knowledge Tracing API Routes
 * Endpoints for BKT (Bayesian Knowledge Tracing) state management
 * - POST /api/kt/bkt/update — Update BKT state with student response
 * - GET /api/kt/bkt/:userId/:skillId — Retrieve current BKT state
 */

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';
import {
  updateBKT,
  DEFAULT_BKT_PARAMS,
  createInitialBKTState,
} from '../services/analytics/kt/bkt';
import type { BKTState, BKTParams } from '../services/analytics/kt/types';

const ktRoute = new Hono<{ Bindings: Bindings }>();

// Require authentication for all KT routes
ktRoute.use('/api/kt/*', requireAuth);

/**
 * POST /api/kt/bkt/update
 * Update BKT state with a student response
 *
 * Request body:
 * {
 *   userId: string
 *   skillId: string
 *   correct: boolean
 *   pL0?: number (optional, default 0.30)
 *   pT?: number (optional, default 0.10)
 *   pG?: number (optional, default 0.20)
 *   pS?: number (optional, default 0.10)
 * }
 *
 * Response:
 * {
 *   success: boolean
 *   state: BKTState
 *   pCorrectNext?: number (predicted probability for next attempt)
 *   error?: string
 * }
 */
ktRoute.post('/api/kt/bkt/update', async (c) => {
  try {
    const db = c.env.DB;
    const body = await c.req.json();
    const auth = getAuthUser(c);
    if (!auth) return c.json({ success: false, error: '인증이 필요합니다.' }, 401);

    const { skillId, correct, pL0, pT, pG, pS } = body;
    const userId = auth.userId;

    // Validate required fields
    if (!skillId || correct === undefined) {
      return c.json(
        {
          success: false,
          error: 'Missing required fields: skillId, correct',
        },
        400
      );
    }

    // Validate correct is boolean
    if (typeof correct !== 'boolean') {
      return c.json(
        {
          success: false,
          error: 'Field "correct" must be boolean',
        },
        400
      );
    }

    // Build custom params if provided, otherwise use defaults
    const params: BKTParams = {
      pL0: pL0 ?? DEFAULT_BKT_PARAMS.pL0,
      pT: pT ?? DEFAULT_BKT_PARAMS.pT,
      pG: pG ?? DEFAULT_BKT_PARAMS.pG,
      pS: pS ?? DEFAULT_BKT_PARAMS.pS,
    };

    // Fetch current state from DB or create initial
    const existing = await db
      .prepare(
        'SELECT user_id, skill_id, p_know, n_opportunities, last_updated FROM bkt_states WHERE user_id = ?1 AND skill_id = ?2'
      )
      .bind(userId, skillId)
      .first<{
        user_id: string;
        skill_id: string;
        p_know: number;
        n_opportunities: number;
        last_updated: number;
      }>();

    let currentState: BKTState;
    if (existing) {
      currentState = {
        userId: existing.user_id,
        skillId: existing.skill_id,
        pKnow: existing.p_know,
        n: existing.n_opportunities,
        lastUpdateAt: existing.last_updated,
      };
    } else {
      currentState = createInitialBKTState(userId, skillId, params.pL0);
    }

    // Update state
    const updatedState = updateBKT(currentState, correct, params);

    // Persist to DB (upsert)
    await db
      .prepare(
        `INSERT INTO bkt_states (user_id, skill_id, p_know, n_opportunities, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, skill_id) DO UPDATE SET
           p_know = ?3,
           n_opportunities = ?4,
           last_updated = ?5`
      )
      .bind(
        updatedState.userId,
        updatedState.skillId,
        updatedState.pKnow,
        updatedState.n,
        updatedState.lastUpdateAt
      )
      .run();

    // Import predictCorrect for response
    const { predictCorrect } = await import(
      '../services/analytics/kt/bkt'
    );
    const pCorrectNext = predictCorrect(updatedState, params);

    return c.json({
      success: true,
      state: {
        userId: updatedState.userId,
        skillId: updatedState.skillId,
        pKnow: updatedState.pKnow,
        n: updatedState.n,
        lastUpdateAt: updatedState.lastUpdateAt,
      },
      pCorrectNext,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('[KT] BKT update error:', message);

    // Check if it's a degenerate parameter error
    if (message.includes('degenerate')) {
      return c.json(
        {
          success: false,
          error: message,
        },
        400
      );
    }

    return c.json(
      {
        success: false,
        error: message,
      },
      500
    );
  }
});

/**
 * GET /api/kt/bkt/:userId/:skillId
 * Retrieve current BKT state for a user and skill
 *
 * Response:
 * {
 *   success: boolean
 *   state?: BKTState
 *   pCorrectNext?: number
 *   error?: string
 * }
 */
ktRoute.get('/api/kt/bkt/:userId/:skillId', async (c) => {
  try {
    const db = c.env.DB;
    const { userId, skillId } = c.req.param();
    const auth = getAuthUser(c);
    if (!auth) return c.json({ success: false, error: '인증이 필요합니다.' }, 401);
    if (userId !== auth.userId && !['admin', 'instructor'].includes(auth.role)) {
      return c.json({ success: false, error: '접근 권한이 없습니다.' }, 403);
    }

    const row = await db
      .prepare(
        'SELECT user_id, skill_id, p_know, n_opportunities, last_updated FROM bkt_states WHERE user_id = ?1 AND skill_id = ?2'
      )
      .bind(userId, skillId)
      .first<{
        user_id: string;
        skill_id: string;
        p_know: number;
        n_opportunities: number;
        last_updated: number;
      }>();

    if (!row) {
      // Return initial state
      const initialState = createInitialBKTState(userId, skillId);
      const { predictCorrect } = await import(
        '../services/analytics/kt/bkt'
      );
      const pCorrectNext = predictCorrect(initialState);

      return c.json({
        success: true,
        state: initialState,
        pCorrectNext,
      });
    }

    const state: BKTState = {
      userId: row.user_id,
      skillId: row.skill_id,
      pKnow: row.p_know,
      n: row.n_opportunities,
      lastUpdateAt: row.last_updated,
    };

    const { predictCorrect } = await import(
      '../services/analytics/kt/bkt'
    );
    const pCorrectNext = predictCorrect(state);

    return c.json({
      success: true,
      state,
      pCorrectNext,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('[KT] BKT get error:', message);
    return c.json(
      {
        success: false,
        error: message,
      },
      500
    );
  }
});

/**
 * GET /api/kt/bkt/user/:userId
 * Retrieve all BKT states for a user (all skills)
 *
 * Response:
 * {
 *   success: boolean
 *   states?: BKTState[]
 *   error?: string
 * }
 */
ktRoute.get('/api/kt/bkt/user/:userId', async (c) => {
  try {
    const db = c.env.DB;
    const { userId } = c.req.param();
    const auth = getAuthUser(c);
    if (!auth) return c.json({ success: false, error: '인증이 필요합니다.' }, 401);
    if (userId !== auth.userId && !['admin', 'instructor'].includes(auth.role)) {
      return c.json({ success: false, error: '접근 권한이 없습니다.' }, 403);
    }

    const rows = await db
      .prepare(
        'SELECT user_id, skill_id, p_know, n_opportunities, last_updated FROM bkt_states WHERE user_id = ?1 ORDER BY skill_id'
      )
      .bind(userId)
      .all<{
        user_id: string;
        skill_id: string;
        p_know: number;
        n_opportunities: number;
        last_updated: number;
      }>();

    const states = (rows?.results ?? []).map((row) => ({
      userId: row.user_id,
      skillId: row.skill_id,
      pKnow: row.p_know,
      n: row.n_opportunities,
      lastUpdateAt: row.last_updated,
    }));

    return c.json({
      success: true,
      states,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('[KT] BKT user list error:', message);
    return c.json(
      {
        success: false,
        error: message,
      },
      500
    );
  }
});

export default ktRoute;
