// ============================================================
// v31: Enterprise HRD Dashboard Routes
// ============================================================
// DeepSkill B2B mirror — organizational critical thinking analytics
// Team-level radar charts, Hi-Po identification, ROI metrics
// ============================================================

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, requireRole, getAuthUser } from '../middleware/auth';

export const enterpriseRoute = new Hono<{ Bindings: Bindings }>();

// GET /api/enterprise/fidelity-public — PUBLIC (before auth middleware)
// A parity score is not emitted until a fixed rubric and production evidence lifecycle
// exist. Returning 503 prevents architecture-presence flags from masquerading as results.
enterpriseRoute.get('/api/enterprise/fidelity-public', async (c) => {
  return c.json({
    status: 'UNGRADABLE',
    fidelity: null,
    version: '35.0.0',
    reason: 'A fixed production rubric and independently verified evidence set are not yet available.',
  }, 503);
});

enterpriseRoute.use('/api/enterprise/*', requireAuth);

// Enterprise is a SocraticAI administrator surface until an organization-scoped
// HRD Program UI is available.
// The legacy Enterprise views are global, not organization-scoped. Keep them
// restricted to the SocraticAI administrator until the HRD Program UI supplies
// and verifies an explicit org/program scope for an instructor operator.
enterpriseRoute.use('/api/enterprise/dashboard', requireRole('admin'));
enterpriseRoute.use('/api/enterprise/team-radar', requireRole('admin'));
enterpriseRoute.use('/api/enterprise/roi', requireRole('admin'));
enterpriseRoute.use('/api/enterprise/fidelity', requireRole('admin'));

