import type { Bindings } from '../types';
import {
  configuredAIRouteIdsForLane,
  isAIRouteAllowedForLane,
  type AIRouteId,
  type AIRouteLane,
} from './ai-router';

const EXECUTION_LANES = [
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
  'background_reasoning',
] as const satisfies readonly AIRouteLane[];

export type LearningSessionContextErrorCode =
  | 'CONTEXT_NOT_FOUND'
  | 'CONTEXT_ALREADY_EXISTS'
  | 'CONTEXT_OWNER_REQUIRED'
  | 'CONTEXT_OPENING_EVIDENCE_REQUIRED'
  | 'MALFORMED_CONTEXT'
  | 'MALFORMED_ROUTE_PLAN'
  | 'INVALID_ROUTE_PLAN'
  | 'CONTEXT_WRITE_FAILED';

export class LearningSessionContextError extends Error {
  constructor(readonly code: LearningSessionContextErrorCode) {
    super(code);
    this.name = 'LearningSessionContextError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type PinnedLaneRoutePlan = Readonly<{
  [Lane in AIRouteLane]: readonly AIRouteId[];
}>;

export interface SessionExecutionContext {
  id: string;
  sessionKind: 'SPARRING';
  sessionId: string;
  context: {
    kind: 'GROWTH_LAB';
    subjectId: string;
    authorityCapabilities: readonly string[];
    policyRevision: string;
  };
  corpus: {
    bindingId: string;
    manifestRevision: string;
  };
  routes: PinnedLaneRoutePlan;
  promptCacheNamespace: string;
  evidencePolicyRevision: string;
  status: 'ACTIVE';
  createdAt: number;
  updatedAt: number;
}

export interface CreateGrowthLabSparringContextInput {
  db: D1Database;
  id?: string;
  sessionId: string;
  ownerUserId: string;
  subjectId: string;
  authorityCapabilities: readonly string[];
  contextPolicyRevision: string;
  corpusBindingId: string;
  corpusManifestRevision: string;
  routes: PinnedLaneRoutePlan;
  promptCacheNamespace: string;
  evidencePolicyRevision: string;
  now?: number;
}

interface LearningSessionContextRow {
  id: unknown;
  session_kind: unknown;
  session_id: unknown;
  owner_user_id: unknown;
  context_kind: unknown;
  subject_id: unknown;
  authority_capabilities_json: unknown;
  context_policy_revision: unknown;
  corpus_binding_id: unknown;
  corpus_manifest_revision: unknown;
  route_plan_json: unknown;
  prompt_cache_namespace: unknown;
  evidence_policy_revision: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: LearningSessionContextErrorCode): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LearningSessionContextError(code);
  }
  return value;
}

function requiredTimestamp(value: unknown): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new LearningSessionContextError('MALFORMED_CONTEXT');
  }
  return timestamp;
}

function freezeRoutePlan(plan: {
  [Lane in AIRouteLane]: readonly AIRouteId[];
}): PinnedLaneRoutePlan {
  return Object.freeze({
    interactive_generation: Object.freeze([...plan.interactive_generation]),
    learner_evaluation: Object.freeze([...plan.learner_evaluation]),
    release_critic: Object.freeze([...plan.release_critic]),
    background_reasoning: Object.freeze([...plan.background_reasoning]),
  });
}

function validateRoutePlan(value: unknown): PinnedLaneRoutePlan {
  if (!isPlainObject(value)) throw new LearningSessionContextError('MALFORMED_ROUTE_PLAN');

  const plan = {} as { [Lane in AIRouteLane]: readonly AIRouteId[] };
  for (const lane of EXECUTION_LANES) {
    const routeIds = value[lane];
    if (!Array.isArray(routeIds) || routeIds.some((routeId) => typeof routeId !== 'string')) {
      throw new LearningSessionContextError('MALFORMED_ROUTE_PLAN');
    }
    const uniqueRouteIds = new Set<string>();
    const validatedRouteIds: AIRouteId[] = [];
    for (const routeId of routeIds) {
      if (!isAIRouteAllowedForLane(routeId, lane) || uniqueRouteIds.has(routeId)) {
        throw new LearningSessionContextError('INVALID_ROUTE_PLAN');
      }
      uniqueRouteIds.add(routeId);
      validatedRouteIds.push(routeId);
    }
    plan[lane] = validatedRouteIds;
  }

  return freezeRoutePlan(plan);
}

