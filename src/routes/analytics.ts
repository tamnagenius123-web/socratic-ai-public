import { readSparringLearningEvidenceMetrics } from '../services/learning-evidence-metrics';
// Analytics API Routes - Dashboard data, statistics, reports
import { Hono } from 'hono';
import type { Bindings, RadarScores } from '../types';
import type { AttritionRangeRow, RecentSessionRow, WeaknessPatternSessionRow, ProgressEvalRow, CompletionByBookRow, CompletionByUserRow, AttritionByTurnRow, AtRiskUserRow, PhaseAttritionRow, PerformanceRankingRow, TopPerformerRow, DiversitySessionRow, EvalDetailRow, RadarAveragesRow } from '../types/d1-rows';
import { requireAuth, getAuthUser } from '../middleware/auth';

const analyticsRoute = new Hono<{ Bindings: Bindings }>();

analyticsRoute.use('/api/analytics/*', requireAuth);

// GET /api/analytics/overview - Overall statistics (admin only)
analyticsRoute.get('/api/analytics/overview', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  // Total users
  const usersCount = await db.prepare("SELECT COUNT(*) as cnt FROM users WHERE is_active = 1").first<{ cnt: number }>();
  const activeUsersResult = await db.prepare("SELECT COUNT(DISTINCT user_id) as cnt FROM sessions WHERE user_id IS NOT NULL AND created_at > ?1").bind(Date.now() - 7 * 24 * 3600 * 1000).first<{ cnt: number }>();

  // Session stats
  const totalSessions = await db.prepare("SELECT COUNT(*) as cnt FROM sessions").first<{ cnt: number }>();
  const completedSessions = await db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE is_completed = 1").first<{ cnt: number }>();
  const abandonedSessions = await db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE is_abandoned = 1").first<{ cnt: number }>();

  // Avg logic
  const avgLogicResult = await db.prepare("SELECT AVG(avg_logic) as avg FROM sessions WHERE is_completed = 1").first<{ avg: number }>();

  // Avg completion turn
  const avgTurnResult = await db.prepare("SELECT AVG(current_turn - 1) as avg FROM sessions WHERE is_completed = 1").first<{ avg: number }>();

  // Attrition points (abandoned sessions grouped by turn)
  const attritionResult = await db.prepare(`
    SELECT 
      CASE 
        WHEN abandoned_turn <= 3 THEN 'turn_1_3'
        WHEN abandoned_turn <= 5 THEN 'turn_4_5'
        WHEN abandoned_turn <= 7 THEN 'turn_6_7'
        WHEN abandoned_turn <= 9 THEN 'turn_8_9'
        ELSE 'turn_10'
      END as range,
      COUNT(*) as cnt
    FROM sessions 
    WHERE is_abandoned = 1 AND abandoned_turn IS NOT NULL
    GROUP BY range
  `).all<AttritionRangeRow>();

  const attritionPoints: Record<string, number> = {};
  (attritionResult.results || []).forEach((r: AttritionRangeRow) => {
    attritionPoints[r.range] = r.cnt;
  });

  // Weekly activity (last 7 days)
  const weeklyActivity: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setDate(dayStart.getDate() - i);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const dayKey = dayStart.toISOString().split('T')[0];
    const dayCount = await db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE created_at >= ?1 AND created_at <= ?2"
    ).bind(dayStart.getTime(), dayEnd.getTime()).first<{ cnt: number }>();
    weeklyActivity[dayKey] = dayCount?.cnt || 0;
  }

  const evidenceFailResult = await db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN evidence_found = 0 THEN 1 ELSE 0 END) as fail
    FROM evaluations
  `).first<{ total: number; fail: number }>();

  const consistencyFailResult = await db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN consistency_score < 50 THEN 1 ELSE 0 END) as fail
    FROM evaluations
  `).first<{ total: number; fail: number }>();

  const avgDropoffResult = await db.prepare(
    'SELECT AVG(dropoff_turn) as avg FROM sessions WHERE is_abandoned = 1 AND dropoff_turn IS NOT NULL'
  ).first<{ avg: number }>();

  const learningEvidence = await readSparringLearningEvidenceMetrics(db);

  const weaknessRows = await db.prepare(
    'SELECT weakness_tags_history, weakness_pattern, last_failure_reason FROM sessions ORDER BY created_at DESC LIMIT 200'
  ).all();
  const weaknessCount = new Map<string, number>();
  for (const row of (weaknessRows.results || []) as Array<Record<string, string | null>>) {
    for (const key of ['weakness_tags_history', 'weakness_pattern'] as const) {
      try {
        const arr = JSON.parse(row[key] || '[]');
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          const pattern = String(item || '').trim();
          if (!pattern) continue;
          weaknessCount.set(pattern, (weaknessCount.get(pattern) || 0) + 1);
        }
      } catch (e) { console.error("[P1-004] Caught:", e);
        // ignore broken legacy rows
      }
    }
  }
  const topWeaknesses = Array.from(weaknessCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));

  const failureReasonCount = new Map<string, number>();
  for (const row of (weaknessRows.results || []) as Array<Record<string, string | null>>) {
    const reason = String(row.last_failure_reason || '').trim();
    if (!reason) continue;
    failureReasonCount.set(reason, (failureReasonCount.get(reason) || 0) + 1);
  }
  const failureReasons = Array.from(failureReasonCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  const total = totalSessions?.cnt || 0;
  const completed = completedSessions?.cnt || 0;
  const evidenceTotal = evidenceFailResult?.total || 0;
  const consistencyTotal = consistencyFailResult?.total || 0;


  return c.json({
    totalUsers: usersCount?.cnt || 0,
    activeUsers: activeUsersResult?.cnt || 0,
    totalSessions: total,
    completedSessions: completed,
    abandonedSessions: abandonedSessions?.cnt || 0,
    completionRate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
    avgCompletionTurn: Math.round((avgTurnResult?.avg || 0) * 10) / 10,
    avgLogicScore: Math.round((avgLogicResult?.avg || 0) * 10) / 10,
    attritionPoints,
    weeklyActivity,
    opsMetrics: {
      avgDropoffTurn: Math.round((avgDropoffResult?.avg || 0) * 10) / 10,
      evidenceFailRate: evidenceTotal > 0 ? Math.round(((evidenceFailResult?.fail || 0) / evidenceTotal) * 1000) / 10 : 0,
      consistencyFailRate: consistencyTotal > 0 ? Math.round(((consistencyFailResult?.fail || 0) / consistencyTotal) * 1000) / 10 : 0,
      hintSuccessRate: null,
      hintEfficacyStatus: 'UNKNOWN',
      learningEvidence,
      topWeaknesses,
      failureReasons,
    },
  });
});

