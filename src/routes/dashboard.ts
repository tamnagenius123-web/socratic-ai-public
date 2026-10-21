import type { StudentGrowthProfileRow } from '../types/d1-rows';
// Dashboard API Routes
// Provides personal dashboard data, growth reports, and aggregate stats
// Fixes token issue: uses same JWT auth as other routes

import { Hono } from 'hono';
import type { Bindings } from '../types';
import type { WeaknessCountRow, SparringSessionPreviewRow, RadarOverTimeRow } from '../types/d1-rows';
import { requireAuth, getAuthUser } from '../middleware/auth';

const dashboardRoute = new Hono<{ Bindings: Bindings }>();

dashboardRoute.use('/api/dashboard', requireAuth);
dashboardRoute.use('/api/dashboard/*', requireAuth);

function roundedMetric(value: unknown, precision = 0): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** precision;
  return Math.round(number * factor) / factor;
}

function publicRecentSparring(row: SparringSessionPreviewRow) {
  const { has_evaluation: _internalHasEvaluation, ...publicRow } = row;
  const score = Number(row.avg_logic);
  const rating = typeof row.rating === 'string' ? row.rating.trim() : '';
  const measured = (row.has_evaluation === true || Number(row.has_evaluation) === 1)
    && rating !== '' && rating !== 'UNKNOWN'
    && Number.isFinite(score) && score >= 20 && score <= 100;
  return {
    ...publicRow,
    avg_logic: measured ? score : null,
    rating: measured ? rating : 'UNKNOWN',
    radar_scores: measured ? row.radar_scores : null,
    evaluationStatus: measured ? 'MEASURED' : 'UNKNOWN',
    radarScores: measured && row.radar_scores ? JSON.parse(row.radar_scores) : null,
  };
}

function publicRecentTraining(row: Record<string, unknown>) {
  const { has_evaluated_turn: _internalHasEvaluatedTurn, ...publicRow } = row;
  const score = typeof row.avg_score === 'number' ? row.avg_score : Number(row.avg_score);
  const rating = typeof row.rating === 'string' ? row.rating.trim() : '';
  const measured = (row.has_evaluated_turn === true || Number(row.has_evaluated_turn) === 1)
    && rating !== '' && rating !== 'UNKNOWN'
    && Number.isFinite(score) && score >= 20 && score <= 100;
  return {
    ...publicRow,
    avg_score: measured ? score : null,
    rating: measured ? rating : 'UNKNOWN',
    evaluationStatus: measured ? 'MEASURED' : 'UNKNOWN',
  };
}

