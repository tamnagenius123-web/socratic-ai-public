// Taiji is a Sparring-only learner action. All claim and gate authority is server-owned.
import { Hono } from 'hono';
import type { Bindings } from '../types';
import { getAuthUser, requireAuth } from '../middleware/auth';
import type { CounterpointRequest, CounterpointResponse } from '../services/taiji/types';

const taijiRoute = new Hono<{ Bindings: Bindings }>();
taijiRoute.use('/api/taiji/*', requireAuth);

type GateEvidence =
  | { available: false; reason: 'gate_evidence_unavailable' }
  | { available: true; masteryScore: number; engagementScore: number; gradeLevel: number };
type AttributionRow = { id: string; claim_snapshot: string };

function getGateEvidence(): GateEvidence {
  // No persisted engagement/grade evidence is currently authoritative for Taiji.
  return { available: false, reason: 'gate_evidence_unavailable' };
}

function isRequest(value: unknown): value is CounterpointRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return ['sessionId', 'claimAttributionId', 'fromNodeId', 'toNodeId'].every((key) =>
    typeof request[key] === 'string' && request[key].trim().length > 0,
  );
}

function unavailable(reason: string): CounterpointResponse {
  return { gateStatus: { passed: false, failureReason: reason }, actionStatus: { available: false, reason } };
}

taijiRoute.post('/api/taiji/counterpoint', async (c) => {
  const auth = getAuthUser(c);
  if (!auth?.userId) return c.json({ error: '인증이 필요합니다.' }, 401);
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  if (!isRequest(body)) return c.json({ error: 'sessionId, claimAttributionId, fromNodeId, toNodeId are required' }, 400);

  const { sessionId, claimAttributionId, fromNodeId, toNodeId } = body;
  const db = c.env.DB;
  const sparring = await db.prepare(`
    SELECT id FROM sessions WHERE id = ?1 AND user_id = ?2
      AND COALESCE(is_completed, 0) = 0 AND COALESCE(is_abandoned, 0) = 0 LIMIT 1
  `).bind(sessionId, auth.userId).first<{ id: string }>();
  if (!sparring) {
    const training = await db.prepare(`SELECT id FROM training_sessions WHERE id = ?1 AND user_id = ?2 LIMIT 1`)
      .bind(sessionId, auth.userId).first<{ id: string }>();
    return c.json({ error: training ? 'taiji_sparring_only' : 'active_sparring_session_not_found' }, training ? 400 : 404);
  }
  const attribution = await db.prepare(`
    SELECT id, claim_snapshot FROM learner_claim_attributions
    WHERE id = ?1 AND user_id = ?2 AND session_kind = 'sparring' AND session_id = ?3
      AND evaluator_status = 'verified' AND status IN ('cited', 'uncited') LIMIT 1
  `).bind(claimAttributionId, auth.userId, sessionId).first<AttributionRow>();
  if (!attribution) return c.json({ error: 'verified_sparring_attribution_not_found' }, 404);

  const nodes = await db.prepare(`
    SELECT source.domain_id AS domain_id FROM knowledge_nodes source
    INNER JOIN knowledge_nodes target ON target.id = ?2
    WHERE source.id = ?1 AND source.domain_id = target.domain_id
  `).bind(fromNodeId, toNodeId).first<{ domain_id: string }>();
  if (!nodes) return c.json({ error: 'taiji_nodes_must_share_a_domain' }, 400);

  // Task5 snapshots are immutable learner authority; book lifecycle is deliberately not re-queried.
  const gate = getGateEvidence();
  // There is no server-verifiable grade/engagement evidence and no authoritative
  // learner response recorded after a counterpoint. Do not start the semantic
  // lifecycle, create a Taiji session, or infer a Chinn-Brewer classification.
  if (!gate.available) return c.json(unavailable(gate.reason), 409);
});

export { taijiRoute };