// GET /api/enterprise/dashboard — legacy global analytics dashboard
enterpriseRoute.get('/api/enterprise/dashboard', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  try {
    // Aggregate user statistics
    const userStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(DISTINCT u.id) as total_users,
        COUNT(DISTINCT s.id) as total_sessions,
        AVG(CAST(s.avg_logic AS REAL)) as avg_logic,
        MAX(CAST(s.avg_logic AS REAL)) as max_logic,
        COUNT(DISTINCT CASE WHEN s.created_at > ?1 THEN s.user_id END) as active_users_30d
      FROM users u
      LEFT JOIN sessions s ON u.id = s.user_id
    `).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).first<Record<string, unknown>>();

    // Top performers
    const topPerformers = await c.env.DB.prepare(`
      SELECT u.username, u.email, 
        COUNT(s.id) as session_count,
        AVG(CAST(s.avg_logic AS REAL)) as avg_score,
        MAX(CAST(s.avg_logic AS REAL)) as best_score
      FROM users u
      JOIN sessions s ON u.id = s.user_id
      GROUP BY u.id
      HAVING session_count > 0
      ORDER BY avg_score DESC
      LIMIT 10
    `).all();

    // Growth trend (last 30 days)
    const growthTrend = await c.env.DB.prepare(`
      SELECT 
        DATE(created_at / 1000, 'unixepoch') as date,
        COUNT(*) as sessions,
        AVG(CAST(avg_logic AS REAL)) as avg_score
      FROM sessions
      WHERE created_at > ?1
      GROUP BY date
      ORDER BY date ASC
    `).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).all();

    // 4-axis competency distribution. The authoritative v18 table stores
    // normalized columns; the historical process_evaluations JSON table never
    // existed in the deployed schema.
    const competencyDist = await c.env.DB.prepare(`
      SELECT 
        AVG(logical_progression_rate) as avg_logical,
        AVG(revision_quality_index) as avg_revision,
        AVG(pressure_response_score) as avg_pressure,
        AVG(metacognition_activation_rate) as avg_metacog
      FROM session_process_evaluations
      WHERE created_at > ?1
    `).bind(Date.now() - 90 * 24 * 60 * 60 * 1000).first<Record<string, unknown>>();

    return c.json({
      overview: userStats || {},
      topPerformers: topPerformers?.results || [],
      growthTrend: growthTrend?.results || [],
      competencyDistribution: competencyDist || {},
      dashboardType: 'enterprise_hrd',
      generatedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('[Enterprise] Dashboard unavailable:', error);
    return c.json({
      status: 'UNAVAILABLE',
      code: 'ENTERPRISE_DASHBOARD_UNAVAILABLE',
      error: 'Organization analytics are temporarily unavailable.',
      retryable: true,
    }, 503);
  }
});

// GET /api/enterprise/team-radar — Team-level radar chart data
enterpriseRoute.get('/api/enterprise/team-radar', async (c) => {
  try {
    const teamScores = await c.env.DB.prepare(`
      SELECT 
        u.grade,
        AVG(CAST(s.avg_logic AS REAL)) as avg_logic,
        COUNT(DISTINCT s.id) as session_count,
        COUNT(DISTINCT u.id) as member_count
      FROM users u
      JOIN sessions s ON u.id = s.user_id
      WHERE u.grade IS NOT NULL
      GROUP BY u.grade
      ORDER BY u.grade
    `).all();

    return c.json({ teamScores: teamScores?.results || [] });
  } catch (error: unknown) {
    console.error('[Enterprise] Team radar unavailable:', error);
    return c.json({
      status: 'UNAVAILABLE',
      code: 'ENTERPRISE_TEAM_RADAR_UNAVAILABLE',
      error: 'Team analytics are temporarily unavailable.',
      retryable: true,
    }, 503);
  }
});

// GET /api/enterprise/roi — ROI metrics (DeepSkill-style)
enterpriseRoute.get('/api/enterprise/roi', async (c) => {
  try {
    // Before/After comparison (first vs latest session per user)
    const roiData = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.username,
        first_s.avg_logic as first_score,
        last_s.avg_logic as latest_score,
        CAST(last_s.avg_logic AS REAL) - CAST(first_s.avg_logic AS REAL) as improvement
      FROM users u
      JOIN (
        SELECT user_id, avg_logic, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC) as rn
        FROM sessions WHERE avg_logic IS NOT NULL
      ) first_s ON u.id = first_s.user_id AND first_s.rn = 1
      JOIN (
        SELECT user_id, avg_logic, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
        FROM sessions WHERE avg_logic IS NOT NULL
      ) last_s ON u.id = last_s.user_id AND last_s.rn = 1
      WHERE CAST(last_s.avg_logic AS REAL) - CAST(first_s.avg_logic AS REAL) != 0
      ORDER BY improvement DESC
      LIMIT 20
    `).all();

    const improvements = (roiData?.results || []) as Record<string, unknown>[];
    const avgImprovement = improvements.length > 0
      ? improvements.reduce((sum, r) => sum + ((r.improvement as number) || 0), 0) / improvements.length
      : null;

    return c.json({
      roi: {
        avgImprovement: avgImprovement === null ? null : Math.round(avgImprovement * 100) / 100,
        totalParticipants: improvements.length,
        improvedCount: improvements.filter(r => ((r.improvement as number) || 0) > 0).length,
        topImprovement: improvements[0] || null,
      },
      details: improvements,
      _note: 'DeepSkill-style ROI: 의사결정 점수 변화 추적',
    });
  } catch (error: unknown) {
    console.error('[Enterprise] ROI unavailable:', error);
    return c.json({
      status: 'UNAVAILABLE',
      code: 'ENTERPRISE_ROI_UNAVAILABLE',
      error: 'ROI analytics are temporarily unavailable.',
      retryable: true,
    }, 503);
  }
});

// GET /api/enterprise/fidelity — DeepSkill Fidelity Score (authenticated)
// See the public endpoint above. Authentication does not make unverified evidence gradable.
enterpriseRoute.get('/api/enterprise/fidelity', async (c) => {
  return c.json({
    status: 'UNGRADABLE',
    fidelity: null,
    version: '35.0.0',
    reason: 'A fixed production rubric and independently verified evidence set are not yet available.',
  }, 503);
});