// =============================================
// GET /api/dashboard - Personal dashboard data
// =============================================
dashboardRoute.get('/api/dashboard', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '로그인이 필요합니다.', code: 'AUTH_REQUIRED' }, 401);

    const db = c.env.DB;
    const { userId } = auth;

    // User info
    const user = await db.prepare(
      'SELECT id, username, email, student_id, grade, role, created_at, last_login FROM users WHERE id = ?1'
    ).bind(userId).first();

    if (!user) {
      return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
    }

    // Sparring sessions stats
    const sparringStats = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN is_abandoned = 1 THEN 1 ELSE 0 END) as abandoned,
        AVG(CASE WHEN has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN avg_logic END) as avgScore,
        AVG(CASE WHEN has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN textual_evidence_cited END) as avgEvidence,
        AVG(CASE WHEN is_completed = 1 AND has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN avg_logic END) as completedAvgScore,
        SUM(CASE WHEN is_completed = 1 AND has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN 1 ELSE 0 END) as completedScoreSampleCount,
        AVG(CASE WHEN is_completed = 1 AND has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN textual_evidence_cited END) as completedAvgEvidence,
        SUM(CASE WHEN is_completed = 1 AND has_evaluation = 1 AND rating != 'UNKNOWN' AND avg_logic BETWEEN 20 AND 100 THEN 1 ELSE 0 END) as completedEvidenceSampleCount
      FROM (
        SELECT s.*,
          EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id) AS has_evaluation
        FROM sessions s WHERE s.user_id = ?1
      ) measured_sessions
    `).bind(userId).first();

    // Training sessions stats
    const trainingStats = await db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed,
        AVG(CASE WHEN has_evaluated_turn = 1 AND rating IS NOT NULL AND rating != 'UNKNOWN' AND avg_score BETWEEN 20 AND 100 THEN avg_score END) as avgScore,
        AVG(CASE WHEN is_completed = 1 AND has_evaluated_turn = 1 AND rating IS NOT NULL AND rating != 'UNKNOWN' AND avg_score BETWEEN 20 AND 100 THEN avg_score END) as completedAvgScore,
        SUM(CASE WHEN is_completed = 1 AND has_evaluated_turn = 1 AND rating IS NOT NULL AND rating != 'UNKNOWN' AND avg_score BETWEEN 20 AND 100 THEN 1 ELSE 0 END) as completedScoreSampleCount
      FROM (
        SELECT ts.*,
          EXISTS(
            SELECT 1 FROM training_turns tt
            WHERE tt.session_id = ts.id
              AND tt.claim_clarity BETWEEN 1 AND 5
              AND tt.evidence_use BETWEEN 1 AND 5
              AND tt.reasoning_strength BETWEEN 1 AND 5
              AND tt.consistency_score BETWEEN 1 AND 5
              AND tt.relevance_score BETWEEN 1 AND 5
          ) AS has_evaluated_turn
        FROM training_sessions ts WHERE ts.user_id = ?1
      ) measured_training
    `).bind(userId).first();

    // Recent sparring sessions
    const recentSparring = await db.prepare(`
      SELECT s.id, s.book_title, s.topic, s.avg_logic, s.rating, s.current_turn, s.max_turns,
             s.is_completed, s.created_at, s.radar_scores,
             EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id) AS has_evaluation
      FROM sessions s WHERE s.user_id = ?1
      ORDER BY s.created_at DESC LIMIT 5
    `).bind(userId).all<SparringSessionPreviewRow>();

    // Recent training sessions
    const recentTraining = await db.prepare(`
      SELECT ts.id, ts.category, ts.difficulty, ts.question_title, ts.avg_score, ts.rating,
             ts.current_turn, ts.max_turns, ts.is_completed, ts.created_at,
             EXISTS(
               SELECT 1 FROM training_turns tt
               WHERE tt.session_id = ts.id
                 AND tt.claim_clarity BETWEEN 1 AND 5
                 AND tt.evidence_use BETWEEN 1 AND 5
                 AND tt.reasoning_strength BETWEEN 1 AND 5
                 AND tt.consistency_score BETWEEN 1 AND 5
                 AND tt.relevance_score BETWEEN 1 AND 5
             ) AS has_evaluated_turn
      FROM training_sessions ts WHERE ts.user_id = ?1
      ORDER BY ts.created_at DESC LIMIT 5
    `).bind(userId).all();

    // Weakness patterns (from evaluations)
    const weaknesses = await db.prepare(`
      SELECT weakness, COUNT(*) as count 
      FROM evaluations 
      WHERE user_id = ?1 AND weakness IS NOT NULL AND weakness != ''
      GROUP BY weakness ORDER BY count DESC LIMIT 5
    `).bind(userId).all<WeaknessCountRow>();

    // Score progression (last 10 sessions)
    const progression = await db.prepare(`
      SELECT s.avg_logic, s.rating, s.created_at
      FROM sessions s WHERE s.user_id = ?1 AND s.is_completed = 1
        AND EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id)
        AND s.rating != 'UNKNOWN' AND s.avg_logic BETWEEN 20 AND 100
      ORDER BY s.created_at DESC LIMIT 10
    `).bind(userId).all();

    const prescriptions = (weaknesses.results || []).map((w: WeaknessCountRow) => ({
      pattern: w.weakness,
      count: w.count,
      prescription: buildWeaknessPrescription(w.weakness),
    }));

    return c.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        studentId: user.student_id,
        grade: user.grade,
        role: user.role,
        createdAt: user.created_at,
      },
      sparring: {
        total: sparringStats?.total || 0,
        completed: sparringStats?.completed || 0,
        abandoned: sparringStats?.abandoned || 0,
        avgScore: roundedMetric(sparringStats?.avgScore),
        avgEvidence: roundedMetric(sparringStats?.avgEvidence, 1),
        completedAvgScore: roundedMetric(sparringStats?.completedAvgScore),
        completedScoreSampleCount: Number(sparringStats?.completedScoreSampleCount || 0),
        completedAvgEvidence: roundedMetric(sparringStats?.completedAvgEvidence, 1),
        completedEvidenceSampleCount: Number(sparringStats?.completedEvidenceSampleCount || 0),
        completionRate: sparringStats?.total
          ? Math.round(((sparringStats.completed as number) / (sparringStats.total as number)) * 100)
          : 0,
        recentSessions: (recentSparring.results || []).map(publicRecentSparring),
      },
      training: {
        total: trainingStats?.total || 0,
        completed: trainingStats?.completed || 0,
        avgScore: roundedMetric(trainingStats?.avgScore),
        completedAvgScore: roundedMetric(trainingStats?.completedAvgScore),
        completedScoreSampleCount: Number(trainingStats?.completedScoreSampleCount || 0),
        recentSessions: (recentTraining.results || []).map((row) => publicRecentTraining(row as Record<string, unknown>)),
      },
      weaknesses: (weaknesses.results || []).map((w: WeaknessCountRow) => ({
        pattern: w.weakness,
        count: w.count,
      })),
      prescriptions,
      progression: (progression.results || []).reverse(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Dashboard error:', error);
    return c.json({ error: '대시보드 데이터 로딩 실패', details: message }, 500);
  }
});

