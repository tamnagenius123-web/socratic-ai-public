// Admin API Routes - User Management + Token Usage Dashboard (Admin only)
// v13.0: Token usage tracking endpoints added
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { getAllUsers, createUser, updateUser, deleteUser, getUserById, userToPublic } from '../services/auth';
import { requireAuth, requireRole, getAuthUser } from '../middleware/auth';
import { getGlobalTokenSummary, getTopConsumers, getUserTokenSummary, getSessionTokenUsage, getTodayCostSummary, creditsToKRW } from '../services/token-tracker';
import { createAIRouter, isProviderSmokeRouteId } from '../services/ai-router';
import type { AdminUserSessionRow, TokenSummaryRow, TopConsumerDetailRow, SessionTokenUsageDetailRow } from '../types/d1-rows';

const adminRoute = new Hono<{ Bindings: Bindings }>();

// Apply unified auth + role middleware
adminRoute.use('/api/admin/*', requireAuth);
adminRoute.use('/api/admin/*', requireRole('admin'));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A deliberately narrow operational probe. Route policy, prompt, and target
// are server-owned; an administrator may only choose a reviewed route ID.
adminRoute.post('/api/admin/ai/providers/smoke', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (
    !isPlainObject(body)
    || Object.keys(body).length !== 1
    || !isProviderSmokeRouteId(body.routeId)
  ) {
    return c.json({ error: 'routeId must be a supported provider smoke route.' }, 400);
  }

  const result = await createAIRouter(c.env).smoke(body.routeId);
  return c.json(result, result.status === 'ready' ? 200 : 503);
});

// GET /api/admin/users - Get all users
adminRoute.get('/api/admin/users', async (c) => {
  const db = c.env.DB;
  const users = await getAllUsers(db);
  return c.json({ users });
});

// POST /api/admin/users - Create user (admin invite)
adminRoute.post('/api/admin/users', async (c) => {
  try {
    const { username, email, password, studentId, grade, role } = await c.req.json();

    if (!username || !email || !password) {
      return c.json({ error: '이름, 이메일, 비밀번호는 필수입니다.' }, 400);
    }

    const db = c.env.DB;

    // Check duplicates
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?1 OR username = ?2').bind(email, username).first();
    if (existing) {
      return c.json({ error: '이미 등록된 이메일 또는 이름입니다.' }, 409);
    }

    const user = await createUser(db, username, email, password, role || 'student', studentId, grade);
    return c.json({ success: true, user });
  } catch (error) {
    console.error('Admin create user error:', error);
    return c.json({ error: '부원 추가에 실패했습니다: ' + String(error) }, 500);
  }
});

// PUT /api/admin/users/:id - Update user
adminRoute.put('/api/admin/users/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const updates = await c.req.json();
    const db = c.env.DB;

    const success = await updateUser(db, id, updates);
    if (!success) {
      return c.json({ error: '사용자를 찾을 수 없거나 변경 사항이 없습니다.' }, 404);
    }

    return c.json({ success: true, message: '부원 정보가 수정되었습니다.' });
  } catch (error) {
    console.error('Admin update user error:', error);
    return c.json({ error: '부원 정보 수정에 실패했습니다.' }, 500);
  }
});

// DELETE /api/admin/users/:id - Soft delete user
adminRoute.delete('/api/admin/users/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const success = await deleteUser(db, id);
  if (!success) {
    return c.json({ error: '사용자를 찾을 수 없습니다.' }, 404);
  }

  return c.json({ success: true, message: '부원이 비활성화되었습니다.' });
});

// GET /api/admin/users/:id/sessions - Get user's sessions
adminRoute.get('/api/admin/users/:id/sessions', async (c) => {
  const auth = getAuthUser(c);
  if (!auth || auth.role !== 'admin') {
    return c.json({ error: '관리자 권한이 필요합니다.' }, 403);
  }
  const userId = c.req.param('id');
  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT id, topic, book_title, book_chapter, created_at, current_turn, max_turns,
           avg_logic, rating, is_completed, is_abandoned, abandoned_turn, ended_at,
           core_claim, textual_evidence_cited, radar_scores
    FROM sessions
    WHERE user_id = ?1
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(userId).all<AdminUserSessionRow>();

  const sessions = (result.results || []).map((row: AdminUserSessionRow) => ({
    id: row.id,
    topic: row.topic,
    bookTitle: row.book_title,
    bookChapter: row.book_chapter,
    createdAt: row.created_at,
    currentTurn: row.current_turn,
    maxTurns: row.max_turns,
    avgLogic: row.avg_logic,
    rating: row.rating,
    isCompleted: !!row.is_completed,
    isAbandoned: !!row.is_abandoned,
    abandonedTurn: row.abandoned_turn,
    endedAt: row.ended_at,
    coreClaim: row.core_claim,
    textualEvidenceCited: row.textual_evidence_cited,
    radarScores: JSON.parse(row.radar_scores || '{}'),
  }));

  return c.json({ sessions });
});

