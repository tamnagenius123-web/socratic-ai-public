// SocraticAI v34 — Case Study (In-Basket) API Routes
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { generateCaseStudy, processCaseStudyTurn, trackDataReference } from '../services/case-study/in-basket-engine';
import { PERSONA_TEMPLATES } from '../services/case-study/persona-engine';
import type { Persona } from '../services/case-study/persona-engine';
import { requireAuth, getAuthUser } from '../middleware/auth';

const caseStudyRoutes = new Hono<{ Bindings: Bindings }>();
caseStudyRoutes.use('*', requireAuth);

// =============================================
// POST /api/case-study/generate — Generate a new case study
// =============================================
caseStudyRoutes.post('/generate', async (c) => {
  try {
    const body = await c.req.json();
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);
    const userId = auth.userId;
    const db = c.env.DB;

    const caseStudy = await generateCaseStudy(c.env, db, {
      userId,
      preferredIndustry: body.industry,
      targetCompetency: body.competency,
      difficulty: body.difficulty,
    });

    // Create session
    const sessionId = `css_${crypto.randomUUID()}`;
    const primaryPersona = caseStudy.personas[0];

    try {
      await db.prepare(`
        INSERT INTO case_study_sessions (id, case_study_id, user_id, active_persona, conversation_json, data_references_json, micro_scores_json, turn_count, status, created_at)
        VALUES (?1, ?2, ?3, ?4, '[]', '[]', '{}', 0, 'active', ?5)
      `).bind(sessionId, caseStudy.id, userId, primaryPersona.id, Date.now()).run();
    } catch (e) {
      console.error('[CASE_STUDY] Session creation failed:', e);
    }

    return c.json({
      success: true,
      caseStudy: {
        id: caseStudy.id,
        sessionId,
        title: caseStudy.title,
        scenario: caseStudy.scenario,
        role: caseStudy.role,
        industry: caseStudy.industry,
        difficulty: caseStudy.difficulty,
        financialData: caseStudy.financialData,
        dataPoints: caseStudy.dataPoints,
        personas: caseStudy.personas.map(p => ({
          id: p.id,
          name: p.name,
          role: p.role,
          personality: p.personality,
          pressureStyle: p.pressureStyle,
        })),
        expectedCompetencies: caseStudy.expectedCompetencies,
      },
    });
  } catch (error) {
    console.error('[CASE_STUDY] Generate failed:', error);
    return c.json({ error: 'Failed to generate case study', detail: String(error) }, 500);
  }
});

// =============================================
// POST /api/case-study/turn — Process a dialogue turn
// =============================================
caseStudyRoutes.post('/turn', async (c) => {
  try {
    const body = await c.req.json();
    const { sessionId, caseStudyId, message, personaId } = body;
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);
    const db = c.env.DB;

    if (!message || !caseStudyId || !sessionId) {
      return c.json({ error: 'message, caseStudyId, and sessionId required' }, 400);
    }

    const ownedSession = await db.prepare(`
      SELECT id FROM case_study_sessions
      WHERE id = ?1 AND case_study_id = ?2 AND user_id = ?3
    `).bind(sessionId, caseStudyId, auth.userId).first<{ id: string }>();
    if (!ownedSession) return c.json({ error: '접근 권한이 없습니다.' }, 403);

    // Load case study
    const csRow = await db.prepare(`SELECT * FROM case_studies WHERE id = ?1`).bind(caseStudyId).first();
    if (!csRow) {
      return c.json({ error: 'Case study not found' }, 404);
    }

    const scenarioData = JSON.parse(csRow.scenario_json as string);
    const financialData = JSON.parse(csRow.financial_data_json as string || '{}');
    const personas: Persona[] = JSON.parse(csRow.personas_json as string);
    const dataPoints = JSON.parse(csRow.data_points_json as string);

    const caseStudy = {
      id: csRow.id as string,
      title: csRow.title as string,
      scenario: scenarioData.scenario || '',
      role: scenarioData.role || '',
      industry: csRow.industry as string,
      financialData,
      personas,
      expectedCompetencies: JSON.parse(csRow.target_competencies as string || '[]'),
      dataPoints,
      difficulty: csRow.difficulty as number,
    };

    // Select persona
    const selectedPersona = personaId 
      ? personas.find(p => p.id === personaId) || personas[0]
      : personas[0];

    // Load conversation history
    let conversation: { role: string; content: string }[] = [];
    if (sessionId) {
      const sessRow = await db.prepare(`
        SELECT conversation_json FROM case_study_sessions WHERE id = ?1 AND user_id = ?2
      `).bind(sessionId, auth.userId).first();
      if (sessRow) {
        conversation = JSON.parse(sessRow.conversation_json as string || '[]');
      }
    }

    // Process turn
    const result = await processCaseStudyTurn(c.env, caseStudy, selectedPersona, message, conversation);

    // Update conversation
    conversation.push({ role: 'user', content: message });
    conversation.push({ role: 'assistant', content: result.aiResponse });

    // Save to DB
    if (sessionId) {
      try {
        await db.prepare(`
          UPDATE case_study_sessions 
          SET conversation_json = ?1, turn_count = turn_count + 1,
              data_references_json = ?2, active_persona = ?3
          WHERE id = ?4 AND user_id = ?5
        `).bind(
          JSON.stringify(conversation),
          JSON.stringify(result.dataReferences),
          selectedPersona.id,
          sessionId,
          auth.userId,
        ).run();
      } catch (e) {
        console.error('[CASE_STUDY] Session update failed:', e);
      }
    }

    return c.json({
      success: true,
      response: result.aiResponse,
      persona: {
        id: selectedPersona.id,
        name: selectedPersona.name,
        role: selectedPersona.role,
      },
      dataReferences: {
        referenceRate: result.dataReferences.referenceRate,
        referencedCount: result.dataReferences.referenced.length,
        missedCount: result.dataReferences.missed.length,
        importantMissed: result.dataReferences.importantMissed.map(dp => dp.key),
      },
      turnCount: conversation.length / 2,
    });
  } catch (error) {
    console.error('[CASE_STUDY] Turn failed:', error);
    return c.json({ error: 'Failed to process turn', detail: String(error) }, 500);
  }
});