// GET /api/analytics/users/:id/stats - Individual user stats
analyticsRoute.get('/api/analytics/users/:id/stats', async (c) => {
  const requestedId = c.req.param('id');
  const auth = getAuthUser(c);
  const currentUserId = auth?.userId;
  const currentRole = auth?.role;

  // Allow access only if admin or self
  if (currentRole !== 'admin' && currentRole !== 'instructor' && currentUserId !== requestedId) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const db = c.env.DB;

  // Get user info
  const userRow = await db.prepare('SELECT id, username, student_id, grade, role FROM users WHERE id = ?1').bind(requestedId).first();
  if (!userRow) return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);

  // Session counts
  const totalResult = await db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?1").bind(requestedId).first<{ cnt: number }>();
  const completedResult = await db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?1 AND is_completed = 1").bind(requestedId).first<{ cnt: number }>();
  const abandonedResult = await db.prepare("SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?1 AND is_abandoned = 1").bind(requestedId).first<{ cnt: number }>();

  // Average radar scores from completed sessions
  const radarResult = await db.prepare(`
    SELECT AVG(defense_score) as defense, AVG(consistency_score) as consistency,
           AVG(evidence_score) as evidence, AVG(relevance_score) as relevance,
           AVG(clarity_score) as clarity
    FROM evaluations WHERE user_id = ?1
  `).bind(requestedId).first<RadarAveragesRow>();

  const avgRadar: RadarScores = {
    defense: Math.round(radarResult?.defense || 0),
    consistency: Math.round(radarResult?.consistency || 0),
    evidence: Math.round(radarResult?.evidence || 0),
    relevance: Math.round(radarResult?.relevance || 0),
    clarity: Math.round(radarResult?.clarity || 0),
  };

  const avgScore = Math.round((avgRadar.defense + avgRadar.consistency + avgRadar.evidence + avgRadar.relevance + avgRadar.clarity) / 5);

  // Recent sessions
  const recentResult = await db.prepare(`
    SELECT id, book_title, created_at, is_completed, current_turn, avg_logic
    FROM sessions WHERE user_id = ?1
    ORDER BY created_at DESC LIMIT 10
  `).bind(requestedId).all<RecentSessionRow>();

  const recentSessions = (recentResult.results || []).map((r: RecentSessionRow) => ({
    id: r.id,
    book: r.book_title,
    startedAt: r.created_at,
    completed: !!r.is_completed,
    turns: r.current_turn - 1,
    avgScore: r.avg_logic,
  }));

  // Weakness patterns from sessions
  const weaknessResult = await db.prepare(`
    SELECT weakness_pattern FROM sessions WHERE user_id = ?1 AND weakness_pattern != '[]'
    ORDER BY created_at DESC LIMIT 10
  `).bind(requestedId).all<WeaknessPatternSessionRow>();

  const allWeaknesses: string[] = [];
  (weaknessResult.results || []).forEach((r: WeaknessPatternSessionRow) => {
    try {
      const patterns = JSON.parse(r.weakness_pattern);
      allWeaknesses.push(...patterns);
    } catch (e) { console.error("[P1-004] Caught:", e); }
  });

  // Group classification
  const total = totalResult?.cnt || 0;
  const completed = completedResult?.cnt || 0;
  const completionRate = total > 0 ? (completed / total) * 100 : 0;
  let group = 'E';
  if (completionRate >= 100 && avgScore >= 80) group = 'A';
  else if (completionRate >= 80 && avgScore >= 70) group = 'B';
  else if (completionRate >= 50 && avgScore >= 60) group = 'C';
  else if (completionRate >= 30 && avgScore >= 50) group = 'D';

  // Identify improvements (axes with increasing trend)
  const improvements: string[] = [];
  const weaknesses: string[] = [];
  const axisNames: Record<string, string> = { defense: '논증력', consistency: '일관성', evidence: '근거 활용', relevance: '관련성', clarity: '명확성' };
  for (const [key, name] of Object.entries(axisNames)) {
    const score = avgRadar[key as keyof RadarScores];
    if (score >= 60) improvements.push(name);
    else weaknesses.push(name);
  }

  return c.json({
    userId: userRow.id,
    username: userRow.username,
    studentId: userRow.student_id,
    totalSessions: total,
    completedSessions: completed,
    abandonedSessions: abandonedResult?.cnt || 0,
    completionRate: Math.round(completionRate * 10) / 10,
    avgScore,
    radarScores: avgRadar,
    recentSessions,
    weaknesses: weaknesses.length > 0 ? weaknesses : [...new Set(allWeaknesses)].slice(0, 3),
    improvements,
    group,
  });
});