// =============================================
// GET /api/dashboard/growth-report - Growth report
// =============================================
dashboardRoute.get('/api/dashboard/growth-report', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '로그인이 필요합니다.' }, 401);

    const db = c.env.DB;
    const { userId } = auth;

    // Get all completed session reports
    const reports = await db.prepare(`
      SELECT sr.*, s.book_title, s.topic
      FROM session_reports sr
      JOIN sessions s ON sr.session_id = s.id
      WHERE sr.user_id = ?1
        AND EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id)
      ORDER BY sr.created_at DESC LIMIT 10
    `).bind(userId).all();

    // Aggregate radar scores over time
    const radarOverTime = await db.prepare(`
      SELECT s.avg_logic, s.radar_scores, s.created_at
      FROM sessions s
      WHERE s.user_id = ?1 AND s.is_completed = 1
        AND EXISTS(SELECT 1 FROM evaluations e WHERE e.session_id = s.id)
        AND s.rating != 'UNKNOWN' AND s.avg_logic BETWEEN 20 AND 100
      ORDER BY s.created_at ASC
    `).bind(userId).all<RadarOverTimeRow>();

    return c.json({
      reports: reports.results || [],
      radarOverTime: (radarOverTime.results || []).map((r: RadarOverTimeRow) => ({
        avgLogic: r.avg_logic,
        radarScores: r.radar_scores ? JSON.parse(r.radar_scores) : null,
        createdAt: r.created_at,
      })),
    });
  } catch (error: unknown) {
    console.error('Growth report error:', error);
    return c.json({ error: '성장 리포트 로딩 실패' }, 500);
  }
});