// =============================================
// GET /api/case-study/:id — Get case study details
// =============================================
caseStudyRoutes.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);

    const row = await db.prepare(`
      SELECT cs.* FROM case_studies cs
      WHERE cs.id = ?1
        AND EXISTS (
          SELECT 1 FROM case_study_sessions css
          WHERE css.case_study_id = cs.id AND css.user_id = ?2
        )
    `).bind(id, auth.userId).first();
    if (!row) {
      return c.json({ error: 'Case study not found' }, 404);
    }

    return c.json({
      id: row.id,
      title: row.title,
      scenario: JSON.parse(row.scenario_json as string),
      financialData: JSON.parse(row.financial_data_json as string || '{}'),
      personas: JSON.parse(row.personas_json as string),
      dataPoints: JSON.parse(row.data_points_json as string),
      difficulty: row.difficulty,
      industry: row.industry,
      status: row.status,
      createdAt: row.created_at,
    });
  } catch (error) {
    console.error('[CASE_STUDY] Get failed:', error);
    return c.json({ error: 'Failed to get case study' }, 500);
  }
});

// =============================================
// GET /api/case-study/session/:sessionId — Get session with conversation
// =============================================
caseStudyRoutes.get('/session/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId');
    const db = c.env.DB;
    const auth = getAuthUser(c);
    if (!auth) return c.json({ error: '인증이 필요합니다.' }, 401);

    const row = await db.prepare(`
      SELECT * FROM case_study_sessions WHERE id = ?1 AND user_id = ?2
    `).bind(sessionId, auth.userId).first();
    if (!row) {
      return c.json({ error: 'Session not found' }, 404);
    }

    return c.json({
      id: row.id,
      caseStudyId: row.case_study_id,
      conversation: JSON.parse(row.conversation_json as string || '[]'),
      dataReferences: JSON.parse(row.data_references_json as string || '[]'),
      microScores: JSON.parse(row.micro_scores_json as string || '{}'),
      turnCount: row.turn_count,
      status: row.status,
      activePersona: row.active_persona,
    });
  } catch (error) {
    console.error('[CASE_STUDY] Session get failed:', error);
    return c.json({ error: 'Failed to get session' }, 500);
  }
});

// =============================================
// GET /api/case-study/personas/list — List available personas
// =============================================
caseStudyRoutes.get('/personas/list', async (c) => {
  const personas = Object.entries(PERSONA_TEMPLATES).map(([key, p]) => ({
    id: `persona_${key}`,
    key,
    name: p.name,
    role: p.role,
    personality: p.personality,
    pressureStyle: p.pressureStyle,
    criticalFocus: p.criticalFocus,
  }));

  return c.json({ personas });
});

export default caseStudyRoutes;