// GET /api/analytics/users/:id/progress - Progress over time
analyticsRoute.get('/api/analytics/users/:id/progress', async (c) => {
  const requestedId = c.req.param('id');
  const auth = getAuthUser(c);
  const currentUserId = auth?.userId;
  const currentRole = auth?.role;

  if (currentRole !== 'admin' && currentRole !== 'instructor' && currentUserId !== requestedId) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  const db = c.env.DB;

  // Get all evaluations for the user, ordered by time
  const evalResult = await db.prepare(`
    SELECT e.session_id, e.turn, e.defense_score, e.consistency_score, 
           e.evidence_score, e.relevance_score, e.clarity_score, e.avg_score, e.created_at,
           s.topic, s.book_title
    FROM evaluations e
    JOIN sessions s ON e.session_id = s.id
    WHERE e.user_id = ?1
    ORDER BY e.created_at ASC
  `).bind(requestedId).all<ProgressEvalRow>();

  const progress = (evalResult.results || []).map((r: ProgressEvalRow) => ({
    sessionId: r.session_id,
    turn: r.turn,
    topic: r.topic,
    book: r.book_title,
    defense: r.defense_score,
    consistency: r.consistency_score,
    evidence: r.evidence_score,
    relevance: r.relevance_score,
    clarity: r.clarity_score,
    avg: r.avg_score,
    timestamp: r.created_at,
  }));

  return c.json({ progress });
});

