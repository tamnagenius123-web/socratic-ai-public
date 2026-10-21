// ============================================================
// v23: Teacher Dashboard + Counterfactual Coaching API
// v23: All `any` types removed — D1 Row types applied
// ============================================================
import { Hono, type Context } from 'hono';
import type { Bindings } from '../types';
import type { WeakIndicatorRow } from '../types/d1-rows';
import { getAuthUser, requireAuth } from '../middleware/auth';

const teacherRoute = new Hono<{ Bindings: Bindings }>();
type TeacherContext = Context<{ Bindings: Bindings }>;

type OrgMembershipRow = { role: 'owner' | 'admin' | 'manager' | 'member' };
type SessionOwnerRow = { user_id: string | null };
const SUPPORTED_TREND_PERIODS = new Set(['weekly']);

function isTeacherOrAdmin(role: string | undefined): boolean {
  return role === 'admin' || role === 'instructor' || role === 'teacher';
}

async function authorizeTeacherOrg(
  c: TeacherContext,
  orgId: string,
): Promise<Response | null> {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  if (!isTeacherOrAdmin(auth.role)) {
    return c.json({ error: 'Forbidden', code: 'TEACHER_ROLE_REQUIRED' }, 403);
  }

  try {
    const membership = await c.env.DB.prepare(
      `SELECT role FROM org_memberships WHERE org_id = ?1 AND user_id = ?2`
    ).bind(orgId, auth.userId).first<OrgMembershipRow>();
    if (!membership || !['owner', 'admin', 'manager'].includes(membership.role)) {
      return c.json({ error: 'Forbidden', code: 'ORG_TEACHER_MEMBERSHIP_REQUIRED' }, 403);
    }
    return null;
  } catch (error) {
    console.error('[TEACHER_AUTHORIZATION]', error);
    return c.json({ error: 'Authorization unavailable', code: 'AUTHORIZATION_UNAVAILABLE' }, 503);
  }
}

async function authorizeSessionRead(
  c: TeacherContext,
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

    if (isTeacherOrAdmin(auth.role)) {
      // Sessions have no organization key, so instructor-to-learner access cannot be proven.
      return c.json({ error: 'Authorization relationship is not provable', code: 'AUTHORIZATION_UNGRADABLE' }, 503);
    }
    return c.json({ error: 'Forbidden', code: 'SESSION_OWNER_REQUIRED' }, 403);
  } catch (error) {
    console.error('[TEACHER_SESSION_AUTHORIZATION]', error);
    return c.json({ error: 'Authorization unavailable', code: 'AUTHORIZATION_UNAVAILABLE' }, 503);
  }
}

// GET /api/teacher/class/:orgId/progress
teacherRoute.get('/api/teacher/class/:orgId/progress', requireAuth, async (c) => {
  const orgId = c.req.param('orgId');
  const db = c.env.DB;
  if (!db) return c.json({ error: 'DB not available' }, 500);

  const denied = await authorizeTeacherOrg(c, orgId);
  if (denied) return denied;

  try {
    const classProgress = await db.prepare(`
      SELECT
        u.username, u.id as user_id,
        COUNT(DISTINCT sps.session_id) as session_count,
        AVG(sps.logical_score) as avg_logical,
        AVG(sps.data_score) as avg_data,
        AVG(sps.flexibility_score) as avg_flexibility,
        AVG(sps.communication_score) as avg_communication,
        AVG(sps.overall_score) as avg_overall,
        MAX(sps.created_at) as last_active
      FROM users u
      JOIN org_memberships om ON u.id = om.user_id AND om.org_id = ?1
      LEFT JOIN session_process_snapshots sps ON sps.session_id IN (
        SELECT s.id FROM sessions s WHERE s.user_id = u.id
      )
      GROUP BY u.id, u.username
      ORDER BY avg_overall DESC
    `).bind(orgId).all();

    const weakIndicators = await db.prepare(`
      SELECT indicator_id, AVG(normalized_score) as avg_score, COUNT(*) as sample_count
      FROM session_micro_scores
      WHERE session_id IN (
        SELECT s.id FROM sessions s
        JOIN org_memberships om ON s.user_id = om.user_id
        WHERE om.org_id = ?1
        AND s.created_at > ?2
      )
      GROUP BY indicator_id
      ORDER BY avg_score ASC
      LIMIT 5
    `).bind(orgId, Date.now() - 7 * 24 * 60 * 60 * 1000).all<WeakIndicatorRow>();

    return c.json({
      orgId,
      classProgress: classProgress.results || [],
      classWeakSpots: (weakIndicators.results || []).map((w: WeakIndicatorRow) => ({
        indicatorId: w.indicator_id,
        avgScore: w.avg_score === null ? null : Math.round(w.avg_score * 100),
        sampleCount: w.sample_count,
      })),
    });
  } catch (e) {
    console.error('[TEACHER_CLASS_PROGRESS]', e);
    return c.json({ error: 'Query failed', code: 'TEACHER_QUERY_FAILED' }, 503);
  }
});