// =============================================
// v13.0: Token Usage Dashboard Endpoints
// =============================================

// GET /api/admin/token-usage/summary - 전체 토큰 사용 현황
adminRoute.get('/api/admin/token-usage/summary', async (c) => {
  try {
    const days = Number(c.req.query('days') || '30');
    const db = c.env.DB;
    
    const summary = await getGlobalTokenSummary(db, days);
    const topConsumers = await getTopConsumers(db, 20);
    const todayCost = await getTodayCostSummary(db);
    
    const totalTokens = (summary.results || []).reduce((sum: number, r: TokenSummaryRow) => sum + (r.tokens || 0), 0);
    const totalCredits = (summary.results || []).reduce((sum: number, r: TokenSummaryRow) => sum + (r.credits || 0), 0);
    
    return c.json({
      period: `${days}일`,
      today: todayCost,
      totalTokens,
      totalCredits: Math.round(totalCredits * 1000) / 1000,
      totalCostKRW: creditsToKRW(totalCredits),
      dailyBreakdown: summary.results || [],
      topConsumers: (topConsumers.results || []).map((r: TopConsumerDetailRow) => ({
        ...r,
        estimatedCostKRW: creditsToKRW(r.total_credits || 0),
      })),
    });
  } catch (error) {
    console.error('Token usage summary error:', error);
    return c.json({ error: '토큰 사용 현황 조회 실패' }, 500);
  }
});

// GET /api/admin/token-usage/user/:userId - 유저별 토큰 사용 현황
adminRoute.get('/api/admin/token-usage/user/:userId', async (c) => {
  try {
    const userId = c.req.param('userId');
    const days = Number(c.req.query('days') || '30');
    const db = c.env.DB;
    
    const summary = await getUserTokenSummary(db, userId, days);
    
    return c.json({
      userId,
      period: `${days}일`,
      ...summary,
      estimatedCostKRW: creditsToKRW(summary?.total_credits || 0),
    });
  } catch (error) {
    console.error('User token usage error:', error);
    return c.json({ error: '유저 토큰 사용 현황 조회 실패' }, 500);
  }
});

// GET /api/admin/token-usage/session/:sessionId - 세션별 토큰 사용 상세
adminRoute.get('/api/admin/token-usage/session/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const db = c.env.DB;
    
    const usage = await getSessionTokenUsage(db, sessionId);
    
    const totalTokens = (usage.results || []).reduce((sum: number, r: SessionTokenUsageDetailRow) => sum + (r.total_tokens || 0), 0);
    const totalCredits = (usage.results || []).reduce((sum: number, r: SessionTokenUsageDetailRow) => sum + (r.estimated_credits || 0), 0);
    
    return c.json({
      sessionId,
      totalTokens,
      totalCredits: Math.round(totalCredits * 1000) / 1000,
      totalCostKRW: creditsToKRW(totalCredits),
      breakdown: usage.results || [],
    });
  } catch (error) {
    console.error('Session token usage error:', error);
    return c.json({ error: '세션 토큰 사용 상세 조회 실패' }, 500);
  }
});

// =============================================
// v21 P0-5: ARC Teacher Feedback — Online Learning Pipeline
// =============================================

