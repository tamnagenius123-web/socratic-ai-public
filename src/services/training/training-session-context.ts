import type { PinnedLaneRoutePlan } from '../learning-session-context';
import {
  isAIRouteAllowedForLane,
  type AIRouteId,
  type AIRouteLane,
} from '../ai-router';

const CONTEXT_INPUT_KEYS = [
  'createdAt',
  'evidenceManifestSha256',
  'evidencePolicyRevision',
  'ownerUserId',
  'promptCacheNamespace',
  'routes',
  'sessionId',
] as const;

const EXECUTION_LANES = [
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
  'background_reasoning',
] as const satisfies readonly AIRouteLane[];

export type TrainingSessionContextErrorCode =
  | 'CONTEXT_NOT_FOUND'
  | 'MALFORMED_CONTEXT'
  | 'MALFORMED_ROUTE_PLAN'
  | 'INVALID_ROUTE_PLAN';

export class TrainingSessionContextError extends Error {
  constructor(readonly code: TrainingSessionContextErrorCode) {
    super(code);
    this.name = 'TrainingSessionContextError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface TrainingSessionContext {
  id: string;
  sessionId: string;
  ownerUserId: string;
  evidenceManifestSha256: string;
  routes: PinnedLaneRoutePlan;
  promptCacheNamespace: string;
  evidencePolicyRevision: string;
  status: 'ACTIVE';
  createdAt: number;
  updatedAt: number;
}

export interface CreateTrainingSessionContextInput {
  sessionId: string;
  ownerUserId: string;
  evidenceManifestSha256: string;
  routes: PinnedLaneRoutePlan;
  promptCacheNamespace: string;
  evidencePolicyRevision: string;
  createdAt: number;
}

interface TrainingSessionContextRow {
  id: unknown;
  session_id: unknown;
  owner_user_id: unknown;
  evidence_manifest_sha256: unknown;
  route_plan_json: unknown;
  prompt_cache_namespace: unknown;
  evidence_policy_revision: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactInput(value: unknown): asserts value is CreateTrainingSessionContextInput {
  if (!isRecord(value)) throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
  const sorted = (keys as string[]).sort();
  if (sorted.length !== CONTEXT_INPUT_KEYS.length
    || sorted.some((key, index) => key !== CONTEXT_INPUT_KEYS[index])) {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
  return value;
}

function requiredTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
  return value as number;
}

function freezeRoutePlan(plan: { [Lane in AIRouteLane]: readonly AIRouteId[] }): PinnedLaneRoutePlan {
  return Object.freeze({
    interactive_generation: Object.freeze([...plan.interactive_generation]),
    learner_evaluation: Object.freeze([...plan.learner_evaluation]),
    release_critic: Object.freeze([...plan.release_critic]),
    background_reasoning: Object.freeze([...plan.background_reasoning]),
  });
}

function validateRoutePlan(value: unknown): PinnedLaneRoutePlan {
  if (!isRecord(value)) throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
  }
  const sorted = (keys as string[]).sort();
  const expected = [...EXECUTION_LANES].sort();
  if (sorted.length !== expected.length || sorted.some((key, index) => key !== expected[index])) {
    throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
  }

  const plan = {} as { [Lane in AIRouteLane]: readonly AIRouteId[] };
  for (const lane of EXECUTION_LANES) {
    const routeIds = value[lane];
    if (!Array.isArray(routeIds) || routeIds.some((routeId) => typeof routeId !== 'string')) {
      throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
    }
    const unique = new Set<string>();
    const accepted: AIRouteId[] = [];
    for (const routeId of routeIds) {
      if (!isAIRouteAllowedForLane(routeId, lane) || unique.has(routeId)) {
        throw new TrainingSessionContextError('INVALID_ROUTE_PLAN');
      }
      unique.add(routeId);
      accepted.push(routeId);
    }
    plan[lane] = accepted;
  }
  return freezeRoutePlan(plan);
}

function parseRoutePlan(value: unknown): PinnedLaneRoutePlan {
  if (typeof value !== 'string') throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
  try {
    return validateRoutePlan(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof TrainingSessionContextError) throw error;
    throw new TrainingSessionContextError('MALFORMED_ROUTE_PLAN');
  }
}

function freezeContext(context: TrainingSessionContext): TrainingSessionContext {
  return Object.freeze({ ...context, routes: freezeRoutePlan(context.routes) });
}

function contextFromRow(row: TrainingSessionContextRow): TrainingSessionContext {
  const manifest = requiredString(row.evidence_manifest_sha256);
  if (!/^[a-f0-9]{64}$/.test(manifest) || row.status !== 'ACTIVE') {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
  const createdAt = requiredTimestamp(row.created_at);
  const updatedAt = requiredTimestamp(row.updated_at);
  if (createdAt !== updatedAt) throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  return freezeContext({
    id: requiredString(row.id),
    sessionId: requiredString(row.session_id),
    ownerUserId: requiredString(row.owner_user_id),
    evidenceManifestSha256: manifest,
    routes: parseRoutePlan(row.route_plan_json),
    promptCacheNamespace: requiredString(row.prompt_cache_namespace),
    evidencePolicyRevision: requiredString(row.evidence_policy_revision),
    status: 'ACTIVE',
    createdAt,
    updatedAt,
  });
}

export function prepareTrainingSessionContext(
  db: D1Database,
  input: CreateTrainingSessionContextInput,
): Readonly<{ context: TrainingSessionContext; statement: D1PreparedStatement }> {
  assertExactInput(input);
  const manifest = requiredString(input.evidenceManifestSha256);
  if (!/^[a-f0-9]{64}$/.test(manifest)) {
    throw new TrainingSessionContextError('MALFORMED_CONTEXT');
  }
  const createdAt = requiredTimestamp(input.createdAt);
  const context = freezeContext({
    id: `trctx_${crypto.randomUUID()}`,
    sessionId: requiredString(input.sessionId),
    ownerUserId: requiredString(input.ownerUserId),
    evidenceManifestSha256: manifest,
    routes: validateRoutePlan(input.routes),
    promptCacheNamespace: requiredString(input.promptCacheNamespace),
    evidencePolicyRevision: requiredString(input.evidencePolicyRevision),
    status: 'ACTIVE',
    createdAt,
    updatedAt: createdAt,
  });
  const statement = db.prepare(`
    INSERT INTO training_session_contexts (
      id, session_id, owner_user_id, evidence_manifest_sha256,
      route_plan_json, prompt_cache_namespace, evidence_policy_revision,
      status, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
  `).bind(
    context.id,
    context.sessionId,
    context.ownerUserId,
    context.evidenceManifestSha256,
    JSON.stringify(context.routes),
    context.promptCacheNamespace,
    context.evidencePolicyRevision,
    context.status,
    context.createdAt,
    context.updatedAt,
  );
  return Object.freeze({ context, statement });
}

export async function loadOwnedTrainingSessionContext(
  db: D1Database,
  sessionId: string,
  ownerUserId: string,
): Promise<TrainingSessionContext> {
  const row = await db.prepare(`
    SELECT id, session_id, owner_user_id, evidence_manifest_sha256,
           route_plan_json, prompt_cache_namespace, evidence_policy_revision,
           status, created_at, updated_at
    FROM training_session_contexts
    WHERE session_id = ?1 AND owner_user_id = ?2
    LIMIT 1
  `).bind(requiredString(sessionId), requiredString(ownerUserId)).first<TrainingSessionContextRow>();
  if (!row) throw new TrainingSessionContextError('CONTEXT_NOT_FOUND');
  return contextFromRow(row);
}
