import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, requireRole, getAuthUser } from '../middleware/auth';
import { tutoringServiceHooksRepository } from '../services/tutoring/hooks';

const deepskillRoute = new Hono<{ Bindings: Bindings }>();

deepskillRoute.use('/api/deepskill/*', requireAuth);

// P2 Route Placeholder: hook list (운영/QA에서 즉시 점검 가능)
deepskillRoute.get('/api/deepskill/hooks', async (c) => {
  const hooks = await tutoringServiceHooksRepository.listHooks(c.env.DB);
  return c.json({ hooks });
});

// P2 Route Placeholder: hook toggle (admin only)
deepskillRoute.post('/api/deepskill/hooks/:hookKey', requireRole('admin'), async (c) => {
  const hookKey = c.req.param('hookKey');
  const body = await c.req.json<{ enabled: boolean; configJson?: Record<string, any> }>();

  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled(boolean) 값이 필요합니다.' }, 400);
  }

  const updated = await tutoringServiceHooksRepository.updateHook(c.env.DB, hookKey, body.enabled, body.configJson);
  if (!updated) return c.json({ error: 'hookKey를 찾을 수 없습니다.' }, 404);

  return c.json({ success: true, hookKey, enabled: body.enabled });
});

// P2 Route Placeholder: retrieval trace 조회 (본인 or admin)
deepskillRoute.get('/api/deepskill/sessions/:id/retrieval-trace', async (c) => {
  const sessionId = c.req.param('id');
  const auth = getAuthUser(c);

  const row = await c.env.DB.prepare('SELECT user_id, retrieval_trace FROM sessions WHERE id = ?1').bind(sessionId).first<any>();
  if (!row) return c.json({ error: 'Session not found' }, 404);

  if (auth?.role !== 'admin' && row.user_id && row.user_id !== auth?.userId) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  return c.json({
    sessionId,
    retrievalTrace: row.retrieval_trace ? JSON.parse(row.retrieval_trace) : [],
  });
});

// =============================================
// Sprint D Scaffolding: PDF Export, Discord Webhook, Custom Rubrics
// =============================================

// POST /api/deepskill/report/export - PDF Export placeholder (Sprint D)
deepskillRoute.post('/api/deepskill/report/export', async (c) => {
  const { sessionId, format } = await c.req.json<{ sessionId: string; format?: string }>();
  const auth = getAuthUser(c);

  // Check session ownership
  const session = await c.env.DB.prepare(
    'SELECT user_id, topic, book_title, avg_logic, rating FROM sessions WHERE id = ?1'
  ).bind(sessionId).first<any>();
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (auth?.role !== 'admin' && session.user_id !== auth?.userId) {
    return c.json({ error: '접근 권한이 없습니다.' }, 403);
  }

  // Get session report
  const reportRow = await c.env.DB.prepare(
    'SELECT * FROM session_reports WHERE session_id = ?1'
  ).bind(sessionId).first<any>();

  // Get deep report
  const deepReport = await c.env.DB.prepare(
    'SELECT * FROM session_deep_reports WHERE session_id = ?1'
  ).bind(sessionId).first<any>();

  // Generate exportable JSON structure (future: convert to PDF)
  const exportData = {
    format: format || 'json',
    session: {
      id: sessionId,
      topic: session.topic,
      bookTitle: session.book_title,
      avgLogic: session.avg_logic,
      rating: session.rating,
    },
    report: reportRow ? {
      summary: reportRow.summary,
      strengths: reportRow.strengths,
      improvements: reportRow.improvements,
      totalTurns: reportRow.total_turns,
      totalEvidence: reportRow.total_evidence_cited,
      finalRating: reportRow.final_rating,
    } : null,
    deepAnalysis: deepReport ? {
      status: deepReport.status,
      microMetrics: deepReport.micro_metrics ? JSON.parse(deepReport.micro_metrics) : null,
      argGraph: deepReport.arg_graph_json ? JSON.parse(deepReport.arg_graph_json) : null,
      prescriptiveFeedback: deepReport.prescriptive_feedback,
      growthTrajectory: deepReport.growth_trajectory,
    } : null,
    exportedAt: new Date().toISOString(),
    _note: 'PDF 변환은 Sprint D에서 구현됩니다. 현재는 JSON 형태로 제공됩니다.',
  };

  return c.json(exportData);
});