// GET /api/analytics/completion-rate - Completion rate analysis (admin)
analyticsRoute.get('/api/analytics/completion-rate', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  // By book
  const byBookResult = await db.prepare(`
    SELECT book_title, 
           COUNT(*) as total,
           SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed
    FROM sessions
    GROUP BY book_title
  `).all<CompletionByBookRow>();

  const byBook = (byBookResult.results || []).map((r: CompletionByBookRow) => ({
    book: r.book_title,
    total: r.total,
    completed: r.completed,
    rate: r.total > 0 ? Math.round((r.completed / r.total) * 1000) / 10 : 0,
  }));

  // By user (top 20)
  const byUserResult = await db.prepare(`
    SELECT s.user_id, u.username, u.student_id,
           COUNT(*) as total,
           SUM(CASE WHEN s.is_completed = 1 THEN 1 ELSE 0 END) as completed
    FROM sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id IS NOT NULL
    GROUP BY s.user_id
    ORDER BY total DESC
    LIMIT 20
  `).all<CompletionByUserRow>();

  const byUser = (byUserResult.results || []).map((r: CompletionByUserRow) => ({
    userId: r.user_id,
    username: r.username || '미확인',
    studentId: r.student_id,
    total: r.total,
    completed: r.completed,
    rate: r.total > 0 ? Math.round((r.completed / r.total) * 1000) / 10 : 0,
  }));

  return c.json({ byBook, byUser });
});

// GET /api/analytics/attrition-analysis - Attrition analysis (admin)
analyticsRoute.get('/api/analytics/attrition-analysis', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  // Attrition by turn
  const byTurnResult = await db.prepare(`
    SELECT abandoned_turn, COUNT(*) as cnt 
    FROM sessions 
    WHERE is_abandoned = 1 AND abandoned_turn IS NOT NULL
    GROUP BY abandoned_turn
    ORDER BY abandoned_turn
  `).all<AttritionByTurnRow>();

  const byTurn = (byTurnResult.results || []).map((r: AttritionByTurnRow) => ({
    turn: r.abandoned_turn,
    count: r.cnt,
  }));

  // At-risk users (3+ abandoned sessions)
  const atRiskResult = await db.prepare(`
    SELECT s.user_id, u.username, u.student_id, COUNT(*) as abandoned_count
    FROM sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.is_abandoned = 1 AND s.user_id IS NOT NULL
    GROUP BY s.user_id
    HAVING abandoned_count >= 2
    ORDER BY abandoned_count DESC
  `).all<AtRiskUserRow>();

  const atRiskUsers = (atRiskResult.results || []).map((r: AtRiskUserRow) => ({
    userId: r.user_id,
    username: r.username || '미확인',
    studentId: r.student_id,
    abandonedCount: r.abandoned_count,
  }));

  // Attrition by phase
  const byPhaseResult = await db.prepare(`
    SELECT current_phase, COUNT(*) as cnt
    FROM sessions
    WHERE is_abandoned = 1
    GROUP BY current_phase
  `).all<PhaseAttritionRow>();

  const byPhase = (byPhaseResult.results || []).map((r: PhaseAttritionRow) => ({
    phase: r.current_phase,
    count: r.cnt,
  }));

  return c.json({ byTurn, atRiskUsers, byPhase });
});