// =============================================
// PATCH-008: Task 5 — Personal token usage chart + header token bar APIs
// =============================================
dashboardRoute.get('/api/dashboard/my-token-usage', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '로그인 필요' }, 401);

    const db = c.env.DB;
    const days = Number(c.req.query('days') || '30');
    const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    const result = await db.prepare(`
      SELECT date,
        SUM(total_tokens) as tokens,
        SUM(total_estimated_credits) as credits,
        SUM(total_calls) as calls
      FROM token_usage_daily
      WHERE user_id = ?1 AND date >= ?2
      GROUP BY date
      ORDER BY date ASC
    `).bind(auth.userId, cutoffDate).all();

    const limits: Record<string, number> = { student: 500000, instructor: 2000000, admin: Infinity };
    const role = auth.role || 'student';

    return c.json({
      dailyUsage: result.results || [],
      dailyLimit: limits[role] || 500000,
      role,
    });
  } catch (e: unknown) {
    console.warn('[MY_TOKEN_USAGE] Error:', e);
    return c.json({ dailyUsage: [], dailyLimit: 500000, role: 'student' });
  }
});

dashboardRoute.get('/api/dashboard/today-usage', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ tokens: 0, limit: 500000, percentage: 0, isNearLimit: false });

    const db = c.env.DB;
    const today = new Date().toISOString().split('T')[0];

    const result = await db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) as tokens
      FROM token_usage_daily
      WHERE user_id = ?1 AND date = ?2
    `).bind(auth.userId, today).first<{ tokens: number }>();

    const limits: Record<string, number> = { student: 500000, instructor: 2000000, admin: Infinity };
    const role = auth.role || 'student';
    const limit = limits[role] || 500000;
    const tokens = result?.tokens || 0;

    return c.json({
      tokens,
      limit,
      percentage: limit === Infinity ? 0 : Math.round(tokens / limit * 100),
      isNearLimit: limit !== Infinity && tokens > limit * 0.8,
    });
  } catch (e: unknown) {
    console.warn('[TODAY_USAGE] Error:', e);
    return c.json({ tokens: 0, limit: 500000, percentage: 0, isNearLimit: false });
  }
});

// =============================================
// GET /api/dashboard/growth-profile — Growth profile with ELO + milestones
// =============================================
dashboardRoute.get('/api/dashboard/growth-profile', async (c) => {
  try {
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '로그인 필요' }, 401);

    const db = c.env.DB;

    const profile = await db.prepare(
      'SELECT * FROM student_growth_profile WHERE user_id = ?1'
    ).bind(auth.userId).first<StudentGrowthProfileRow>();

    const milestones = await db.prepare(
      'SELECT milestone_type, achieved_at, details FROM growth_milestones WHERE user_id = ?1 ORDER BY achieved_at DESC'
    ).bind(auth.userId).all();

    if (!profile) {
      return c.json({ profile: null, milestones: [] });
    }

    return c.json({
      profile: {
        totalSessions: profile.total_sessions,
        totalTurns: profile.total_turns,
        elo: {
          evidence: profile.elo_evidence,
          reasoning: profile.elo_reasoning,
          defense: profile.elo_defense,
          clarity: profile.elo_clarity,
          consistency: profile.elo_consistency,
        },
        thoughtProfile: JSON.parse(profile.thought_profile_json || '{}'),
        chronicWeaknesses: JSON.parse(profile.chronic_weaknesses || '[]'),
        recentSessionScores: JSON.parse(profile.recent_session_scores || '[]'),
        updatedAt: profile.updated_at,
      },
      milestones: milestones.results || [],
    });
  } catch (e: unknown) {
    console.warn('[GROWTH_PROFILE] Error:', e);
    return c.json({ profile: null, milestones: [] });
  }
});

function buildWeaknessPrescription(pattern: string): string {
  if (pattern.includes('근거')) return '다음 3턴 동안 답변마다 텍스트 인용 1개 이상을 포함하세요.';
  if (pattern.includes('추론') || pattern.includes('비약')) return '주장 → 근거 → 연결 이유 3문장 구조로 재작성하세요.';
  if (pattern.includes('모순')) return '기존 주장과 충돌하는 문장을 찾아 수정 근거를 함께 제시하세요.';
  if (pattern.includes('질문 이탈')) return '질문의 핵심 쟁점을 한 문장으로 먼저 요약한 뒤 답변하세요.';
  return '답변 전 20초 점검: 핵심 주장/근거/연결 이유가 모두 있는지 확인하세요.';
}

export default dashboardRoute;