adminRoute.post('/api/admin/arc-feedback', async (c) => {
  try {
    const body = await c.req.json<{
      sessionId: string;
      turnNumber: number;
      predictedArc: string; // 'support' | 'attack' | 'neutral'
      goldArc: string;      // teacher-provided ground truth
    }>();

    if (!body.sessionId || !body.turnNumber || !body.predictedArc || !body.goldArc) {
      return c.json({ error: 'sessionId, turnNumber, predictedArc, goldArc 모두 필수입니다.' }, 400);
    }

    const db = c.env.DB;
    const feedbackId = `arc_fb_${body.sessionId}_t${body.turnNumber}_${Date.now()}`;

    // 1. Insert feedback record
    await db.prepare(
      `INSERT OR REPLACE INTO arc_teacher_feedback
       (id, session_id, turn_number, predicted_arc, gold_arc, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(feedbackId, body.sessionId, body.turnNumber, body.predictedArc, body.goldArc, Date.now()).run();

    // 2. Check if we have enough data for weight update (>= 10 samples)
    const countResult = await db.prepare(
      'SELECT COUNT(*) as cnt FROM arc_teacher_feedback'
    ).first<{ cnt: number }>();

    let weightUpdateResult: { updated: boolean; accuracy?: number; version?: number } = { updated: false };

    if ((countResult?.cnt || 0) >= 10) {
      // 3. Collect all feedback for gradient-free weight update
      const allFeedback = await db.prepare(
        'SELECT predicted_arc, gold_arc FROM arc_teacher_feedback ORDER BY created_at DESC LIMIT 100'
      ).all();

      const feedbackRows = (allFeedback.results || []) as Array<{ predicted_arc: string; gold_arc: string }>;

      // 4. Compute error patterns → adjust ARC_WEIGHTS
      // Gradient-free online learning: count misclassification patterns
      let correctCount = 0;
      const errorDeltas = { support: 0, attack: 0, neutral: 0 };
      const classCounts = { support: 0, attack: 0, neutral: 0 };

      for (const fb of feedbackRows) {
        const predicted = fb.predicted_arc as keyof typeof errorDeltas;
        const gold = fb.gold_arc as keyof typeof errorDeltas;
        if (predicted === gold) {
          correctCount++;
        } else {
          // Decrease weight of incorrectly predicted class, increase gold class
          if (errorDeltas[predicted] !== undefined) errorDeltas[predicted] -= 0.01;
          if (errorDeltas[gold] !== undefined) errorDeltas[gold] += 0.01;
        }
        if (classCounts[gold] !== undefined) classCounts[gold]++;
      }

      const accuracy = feedbackRows.length > 0 ? correctCount / feedbackRows.length : 0;

      // 5. Load current weights or use defaults
      const latestSnapshot = await db.prepare(
        'SELECT version, weights_json FROM arc_weight_snapshots ORDER BY version DESC LIMIT 1'
      ).first<{ version: number; weights_json: string }>();

      const currentVersion = latestSnapshot?.version || 0;
      const currentWeights = latestSnapshot?.weights_json
        ? JSON.parse(latestSnapshot.weights_json)
        : { support: [0.3, 0.2, 0.1], attack: [0.1, 0.3, 0.2], neutral: [0.2, 0.1, 0.3] };

      // 6. Apply deltas (clamped)
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      for (const cls of ['support', 'attack', 'neutral'] as const) {
        if (currentWeights[cls]) {
          for (let i = 0; i < currentWeights[cls].length; i++) {
            currentWeights[cls][i] = clamp(currentWeights[cls][i] + errorDeltas[cls], -1, 1);
          }
        }
      }

      // 7. Persist new weight snapshot
      const newVersion = currentVersion + 1;
      await db.prepare(
        `INSERT INTO arc_weight_snapshots (id, version, weights_json, training_samples, accuracy, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
      ).bind(
        `arc_w_v${newVersion}`, newVersion,
        JSON.stringify(currentWeights),
        feedbackRows.length, accuracy, Date.now(),
      ).run();

      weightUpdateResult = { updated: true, accuracy: Math.round(accuracy * 100) / 100, version: newVersion };
    }

    return c.json({
      ok: true,
      feedbackId,
      totalFeedback: countResult?.cnt || 0,
      weightUpdate: weightUpdateResult,
    });
  } catch (error) {
    console.error('ARC feedback error:', error);
    return c.json({ error: 'ARC 피드백 처리 실패' }, 500);
  }
});

// GET /api/admin/arc-weights — 현재 ARC 가중치 조회
adminRoute.get('/api/admin/arc-weights', async (c) => {
  try {
    const db = c.env.DB;
    const latest = await db.prepare(
      'SELECT * FROM arc_weight_snapshots ORDER BY version DESC LIMIT 5'
    ).all();
    return c.json({ snapshots: latest.results || [] });
  } catch (error) {
    console.error('ARC weights error:', error);
    return c.json({ error: 'ARC 가중치 조회 실패' }, 500);
  }
});

export default adminRoute;