// GET /api/analytics/performance-ranking - Performance ranking (admin)
analyticsRoute.get('/api/analytics/performance-ranking', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT s.user_id, u.username, u.student_id, u.grade,
           COUNT(*) as total_sessions,
           SUM(CASE WHEN s.is_completed = 1 THEN 1 ELSE 0 END) as completed_sessions,
           ROUND(AVG(s.avg_logic), 1) as avg_logic,
           MAX(s.avg_logic) as best_logic,
           SUM(s.textual_evidence_cited) as total_evidence
    FROM sessions s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id IS NOT NULL
    GROUP BY s.user_id
    ORDER BY avg_logic DESC
    LIMIT 30
  `).all<PerformanceRankingRow>();

  const rankings = (result.results || []).map((r: PerformanceRankingRow, idx: number) => ({
    rank: idx + 1,
    userId: r.user_id,
    username: r.username || '미확인',
    studentId: r.student_id,
    grade: r.grade,
    totalSessions: r.total_sessions,
    completedSessions: r.completed_sessions,
    avgLogic: r.avg_logic,
    bestLogic: r.best_logic,
    totalEvidence: r.total_evidence,
    completionRate: r.total_sessions > 0 ? Math.round((r.completed_sessions / r.total_sessions) * 1000) / 10 : 0,
  }));

  return c.json({ rankings });
});

// GET /api/analytics/export - Export data as JSON (admin)
analyticsRoute.get('/api/analytics/export', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  // Export users
  const users = await db.prepare('SELECT id, username, email, student_id, grade, role, created_at, last_login, is_active FROM users').all();

  // Export sessions
  const sessions = await db.prepare('SELECT id, user_id, book_title, topic, created_at, current_turn, max_turns, avg_logic, rating, is_completed, is_abandoned, abandoned_turn FROM sessions ORDER BY created_at DESC LIMIT 500').all();

  // Export evaluations
  const evaluations = await db.prepare('SELECT session_id, user_id, turn, defense_score, consistency_score, evidence_score, relevance_score, clarity_score, avg_score, created_at FROM evaluations ORDER BY created_at DESC LIMIT 2000').all();

  return c.json({
    exportedAt: new Date().toISOString(),
    users: users.results || [],
    sessions: sessions.results || [],
    evaluations: evaluations.results || [],
  });
});

// GET /api/analytics/weekly-report - Auto-generated weekly operations report (admin)
analyticsRoute.get('/api/analytics/weekly-report', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 3600 * 1000;
  const twoWeeksAgo = now - 14 * 24 * 3600 * 1000;

  // This week vs last week comparison
  const thisWeekSessions = await db.prepare(
    'SELECT COUNT(*) as cnt FROM sessions WHERE created_at >= ?1'
  ).bind(oneWeekAgo).first<{ cnt: number }>();

  const lastWeekSessions = await db.prepare(
    'SELECT COUNT(*) as cnt FROM sessions WHERE created_at >= ?1 AND created_at < ?2'
  ).bind(twoWeeksAgo, oneWeekAgo).first<{ cnt: number }>();

  const thisWeekCompleted = await db.prepare(
    'SELECT COUNT(*) as cnt FROM sessions WHERE is_completed = 1 AND ended_at >= ?1'
  ).bind(oneWeekAgo).first<{ cnt: number }>();

  const thisWeekAbandoned = await db.prepare(
    'SELECT COUNT(*) as cnt FROM sessions WHERE is_abandoned = 1 AND abandoned_at >= ?1'
  ).bind(oneWeekAgo).first<{ cnt: number }>();

  const thisWeekAvgLogic = await db.prepare(
    'SELECT AVG(avg_logic) as avg FROM sessions WHERE is_completed = 1 AND ended_at >= ?1'
  ).bind(oneWeekAgo).first<{ avg: number }>();

  const lastWeekAvgLogic = await db.prepare(
    'SELECT AVG(avg_logic) as avg FROM sessions WHERE is_completed = 1 AND ended_at >= ?1 AND ended_at < ?2'
  ).bind(twoWeeksAgo, oneWeekAgo).first<{ avg: number }>();

  const thisWeekUsers = await db.prepare(
    'SELECT COUNT(DISTINCT user_id) as cnt FROM sessions WHERE user_id IS NOT NULL AND created_at >= ?1'
  ).bind(oneWeekAgo).first<{ cnt: number }>();

  // Top performers this week
  const topPerformers = await db.prepare(`
    SELECT s.user_id, u.username, ROUND(AVG(s.avg_logic), 1) as avg_logic, COUNT(*) as sessions
    FROM sessions s LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id IS NOT NULL AND s.is_completed = 1 AND s.ended_at >= ?1
    GROUP BY s.user_id ORDER BY avg_logic DESC LIMIT 5
  `).bind(oneWeekAgo).all<TopPerformerRow>();

  // Evidence improvement this week
  const thisWeekEvidence = await db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN evidence_found = 1 THEN 1 ELSE 0 END) as found
    FROM evaluations WHERE created_at >= ?1
  `).bind(oneWeekAgo).first<{ total: number; found: number }>();

  const thisTotal = thisWeekSessions?.cnt || 0;
  const lastTotal = lastWeekSessions?.cnt || 0;
  const sessionGrowth = lastTotal > 0 ? Math.round(((thisTotal - lastTotal) / lastTotal) * 100) : 0;
  const logicImprovement = Math.round(((thisWeekAvgLogic?.avg || 0) - (lastWeekAvgLogic?.avg || 0)) * 10) / 10;

  return c.json({
    reportPeriod: {
      from: new Date(oneWeekAgo).toISOString().split('T')[0],
      to: new Date(now).toISOString().split('T')[0],
    },
    summary: {
      totalSessions: thisTotal,
      completedSessions: thisWeekCompleted?.cnt || 0,
      abandonedSessions: thisWeekAbandoned?.cnt || 0,
      activeUsers: thisWeekUsers?.cnt || 0,
      avgLogicScore: Math.round((thisWeekAvgLogic?.avg || 0) * 10) / 10,
      evidenceRate: (thisWeekEvidence?.total || 0) > 0
        ? Math.round(((thisWeekEvidence?.found || 0) / (thisWeekEvidence?.total || 1)) * 100)
        : 0,
    },
    comparison: {
      sessionGrowthPercent: sessionGrowth,
      logicScoreChange: logicImprovement,
      previousWeekSessions: lastTotal,
    },
    topPerformers: (topPerformers.results || []).map((r: TopPerformerRow) => ({
      username: r.username || '미확인',
      avgLogic: r.avg_logic,
      sessions: r.sessions,
    })),
    generatedAt: new Date().toISOString(),
  });
});