function parseCapabilities(serialized: unknown): readonly string[] {
  if (typeof serialized !== 'string') throw new LearningSessionContextError('MALFORMED_CONTEXT');
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.some((capability) => typeof capability !== 'string' || capability.trim().length === 0)) {
      throw new LearningSessionContextError('MALFORMED_CONTEXT');
    }
    return Object.freeze([...value]);
  } catch (error) {
    if (error instanceof LearningSessionContextError) throw error;
    throw new LearningSessionContextError('MALFORMED_CONTEXT');
  }
}

function parseRoutePlan(serialized: unknown): PinnedLaneRoutePlan {
  if (typeof serialized !== 'string') throw new LearningSessionContextError('MALFORMED_ROUTE_PLAN');
  try {
    return validateRoutePlan(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof LearningSessionContextError) throw error;
    throw new LearningSessionContextError('MALFORMED_ROUTE_PLAN');
  }
}

function freezeContext(context: SessionExecutionContext): SessionExecutionContext {
  return Object.freeze({
    ...context,
    context: Object.freeze({
      ...context.context,
      authorityCapabilities: Object.freeze([...context.context.authorityCapabilities]),
    }),
    corpus: Object.freeze({ ...context.corpus }),
    routes: freezeRoutePlan(context.routes),
  });
}

function contextFromRow(row: LearningSessionContextRow): SessionExecutionContext {
  const sessionKind = requiredString(row.session_kind, 'MALFORMED_CONTEXT');
  const contextKind = requiredString(row.context_kind, 'MALFORMED_CONTEXT');
  const status = requiredString(row.status, 'MALFORMED_CONTEXT');
  if (sessionKind !== 'SPARRING' || contextKind !== 'GROWTH_LAB' || status !== 'ACTIVE') {
    throw new LearningSessionContextError('MALFORMED_CONTEXT');
  }

  return freezeContext({
    id: requiredString(row.id, 'MALFORMED_CONTEXT'),
    sessionKind,
    sessionId: requiredString(row.session_id, 'MALFORMED_CONTEXT'),
    context: {
      kind: contextKind,
      subjectId: requiredString(row.subject_id, 'MALFORMED_CONTEXT'),
      authorityCapabilities: parseCapabilities(row.authority_capabilities_json),
      policyRevision: requiredString(row.context_policy_revision, 'MALFORMED_CONTEXT'),
    },
    corpus: {
      bindingId: requiredString(row.corpus_binding_id, 'MALFORMED_CONTEXT'),
      manifestRevision: requiredString(row.corpus_manifest_revision, 'MALFORMED_CONTEXT'),
    },
    routes: parseRoutePlan(row.route_plan_json),
    promptCacheNamespace: requiredString(row.prompt_cache_namespace, 'MALFORMED_CONTEXT'),
    evidencePolicyRevision: requiredString(row.evidence_policy_revision, 'MALFORMED_CONTEXT'),
    status,
    createdAt: requiredTimestamp(row.created_at),
    updatedAt: requiredTimestamp(row.updated_at),
  });
}

function mapContextWriteError(error: unknown): LearningSessionContextError {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LEARNING_SESSION_CONTEXT_ALREADY_EXISTS')) {
    return new LearningSessionContextError('CONTEXT_ALREADY_EXISTS');
  }
  if (message.includes('LEARNING_SESSION_CONTEXT_SESSION_OWNER_REQUIRED')) {
    return new LearningSessionContextError('CONTEXT_OWNER_REQUIRED');
  }
  if (message.includes('LEARNING_SESSION_CONTEXT_OPENING_MANIFEST_REQUIRED')) {
    return new LearningSessionContextError('CONTEXT_OPENING_EVIDENCE_REQUIRED');
  }
  return new LearningSessionContextError('CONTEXT_WRITE_FAILED');
}

