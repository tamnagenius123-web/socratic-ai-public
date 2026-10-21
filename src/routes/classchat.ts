// ============================================================
// v32: ClassChat Peer Learning Routes
// ============================================================
// DeepSkill ClassChat mirror — multi-student collaborative
// learning with shared AI facilitator
// ============================================================

import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';
import { generateFacilitatorResponse, assignInitialRoles, calculateContributionScore } from '../services/classchat-engine';
import type { ClassChatParticipant, ClassChatTurn } from '../services/classchat-engine';

export const classchatRoute = new Hono<{ Bindings: Bindings }>();

classchatRoute.use('/api/classchat/*', requireAuth);

// POST /api/classchat/rooms — Create a new ClassChat room
classchatRoute.post('/api/classchat/rooms', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  const { topic, maxParticipants, facilitatorMode } = await c.req.json<{
    topic: string;
    maxParticipants?: number;
    facilitatorMode?: string;
  }>();

  if (!topic) return c.json({ error: '토론 주제가 필요합니다.' }, 400);

  const id = 'cc_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const now = Date.now();

  try {
    await c.env.DB.prepare(`
      INSERT INTO classchat_sessions (id, room_name, topic, max_participants, facilitator_mode, status, created_by, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7)
    `).bind(id, `ClassChat-${id.slice(-4)}`, topic, maxParticipants || 6, facilitatorMode || 'ai_guided', auth.userId, now).run();

    return c.json({ success: true, roomId: id, topic });
  } catch (error: unknown) {
    return c.json({ error: '방 생성 실패', detail: (error as Error)?.message }, 500);
  }
});

// GET /api/classchat/rooms — List rooms
classchatRoute.get('/api/classchat/rooms', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `SELECT id, room_name, topic, max_participants, facilitator_mode, status, created_at
       FROM classchat_sessions WHERE status != 'archived' ORDER BY created_at DESC LIMIT 20`
    ).all();
    return c.json({ rooms: result.results || [] });
  } catch (e) { console.error("[P1-004] Caught:", e);
    return c.json({ rooms: [] });
  }
});

// POST /api/classchat/rooms/:id/message — Send a message
classchatRoute.post('/api/classchat/rooms/:id/message', async (c) => {
  const roomId = c.req.param('id');
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: '인증 필요' }, 401);

  const { content } = await c.req.json<{ content: string }>();
  if (!content) return c.json({ error: '메시지 내용이 필요합니다.' }, 400);

  const msgId = 'ccm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const now = Date.now();

  try {
    await c.env.DB.prepare(`
      INSERT INTO classchat_messages (id, session_id, user_id, role, content, created_at)
      VALUES (?1, ?2, ?3, 'student', ?4, ?5)
    `).bind(msgId, roomId, auth.userId, content, now).run();

    // Get recent messages for facilitator
    const recentMsgs = await c.env.DB.prepare(
      `SELECT user_id, role, content, da_classification, arc_relation, created_at
       FROM classchat_messages WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 10`
    ).bind(roomId).all();

    const turns: ClassChatTurn[] = (recentMsgs.results || []).reverse().map((m: Record<string, unknown>) => ({
      participantId: (m.user_id as string) || '',
      role: (m.role as string) || 'student',
      content: (m.content as string) || '',
      daClassification: (m.da_classification as string) || 'claim',
      arcRelation: (m.arc_relation as string) || null,
      timestamp: (m.created_at as number) || 0,
    }));

    // Get room config
    const room = await c.env.DB.prepare(
      'SELECT topic, facilitator_mode FROM classchat_sessions WHERE id = ?1'
    ).bind(roomId).first<Record<string, unknown>>();

    // Generate facilitator response if AI-guided
    let facilitatorMsg = null;
    if (room?.facilitator_mode !== 'peer_led' && turns.length >= 2) {
      const participants: ClassChatParticipant[] = [{
        userId: auth.userId,
        username: 'Student',
        currentRole: 'advocate',
        turnCount: turns.filter(t => t.participantId === auth.userId).length,
        daDistribution: {},
        contributionScore: 0.5,
      }];

      facilitatorMsg = await generateFacilitatorResponse(
        turns,
        participants,
        {
          maxParticipants: 6,
          facilitatorMode: 'ai_guided',
          rotationInterval: 3,
          topic: (room?.topic as string) || '',
          difficultyLevel: 'intermediate',
        },
        c.env as Record<string, unknown>
      );

      // Store facilitator response
      if (facilitatorMsg.message) {
        const fMsgId = 'ccf_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
        await c.env.DB.prepare(`
          INSERT INTO classchat_messages (id, session_id, user_id, role, content, created_at)
          VALUES (?1, ?2, 'ai_facilitator', 'facilitator', ?3, ?4)
        `).bind(fMsgId, roomId, facilitatorMsg.message, Date.now()).run();
      }
    }

    return c.json({
      success: true,
      messageId: msgId,
      facilitator: facilitatorMsg,
    });
  } catch (error: unknown) {
    return c.json({ error: '메시지 전송 실패', detail: (error as Error)?.message }, 500);
  }
});

// GET /api/classchat/rooms/:id/messages — Get messages
classchatRoute.get('/api/classchat/rooms/:id/messages', async (c) => {
  const roomId = c.req.param('id');
  try {
    const result = await c.env.DB.prepare(
      `SELECT id, user_id, role, content, da_classification, arc_relation, created_at
       FROM classchat_messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT 100`
    ).bind(roomId).all();
    return c.json({ messages: result.results || [] });
  } catch (e) { console.error("[P1-004] Caught:", e);
    return c.json({ messages: [] });
  }
});