// POST /api/analytics/typing-events - Collect keystroke timing data
analyticsRoute.post('/api/analytics/typing-events', async (c) => {
  const auth = getAuthUser(c);
  if (!auth?.userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await c.req.json();
    const { sessionId, userId, eventCount, deltaCount, deltas, averageDelta, timestamp } = body;

    // Validate input
    if (!sessionId || !userId || !Array.isArray(deltas) || deltas.length === 0) {
      return c.json({ error: 'Invalid typing events payload' }, 400);
    }

    // Rate limiting: max 100 events per second per user
    if (deltaCount > 100) {
      console.warn(`[Analytics] High keystroke rate detected for user ${userId}: ${deltaCount} deltas`);
      // Still process but log for monitoring
    }

    const db = c.env.DB;

    // Store typing event batch
    await db.prepare(`
      INSERT INTO analytics_keystroke_events
      (session_id, user_id, event_count, delta_count, average_delta_ms, deltas_json, recorded_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `)
      .bind(
        sessionId,
        userId,
        eventCount,
        deltaCount,
        averageDelta || 0,
        JSON.stringify(deltas),
        timestamp || Date.now(),
        Date.now()
      )
      .run();

    return c.json({ success: true, processed: deltaCount });
  } catch (e) {
    console.error('[Analytics] Keystroke event processing failed:', e);
    return c.json({ error: 'Processing failed' }, 500);
  }
});