/** Snapshot the currently configured routes; later credential changes cannot alter this plan. */
export function pinAIRoutePlan(env: Bindings): PinnedLaneRoutePlan {
  return freezeRoutePlan({
    interactive_generation: configuredAIRouteIdsForLane(env, 'interactive_generation'),
    learner_evaluation: configuredAIRouteIdsForLane(env, 'learner_evaluation'),
    release_critic: configuredAIRouteIdsForLane(env, 'release_critic'),
    background_reasoning: configuredAIRouteIdsForLane(env, 'background_reasoning'),
  });
}

export async function createGrowthLabSparringContext(
  input: CreateGrowthLabSparringContextInput,
): Promise<SessionExecutionContext> {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new LearningSessionContextError('MALFORMED_CONTEXT');

  const context = freezeContext({
    id: input.id ? requiredString(input.id, 'MALFORMED_CONTEXT') : crypto.randomUUID(),
    sessionKind: 'SPARRING',
    sessionId: requiredString(input.sessionId, 'MALFORMED_CONTEXT'),
    context: {
      kind: 'GROWTH_LAB',
      subjectId: requiredString(input.subjectId, 'MALFORMED_CONTEXT'),
      authorityCapabilities: Object.freeze(input.authorityCapabilities.map((capability) => (
        requiredString(capability, 'MALFORMED_CONTEXT')
      ))),
      policyRevision: requiredString(input.contextPolicyRevision, 'MALFORMED_CONTEXT'),
    },
    corpus: {
      bindingId: requiredString(input.corpusBindingId, 'MALFORMED_CONTEXT'),
      manifestRevision: requiredString(input.corpusManifestRevision, 'MALFORMED_CONTEXT'),
    },
    routes: validateRoutePlan(input.routes),
    promptCacheNamespace: requiredString(input.promptCacheNamespace, 'MALFORMED_CONTEXT'),
    evidencePolicyRevision: requiredString(input.evidencePolicyRevision, 'MALFORMED_CONTEXT'),
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  try {
    await input.db.prepare(`
      INSERT INTO learning_session_contexts (
        id, session_kind, session_id, owner_user_id, context_kind, subject_id,
        authority_capabilities_json, context_policy_revision, corpus_binding_id,
        corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
        evidence_policy_revision, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `).bind(
      context.id,
      context.sessionKind,
      context.sessionId,
      requiredString(input.ownerUserId, 'MALFORMED_CONTEXT'),
      context.context.kind,
      context.context.subjectId,
      JSON.stringify(context.context.authorityCapabilities),
      context.context.policyRevision,
      context.corpus.bindingId,
      context.corpus.manifestRevision,
      JSON.stringify(context.routes),
      context.promptCacheNamespace,
      context.evidencePolicyRevision,
      context.status,
      context.createdAt,
      context.updatedAt,
    ).run();
  } catch (error) {
    if (error instanceof LearningSessionContextError) throw error;
    throw mapContextWriteError(error);
  }

  return context;
}

export async function loadOwnedSparringContext(
  db: D1Database,
  sessionId: string,
  ownerUserId: string,
): Promise<SessionExecutionContext> {
  const row = await db.prepare(`
    SELECT id, session_kind, session_id, owner_user_id, context_kind, subject_id,
           authority_capabilities_json, context_policy_revision, corpus_binding_id,
           corpus_manifest_revision, route_plan_json, prompt_cache_namespace,
           evidence_policy_revision, status, created_at, updated_at
    FROM learning_session_contexts
    WHERE session_kind = 'SPARRING' AND session_id = ?1 AND owner_user_id = ?2
    LIMIT 1
  `).bind(
    requiredString(sessionId, 'MALFORMED_CONTEXT'),
    requiredString(ownerUserId, 'MALFORMED_CONTEXT'),
  ).first<LearningSessionContextRow>();

  if (!row) throw new LearningSessionContextError('CONTEXT_NOT_FOUND');
  return contextFromRow(row);
}
