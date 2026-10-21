import { assertTrainingNotStopped } from './interventions';
import type { DeepEvaluation, TutorAction, TutorState } from '../tutoring/types';
import type { ReadyEvidenceGroundedScenario, ScenarioRubricCriterion } from './scenario-evidence';

export const TRAINING_ROUTES = ['case-first', 'proof-first', 'mixed'] as const;
export type TrainingRoute = typeof TRAINING_ROUTES[number];
type Alternative = { route: TrainingRoute; reason: string; evidenceRefs: string[] };
export type TrainingRouteOffer = {
 version: 1; taskIdentity: string; manifestSha256: string; efficacy: 'UNKNOWN';
 target: { goal: string; rubric: ScenarioRubricCriterion[]; equalDepth: true };
 options: Array<{ route: TrainingRoute; supportStatus: 'TASK_SUPPORTED' | 'UNKNOWN'; rationale: string; evidenceRefs: string[]; alternatives: Alternative[] }>;
};
export type TrainingRouteDecision = {
 id: string; revision: number; selectedRoute: TrainingRoute; supportStatus: 'TASK_SUPPORTED' | 'UNKNOWN';
 effectiveFromTurn: number; createdAt: number; offer: TrainingRouteOffer;
};
export type TrainingRouteProjection = { status: 'AWAITING_CHOICE' | 'SELECTED' | 'UNKNOWN'; offer: TrainingRouteOffer | null; decision: TrainingRouteDecision | null; history?: TrainingRouteDecision[] };
export class TrainingRouteError extends Error {
 constructor(readonly status: number, readonly code: string) { super(code); }
}
export function isTrainingRoute(value: unknown): value is TrainingRoute { return TRAINING_ROUTES.some(route => route === value); }

/** Structural applicability is not comparative efficacy or a learner type. */
export function buildTrainingRouteOffer(sessionId: string, build: ReadyEvidenceGroundedScenario): TrainingRouteOffer {
 const { scenario, evidencePack } = build;
 const evidenceIds = new Set(evidencePack.sources.filter(s => s.lifecycleStatus === 'active').map(s => s.sourceId));
 const grounded = scenario.evidenceSourceIds.length >= 2 && scenario.evidenceSourceIds.every(id => evidenceIds.has(id)) && scenario.rubric.length > 0;
 const sources = scenario.evidenceSourceIds.map(id => `source:${id}`);
 const support: Record<TrainingRoute, { ok: boolean; refs: string[]; rationale: string }> = {
  'case-first': { ok: grounded && scenario.stakeholders.length > 0 && scenario.constraints.length > 0,
   refs: ['scenario:decisionQuestion', 'scenario:stakeholders', 'scenario:constraints', ...sources],
   rationale: 'Start with the task stakeholders and constraints, then reconstruct a source-supported claim and reasoning. The same rubric still applies.' },
  'proof-first': { ok: grounded && scenario.rubric.some(r => /claim|evidence|reason|주장|근거|추론/i.test(r.id + ' ' + r.label)),
   refs: ['scenario:decisionQuestion', 'scenario:rubric', ...sources],
   rationale: 'Start with the claim and evidence obligations in the task rubric, then test the reasoning against the concrete situation. This is reasoning order, not a claim of formal proof.' },
  mixed: { ok: grounded && scenario.tradeoffs.length > 0,
   refs: ['scenario:decisionQuestion', 'scenario:tradeoffs', 'scenario:rubric', ...sources],
   rationale: 'Alternate concrete tradeoffs and explicit justifications, checking both against the same task rubric.' },
 };
 return {
  version: 1, taskIdentity: `training:${sessionId}:${evidencePack.manifestSha256}`, manifestSha256: evidencePack.manifestSha256, efficacy: 'UNKNOWN',
  target: { goal: scenario.sessionGoal, rubric: scenario.rubric.map(r => ({ ...r })), equalDepth: true },
  options: TRAINING_ROUTES.map(route => ({ route, supportStatus: support[route].ok ? 'TASK_SUPPORTED' : 'UNKNOWN',
   rationale: support[route].ok ? support[route].rationale : 'Insufficient task evidence for this order. The preference is preserved without an evidence-based adaptation claim.',
   evidenceRefs: support[route].ok ? support[route].refs : [],
   alternatives: TRAINING_ROUTES.filter(other => other !== route).map(other => ({ route: other,
    reason: support[other].ok ? support[other].rationale : 'Alternative applicability is UNKNOWN.', evidenceRefs: support[other].ok ? support[other].refs : [] })),
  })),
 };
}