// GET /api/analytics/response-diversity - A/B/C response diversity validation (admin)
analyticsRoute.get('/api/analytics/response-diversity', async (c) => {
  const role = getAuthUser(c)?.role;
  if (role !== 'admin' && role !== 'instructor') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }

  const db = c.env.DB;

  // Get recent completed sessions with their evaluations
  const sessions = await db.prepare(`
    SELECT s.id, s.topic, s.avg_logic, s.rating, s.textual_evidence_cited, s.current_turn,
           s.radar_scores, s.weakness_pattern
    FROM sessions s
    WHERE s.is_completed = 1
    ORDER BY s.created_at DESC
    LIMIT 30
  `).all<DiversitySessionRow>();

  const diversityAnalysis = await Promise.all(
    (sessions.results || []).map(async (session: DiversitySessionRow) => {
      const evals = await db.prepare(`
        SELECT turn, defense_score, consistency_score, evidence_score, relevance_score, clarity_score,
               evidence_found, fallacy_detected, feedback
        FROM evaluations
        WHERE session_id = ?1
        ORDER BY turn ASC
      `).bind(session.id).all<EvalDetailRow>();

      const turnScores = (evals.results || []).map((e: EvalDetailRow) => ({
        turn: e.turn,
        avg: Math.round((e.defense_score + e.consistency_score + e.evidence_score + e.relevance_score + e.clarity_score) / 5),
        evidenceFound: !!e.evidence_found,
        fallacyDetected: !!e.fallacy_detected,
      }));

      // Calculate score variance (diversity indicator)
      const avgScores = turnScores.map(t => t.avg);
      const mean = avgScores.reduce((a, b) => a + b, 0) / Math.max(avgScores.length, 1);
      const variance = avgScores.length > 1
        ? avgScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / avgScores.length
        : 0;

      // Classify response type based on patterns
      const evidenceRate = turnScores.filter(t => t.evidenceFound).length / Math.max(turnScores.length, 1);
      let responseType = 'abstract'; // Type A: abstract/vague
      if (evidenceRate >= 0.5 && mean >= 50) responseType = 'logical'; // Type B: logical with evidence
      else if (evidenceRate >= 0.3) responseType = 'mixed'; // Type C: mixed

      return {
        sessionId: session.id,
        topic: session.topic,
        avgLogic: session.avg_logic,
        rating: session.rating,
        responseType,
        evidenceRate: Math.round(evidenceRate * 100),
        scoreVariance: Math.round(variance),
        turnCount: turnScores.length,
      };
    })
  );

  // Aggregate by response type
  const typeDistribution = { abstract: 0, mixed: 0, logical: 0 };
  diversityAnalysis.forEach(d => {
    typeDistribution[d.responseType as keyof typeof typeDistribution]++;
  });

  return c.json({
    sessions: diversityAnalysis,
    typeDistribution,
    totalAnalyzed: diversityAnalysis.length,
    diversityScore: Object.values(typeDistribution).filter(v => v > 0).length >= 2 ? 'GOOD' : 'LOW',
  });
});

export default analyticsRoute;