// GET /api/teacher/trends/:orgId — 조직 시계열 트렌드
teacherRoute.get('/api/teacher/trends/:orgId', requireAuth, async (c) => {
  const orgId = c.req.param('orgId');
  const periodType = c.req.query('period') || 'weekly';
  const db = c.env.DB;
  if (!db) return c.json({ error: 'DB not available' }, 500);
  if (!SUPPORTED_TREND_PERIODS.has(periodType)) {
    return c.json({ error: 'Unsupported period', code: 'UNSUPPORTED_TREND_PERIOD' }, 400);
  }

  const denied = await authorizeTeacherOrg(c, orgId);
  if (denied) return denied;

  try {
    const trends = await db.prepare(`
      SELECT * FROM talent_trend_data
      WHERE org_id = ?1 AND period_type = ?2
      ORDER BY period_start DESC LIMIT 12
    `).bind(orgId, periodType).all();

    return c.json({ orgId, periodType, trends: trends.results || [] });
  } catch (e) {
    console.error('[TEACHER_TRENDS]', e);
    return c.json({ error: 'Query failed', code: 'TEACHER_QUERY_FAILED' }, 503);
  }
});

// GET /api/counterfactual/:sessionId — 반사실적 시뮬레이션
teacherRoute.get('/api/counterfactual/:sessionId', requireAuth, async (c) => {
  const sessionId = c.req.param('sessionId');
  const db = c.env.DB;
  if (!db) return c.json({ error: 'DB not available' }, 500);

  const denied = await authorizeSessionRead(c, sessionId);
  if (denied) return denied;

  // No causal or counterfactual model, intervention data, or calibrated effect estimate is stored.
  // Returning an arithmetic projection from observed scores would fabricate a learning outcome.
  return c.json({
    sessionId,
    status: 'UNGRADABLE',
    counterfactuals: null,
    reason: 'No evidence-backed counterfactual model is configured for this session.',
  }, 503);
});

// GET /api/teacher/process/:sessionId — 세션 과정 평가 조회
teacherRoute.get('/api/teacher/process/:sessionId', requireAuth, async (c) => {
  const sessionId = c.req.param('sessionId');
  const db = c.env.DB;
  if (!db) return c.json({ error: 'DB not available' }, 500);

  const denied = await authorizeSessionRead(c, sessionId);
  if (denied) return denied;

  try {
    const evaluation = await db.prepare(
      'SELECT * FROM session_process_evaluations WHERE session_id = ?1'
    ).bind(sessionId).first();

    const snapshots = await db.prepare(
      'SELECT * FROM session_process_snapshots WHERE session_id = ?1 ORDER BY turn_number'
    ).bind(sessionId).all();

    return c.json({
      sessionId,
      processEvaluation: evaluation || null,
      turnSnapshots: snapshots.results || [],
    });
  } catch (e) {
    console.error('[TEACHER_PROCESS_QUERY]', e);
    return c.json({ error: 'Query failed', code: 'TEACHER_PROCESS_QUERY_FAILED' }, 503);
  }
});

export { teacherRoute };
