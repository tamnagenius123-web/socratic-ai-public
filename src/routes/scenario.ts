// Legacy Scenario API compatibility adapter. All new work is Training-owned.
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { requireAuth, getAuthUser } from '../middleware/auth';
import { TrainingOperationError, listTrainingSessions, publicTrainingSession, respondTrainingSession, startTrainingSession, toPublicTrainingMode } from './training';

const scenarioRoute = new Hono<{ Bindings: Bindings }>();
scenarioRoute.use('/api/scenario/*', requireAuth);

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function readString(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function parseLegacyJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}
function legacyDifficulty(value: unknown): 'beginner' | 'intermediate' | 'advanced' {
  const numeric = Number(value);
  return numeric >= 2.3 ? 'advanced' : numeric >= 1.5 ? 'intermediate' : 'beginner';
}
function legacyDifficultyNumber(value: unknown): number { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? numeric : 1; }
function scenarioCategory(domain: string): string {
  const supported = new Set(['business', 'economics', 'philosophy', 'psychology', 'politics', 'policy', 'technology', 'environment', 'science', 'humanities']);
  return supported.has(domain) ? domain : 'business';
}
function operationResponse(c: { json: (value: Record<string, unknown>, status?: number) => Response }, error: unknown) {
  if (error instanceof TrainingOperationError) {
    if (error.body.code === 'CRITIC_UNAVAILABLE') return c.json({ ...error.body, phase: 'scenario' }, error.status);
    return c.json(error.body, error.status);
  }
  if (error instanceof Error && error.name === 'CriticUnavailableError') return c.json({ error: '튜터 응답 검수를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'CRITIC_UNAVAILABLE', phase: 'scenario', timestamp: new Date().toISOString() }, 503);
  console.error('Scenario compatibility error:', error);
  return c.json({ error: 'Failed to process scenario request' }, 500);
}

scenarioRoute.post('/api/scenario/start', async (c) => {
  const body = await c.req.json<unknown>();
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: 'Auth required' }, 401);
  if (!isRecord(body)) return c.json({ error: 'Invalid scenario request' }, 400);
  const domain = readString(body.domain) || 'business';
  const subDomain = readString(body.subDomain);
  const difficulty = legacyDifficultyNumber(body.difficulty);
  try {
    const started = await startTrainingSession(c.env, auth.userId, {
      category: scenarioCategory(domain),
      difficulty: legacyDifficulty(difficulty),
      mode: 'constructed',
      evidenceQuery: '',
      evidenceBookIds: [],
      constructedFocus: subDomain || domain,
    }, { sessionId: `scn_${crypto.randomUUID().slice(0, 12)}`, maxTurns: 6 });
    return c.json({
      sessionId: started.sessionId,
      scenario: { title: started.title, context: started.context, challenge: started.question, expectedApproaches: started.expectedTensions },
      domain,
      subDomain: subDomain || null,
      difficulty,
      maxTurns: started.maxTurns,
    });
  } catch (error) { return operationResponse(c, error); }
});

scenarioRoute.post('/api/scenario/respond', async (c) => {
  const body = await c.req.json<unknown>();
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: 'Auth required' }, 401);
  if (!isRecord(body)) return c.json({ error: 'Invalid scenario response' }, 400);
  try {
    const response = await respondTrainingSession(c.env, auth.userId, readString(body.sessionId), readString(body.response));
    return c.json({
      evaluation: { feedback: response.aiReply, canonicalEvaluation: response.evaluation },
      turn: response.session.currentTurn,
      isSessionEnd: response.isSessionEnd,
    });
  } catch (error) { return operationResponse(c, error); }
});

scenarioRoute.get('/api/scenario/sessions', async (c) => {
  const auth = getAuthUser(c);
  if (!auth) return c.json({ error: 'Auth required' }, 401);
  try {
    const sessions = await listTrainingSessions(c.env, auth.userId);
    return c.json({ sessions: sessions.filter((session) => session.mode === 'constructed').map((session) => ({ id: session.id, domain: session.category, difficulty: session.difficulty, status: session.is_completed ? 'completed' : 'active', current_turn: Math.max(0, Number(session.current_turn || 1) - 1), created_at: session.created_at, origin: session.origin })) });
  } catch (error) { return operationResponse(c, error); }
});

scenarioRoute.get('/api/scenario/report/:sessionId', async (c) => {
  const auth = getAuthUser(c);
  const sessionId = c.req.param('sessionId');
  if (!auth) return c.json({ error: 'Auth required' }, 401);
  const session = await c.env.DB.prepare(`
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
    FROM training_sessions ts
    WHERE ts.id = ?1 AND ts.user_id = ?2
  `).bind(sessionId, auth.userId).first<Record<string, unknown>>();
  if (!session) {
    const legacy = await c.env.DB.prepare('SELECT * FROM scenario_sessions WHERE id = ?1 AND user_id = ?2').bind(sessionId, auth.userId).first<Record<string, unknown>>();
    if (!legacy) return c.json({ error: 'Session not found' }, 404);
    const turns = await c.env.DB.prepare('SELECT * FROM scenario_turns WHERE session_id = ?1 ORDER BY turn_number ASC').bind(sessionId).all<Record<string, unknown>>();
    return c.json({
      session: {
        ...legacy,
        scenario: parseLegacyJson(legacy.scenario_json),
        finalScores: parseLegacyJson(legacy.final_scores_json),
        legacyScenarioRaw: { scenarioJson: legacy.scenario_json, finalScoresJson: legacy.final_scores_json },
        origin: 'legacy_scenario',
        readOnly: true,
      },
      turns: (turns.results || []).map((turn) => {
        return {
          ...turn,
          evaluation: parseLegacyJson(turn.evaluation_json),
          nextChallenge: parseLegacyJson(turn.next_challenge_json),
          legacyScenarioEvaluation: turn.evaluation_json,
          legacyScenarioNextChallenge: turn.next_challenge_json,
          legacyScenarioRaw: { evaluationJson: turn.evaluation_json, nextChallengeJson: turn.next_challenge_json },
        };
      }),
    });
  }
  if (toPublicTrainingMode(session.training_mode) !== 'constructed') return c.json({ error: 'Session is not a constructed scenario' }, 400);
  const turns = await c.env.DB.prepare('SELECT * FROM training_turns WHERE session_id = ?1 ORDER BY turn_number ASC').bind(sessionId).all();
  return c.json({ session: publicTrainingSession(session), turns: turns.results || [] });
});

export { scenarioRoute };