// GET /api/deepskill/rubrics - List custom rubrics
deepskillRoute.get('/api/deepskill/rubrics', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      'SELECT id, name, description, created_by, is_active, created_at FROM custom_rubrics WHERE is_active = 1 ORDER BY created_at DESC'
    ).all();
    return c.json({ rubrics: result.results || [] });
  } catch (e) { console.error("[P1-004] Caught:", e);
    return c.json({ rubrics: [], _note: 'custom_rubrics 테이블이 아직 생성되지 않았습니다.' });
  }
});

// POST /api/deepskill/rubrics - Create custom rubric (admin only)
deepskillRoute.post('/api/deepskill/rubrics', requireRole('admin'), async (c) => {
  const { name, description, rubricJson } = await c.req.json<{
    name: string;
    description?: string;
    rubricJson: Record<string, any>;
  }>();

  if (!name || !rubricJson) {
    return c.json({ error: 'name과 rubricJson은 필수입니다.' }, 400);
  }

  const auth = getAuthUser(c);
  const id = 'rubric_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const now = Date.now();

  try {
    await c.env.DB.prepare(`
      INSERT INTO custom_rubrics (id, name, description, created_by, rubric_json, is_active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
    `).bind(id, name, description || '', auth?.userId || null, JSON.stringify(rubricJson), now).run();

    return c.json({ success: true, id, name });
  } catch (error: unknown) {
    return c.json({ error: (error instanceof Error ? error.message : '') || 'custom_rubrics 테이블이 아직 마이그레이션되지 않았습니다.' }, 500);
  }
});

// POST /api/deepskill/notify - Discord webhook notification (Sprint D scaffold)
deepskillRoute.post('/api/deepskill/notify', requireRole('admin'), async (c) => {
  const { event, sessionId, webhookUrl, message } = await c.req.json<{
    event: string;
    sessionId?: string;
    webhookUrl?: string;
    message?: string;
  }>();

  if (!event) {
    return c.json({ error: 'event는 필수입니다.' }, 400);
  }

  const logId = 'notif_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const payload = JSON.stringify({ event, sessionId, message, timestamp: new Date().toISOString() });

  // Log the notification attempt
  try {
    await c.env.DB.prepare(`
      INSERT INTO notification_log (id, type, event, session_id, user_id, payload, status, created_at)
      VALUES (?1, 'discord_webhook', ?2, ?3, ?4, ?5, 'pending', ?6)
    `).bind(logId, event, sessionId || null, getAuthUser(c)?.userId || null, payload, Date.now()).run();
  } catch (e) { console.error("[P1-004] Caught:", e);
    // notification_log table may not exist yet
  }

  // If webhook URL is provided, attempt to send
  if (webhookUrl) {
    try {
      const discordPayload = {
        content: message || `**SocraticAI Alert** - ${event}`,
        embeds: [{
          title: `SocraticAI: ${event}`,
          description: message || `Event triggered: ${event}`,
          color: event.includes('excellent') ? 0x10B981 : 0x5B4CDB,
          fields: sessionId ? [{ name: 'Session ID', value: sessionId, inline: true }] : [],
          timestamp: new Date().toISOString(),
        }],
      };

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload),
      });

      const status = res.ok ? 'sent' : 'failed';
      try {
        await c.env.DB.prepare('UPDATE notification_log SET status = ?2 WHERE id = ?1').bind(logId, status).run();
      } catch (e) { console.error('[P1-004] ignored:', e); }

      return c.json({ success: res.ok, logId, status });
    } catch (error: unknown) {
      return c.json({ success: false, logId, error: (error instanceof Error ? error.message : '') || 'Webhook 전송 실패' }, 500);
    }
  }

  return c.json({
    success: true,
    logId,
    _note: 'Discord webhook URL이 설정되면 실시간 알림이 전송됩니다.',
  });
});

export default deepskillRoute;