export function prepareTrainingRouteOffer(db: D1Database, sessionId: string, owner: string, build: ReadyEvidenceGroundedScenario) {
 const offer = buildTrainingRouteOffer(sessionId, build);
 return { offer, statement: db.prepare('INSERT INTO training_route_offers (session_id, owner_user_id, offer_json, created_at) VALUES (?1, ?2, ?3, ?4)').bind(sessionId, owner, JSON.stringify(offer), Date.now()) };
}

async function ownedSession(db: D1Database, owner: string, sessionId: string) {
 const row = await db.prepare('SELECT id, user_id, is_completed, current_turn, learning_route_version FROM training_sessions WHERE id = ?1 AND user_id = ?2').bind(sessionId, owner).first<{ id: string; user_id: string; is_completed: number; current_turn: number; learning_route_version: number | null }>();
 if (!row) throw new TrainingRouteError(404, 'TRAINING_ROUTE_NOT_FOUND');
 return row;
}
type DecisionRow = { id: string; decision_revision: number; selected_route: TrainingRoute; effective_from_turn: number; created_at: number; mutation_key: string; expected_revision: number };
function projectDecision(row: DecisionRow, offer: TrainingRouteOffer): TrainingRouteDecision {
 if (!isTrainingRoute(row.selected_route)) throw new TrainingRouteError(503, 'TRAINING_ROUTE_INVALID');
 const option = offer.options.find(option => option.route === row.selected_route);
 if (!option) throw new TrainingRouteError(503, 'TRAINING_ROUTE_INVALID');
 return { id: row.id, revision: row.decision_revision, selectedRoute: row.selected_route, supportStatus: option.supportStatus, effectiveFromTurn: row.effective_from_turn, createdAt: row.created_at, offer };
}
async function loadOffer(db: D1Database, owner: string, sessionId: string): Promise<TrainingRouteOffer> {
 const row = await db.prepare('SELECT offer_json FROM training_route_offers WHERE session_id = ?1 AND owner_user_id = ?2').bind(sessionId, owner).first<{ offer_json: string }>();
 try {
  const offer: TrainingRouteOffer = JSON.parse(row?.offer_json || 'null');
  if (!offer || offer.version !== 1 || !offer.target.equalDepth || offer.options.length !== 3 || offer.efficacy !== 'UNKNOWN') throw new Error('Invalid route offer');
  return offer;
 } catch { throw new TrainingRouteError(503, 'TRAINING_ROUTE_INVALID'); }
}
export async function loadTrainingRoute(db: D1Database, owner: string, sessionId: string): Promise<TrainingRouteProjection> {
 const session = await ownedSession(db, owner, sessionId);
 if (session.learning_route_version !== 1) return { status: 'UNKNOWN', offer: null, decision: null };
 const offer = await loadOffer(db, owner, sessionId);
 const rows = await db.prepare('SELECT * FROM training_route_decisions WHERE session_id = ?1 ORDER BY decision_revision').bind(sessionId).all<DecisionRow>();
 const history = (rows.results || []).map(row => projectDecision(row, offer));
 const decision = history.at(-1) || null;
 return { status: decision ? 'SELECTED' : 'AWAITING_CHOICE', offer, decision, history };
}
export async function reviseTrainingRoute(db: D1Database, owner: string, sessionId: string, input: { selectedRoute: TrainingRoute; expectedRevision: number; mutationKey: string }): Promise<TrainingRouteProjection> {
 if (!isTrainingRoute(input.selectedRoute) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[A-Za-z0-9_-]{8,100}$/.test(input.mutationKey)) throw new TrainingRouteError(400, 'TRAINING_ROUTE_INPUT_INVALID');
 const session = await ownedSession(db, owner, sessionId);
 if (session.learning_route_version !== 1) throw new TrainingRouteError(409, 'TRAINING_ROUTE_NOT_ENABLED');
 const offer = await loadOffer(db, owner, sessionId);
 const replay = await db.prepare('SELECT * FROM training_route_decisions WHERE session_id = ?1 AND mutation_key = ?2').bind(sessionId, input.mutationKey).first<DecisionRow>();
 if (replay) {
  if (replay.selected_route !== input.selectedRoute || replay.expected_revision !== input.expectedRevision) throw new TrainingRouteError(409, 'TRAINING_ROUTE_IDEMPOTENCY_CONFLICT');
  return { status: 'SELECTED', offer, decision: projectDecision(replay, offer) };
 }
 await assertTrainingNotStopped(db,sessionId);
 if (session.is_completed) throw new TrainingRouteError(409, 'TRAINING_ROUTE_COMPLETED');
 const decisionId = crypto.randomUUID();
 const createdAt = Date.now();
 try {
  await db.prepare(`INSERT INTO training_route_decisions (id, session_id, owner_user_id, decision_revision, selected_route, effective_from_turn, mutation_key, expected_revision, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(decisionId, sessionId, owner, input.expectedRevision + 1, input.selectedRoute, session.current_turn, input.mutationKey, input.expectedRevision, createdAt).run();
 } catch (error) {
  if (/TRAINING_ROUTE_CONFLICT|UNIQUE constraint/.test(String(error))) {
   // Compare the entire normalized request tuple; a digest adds no information.
   const committed = await db.prepare('SELECT * FROM training_route_decisions WHERE session_id = ?1 AND mutation_key = ?2').bind(sessionId, input.mutationKey).first<DecisionRow>();
   if (committed) {
    if (committed.selected_route !== input.selectedRoute || committed.expected_revision !== input.expectedRevision) throw new TrainingRouteError(409, 'TRAINING_ROUTE_IDEMPOTENCY_CONFLICT');
    return { status: 'SELECTED', offer, decision: projectDecision(committed, offer) };
   }
   throw new TrainingRouteError(409, 'TRAINING_ROUTE_CONFLICT');
  }
  throw error;
 }
 return { status: 'SELECTED', offer, decision: projectDecision({ id: decisionId, decision_revision: input.expectedRevision + 1, selected_route: input.selectedRoute, effective_from_turn: session.current_turn, created_at: createdAt, mutation_key: input.mutationKey, expected_revision: input.expectedRevision }, offer) };
}

export function trainingRouteDirective(decision: TrainingRouteDecision | null | undefined): string {
 if (!decision) return '';
 const option = decision.offer.options.find(o => o.route === decision.selectedRoute)!;
 return `\n\n## Task-local learning order (not a learner type)\n${JSON.stringify({ decisionId: decision.id, revision: decision.revision, selectedRoute: decision.selectedRoute, applicability: decision.supportStatus, efficacy: 'UNKNOWN', target: decision.offer.target, rationale: option.rationale, evidenceRefs: option.evidenceRefs, alternatives: option.alternatives })}\n${decision.supportStatus === 'TASK_SUPPORTED' ? 'Use this order of presentation while following the selected tutor action and safety/correction requirements.' : 'Applicability is UNKNOWN. Preserve the preference in the record but use the ordinary tutor policy.'} Never lower the rubric or target depth, infer a permanent learning style, or describe route efficacy as measured.`;
}

/** A presentation preference for healthy introductory turns, subordinate to remediation. */
export function trainingRouteActionPreference(decision: TrainingRouteDecision | null | undefined, base: TutorAction, evaluation: DeepEvaluation, state: TutorState): { initial: TutorAction; candidates: TutorAction[] | null } {
 if (!decision || decision.supportStatus !== 'TASK_SUPPORTED' || decision.selectedRoute === 'mixed' || !['elicitation', 'grounding'].includes(state)
  || Math.min(evaluation.claim_clarity, evaluation.evidence_use, evaluation.reasoning_strength, evaluation.consistency, evaluation.relevance) <= 2
  || !['ask_evidence', 'ask_reasoning', 'ask_clarification', 'request_text_reference', 'ask_counterexample'].includes(base)) return { initial: base, candidates: null };
 const preferred: TutorAction = decision.selectedRoute === 'case-first' ? 'ask_evidence' : 'ask_reasoning';
 return { initial: preferred, candidates: [...new Set([preferred, base])] };
}
