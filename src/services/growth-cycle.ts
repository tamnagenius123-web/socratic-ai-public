import { loadOwnedSparringContext } from './learning-session-context';
import { FOLLOW_UP_PROTOCOL_REVISION, ASSISTANCE_CAPTURE_POLICY_REVISION, SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION, SPARRING_ASSISTANCE_RECORD_REVISION, projectFollowUpProtocol, type FollowUpProtocolRow } from './growth-follow-up-protocol';
import { loadOwnedFollowUpLaunch, hasFollowUpLaunchSchema, requireFollowUpProtocolSchema, followUpTables } from './growth-follow-up';
import { loadOwnedTrainingSessionContext } from './training/training-session-context';
import type {
  GapResponseInput,
  GrowthCycleDetail,
  GrowthCycleSecurity,
  GrowthCycleSummary,
  GrowthFocusProjection,
  GrowthFocusInput,
  GrowthGapHypothesisProjection,
  HumanReviewRequestV1,
  GrowthOriginKind,
  GrowthObservationProjection,
  GrowthPracticeQuestProjection,
  GrowthPrivateConsentProjection,
  GrowthRecheckProjection,
  GrowthSpaceProjection,
  GrowthState,
  GrowthTimelineEventProjection,
  ListGrowthCyclesFilters,
  OpenGrowthCycleInput,
  PracticeResponseInput,
  PrivateSoloConsentInput,
  RecordRecheckInput,
  GrowthHttpStatus,
} from './growth-cycle-types';
import { GrowthServiceError } from './growth-cycle-types';
import { compareRecheckContexts } from './growth-recheck-context';
import { captureRecheckAssistance, captureSparringRecheckAssistance, projectRecheckAssistance } from './growth-recheck-assistance';

export { GrowthServiceError } from './growth-cycle-types';
export type * from './growth-cycle-types';

type Row = Record<string, unknown>;
type MutationResult = Record<string, unknown>;
type ResultResourceType = 'CONSENT_RECEIPT' | 'GROWTH_SPACE' | 'GROWTH_CYCLE' | 'GROWTH_DELETION_RECEIPT';
type SubjectType = 'GAP_HYPOTHESIS' | 'FOCUS_SELECTION' | 'PRACTICE_QUEST' | 'RECHECK';
type Subject = readonly [SubjectType, string];

type Cycle = {
  id: string;
  space_id: string;
  participant_membership_id: string;
  path_revision_id: string;
  consent_receipt_id: string;
  state: GrowthState;
  aggregate_revision: number;
  origin_kind: GrowthOriginKind;
  origin_attempt_id: string;
  origin_turn_number: number | null;
  origin_event_identity: string;
  origin_lookup_digest: string;
  origin_request_digest: string;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
};

type Member = {
  id: string;
  space_id: string;
  pseudonym_id: string;
  policy_revision: number;
  consent_receipt_id: string;
};

type Signal = {
  reason: string;
  capabilityCode: string | null;
  value: number | null;
  ties: string[];
  payload: Row;
};

type Origin = {
  kind: GrowthOriginKind;
  attemptId: string;
  turn: number;
  identity: string;
  pathId: string;
  capabilityId: string;
  observationRuleId: string;
  observationRuleRevision: number;
  gapRuleId: string;
  gapRuleRevision: number;
  focusPracticeRuleId: string;
  payload: Row;
  signal: Signal;
};

type ReceiptPlan = { id: string; statements: D1PreparedStatement[] };
type RawEvidencePlan = { id: string; payloadDigest: string; statements: D1PreparedStatement[] };
type UnknownEvidencePlan = { observationId: string; hypothesisId: string; statements: D1PreparedStatement[] };
type LifecyclePlan = { toState: GrowthState; response: MutationResult; statements: D1PreparedStatement[] };
type ExistingOpenOrigin = { id: string; origin_request_digest: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ROUTE = {
  consent: 'POST:/api/growth/privacy/consent',
  revoke: 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke',
  space: 'POST:/api/growth/spaces/solo',
  open: 'POST:/api/growth/spaces/:spaceId/cycles',
  gap: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response',
  focus: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/focus',
  practice: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response',
  followUpLaunch: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/recheck-follow-up-launches',
  recheck: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks',
  humanReview: 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests',
  system: 'SYSTEM:GROWTH_CYCLE',
  raw: 'SYSTEM:GROWTH_EVIDENCE',
  deletion: 'DELETE_GROWTH_CYCLE',
} as const;

const AXES = ['claim_clarity', 'evidence_use', 'reasoning_strength', 'consistency', 'relevance'] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

type ReceiptSchema = {
  hasExpectedRevision: boolean;
  hasReplayColumns: boolean;
};

type CycleSchema = { hasOriginDigests: boolean };
type DeletionSchema = {
  hasCurrentIdempotencyColumns: boolean;
  hasLegacyReceiptRetryLookup: boolean;
  hasLegacyContextRetryLookup: boolean;
};
type LifecycleSchema = { hasContractColumns: boolean };
type EventSchema = { hasMutationReceiptId: boolean; hasTransitionSubject: boolean };
type HypothesisSchema = { hasRevisionLineage: boolean };
type FocusSchema = { hasSelectionKind: boolean };
type RecheckSchema = { hasObservationLinks: boolean };

const receiptSchemaCache = new WeakMap<D1Database, Promise<ReceiptSchema>>();
const cycleSchemaCache = new WeakMap<D1Database, Promise<CycleSchema>>();
const deletionSchemaCache = new WeakMap<D1Database, Promise<DeletionSchema>>();
const lifecycleSchemaCache = new WeakMap<D1Database, Promise<LifecycleSchema>>();
const eventSchemaCache = new WeakMap<D1Database, Promise<EventSchema>>();
const hypothesisSchemaCache = new WeakMap<D1Database, Promise<HypothesisSchema>>();
const focusSchemaCache = new WeakMap<D1Database, Promise<FocusSchema>>();
const recheckSchemaCache = new WeakMap<D1Database, Promise<RecheckSchema>>();

function fail(
  status: GrowthHttpStatus,
  code: string,
  phase: GrowthServiceError['phase'],
  retryable = false,
  details?: Row,
): never {
  throw new GrowthServiceError({ status, code, phase, retryable, details });
}

function now(): number {
  return Date.now();
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function isState(value: unknown): value is GrowthState {
  return typeof value === 'string' && [
    'EVIDENCE_PENDING', 'GAP_PROPOSED', 'GAP_ACCEPTED', 'GAP_CONTESTED', 'GAP_DISMISSED',
    'GAP_DEFERRED', 'GAP_UNKNOWN', 'FOCUS_SELECTED', 'PRACTICE_OFFERED', 'PRACTICE_ACCEPTED',
    'PRACTICE_DECLINED', 'PRACTICE_DEFERRED', 'RECHECK_SCHEDULED', 'RECHECKED',
    'TRANSFER_PENDING', 'CLOSED',
  ].includes(value);
}

function requireIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) fail(400, 'GROWTH_IDEMPOTENCY_KEY_INVALID', 'validation');
}

/** Recursively sorted JSON encoded as UTF-8. It intentionally rejects coercible values. */
function canonical(value: unknown): Uint8Array {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(400, 'GROWTH_CANONICAL_VALUE_INVALID', 'validation');
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Row)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    fail(400, 'GROWTH_CANONICAL_VALUE_INVALID', 'validation');
  };
  return encoder.encode(JSON.stringify(visit(value)));
}

function canonicalText(value: unknown): string {
  return decoder.decode(canonical(value));
}

function canonicalResponse(value: MutationResult): MutationResult {
  const parsed = parseObject(canonicalText(value));
  if (!parsed) fail(500, 'GROWTH_CANONICAL_RESPONSE_INVALID', 'policy');
  return parsed;
}

async function hmac(security: GrowthCycleSecurity, purpose: string, value: unknown): Promise<string> {
  let digest: string;
  try {
    digest = await security.hmacSha256(purpose, canonical(value));
  } catch {
    fail(503, 'GROWTH_SECURITY_HMAC_UNAVAILABLE', 'unavailable', true);
  }
  if (!/^[a-f0-9]{64}$/.test(digest!)) {
    fail(503, 'GROWTH_SECURITY_HMAC_UNAVAILABLE', 'unavailable', true);
  }
  return digest!;
}

/**
 * Internal receipts never concatenate a client-controlled key. The HMAC keeps
 * each sub-operation stable for a retry while remaining within the persisted
 * 128-character idempotency-key contract.
 */
async function internalIdempotencyKey(
  security: GrowthCycleSecurity,
  externalKey: string,
  operation: string,
): Promise<string> {
  requireIdempotencyKey(externalKey);
  const digest = await hmac(security, 'growth-cycle:internal-idempotency:v1', { externalKey, operation });
  return `growth-internal:${digest}`;
}

function d1ErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

function isD1Conflict(error: unknown): boolean {
  const message = d1ErrorText(error);
  return /SQLITE_CONSTRAINT|UNIQUE constraint|FOREIGN KEY constraint|CHECK constraint|constraint failed|\bGROWTH_[A-Z0-9_]+\b/i.test(message);
}

async function inspectReceiptSchema(db: D1Database): Promise<ReceiptSchema> {
  try {
    const result = await db.prepare('PRAGMA table_info(growth_mutation_receipts)').all<{ name: string }>();
    const columns = new Set((result.results ?? []).map((row) => row.name));
    const baseColumns = [
      'id', 'actor_user_id', 'route_action', 'idempotency_key', 'growth_cycle_id',
      'request_digest', 'response_digest', 'created_at', 'expires_at',
    ];
    if (baseColumns.some((column) => !columns.has(column))) {
      fail(503, 'GROWTH_RECEIPT_SCHEMA_UNSUPPORTED', 'unavailable', true);
    }
    const expectedColumns = ['expected_aggregate_revision', 'lifecycle_action'];
    const replayColumns = [
      'response_json', 'result_resource_type', 'result_resource_id', 'result_aggregate_revision',
    ];
    const hasExpectedRevision = expectedColumns.every((column) => columns.has(column));
    const hasReplayColumns = replayColumns.every((column) => columns.has(column));
    if (expectedColumns.some((column) => columns.has(column)) !== hasExpectedRevision
      || replayColumns.some((column) => columns.has(column)) !== hasReplayColumns) {
      fail(503, 'GROWTH_RECEIPT_SCHEMA_UNSUPPORTED', 'unavailable', true);
    }
    return { hasExpectedRevision, hasReplayColumns };
  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    fail(503, 'GROWTH_RECEIPT_SCHEMA_UNAVAILABLE', 'unavailable', true);
  }
}

function receiptSchema(db: D1Database): Promise<ReceiptSchema> {
  const cached = receiptSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectReceiptSchema(db);
  receiptSchemaCache.set(db, pending);
  return pending;
}

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  try {
    const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    const columns = new Set((result.results ?? []).map((row) => row.name));
    if (columns.size === 0) fail(503, 'GROWTH_SCHEMA_UNAVAILABLE', 'unavailable', true);
    return columns;
  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    fail(503, 'GROWTH_SCHEMA_UNAVAILABLE', 'unavailable', true);
  }
}

async function childFirstHypothesisDeleteStatements(
  db: D1Database,
  cycleId: string,
  hasRevisionLineage: boolean,
): Promise<D1PreparedStatement[]> {
  if (!hasRevisionLineage) {
    return [db.prepare(`DELETE FROM growth_gap_hypotheses WHERE growth_cycle_id = ?1`).bind(cycleId)];
  }
  const rows = await db.prepare(`
    SELECT id, revises_hypothesis_id
    FROM growth_gap_hypotheses
    WHERE growth_cycle_id = ?1
    ORDER BY id ASC
  `).bind(cycleId).all<{ id: string; revises_hypothesis_id: string | null }>();
  const byId = new Map<string, string | null>();
  for (const row of rows.results ?? []) {
    if (!text(row.id) || byId.has(row.id)) fail(503, 'GROWTH_HYPOTHESIS_LINEAGE_UNAVAILABLE', 'unavailable', true);
    byId.set(row.id, row.revises_hypothesis_id);
  }
  const children = new Map<string, string[]>();
  for (const [id, parentId] of byId) {
    if (parentId === null) continue;
    if (!text(parentId) || parentId === id || !byId.has(parentId)) {
      fail(503, 'GROWTH_HYPOTHESIS_LINEAGE_UNAVAILABLE', 'unavailable', true);
    }
    const list = children.get(parentId) ?? [];
    list.push(id);
    children.set(parentId, list);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail(503, 'GROWTH_HYPOTHESIS_LINEAGE_UNAVAILABLE', 'unavailable', true);
    visiting.add(id);
    for (const childId of (children.get(id) ?? []).sort()) visit(childId);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  if (order.length !== byId.size) fail(503, 'GROWTH_HYPOTHESIS_LINEAGE_UNAVAILABLE', 'unavailable', true);
  return order.map((id) => db.prepare(`DELETE FROM growth_gap_hypotheses WHERE id = ?1 AND growth_cycle_id = ?2`).bind(id, cycleId));
}

async function inspectCycleSchema(db: D1Database): Promise<CycleSchema> {
  const columns = await tableColumns(db, 'growth_cycles');
  const names = ['origin_lookup_digest', 'origin_request_digest'];
  const hasOriginDigests = names.every((name) => columns.has(name));
  if (names.some((name) => columns.has(name)) !== hasOriginDigests) {
    fail(503, 'GROWTH_CYCLE_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasOriginDigests };
}

function cycleSchema(db: D1Database): Promise<CycleSchema> {
  const cached = cycleSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectCycleSchema(db);
  cycleSchemaCache.set(db, pending);
  return pending;
}

async function inspectDeletionSchema(db: D1Database): Promise<DeletionSchema> {
  const receiptColumns = await tableColumns(db, 'growth_deletion_receipts');
  const contextColumns = await tableColumns(db, 'growth_deletion_context');
  const receiptNames = ['idempotency_lookup_digest', 'request_digest'];
  const hasCurrentReceipt = receiptNames.every((name) => receiptColumns.has(name));
  const hasCurrentContext = contextColumns.has('idempotency_lookup_digest');
  const hasLegacyReceiptRetryLookup = receiptColumns.has('retry_lookup_digest');
  const hasLegacyContextRetryLookup = contextColumns.has('retry_lookup_digest');
  if (receiptNames.some((name) => receiptColumns.has(name)) !== hasCurrentReceipt
    || hasCurrentReceipt !== hasCurrentContext
    || (!hasCurrentReceipt && hasCurrentContext)) {
    fail(503, 'GROWTH_DELETION_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasCurrentIdempotencyColumns: hasCurrentReceipt, hasLegacyReceiptRetryLookup, hasLegacyContextRetryLookup };
}

function deletionSchema(db: D1Database): Promise<DeletionSchema> {
  const cached = deletionSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectDeletionSchema(db);
  deletionSchemaCache.set(db, pending);
  return pending;
}

async function inspectLifecycleSchema(db: D1Database): Promise<LifecycleSchema> {
  const columns = await tableColumns(db, 'growth_lifecycle_transitions');
  const names = ['actor_class', 'route_action'];
  const hasContractColumns = names.every((name) => columns.has(name));
  if (names.some((name) => columns.has(name)) !== hasContractColumns) {
    fail(503, 'GROWTH_LIFECYCLE_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasContractColumns };
}

function lifecycleSchema(db: D1Database): Promise<LifecycleSchema> {
  const cached = lifecycleSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectLifecycleSchema(db);
  lifecycleSchemaCache.set(db, pending);
  return pending;
}

async function inspectEventSchema(db: D1Database): Promise<EventSchema> {
  const columns = await tableColumns(db, 'growth_events');
  const transitionNames = ['transition_subject_type', 'transition_subject_id'];
  const hasTransitionSubject = transitionNames.every((name) => columns.has(name));
  if (transitionNames.some((name) => columns.has(name)) !== hasTransitionSubject) {
    fail(503, 'GROWTH_EVENT_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasMutationReceiptId: columns.has('mutation_receipt_id'), hasTransitionSubject };
}

function eventSchema(db: D1Database): Promise<EventSchema> {
  const cached = eventSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectEventSchema(db);
  eventSchemaCache.set(db, pending);
  return pending;
}

async function inspectHypothesisSchema(db: D1Database): Promise<HypothesisSchema> {
  const columns = await tableColumns(db, 'growth_gap_hypotheses');
  const names = ['revises_hypothesis_id', 'revision_rationale'];
  const hasRevisionLineage = names.every((name) => columns.has(name));
  if (names.some((name) => columns.has(name)) !== hasRevisionLineage) {
    fail(503, 'GROWTH_HYPOTHESIS_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasRevisionLineage };
}

function hypothesisSchema(db: D1Database): Promise<HypothesisSchema> {
  const cached = hypothesisSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectHypothesisSchema(db);
  hypothesisSchemaCache.set(db, pending);
  return pending;
}

async function inspectFocusSchema(db: D1Database): Promise<FocusSchema> {
  const columns = await tableColumns(db, 'growth_focus_selections');
  return { hasSelectionKind: columns.has('selection_kind') };
}

function focusSchema(db: D1Database): Promise<FocusSchema> {
  const cached = focusSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectFocusSchema(db);
  focusSchemaCache.set(db, pending);
  return pending;
}

async function inspectRecheckSchema(db: D1Database): Promise<RecheckSchema> {
  const columns = await tableColumns(db, 'growth_rechecks');
  const names = ['opening_observation_id', 'recheck_observation_id'];
  const hasObservationLinks = names.every((name) => columns.has(name));
  if (names.some((name) => columns.has(name)) !== hasObservationLinks) {
    fail(503, 'GROWTH_RECHECK_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  return { hasObservationLinks };
}

function recheckSchema(db: D1Database): Promise<RecheckSchema> {
  const cached = recheckSchemaCache.get(db);
  if (cached) return cached;
  const pending = inspectRecheckSchema(db);
  recheckSchemaCache.set(db, pending);
  return pending;
}

/** D1 trigger/constraint failures are state conflicts; transport/runtime failures remain unavailable. */
async function commitBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    if (isD1Conflict(error)) fail(409, 'GROWTH_PERSISTENCE_CONFLICT', 'conflict', true);
    fail(503, 'GROWTH_PERSISTENCE_UNAVAILABLE', 'unavailable', true);
  }
}

function parseObject(value: unknown): Row | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : null;
  } catch {
    return null;
  }
}

function receiptCorrupt(): never {
  fail(503, 'GROWTH_RECEIPT_CORRUPT', 'unavailable', true);
}

function receiptResponse(value: unknown): Row {
  const parsed = parseObject(value);
  if (!parsed) return receiptCorrupt();
  return parsed;
}

function validateReplayResult(row: {
  result_resource_type: unknown;
  result_resource_id: unknown;
  result_aggregate_revision: unknown;
}, response: Row): void {
  const resourceType = row.result_resource_type;
  const resourceId = row.result_resource_id;
  const revision = finiteInteger(row.result_aggregate_revision);
  if (typeof resourceId !== 'string' || !resourceId || revision === null || revision < 0) receiptCorrupt();
  if (resourceType === 'GROWTH_CYCLE') {
    if (response.cycleId !== resourceId || finiteInteger(response.aggregateRevision) !== revision || !isState(response.state)) receiptCorrupt();
    return;
  }
  if (resourceType === 'CONSENT_RECEIPT') {
    if (response.consentReceiptId !== resourceId || finiteInteger(response.policyRevision) !== revision) receiptCorrupt();
    return;
  }
  if (resourceType === 'GROWTH_SPACE') {
    if (response.spaceId !== resourceId || revision !== 1) receiptCorrupt();
    return;
  }
  if (resourceType === 'GROWTH_DELETION_RECEIPT') {
    if (response.deletionReceiptId !== resourceId) receiptCorrupt();
    return;
  }
  receiptCorrupt();
}

async function replay(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  routeAction: string,
  idempotencyKey: string,
  request: unknown,
): Promise<MutationResult | null> {
  requireIdempotencyKey(idempotencyKey);
  const schema = await receiptSchema(db);
  const stored = await db.prepare(schema.hasReplayColumns ? `
    SELECT request_digest, response_digest, response_json, result_resource_type,
      result_resource_id, result_aggregate_revision
    FROM growth_mutation_receipts
    WHERE actor_user_id = ?1 AND route_action = ?2 AND idempotency_key = ?3
  ` : `
    SELECT receipt.request_digest, receipt.response_digest, payload.response_json,
      payload.result_resource_type, payload.result_resource_id, payload.result_aggregate_revision
    FROM growth_mutation_receipts receipt
    LEFT JOIN growth_mutation_receipt_replay_payloads payload ON payload.mutation_receipt_id = receipt.id
    WHERE receipt.actor_user_id = ?1 AND receipt.route_action = ?2 AND receipt.idempotency_key = ?3
  `).bind(userId, routeAction, idempotencyKey).first<{
    request_digest: string;
    response_digest: string;
    response_json: string;
    result_resource_type: string;
    result_resource_id: string;
    result_aggregate_revision: number;
  }>();
  if (!stored) return null;
  if (stored.request_digest !== await hmac(security, 'growth-cycle:request:v1', request)) {
    fail(409, 'GROWTH_IDEMPOTENCY_INPUT_CONFLICT', 'conflict');
  }
  const response = receiptResponse(stored.response_json);
  if (stored.response_digest !== await hmac(security, 'growth-cycle:response:v1', response)) receiptCorrupt();
  validateReplayResult(stored, response);
  return response;
}

async function receiptStatement(
  db: D1Database,
  security: GrowthCycleSecurity,
  input: {
    userId: string;
    routeAction: string;
    idempotencyKey: string;
    cycleId: string | null;
    expectedRevision: number;
    lifecycleAction: string | null;
    request: unknown;
    response: MutationResult;
    resultType: ResultResourceType;
    resultId: string;
    resultRevision: number;
    createdAt: number;
  },
): Promise<ReceiptPlan> {
  requireIdempotencyKey(input.idempotencyKey);
  const schema = await receiptSchema(db);
  const receiptId = id('growth-receipt');
  const requestDigest = await hmac(security, 'growth-cycle:request:v1', input.request);
  const responseDigest = await hmac(security, 'growth-cycle:response:v1', input.response);
  const parentColumns = [
    'id', 'actor_user_id', 'route_action', 'idempotency_key', 'growth_cycle_id',
    ...(schema.hasExpectedRevision ? ['expected_aggregate_revision', 'lifecycle_action'] : []),
    'request_digest', 'response_digest',
    ...(schema.hasReplayColumns
      ? ['response_json', 'result_resource_type', 'result_resource_id', 'result_aggregate_revision']
      : []),
    'created_at',
  ];
  const parentValues = [
    receiptId, input.userId, input.routeAction, input.idempotencyKey, input.cycleId,
    ...(schema.hasExpectedRevision ? [input.expectedRevision, input.lifecycleAction] : []),
    requestDigest, responseDigest,
    ...(schema.hasReplayColumns
      ? [canonicalText(input.response), input.resultType, input.resultId, input.resultRevision]
      : []),
    input.createdAt,
  ];
  const statements = [db.prepare(`
    INSERT INTO growth_mutation_receipts (${parentColumns.join(', ')})
    VALUES (${parentColumns.map((_, index) => `?${index + 1}`).join(', ')})
  `).bind(...parentValues)];
  if (!schema.hasReplayColumns) {
    statements.push(db.prepare(`
      INSERT INTO growth_mutation_receipt_replay_payloads (
        mutation_receipt_id, expected_aggregate_revision, lifecycle_action,
        response_json, result_resource_type, result_resource_id, result_aggregate_revision, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(
      receiptId, input.expectedRevision, input.lifecycleAction, canonicalText(input.response),
      input.resultType, input.resultId, input.resultRevision, input.createdAt,
    ));
  }
  return {
    id: receiptId,
    statements,
  };
}

async function existingOpenOrigin(db: D1Database, lookupDigest: string): Promise<ExistingOpenOrigin | null> {
  const schema = await cycleSchema(db);
  return db.prepare(schema.hasOriginDigests ? `
    SELECT id, origin_request_digest
    FROM growth_cycles WHERE origin_lookup_digest = ?1
  ` : `
    SELECT cycle.id, identity.origin_request_digest
    FROM growth_cycle_origin_identities identity
    INNER JOIN growth_cycles cycle ON cycle.id = identity.growth_cycle_id
    WHERE identity.origin_lookup_digest = ?1
  `).bind(lookupDigest).first<ExistingOpenOrigin>();
}

async function canonicalExistingOpenResponse(
  db: D1Database,
  security: GrowthCycleSecurity,
  existing: ExistingOpenOrigin,
  originRequestDigest: string,
  request: unknown,
): Promise<MutationResult> {
  if (existing.origin_request_digest !== originRequestDigest) fail(409, 'GROWTH_ORIGIN_INPUT_CONFLICT', 'conflict');
  const schema = await receiptSchema(db);
  const stored = await db.prepare(schema.hasReplayColumns ? `
    SELECT request_digest, response_digest, response_json, result_resource_type,
      result_resource_id, result_aggregate_revision
    FROM growth_mutation_receipts
    WHERE growth_cycle_id = ?1 AND route_action = ?2
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  ` : `
    SELECT receipt.request_digest, receipt.response_digest, payload.response_json,
      payload.result_resource_type, payload.result_resource_id, payload.result_aggregate_revision
    FROM growth_mutation_receipts receipt
    LEFT JOIN growth_mutation_receipt_replay_payloads payload ON payload.mutation_receipt_id = receipt.id
    WHERE receipt.growth_cycle_id = ?1 AND receipt.route_action = ?2
    ORDER BY receipt.created_at ASC, receipt.id ASC
    LIMIT 1
  `).bind(existing.id, ROUTE.open).first<{
    request_digest: string;
    response_digest: string;
    response_json: string;
    result_resource_type: string;
    result_resource_id: string;
    result_aggregate_revision: number;
  }>();
  if (!stored || stored.request_digest !== await hmac(security, 'growth-cycle:request:v1', request)) {
    fail(503, 'GROWTH_OPEN_REPLAY_RECEIPT_UNAVAILABLE', 'unavailable', true);
  }
  const response = receiptResponse(stored.response_json);
  if (stored.response_digest !== await hmac(security, 'growth-cycle:response:v1', response)) receiptCorrupt();
  validateReplayResult(stored, response);
  return response;
}

/**
 * A retained open response contains cycle state. Validate its resource before
 * returning it, rather than trusting the receipt alone after consent changes.
 */
async function assertRetainedOpenReplayAccess(
  db: D1Database,
  userId: string,
  spaceId: string,
  response: MutationResult,
): Promise<void> {
  const cycleId = text(response.cycleId);
  if (!cycleId) receiptCorrupt();
  await assertActiveCycleReplayAccess(db, userId, spaceId, cycleId);
}

async function bindOpenAliasReceipt(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  idempotencyKey: string,
  request: unknown,
  existing: ExistingOpenOrigin,
  originRequestDigest: string,
): Promise<MutationResult> {
  // This path reads a retained canonical open receipt. Check the exact cycle
  // before receipt work and again immediately before either retained return.
  await assertActiveCycleReplayAccess(db, userId, spaceId, existing.id);
  const response = await canonicalExistingOpenResponse(db, security, existing, originRequestDigest, request);
  const revision = finiteInteger(response.aggregateRevision);
  if (revision === null) receiptCorrupt();
  const aliasReceipt = await receiptStatement(db, security, {
    userId,
    routeAction: ROUTE.open,
    idempotencyKey,
    cycleId: existing.id,
    expectedRevision: 0,
    lifecycleAction: null,
    request,
    response,
    resultType: 'GROWTH_CYCLE',
    resultId: existing.id,
    resultRevision: revision,
    createdAt: now(),
  });
  try {
    await commitBatch(db, aliasReceipt.statements);
  } catch (error) {
    // A concurrent caller may already have frozen this exact key. Re-read it;
    // changed input still deterministically fails in replay rather than aliasing.
    if (error instanceof GrowthServiceError && error.code === 'GROWTH_PERSISTENCE_CONFLICT') {
      const concurrent = await replay(db, security, userId, ROUTE.open, idempotencyKey, request);
      if (concurrent) {
        await assertRetainedOpenReplayAccess(db, userId, spaceId, concurrent);
        return concurrent;
      }
    }
    throw error;
  }
  await assertActiveCycleReplayAccess(db, userId, spaceId, existing.id);
  return response;
}

async function recoverOpenFirstCommitConflict(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  idempotencyKey: string,
  request: unknown,
  lookupDigest: string,
  originRequestDigest: string,
): Promise<MutationResult> {
  // First, an exact route receipt resolves same-origin/same-key contention.
  // For a different origin under the same key, replay throws the canonical
  // GROWTH_IDEMPOTENCY_INPUT_CONFLICT before any origin alias can be created.
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const retained = await replay(db, security, userId, ROUTE.open, idempotencyKey, request);
  if (retained) {
    await assertRetainedOpenReplayAccess(db, userId, spaceId, retained);
    return retained;
  }

  // A different-key same-origin loser must see the winner's committed cycle,
  // then atomically bind its own route receipt. Bound attempts avoid recursion.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await existingOpenOrigin(db, lookupDigest);
    if (existing) {
      return bindOpenAliasReceipt(db, security, userId, spaceId, idempotencyKey, request, existing, originRequestDigest);
    }
    if (attempt === 0) await Promise.resolve();
  }
  fail(409, 'GROWTH_OPEN_RACE_CONFLICT', 'conflict', true);
}

function cycleResult(cycle: Cycle, state: GrowthState, aggregateRevision: number, extras: Row = {}): MutationResult {
  return canonicalResponse({ cycleId: cycle.id, state, aggregateRevision, ...extras });
}

function publicStringArray(value: unknown): string[] {
  if (typeof value !== 'string') fail(503, 'GROWTH_PUBLIC_PROJECTION_INVALID', 'unavailable', true);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      fail(503, 'GROWTH_PUBLIC_PROJECTION_INVALID', 'unavailable', true);
    }
    return parsed as string[];
  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    fail(503, 'GROWTH_PUBLIC_PROJECTION_INVALID', 'unavailable', true);
  }
}

function asConsentProjection(row: {
  consent_receipt_id: string;
  consent_purpose: string;
  consent_data_classes_json: string;
  consent_policy_revision: number;
  consent_retention_policy: string;
  consent_issued_at: number;
  consent_revoked_at: number | null;
}): GrowthPrivateConsentProjection {
  return {
    receiptId: row.consent_receipt_id,
    purpose: row.consent_purpose,
    dataClasses: publicStringArray(row.consent_data_classes_json),
    policyRevision: row.consent_policy_revision,
    retentionPolicy: row.consent_retention_policy,
    issuedAt: row.consent_issued_at,
    revokedAt: row.consent_revoked_at,
  };
}

function asSpaceProjection(row: {
  id: string;
  space_type: 'SOLO';
  privacy_mode: 'PRIVATE';
  status: 'ACTIVE';
  aggregate_revision: number;
  created_at: number;
  updated_at: number;
  archived_at: null;
  consent_receipt_id: string;
  consent_purpose: string;
  consent_data_classes_json: string;
  consent_policy_revision: number;
  consent_retention_policy: string;
  consent_issued_at: number;
  consent_revoked_at: number | null;
}): GrowthSpaceProjection {
  if (row.space_type !== 'SOLO' || row.privacy_mode !== 'PRIVATE' || row.status !== 'ACTIVE'
    || row.archived_at !== null || row.consent_revoked_at !== null) {
    fail(503, 'GROWTH_PUBLIC_PROJECTION_INVALID', 'unavailable', true);
  }
  return {
    id: row.id,
    spaceType: row.space_type,
    privacyMode: row.privacy_mode,
    status: row.status,
    aggregateRevision: row.aggregate_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    consent: asConsentProjection(row),
  };
}

function asSummary(cycle: Cycle): GrowthCycleSummary {
  return {
    id: cycle.id,
    spaceId: cycle.space_id,
    state: cycle.state,
    aggregateRevision: cycle.aggregate_revision,
    originKind: cycle.origin_kind,
    originAttemptId: cycle.origin_attempt_id,
    originTurnNumber: cycle.origin_turn_number,
    openedAt: cycle.opened_at,
    updatedAt: cycle.updated_at,
    closedAt: cycle.closed_at,
  };
}

function publicSourceCategory(sourceSystem: string): GrowthTimelineEventProjection['sourceCategory'] {
  if (sourceSystem === 'owned-persisted-origin') return 'OWNED_PERSISTED_ORIGIN';
  if (sourceSystem === 'growth-cycle-service') return 'GROWTH_CYCLE_SERVICE';
  return 'UNKNOWN';
}

async function assertOwnedActiveGrowthSpace(db: D1Database, userId: string, spaceId: string): Promise<Member> {
  const row = await db.prepare(`
    SELECT membership.id, membership.space_id, membership.pseudonym_id,
      membership.policy_revision, space.consent_receipt_id
    FROM growth_spaces space
    INNER JOIN growth_space_memberships membership ON membership.space_id = space.id
    INNER JOIN growth_private_consent_receipts consent ON consent.id = space.consent_receipt_id
    WHERE space.id = ?1 AND space.host_user_id = ?2 AND space.status = 'ACTIVE'
      AND membership.user_id = ?2 AND membership.role = 'HOST' AND membership.status = 'ACTIVE'
      AND consent.revoked_at IS NULL
  `).bind(spaceId, userId).first<Member>();
  if (!row) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  return row;
}

async function assertOwnedActiveConsent(db: D1Database, userId: string, consentReceiptId: string): Promise<void> {
  const row = await db.prepare(`
    SELECT id
    FROM growth_private_consent_receipts
    WHERE id = ?1 AND subject_user_id = ?2 AND revoked_at IS NULL
  `).bind(consentReceiptId, userId).first<{ id: string }>();
  if (!row) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
}

type ActiveSoloSpace = { id: string; consent_receipt_id: string };

async function activeSoloSpaceForOwner(db: D1Database, userId: string): Promise<ActiveSoloSpace | null> {
  return db.prepare(`
    SELECT space.id, space.consent_receipt_id
    FROM growth_spaces space
    INNER JOIN growth_private_consent_receipts consent ON consent.id = space.consent_receipt_id
    WHERE space.host_user_id = ?1 AND space.space_type = 'SOLO' AND space.status = 'ACTIVE'
      AND consent.revoked_at IS NULL
    ORDER BY space.created_at DESC, space.id DESC
    LIMIT 1
  `).bind(userId).first<ActiveSoloSpace>();
}

async function activeMember(db: D1Database, userId: string, spaceId: string, cycleId: string): Promise<Member> {
  const row = await db.prepare(`
    SELECT membership.id, membership.space_id, membership.pseudonym_id,
      membership.policy_revision, cycle.consent_receipt_id
    FROM growth_cycles cycle
    INNER JOIN growth_spaces space ON space.id = cycle.space_id
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    INNER JOIN growth_private_consent_receipts consent ON consent.id = cycle.consent_receipt_id
    WHERE cycle.id = ?1 AND cycle.space_id = ?2 AND space.host_user_id = ?3
      AND space.status = 'ACTIVE' AND membership.user_id = ?3 AND membership.role = 'HOST'
      AND membership.status = 'ACTIVE' AND consent.revoked_at IS NULL
  `).bind(cycleId, spaceId, userId).first<Member>();
  if (!row) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  return row;
}

async function activeCycle(db: D1Database, userId: string, spaceId: string, cycleId: string): Promise<Cycle> {
  const schema = await cycleSchema(db);
  const row = await db.prepare(schema.hasOriginDigests ? `
    SELECT cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
      cycle.consent_receipt_id, cycle.state, cycle.aggregate_revision, cycle.origin_kind,
      cycle.origin_attempt_id, cycle.origin_turn_number, cycle.origin_event_identity,
      cycle.origin_lookup_digest, cycle.origin_request_digest, cycle.opened_at, cycle.updated_at,
      cycle.closed_at
    FROM growth_cycles cycle
    INNER JOIN growth_spaces space ON space.id = cycle.space_id
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    INNER JOIN growth_private_consent_receipts consent ON consent.id = cycle.consent_receipt_id
    WHERE cycle.id = ?1 AND cycle.space_id = ?2 AND space.host_user_id = ?3
      AND space.status = 'ACTIVE' AND membership.user_id = ?3 AND membership.role = 'HOST'
      AND membership.status = 'ACTIVE' AND consent.revoked_at IS NULL
  ` : `
    SELECT cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
      cycle.consent_receipt_id, cycle.state, cycle.aggregate_revision, cycle.origin_kind,
      cycle.origin_attempt_id, cycle.origin_turn_number, cycle.origin_event_identity,
      '' AS origin_lookup_digest, '' AS origin_request_digest, cycle.opened_at, cycle.updated_at,
      cycle.closed_at
    FROM growth_cycles cycle
    INNER JOIN growth_spaces space ON space.id = cycle.space_id
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    INNER JOIN growth_private_consent_receipts consent ON consent.id = cycle.consent_receipt_id
    WHERE cycle.id = ?1 AND cycle.space_id = ?2 AND space.host_user_id = ?3
      AND space.status = 'ACTIVE' AND membership.user_id = ?3 AND membership.role = 'HOST'
      AND membership.status = 'ACTIVE' AND consent.revoked_at IS NULL
  `).bind(cycleId, spaceId, userId).first<Cycle>();
  if (!row) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  return row;
}

/** Re-check immediately before returning retained non-delete cycle content. */
async function assertActiveCycleReplayAccess(
  db: D1Database,
  userId: string,
  spaceId: string,
  cycleId: string,
): Promise<void> {
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  await activeCycle(db, userId, spaceId, cycleId);
  await activeMember(db, userId, spaceId, cycleId);
}

function requireRevision(cycle: Cycle, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== cycle.aggregate_revision) {
    fail(409, 'GROWTH_REVISION_CONFLICT', 'conflict', true, { expectedRevision: cycle.aggregate_revision });
  }
}

type HumanReviewRequestRow = {
  id: string;
  growth_cycle_id: string;
  owner_user_id: string;
  state: 'PENDING';
  request_dedup_digest: string;
  created_at: number;
};

function asHumanReviewRequest(row: HumanReviewRequestRow): HumanReviewRequestV1 {
  if (row.state !== 'PENDING'
    || typeof row.id !== 'string'
    || typeof row.growth_cycle_id !== 'string'
    || !Number.isSafeInteger(row.created_at)
    || !/^[a-f0-9]{64}$/.test(row.request_dedup_digest)) {
    fail(503, 'GROWTH_HUMAN_REVIEW_REQUEST_CORRUPT', 'unavailable', true);
  }
  return {
    id: row.id,
    cycleId: row.growth_cycle_id,
    state: 'PENDING',
    createdAt: row.created_at,
  };
}

async function existingHumanReviewRequest(
  db: D1Database,
  cycleId: string,
  ownerUserId: string,
): Promise<HumanReviewRequestRow | null> {
  return db.prepare(`
    SELECT id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at
    FROM growth_human_review_requests
    WHERE growth_cycle_id = ?1 AND owner_user_id = ?2
  `).bind(cycleId, ownerUserId).first<HumanReviewRequestRow>();
}

/** Creates or replays the owner's private, non-completing human-review request. */
export async function requestGrowthHumanReview(
  db: D1Database,
  security: GrowthCycleSecurity,
  ownerUserId: string,
  spaceId: string,
  cycleId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<HumanReviewRequestV1> {
  requireIdempotencyKey(idempotencyKey);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    fail(400, 'GROWTH_EXPECTED_REVISION_INVALID', 'validation');
  }

  // Authorization and current-cycle checks intentionally precede the request
  // lookup so a foreign target cannot be distinguished by request existence.
  await assertOwnedActiveGrowthSpace(db, ownerUserId, spaceId);
  const cycle = await activeCycle(db, ownerUserId, spaceId, cycleId);
  await activeMember(db, ownerUserId, spaceId, cycleId);
  requireRevision(cycle, expectedRevision);

  const requestDigest = await hmac(security, 'growth-human-review-request:dedup:v1', {
    ownerUserId,
    routeAction: ROUTE.humanReview,
    spaceId,
    cycleId,
    expectedRevision,
    idempotencyKey,
  });
  const existing = await existingHumanReviewRequest(db, cycleId, ownerUserId);
  if (existing) {
    // Revalidate immediately after the lookup so a revocation/archive race
    // cannot disclose even an exact pending replay (or its conflict status).
    await assertActiveCycleReplayAccess(db, ownerUserId, spaceId, cycleId);
    if (existing.request_dedup_digest === requestDigest) return asHumanReviewRequest(existing);
    fail(409, 'GROWTH_HUMAN_REVIEW_REQUEST_CONFLICT', 'conflict');
  }

  const requestId = id('growth-human-review');
  const createdAt = now();
  try {
    await commitBatch(db, [db.prepare(`
      INSERT INTO growth_human_review_requests (
        id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at
      ) VALUES (?1, ?2, ?3, 'PENDING', ?4, ?5)
    `).bind(requestId, cycleId, ownerUserId, requestDigest, createdAt)]);
  } catch (error) {
    if (!(error instanceof GrowthServiceError) || error.code !== 'GROWTH_PERSISTENCE_CONFLICT') throw error;
    // A concurrent winner may have committed between the first lookup and the
    // insert. Re-read only the exact owner/cycle/digest triple before replaying.
    const winner = await db.prepare(`
      SELECT id, growth_cycle_id, owner_user_id, state, request_dedup_digest, created_at
      FROM growth_human_review_requests
      WHERE growth_cycle_id = ?1 AND owner_user_id = ?2 AND request_dedup_digest = ?3
    `).bind(cycleId, ownerUserId, requestDigest).first<HumanReviewRequestRow>();
    if (winner) {
      await assertActiveCycleReplayAccess(db, ownerUserId, spaceId, cycleId);
      return asHumanReviewRequest(winner);
    }
    fail(409, 'GROWTH_HUMAN_REVIEW_REQUEST_CONFLICT', 'conflict');
  }
  return { id: requestId, cycleId, state: 'PENDING', createdAt };
}

async function lifecyclePlan(
  db: D1Database,
  security: GrowthCycleSecurity,
  input: {
    cycle: Cycle;
    userId: string;
    actor: Member | null;
    action: string;
    routeAction: string;
    idempotencyKey: string;
    request: unknown;
    response?: MutationResult;
    subject?: Subject;
    createdAt: number;
  },
): Promise<LifecyclePlan> {
  const [schema, eventStorage] = await Promise.all([lifecycleSchema(db), eventSchema(db)]);
  const catalog = await db.prepare(schema.hasContractColumns ? `
    SELECT to_state, event_type, actor_class
    FROM growth_lifecycle_transitions
    WHERE from_state = ?1 AND action = ?2 AND route_action = ?3
  ` : `
    SELECT transition.to_state, transition.event_type, contract.actor_class
    FROM growth_lifecycle_transitions transition
    INNER JOIN growth_lifecycle_transition_contracts contract
      ON contract.from_state = transition.from_state
     AND contract.action = transition.action
     AND contract.to_state = transition.to_state
     AND contract.event_type = transition.event_type
    WHERE transition.from_state = ?1 AND transition.action = ?2 AND contract.route_action = ?3
  `).bind(input.cycle.state, input.action, input.routeAction).first<{
    to_state: GrowthState;
    event_type: string;
    actor_class: string;
  }>();
  if (!catalog && !schema.hasContractColumns) {
    const legacyTransition = await db.prepare(`
      SELECT 1 FROM growth_lifecycle_transitions WHERE from_state = ?1 AND action = ?2
    `).bind(input.cycle.state, input.action).first<{ 1: number }>();
    if (legacyTransition) fail(503, 'GROWTH_LIFECYCLE_CONTRACT_UNAVAILABLE', 'unavailable', true);
  }
  if (!catalog || (catalog.actor_class === 'PARTICIPANT') !== Boolean(input.actor)) {
    fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
  }
  const eventRevision = input.cycle.aggregate_revision + 1;
  const response = input.response ?? cycleResult(input.cycle, catalog.to_state, eventRevision, { action: input.action });
  const receipt = await receiptStatement(db, security, {
    userId: input.userId,
    routeAction: input.routeAction,
    idempotencyKey: input.idempotencyKey,
    cycleId: input.cycle.id,
    expectedRevision: input.cycle.aggregate_revision,
    lifecycleAction: input.action,
    request: input.request,
    response,
    resultType: 'GROWTH_CYCLE',
    resultId: input.cycle.id,
    resultRevision: finiteInteger(response.aggregateRevision) ?? eventRevision,
    createdAt: input.createdAt,
  });
  const eventPayload = {
    action: input.action,
    routeAction: input.routeAction,
    request: input.request,
    subject: input.subject ?? null,
  };
  const eventId = id('growth-event');
  const eventUsesCurrentColumns = eventStorage.hasMutationReceiptId && eventStorage.hasTransitionSubject;
  if (eventStorage.hasMutationReceiptId !== eventStorage.hasTransitionSubject) {
    fail(503, 'GROWTH_EVENT_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  const event = db.prepare(eventUsesCurrentColumns ? `
    INSERT INTO growth_events (
      id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
      event_type, object_type, object_id, object_revision, lifecycle_action,
      previous_state, next_state, transition_subject_type, transition_subject_id,
      occurred_at, recorded_at, source_system, source_event_id, payload_digest,
      mutation_receipt_id, visibility, consent_receipt_id
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, 'GROWTH_CYCLE', ?3, ?7, ?8, ?9, ?10, ?11, ?12,
      ?13, ?13, 'growth-cycle-service', ?14, ?15, ?16, 'PRIVATE', ?17
    )
  ` : `
    INSERT INTO growth_events (
      id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
      event_type, object_type, object_id, object_revision, lifecycle_action,
      previous_state, next_state, occurred_at, recorded_at, source_system,
      source_event_id, payload_digest, visibility, consent_receipt_id
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, 'GROWTH_CYCLE', ?3, ?7, ?8, ?9, ?10,
      ?11, ?11, 'growth-cycle-service', ?12, ?13, 'PRIVATE', ?14
    )
  `).bind(
    eventId, input.cycle.space_id, input.cycle.id, input.actor?.id ?? null,
    input.actor?.pseudonym_id ?? 'system:growth-cycle', catalog.event_type, eventRevision,
    input.action, input.cycle.state, catalog.to_state,
    ...(eventUsesCurrentColumns ? [input.subject?.[0] ?? null, input.subject?.[1] ?? null] : []),
    input.createdAt,
    `${input.cycle.id}:${eventRevision}:${input.action}:${input.idempotencyKey}`,
    await hmac(security, 'growth-cycle:lifecycle-event:v1', eventPayload),
    ...(eventUsesCurrentColumns ? [receipt.id, input.cycle.consent_receipt_id] : [input.cycle.consent_receipt_id]),
  );
  const eventReceiptLink = eventUsesCurrentColumns ? [] : [db.prepare(`
    INSERT INTO growth_event_mutation_receipt_links (growth_event_id, mutation_receipt_id, created_at)
    VALUES (?1, ?2, ?3)
  `).bind(eventId, receipt.id, input.createdAt)];
  const eventSubjectLink = eventUsesCurrentColumns || !input.subject ? [] : [db.prepare(`
    INSERT INTO growth_event_transition_subjects (
      growth_event_id, transition_subject_type, transition_subject_id, created_at
    ) VALUES (?1, ?2, ?3, ?4)
  `).bind(eventId, input.subject[0], input.subject[1], input.createdAt)];
  // Current 0047 advances the aggregate in its event trigger. The applied
  // legacy schema records the same event but has no actuator trigger, so the
  // service performs the guarded update only on that legacy shape.
  const aggregateAdvance = eventUsesCurrentColumns ? [] : [db.prepare(`
    UPDATE growth_cycles
    SET state = ?2, aggregate_revision = ?3, updated_at = ?4,
      closed_at = CASE WHEN ?2 = 'CLOSED' THEN ?4 ELSE NULL END
    WHERE id = ?1
  `).bind(input.cycle.id, catalog.to_state, eventRevision, input.createdAt)];
  return {
    toState: catalog.to_state,
    response,
    statements: [...receipt.statements, event, ...eventReceiptLink, ...eventSubjectLink, ...aggregateAdvance],
  };
}

function describeSignal(payload: Row, minimum: number, maximum: number, unavailableReason: string): Signal {
  const values: Array<readonly [string, number]> = [];
  for (const axis of AXES) {
    const value = finiteNumber(payload[axis]);
    if (value === null || value < minimum || value > maximum) {
      return { reason: unavailableReason, capabilityCode: null, value: null, ties: [], payload };
    }
    values.push([axis, value]);
  }
  const lowest = Math.min(...values.map(([, value]) => value));
  const ties = values.filter(([, value]) => value === lowest).map(([axis]) => axis).sort();
  return {
    reason: 'LOWEST_AXIS_DESCRIPTIVE_SIGNAL_STABLE_CAPABILITY_CODE_ASCENDING',
    capabilityCode: ties[0] ?? null,
    value: lowest,
    ties,
    payload,
  };
}

function trainingEvaluationMatchesStoredAxes(evaluation: Row | null, axes: Row): boolean {
  if (!evaluation) return false;
  const evaluationAxes: Record<string, unknown> = {
    claim_clarity: evaluation.claimClarity,
    evidence_use: evaluation.evidenceUse,
    reasoning_strength: evaluation.reasoningStrength,
    consistency: evaluation.consistency,
    relevance: evaluation.relevance,
  };
  return AXES.every((axis) => {
    const persisted = finiteNumber(evaluationAxes[axis]);
    const stored = finiteNumber(axes[axis]);
    return persisted !== null && stored !== null && persisted >= 1 && persisted <= 5
      && stored >= 1 && stored <= 5 && persisted === stored;
  });
}

function originConfig(kind: GrowthOriginKind): Pick<Origin, 'pathId' | 'observationRuleId' | 'observationRuleRevision' | 'gapRuleId' | 'gapRuleRevision' | 'focusPracticeRuleId'> {
  const key = kind.toLowerCase();
  return {
    pathId: `growth-path:${key}-five-axis:en:1`,
    observationRuleId: kind === 'TRAINING'
      ? 'growth-observation-rule:training-lowest-axis-descriptive:en:2'
      : 'growth-observation-rule:sparring-five-axis-descriptive:en:2',
    observationRuleRevision: 2,
    gapRuleId: `growth-gap-rule:${key}-five-axis:provisional:en:2`,
    gapRuleRevision: 2,
    focusPracticeRuleId: `growth-practice-rule:${key}-five-axis:learner-focus:en:1`,
  };
}

async function requireOriginSeedContract(db: D1Database, kind: GrowthOriginKind): Promise<void> {
  const config = originConfig(kind);
  const [path, observation, gap, capabilities] = await Promise.all([
    db.prepare(`
      SELECT id, revision, validation_status, status FROM growth_path_revisions WHERE id = ?1
    `).bind(config.pathId).first<{ id: string; revision: number; validation_status: string; status: string }>(),
    db.prepare(`
      SELECT id, revision, rule_json, validation_status, status
      FROM growth_observation_rules WHERE id = ?1 AND path_revision_id = ?2
    `).bind(config.observationRuleId, config.pathId).first<{ id: string; revision: number; rule_json: string; validation_status: string; status: string }>(),
    db.prepare(`
      SELECT id, revision, rule_json, validation_status, status
      FROM growth_gap_rules WHERE id = ?1 AND path_revision_id = ?2
    `).bind(config.gapRuleId, config.pathId).first<{ id: string; revision: number; rule_json: string; validation_status: string; status: string }>(),
    db.prepare(`
      SELECT capability_code FROM growth_capability_definitions
      WHERE path_revision_id = ?1 AND revision = 1 AND validation_status = 'PROVISIONAL_UNCALIBRATED' AND status = 'ACTIVE'
    `).bind(config.pathId).all<{ capability_code: string }>(),
  ]);
  const observationRule = parseObject(observation?.rule_json);
  const prohibitedOutcomes = observationRule?.prohibits;
  const gapRule = parseObject(gap?.rule_json);
  const capabilityCodes = new Set((capabilities.results ?? []).map((row) => row.capability_code));
  const exactAxes = AXES.every((axis) => capabilityCodes.has(axis));
  const validPath = path?.revision === 1 && path.validation_status === 'PROVISIONAL_UNCALIBRATED' && path.status === 'ACTIVE';
  const validObservation = observation?.revision === 2 && observation.validation_status === 'PROVISIONAL_UNCALIBRATED'
    && observation.status === 'ACTIVE' && (kind === 'TRAINING'
      ? canonicalText(observationRule ?? {}) === canonicalText({
        kind: 'LOWEST_AXIS_DESCRIPTIVE_SIGNAL', source: 'legacy-training-evaluator',
        tie_break: 'stable_capability_code_ascending', outcome: 'UNKNOWN',
        prohibits: ['MEASURED', 'GAP_PROPOSED', 'CALIBRATED_CONFIDENCE', 'IMPROVED'],
      })
      : observationRule?.kind === 'SPARRING_FIVE_AXIS_DESCRIPTIVE_SIGNAL'
        && observationRule.source === 'sparring-evaluator'
        && observationRule.outcome === 'UNKNOWN'
        && Array.isArray(prohibitedOutcomes)
        && ['MEASURED', 'GAP_PROPOSED', 'CALIBRATED_CONFIDENCE', 'IMPROVED'].every((value) => prohibitedOutcomes.includes(value))
        && canonicalText(parseObject(observationRule.axis_mapping) ?? {}) === canonicalText({
          clarity_score: 'claim_clarity', evidence_score: 'evidence_use', defense_score: 'reasoning_strength',
          consistency_score: 'consistency', relevance_score: 'relevance',
        }) && observationRule.tie_break === 'stable_capability_code_ascending');
  const validGap = gap?.revision === 2 && gap.validation_status === 'PROVISIONAL_UNCALIBRATED'
    && gap.status === 'ACTIVE' && canonicalText(gapRule ?? {}) === canonicalText({
      kind: 'PROVISIONAL_GAP_UNAVAILABLE', requires: 'validated_observation_and_exact_evidence', outcome: 'UNKNOWN',
    });
  if (!validPath || !exactAxes || !validObservation || !validGap) {
    fail(503, 'GROWTH_ORIGIN_SEED_CONTRACT_UNAVAILABLE', 'unavailable', true);
  }
}

function capabilityId(kind: GrowthOriginKind, capabilityCode: string | null): string {
  const code = capabilityCode && AXES.includes(capabilityCode as typeof AXES[number])
    ? capabilityCode
    : 'claim_clarity';
  return `growth-capability:${kind.toLowerCase()}-five-axis:${code.replace('_', '-')}:1`;
}

function requireOriginInput(input: OpenGrowthCycleInput): void {
  if ((input.originKind !== 'TRAINING' && input.originKind !== 'SPARRING') || !text(input.originAttemptId) || input.originAttemptId.length > 256) {
    fail(400, 'GROWTH_ORIGIN_INPUT_INVALID', 'validation');
  }
}

/** Loads only server-owned, persisted completion records. It never accepts client evidence. */
async function loadOwnedOrigin(db: D1Database, userId: string, input: OpenGrowthCycleInput): Promise<Origin> {
  requireOriginInput(input);
  if (input.originKind === 'TRAINING') {
    const row = await db.prepare(`
      SELECT turn.id, turn.turn_number, turn.evaluation_json, turn.claim_clarity,
        turn.evidence_use, turn.reasoning_strength, turn.consistency_score, turn.relevance_score
      FROM training_sessions session
      INNER JOIN training_turns turn ON turn.session_id = session.id
      WHERE session.id = ?1 AND session.user_id = ?2 AND session.is_completed = 1
      ORDER BY turn.turn_number DESC, turn.id DESC
      LIMIT 1
    `).bind(input.originAttemptId, userId).first<Row>();
    const turn = finiteInteger(row?.turn_number);
    if (!row || turn === null || turn < 1) {
      fail(422, 'GROWTH_OWNED_COMPLETED_TRAINING_ORIGIN_REQUIRED', 'evidence');
    }
    const persistedEvaluation = parseObject(row.evaluation_json);
    const axes: Row = {
      claim_clarity: row.claim_clarity,
      evidence_use: row.evidence_use,
      reasoning_strength: row.reasoning_strength,
      consistency: row.consistency_score,
      relevance: row.relevance_score,
    };
    const payload = { source: 'training_turn', persistedEvaluation: row.evaluation_json ?? null, axes };
    const signal = trainingEvaluationMatchesStoredAxes(persistedEvaluation, axes)
      ? describeSignal(axes, 1, 5, 'TRAINING_EVALUATION_INCOMPATIBLE_OR_INCOMPLETE')
      : {
        reason: persistedEvaluation ? 'TRAINING_EVALUATION_INCOMPATIBLE_OR_INCOMPLETE' : 'TRAINING_EVALUATION_JSON_MALFORMED',
        capabilityCode: null,
        value: null,
        ties: [],
        payload: axes,
      };
    return {
      kind: 'TRAINING',
      attemptId: input.originAttemptId,
      turn,
      identity: `training:${input.originAttemptId}:turn:${String(row.id)}`,
      ...originConfig('TRAINING'),
      capabilityId: capabilityId('TRAINING', signal.capabilityCode),
      payload,
      signal: { ...signal, payload },
    };
  }

  const row = await db.prepare(`
    SELECT message.id AS message_id, message.turn, evaluation.id AS evaluation_id,
      evaluation.clarity_score, evaluation.evidence_score, evaluation.defense_score,
      evaluation.consistency_score, evaluation.relevance_score
    FROM sessions session
    INNER JOIN messages message ON message.session_id = session.id AND message.role = 'user'
    LEFT JOIN evaluations evaluation ON evaluation.id = (
      SELECT candidate.id
      FROM evaluations candidate
      WHERE candidate.session_id = session.id AND candidate.turn = message.turn AND candidate.user_id = ?2
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    )
    WHERE session.id = ?1 AND session.user_id = ?2 AND session.is_completed = 1
      AND message.turn = session.session_completion_turn
      AND message.id = (SELECT id FROM messages WHERE session_id=session.id AND role='user' ORDER BY turn DESC,id DESC LIMIT 1)
    ORDER BY message.turn DESC, message.id DESC
    LIMIT 1
  `).bind(input.originAttemptId, userId).first<Row>();
  const turn = finiteInteger(row?.turn);
  if (!row || turn === null || turn < 1) {
    fail(422, 'GROWTH_OWNED_COMPLETED_SPARRING_ORIGIN_REQUIRED', 'evidence');
  }
  const axes: Row = {
    claim_clarity: row.clarity_score,
    evidence_use: row.evidence_score,
    reasoning_strength: row.defense_score,
    consistency: row.consistency_score,
    relevance: row.relevance_score,
  };
  const payload = {
    source: 'sparring_evaluation',
    evaluationId: row.evaluation_id ?? null,
    axes,
  };
  const signal = row.evaluation_id !== null && row.evaluation_id !== undefined
    ? describeSignal(axes, 0, 100, 'SPARRING_EVALUATION_INCOMPATIBLE_OR_INCOMPLETE')
    : { reason: 'SPARRING_EVALUATION_UNAVAILABLE', capabilityCode: null, value: null, ties: [], payload: axes };
  return {
    kind: 'SPARRING',
    attemptId: input.originAttemptId,
    turn,
    identity: `sparring:${input.originAttemptId}:message:${String(row.message_id)}:evaluation:${String(row.evaluation_id ?? 'missing')}`,
    ...originConfig('SPARRING'),
    capabilityId: capabilityId('SPARRING', signal.capabilityCode),
    payload,
    signal: { ...signal, payload },
  };
}

async function rawEvidencePlan(
  db: D1Database,
  security: GrowthCycleSecurity,
  cycle: Cycle,
  actor: Member,
  userId: string,
  source: Origin,
  idempotencyKey: string,
  createdAt: number,
): Promise<RawEvidencePlan> {
  const eventStorage = await eventSchema(db);
  const eventUsesCurrentColumns = eventStorage.hasMutationReceiptId && eventStorage.hasTransitionSubject;
  if (eventStorage.hasMutationReceiptId !== eventStorage.hasTransitionSubject) {
    fail(503, 'GROWTH_EVENT_SCHEMA_UNSUPPORTED', 'unavailable', true);
  }
  const eventId = id('growth-raw-evidence');
  const payloadDigest = await hmac(security, 'growth-cycle:raw-origin:v1', {
    originIdentity: source.identity,
    payload: source.payload,
  });
  const response = cycleResult(cycle, cycle.state, cycle.aggregate_revision, {
    evidenceEventId: eventId,
    originIdentity: source.identity,
  });
  const receipt = await receiptStatement(db, security, {
    userId,
    routeAction: ROUTE.raw,
    idempotencyKey,
    cycleId: cycle.id,
    expectedRevision: cycle.aggregate_revision,
    lifecycleAction: null,
    request: { cycleId: cycle.id, originIdentity: source.identity },
    response,
    resultType: 'GROWTH_CYCLE',
    resultId: cycle.id,
    resultRevision: cycle.aggregate_revision,
    createdAt,
  });
  const event = db.prepare(eventUsesCurrentColumns ? `
    INSERT INTO growth_events (
      id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
      event_type, object_type, object_id, object_revision, occurred_at, recorded_at,
      source_system, source_event_id, payload_digest, mutation_receipt_id, visibility,
      consent_receipt_id
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'RAW_ORIGIN_EVALUATION_RECORDED', 'OBSERVATION',
      ?1, ?6, ?7, ?7, 'owned-persisted-origin', ?8, ?9, ?10, 'PRIVATE', ?11)
  ` : `
    INSERT INTO growth_events (
      id, space_id, growth_cycle_id, actor_membership_id, actor_pseudonym_id,
      event_type, object_type, object_id, object_revision, occurred_at, recorded_at,
      source_system, source_event_id, payload_digest, visibility, consent_receipt_id
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'RAW_ORIGIN_EVALUATION_RECORDED', 'OBSERVATION',
      ?1, ?6, ?7, ?7, 'owned-persisted-origin', ?8, ?9, 'PRIVATE', ?10)
  `).bind(
    eventId, cycle.space_id, cycle.id, actor.id, actor.pseudonym_id,
    cycle.aggregate_revision, createdAt, source.identity, payloadDigest,
    ...(eventUsesCurrentColumns ? [receipt.id, cycle.consent_receipt_id] : [cycle.consent_receipt_id]),
  );
  const eventReceiptLink = eventUsesCurrentColumns ? [] : [db.prepare(`
    INSERT INTO growth_event_mutation_receipt_links (growth_event_id, mutation_receipt_id, created_at)
    VALUES (?1, ?2, ?3)
  `).bind(eventId, receipt.id, createdAt)];
  return { id: eventId, payloadDigest, statements: [...receipt.statements, event, ...eventReceiptLink] };
}

function unknownEvidencePlan(db: D1Database, cycle: Cycle, source: Origin, rawEventId: string, createdAt: number): UnknownEvidencePlan {
  const observationId = id('growth-observation');
  const hypothesisId = id('growth-hypothesis');
  const descriptiveSignal = {
    label: 'DESCRIPTIVE_ONLY',
    reason: source.signal.reason,
    tieRule: 'stable_capability_code_ascending',
    representativeCapability: source.signal.capabilityCode,
    tiedCapabilities: source.signal.ties,
    rawValue: source.signal.value,
    storedSourcePayload: source.payload,
  };
  const statement = source.signal.capabilityCode
    ? `A descriptive ${source.kind.toLowerCase()} signal retained ${source.signal.ties.join(', ')} as tied minimum axis values. It is not a validated gap.`
    : 'The owned stored evaluation is unavailable, malformed, or incompatible. No capability was identified.';
  const observation = db.prepare(`
    INSERT INTO growth_capability_observations (
      id, growth_cycle_id, capability_id, capability_revision, rubric_revision_id,
      status, evidence_event_ids_json, inference_rule_id, inference_rule_revision,
      inference_validation, confidence, raw_signal_json, observed_at, recorded_at
    ) VALUES (?1, ?2, ?3, 1, NULL, 'UNKNOWN', ?4, ?5, ?6,
      'PROVISIONAL_UNCALIBRATED', NULL, ?7, ?8, ?8)
  `).bind(
    observationId, cycle.id, source.capabilityId, JSON.stringify([rawEventId]),
    source.observationRuleId, source.observationRuleRevision, canonicalText(descriptiveSignal), createdAt,
  );
  const hypothesis = db.prepare(`
    INSERT INTO growth_gap_hypotheses (
      id, growth_cycle_id, observation_id, capability_id, capability_revision,
      gap_rule_id, gap_rule_revision, statement, state, supporting_event_ids_json,
      contradicting_event_ids_json, generator_revision, source_revision, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, 'UNKNOWN', ?8, '[]',
      'growth-cycle-service:1', 'provisional-owned-origin:1', ?9, ?9)
  `).bind(
    hypothesisId, cycle.id, observationId, source.capabilityId, source.gapRuleId, source.gapRuleRevision,
    statement, JSON.stringify([rawEventId]), createdAt,
  );
  return { observationId, hypothesisId, statements: [observation, hypothesis] };
}

function sourcePacket(cycle: Cycle, raw: RawEvidencePlan): string {
  return canonicalText({
    source: 'owned_origin_evidence_only',
    immutableOrigin: {
      kind: cycle.origin_kind,
      attemptId: cycle.origin_attempt_id,
      turnNumber: cycle.origin_turn_number,
      eventIdentity: cycle.origin_event_identity,
    },
    rawGrowthEventId: raw.id,
    rawPayloadDigest: raw.payloadDigest,
  });
}

async function learnerFocusRule(
  db: D1Database,
  cycle: Cycle,
): Promise<{ id: string; revision: number; horizonHours: number; questTypes: Record<string, string> }> {
  const ruleId = originConfig(cycle.origin_kind).focusPracticeRuleId;
  const row = await db.prepare(`
    SELECT id, revision, rule_json
    FROM growth_practice_rules
    WHERE id = ?1 AND path_revision_id = ?2 AND status = 'ACTIVE'
      AND validation_status = 'PROVISIONAL_UNCALIBRATED'
  `).bind(ruleId, cycle.path_revision_id).first<{ id: string; revision: number; rule_json: string }>();
  const json = parseObject(row?.rule_json);
  const horizon = finiteInteger(json?.retention_horizon_hours);
  const questTypes = parseObject(json?.axis_to_quest_type);
  if (!row || row.revision !== 1 || !json || json.kind !== 'LEARNER_CHOSEN_FOCUS_PRACTICE'
    || json.outcome !== 'UNKNOWN' || json.requires !== 'focus_selection'
    || json.source_packet_rule !== 'owned_origin_evidence_only' || horizon === null || horizon < 1
    || !questTypes || AXES.some((axis) => typeof questTypes[axis] !== 'string')) {
    fail(503, 'GROWTH_LEARNER_FOCUS_RULE_UNAVAILABLE', 'unavailable', true);
  }
  return { id: row.id, revision: row.revision, horizonHours: horizon, questTypes: questTypes as Record<string, string> };
}

function capabilityCode(cycle: Cycle, value: string): string | null {
  const match = new RegExp(`^growth-capability:${cycle.origin_kind.toLowerCase()}-five-axis:([a-z-]+):1$`).exec(value);
  if (!match) return null;
  const code = match[1].replace('-', '_');
  return AXES.includes(code as typeof AXES[number]) ? code : null;
}

async function firstOwnedRawEvidence(db: D1Database, cycle: Cycle): Promise<RawEvidencePlan> {
  const raw = await db.prepare(`
    SELECT id, payload_digest, source_event_id
    FROM growth_events
    WHERE growth_cycle_id = ?1 AND source_system = 'owned-persisted-origin'
      AND source_event_id = ?2 AND event_type = 'RAW_ORIGIN_EVALUATION_RECORDED'
    ORDER BY recorded_at ASC, id ASC
    LIMIT 1
  `).bind(cycle.id, cycle.origin_event_identity).first<{ id: string; payload_digest: string; source_event_id: string }>();
  if (!raw || raw.source_event_id !== cycle.origin_event_identity || !/^[a-f0-9]{64}$/.test(raw.payload_digest)) {
    fail(503, 'GROWTH_OWNED_ORIGIN_EVIDENCE_UNAVAILABLE', 'unavailable', true);
  }
  return { id: raw.id, payloadDigest: raw.payload_digest, statements: [] };
}

async function validatedGapPracticeRule(
  db: D1Database,
  cycle: Cycle,
): Promise<{ id: string; revision: number; horizonHours: number; questTypes: Record<string, string> }> {
  const row = await db.prepare(`
    SELECT id, revision, rule_json
    FROM growth_practice_rules
    WHERE path_revision_id = ?1 AND status = 'ACTIVE' AND validation_status = 'VALIDATED'
      AND json_extract(rule_json, '$.kind') = 'VALIDATED_GAP_PRACTICE'
    ORDER BY revision DESC, id ASC
    LIMIT 1
  `).bind(cycle.path_revision_id).first<{ id: string; revision: number; rule_json: string }>();
  const rule = parseObject(row?.rule_json);
  const horizon = finiteInteger(rule?.retention_horizon_hours);
  const questTypes = parseObject(rule?.axis_to_quest_type);
  if (!row || !rule || horizon === null || horizon < 1 || !questTypes
    || AXES.some((axis) => typeof questTypes[axis] !== 'string')) {
    fail(503, 'GROWTH_VALIDATED_PRACTICE_RULE_UNAVAILABLE', 'unavailable', true);
  }
  return { id: row.id, revision: row.revision, horizonHours: horizon, questTypes: questTypes as Record<string, string> };
}

function practiceQuestStatement(
  db: D1Database,
  input: {
    id: string;
    cycle: Cycle;
    gapHypothesisId: string | null;
    focusSelectionId: string | null;
    ruleId: string;
    ruleRevision: number;
    questType: string;
    sourcePacketJson: string;
    selectionReason: string;
    learningPurpose: string;
    horizonHours: number;
    createdAt: number;
  },
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO growth_practice_quests (
      id, growth_cycle_id, gap_hypothesis_id, focus_selection_id, practice_rule_id,
      practice_rule_revision, quest_type, source_packet_json, selection_reason,
      learning_purpose, status, target_retention_horizon_hours, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'OFFERED', ?11, ?12, ?12)
  `).bind(
    input.id, input.cycle.id, input.gapHypothesisId, input.focusSelectionId,
    input.ruleId, input.ruleRevision, input.questType, input.sourcePacketJson,
    input.selectionReason, input.learningPurpose, input.horizonHours, input.createdAt,
  );
}

export async function recordPrivateSoloConsent(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  input: PrivateSoloConsentInput,
  idempotencyKey: string,
): Promise<MutationResult> {
  if (!text(input.purpose) || !text(input.retentionPolicy) || !Number.isInteger(input.policyRevision)
    || input.policyRevision < 1 || !Array.isArray(input.dataClasses) || input.dataClasses.length === 0
    || input.dataClasses.some((entry) => !text(entry))) {
    fail(400, 'GROWTH_PRIVATE_CONSENT_INVALID', 'validation');
  }
  const request = {
    purpose: input.purpose.trim(),
    dataClasses: input.dataClasses.map((entry) => entry.trim()).sort(),
    policyRevision: input.policyRevision,
    retentionPolicy: input.retentionPolicy.trim(),
  };
  const prior = await replay(db, security, userId, ROUTE.consent, idempotencyKey, request);
  if (prior) {
    const consentReceiptId = text(prior.consentReceiptId);
    if (!consentReceiptId || prior.status !== 'ACTIVE') receiptCorrupt();
    await assertOwnedActiveConsent(db, userId, consentReceiptId);
    return prior;
  }
  const consentId = id('growth-consent');
  const response = canonicalResponse({ consentReceiptId: consentId, policyRevision: input.policyRevision, status: 'ACTIVE' });
  const createdAt = now();
  const receipt = await receiptStatement(db, security, {
    userId, routeAction: ROUTE.consent, idempotencyKey, cycleId: null, expectedRevision: 0,
    lifecycleAction: null, request, response, resultType: 'CONSENT_RECEIPT', resultId: consentId,
    resultRevision: input.policyRevision, createdAt,
  });
  await commitBatch(db, [
    db.prepare(`
      INSERT INTO growth_private_consent_receipts (
        id, subject_user_id, purpose, data_classes_json, policy_revision,
        retention_policy, issued_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    `).bind(consentId, userId, request.purpose, JSON.stringify(request.dataClasses), input.policyRevision, request.retentionPolicy, createdAt),
    ...receipt.statements,
  ]);
  return response;
}

export async function revokePrivateSoloConsent(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  consentReceiptId: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  const request = { consentReceiptId };
  const prior = await replay(db, security, userId, ROUTE.revoke, idempotencyKey, request);
  if (prior) return prior;
  const owned = await db.prepare(`
    SELECT policy_revision
    FROM growth_private_consent_receipts
    WHERE id = ?1 AND subject_user_id = ?2 AND revoked_at IS NULL
  `).bind(consentReceiptId, userId).first<{ policy_revision: number }>();
  if (!owned) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  const response = canonicalResponse({ consentReceiptId, policyRevision: owned.policy_revision, status: 'REVOKED' });
  const createdAt = now();
  const receipt = await receiptStatement(db, security, {
    userId, routeAction: ROUTE.revoke, idempotencyKey, cycleId: null, expectedRevision: 0,
    lifecycleAction: null, request, response, resultType: 'CONSENT_RECEIPT',
    resultId: consentReceiptId, resultRevision: owned.policy_revision, createdAt,
  });
  await commitBatch(db, [
    db.prepare(`
      UPDATE growth_spaces
      SET status = 'ARCHIVED', archived_at = ?3, updated_at = ?3
      WHERE host_user_id = ?1 AND consent_receipt_id = ?2 AND status = 'ACTIVE'
    `).bind(userId, consentReceiptId, createdAt),
    db.prepare(`
      UPDATE growth_private_consent_receipts
      SET revoked_at = ?3
      WHERE id = ?1 AND subject_user_id = ?2 AND revoked_at IS NULL
    `).bind(consentReceiptId, userId, createdAt),
    ...receipt.statements,
  ]);
  return response;
}

export async function ensureSoloGrowthSpace(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  idempotencyKey: string,
): Promise<MutationResult> {
  const request = { userId, mode: 'SOLO' };
  const activeSpace = await activeSoloSpaceForOwner(db, userId);
  const prior = await replay(db, security, userId, ROUTE.space, idempotencyKey, request);
  if (prior) {
    const replayedSpaceId = text(prior.spaceId);
    const replayedConsentId = text(prior.consentReceiptId);
    if (!replayedSpaceId || !replayedConsentId || prior.status !== 'ACTIVE') receiptCorrupt();
    // Re-read after receipt resolution: revocation can race the first lookup.
    const currentActiveSpace = await activeSoloSpaceForOwner(db, userId);
    if (!currentActiveSpace || currentActiveSpace.id !== replayedSpaceId
      || currentActiveSpace.consent_receipt_id !== replayedConsentId) {
      fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
    }
    return prior;
  }
  const spaceId = activeSpace?.id ?? id('growth-space');
  const consentId = activeSpace?.consent_receipt_id ?? (await db.prepare(`
    SELECT id FROM growth_private_consent_receipts
    WHERE subject_user_id = ?1 AND revoked_at IS NULL
    ORDER BY issued_at DESC, id DESC LIMIT 1
  `).bind(userId).first<{ id: string }>())?.id;
  if (!consentId) fail(409, 'GROWTH_PRIVATE_SOLO_CONSENT_REQUIRED', 'policy');
  const response = canonicalResponse({ spaceId, consentReceiptId: consentId, status: 'ACTIVE' });
  const createdAt = now();
  const receipt = await receiptStatement(db, security, {
    userId, routeAction: ROUTE.space, idempotencyKey, cycleId: null, expectedRevision: 0,
    lifecycleAction: null, request, response, resultType: 'GROWTH_SPACE', resultId: spaceId,
    resultRevision: 1, createdAt,
  });
  const statements: D1PreparedStatement[] = [];
  if (!activeSpace) {
    statements.push(db.prepare(`
      INSERT INTO growth_spaces (
        id, space_type, host_user_id, privacy_mode, consent_receipt_id,
        aggregate_revision, status, created_at, updated_at
      ) VALUES (?1, 'SOLO', ?2, 'PRIVATE', ?3, 1, 'ACTIVE', ?4, ?4)
    `).bind(spaceId, userId, consentId, createdAt));
  }
  statements.push(...receipt.statements);
  await commitBatch(db, statements);
  return response;
}

export async function listGrowthSpaces(db: D1Database, userId: string): Promise<GrowthSpaceProjection[]> {
  const rows = await db.prepare(`
    SELECT space.id, space.space_type, space.privacy_mode, space.status, space.aggregate_revision,
      space.created_at, space.updated_at, space.archived_at, consent.id AS consent_receipt_id,
      consent.purpose AS consent_purpose, consent.data_classes_json AS consent_data_classes_json,
      consent.policy_revision AS consent_policy_revision, consent.retention_policy AS consent_retention_policy,
      consent.issued_at AS consent_issued_at, consent.revoked_at AS consent_revoked_at
    FROM growth_spaces space
    INNER JOIN growth_private_consent_receipts consent ON consent.id = space.consent_receipt_id
    WHERE space.host_user_id = ?1 AND space.status = 'ACTIVE' AND consent.revoked_at IS NULL
    ORDER BY space.created_at DESC, space.id DESC
  `).bind(userId).all<Parameters<typeof asSpaceProjection>[0]>();
  return (rows.results ?? []).map(asSpaceProjection);
}

export async function loadGrowthSpace(db: D1Database, userId: string, spaceId: string): Promise<GrowthSpaceProjection> {
  const row = await db.prepare(`
    SELECT space.id, space.space_type, space.privacy_mode, space.status, space.aggregate_revision,
      space.created_at, space.updated_at, space.archived_at, consent.id AS consent_receipt_id,
      consent.purpose AS consent_purpose, consent.data_classes_json AS consent_data_classes_json,
      consent.policy_revision AS consent_policy_revision, consent.retention_policy AS consent_retention_policy,
      consent.issued_at AS consent_issued_at, consent.revoked_at AS consent_revoked_at
    FROM growth_spaces space
    INNER JOIN growth_private_consent_receipts consent ON consent.id = space.consent_receipt_id
    WHERE space.id = ?1 AND space.host_user_id = ?2
      AND space.status = 'ACTIVE' AND consent.revoked_at IS NULL
  `).bind(spaceId, userId).first<Parameters<typeof asSpaceProjection>[0]>();
  if (!row) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  return asSpaceProjection(row);
}

export async function listGrowthCycles(
  db: D1Database,
  userId: string,
  spaceId: string,
  filters: ListGrowthCyclesFilters = {},
): Promise<GrowthCycleSummary[]> {
  const membership = await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const binds: unknown[] = [spaceId, membership.id];
  const where = ['space_id = ?1', 'participant_membership_id = ?2'];
  if (filters.state !== undefined && !isState(filters.state)) {
    fail(400, 'GROWTH_STATE_FILTER_INVALID', 'validation');
  }
  if (filters.state) {
    where.push(`state = ?${binds.length + 1}`);
    binds.push(filters.state);
  }
  if (filters.originKind !== undefined && filters.originKind !== 'TRAINING' && filters.originKind !== 'SPARRING') {
    fail(400, 'GROWTH_ORIGIN_FILTER_INVALID', 'validation');
  }
  if (filters.originKind) {
    where.push(`origin_kind = ?${binds.length + 1}`);
    binds.push(filters.originKind);
  }
  const hasCursorTime = filters.cursorUpdatedAt !== undefined;
  const hasCursorId = filters.cursorId !== undefined;
  if (hasCursorTime !== hasCursorId
    || (hasCursorTime && (!Number.isInteger(filters.cursorUpdatedAt) || filters.cursorUpdatedAt! < 0 || !text(filters.cursorId)))) {
    fail(400, 'GROWTH_CURSOR_INVALID', 'validation');
  }
  if (hasCursorTime) {
    const timePosition = binds.length + 1;
    const idPosition = binds.length + 2;
    where.push(`(updated_at < ?${timePosition} OR (updated_at = ?${timePosition} AND id < ?${idPosition}))`);
    binds.push(filters.cursorUpdatedAt, filters.cursorId);
  }
  const limit = filters.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(400, 'GROWTH_LIMIT_INVALID', 'validation');
  }
  binds.push(limit);
  const rows = await db.prepare(`
    SELECT id, space_id, state, aggregate_revision, origin_kind, origin_attempt_id,
      origin_turn_number, opened_at, updated_at, closed_at
    FROM growth_cycles
    WHERE ${where.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?${binds.length}
  `).bind(...binds).all<Cycle>();
  // Avoid returning a list that was read after a concurrent consent revocation
  // or archive following the initial ownership resolution.
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  return (rows.results ?? []).map(asSummary);
}

export async function loadGrowthCycle(db: D1Database, userId: string, spaceId: string, cycleId: string): Promise<GrowthCycleDetail> {
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const cycle = await activeCycle(db, userId, spaceId, cycleId);
  const [hypothesesSchema, focusesSchema, rechecksSchema, eventsSchema] = await Promise.all([
    hypothesisSchema(db), focusSchema(db), recheckSchema(db), eventSchema(db),
  ]);
  const hypothesisLineageProjection = hypothesesSchema.hasRevisionLineage
    ? `hypothesis.revises_hypothesis_id, hypothesis.revision_rationale`
    : `lineage.revises_hypothesis_id, lineage.revision_rationale`;
  const hypothesisLineageJoin = hypothesesSchema.hasRevisionLineage
    ? ''
    : `LEFT JOIN growth_gap_hypothesis_revision_lineage lineage ON lineage.growth_hypothesis_id = hypothesis.id`;
  const focusSelectionKind = focusesSchema.hasSelectionKind ? 'focus.selection_kind' : `'INITIAL' AS selection_kind`;
  const recheckObservationLinks = rechecksSchema.hasObservationLinks
    ? 'recheck.opening_observation_id, recheck.recheck_observation_id'
    : 'NULL AS opening_observation_id, NULL AS recheck_observation_id';
  const eventTransitionSubjects = eventsSchema.hasTransitionSubject
    ? 'event.transition_subject_type, event.transition_subject_id'
    : 'subject.transition_subject_type, subject.transition_subject_id';
  const eventTransitionSubjectJoin = eventsSchema.hasTransitionSubject
    ? ''
    : 'LEFT JOIN growth_event_transition_subjects subject ON subject.growth_event_id = event.id';
  const [observations, hypotheses, focuses, quests, rechecks, timeline] = await Promise.all([
    db.prepare(`
      SELECT observation.id, observation.capability_id, observation.capability_revision, observation.rubric_revision_id,
        observation.status, observation.value_numeric, observation.value_scale, observation.evidence_event_ids_json,
        observation.inference_rule_id, observation.inference_rule_revision, observation.inference_validation,
        observation.confidence, observation.observed_at, observation.recorded_at
      FROM growth_capability_observations observation
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = observation.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      WHERE observation.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY observation.recorded_at ASC, observation.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; capability_id: string; capability_revision: number; rubric_revision_id: string | null;
      status: string; value_numeric: number | null; value_scale: string | null; evidence_event_ids_json: string;
      inference_rule_id: string; inference_rule_revision: number; inference_validation: string; confidence: number | null;
      observed_at: number; recorded_at: number;
    }>(),
    db.prepare(`
      SELECT hypothesis.id, hypothesis.observation_id, hypothesis.capability_id, hypothesis.capability_revision,
        hypothesis.gap_rule_id, hypothesis.gap_rule_revision, hypothesis.statement, hypothesis.state,
        hypothesis.supporting_event_ids_json, hypothesis.contradicting_event_ids_json,
        hypothesis.participant_rationale, hypothesis.source_revision, ${hypothesisLineageProjection},
        hypothesis.created_at, hypothesis.updated_at
      FROM growth_gap_hypotheses hypothesis
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = hypothesis.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      ${hypothesisLineageJoin}
      WHERE hypothesis.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY hypothesis.created_at ASC, hypothesis.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; observation_id: string | null; capability_id: string; capability_revision: number; gap_rule_id: string;
      gap_rule_revision: number; statement: string; state: string; supporting_event_ids_json: string;
      contradicting_event_ids_json: string; participant_rationale: string | null; source_revision: string | null;
      revises_hypothesis_id: string | null; revision_rationale: string | null; created_at: number; updated_at: number;
    }>(),
    db.prepare(`
      SELECT focus.id, focus.capability_id, focus.capability_revision, ${focusSelectionKind},
        focus.focus_statement, focus.selection_reason, focus.created_at
      FROM growth_focus_selections focus
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = focus.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      WHERE focus.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY focus.created_at ASC, focus.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; capability_id: string | null; capability_revision: number | null; selection_kind: string;
      focus_statement: string; selection_reason: string | null; created_at: number;
    }>(),
    db.prepare(`
      SELECT quest.id, quest.gap_hypothesis_id, quest.focus_selection_id, quest.practice_rule_id,
        quest.practice_rule_revision, quest.quest_type, quest.selection_reason, quest.learning_purpose,
        quest.status, quest.target_retention_horizon_hours, quest.revisit_at, quest.created_at, quest.updated_at
      FROM growth_practice_quests quest
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = quest.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      WHERE quest.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY quest.created_at ASC, quest.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; gap_hypothesis_id: string | null; focus_selection_id: string | null; practice_rule_id: string;
      practice_rule_revision: number; quest_type: string; selection_reason: string; learning_purpose: string;
      status: string; target_retention_horizon_hours: number; revisit_at: number | null; created_at: number; updated_at: number;
    }>(),
    db.prepare(`
      SELECT recheck.id, recheck.practice_quest_id, recheck.target_horizon_hours, recheck.scheduled_for,
        recheck.variant_policy_revision, recheck.follow_up_origin_kind, recheck.follow_up_attempt_id,
        ${recheckObservationLinks}, recheck.evidence_event_ids_json,
        recheck.outcome, recheck.created_at, recheck.recorded_at,
        ${rechecksSchema.hasObservationLinks ? '(SELECT capture.raw_signal_json FROM growth_capability_observations capture WHERE capture.id=recheck.recheck_observation_id AND capture.growth_cycle_id=recheck.growth_cycle_id)' : 'NULL'} AS assistance_signal
      FROM growth_rechecks recheck
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = recheck.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      WHERE recheck.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY recheck.created_at ASC, recheck.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; practice_quest_id: string; target_horizon_hours: number; scheduled_for: number;
      variant_policy_revision: string; follow_up_origin_kind: GrowthOriginKind | null; follow_up_attempt_id: string | null;
      opening_observation_id: string | null; recheck_observation_id: string | null; evidence_event_ids_json: string;
      outcome: string | null; created_at: number; recorded_at: number | null; assistance_signal: string | null;
    }>(),
    db.prepare(`
      SELECT event.id, event.event_type, event.object_type, event.object_id, event.object_revision,
        event.lifecycle_action, event.previous_state, event.next_state, ${eventTransitionSubjects},
        event.occurred_at, event.recorded_at, event.source_system,
        event.visibility, event.consent_receipt_id
      FROM growth_events event
      INNER JOIN growth_cycles scoped_cycle ON scoped_cycle.id = event.growth_cycle_id
      INNER JOIN growth_spaces scoped_space ON scoped_space.id = scoped_cycle.space_id
      INNER JOIN growth_space_memberships scoped_member ON scoped_member.id = scoped_cycle.participant_membership_id
      INNER JOIN growth_private_consent_receipts scoped_consent ON scoped_consent.id = scoped_cycle.consent_receipt_id
      ${eventTransitionSubjectJoin}
      WHERE event.growth_cycle_id = ?1 AND scoped_cycle.space_id = ?2
        AND scoped_space.host_user_id = ?3 AND scoped_space.status = 'ACTIVE'
        AND scoped_member.user_id = ?3 AND scoped_member.role = 'HOST' AND scoped_member.status = 'ACTIVE'
        AND scoped_consent.revoked_at IS NULL
      ORDER BY event.object_revision ASC, event.recorded_at ASC, event.id ASC
    `).bind(cycleId, spaceId, userId).all<{
      id: string; event_type: string; object_type: string; object_id: string; object_revision: number;
      lifecycle_action: string | null; previous_state: string | null; next_state: string | null;
      transition_subject_type: string | null; transition_subject_id: string | null; occurred_at: number; recorded_at: number;
      source_system: string; visibility: 'PRIVATE'; consent_receipt_id: string;
    }>(),
  ]);
  const followUpTablesForCycle = followUpTables(cycle.origin_kind);
  const followUpLaunches = await hasFollowUpLaunchSchema(db,cycle.origin_kind) ? await db.prepare(`SELECT launch.*,
      binding.session_id,binding.context_id,session.is_completed,
      ${cycle.origin_kind==='SPARRING'?'binding.completed_evaluation_id':'NULL'} AS completed_evaluation_id,
      ${cycle.origin_kind==='SPARRING'?'binding.completed_message_id':'binding.completed_turn_id'} AS completion_id
    FROM ${followUpTablesForCycle.launches} launch
    LEFT JOIN ${followUpTablesForCycle.bindings} binding ON binding.launch_id=launch.id
    LEFT JOIN ${followUpTablesForCycle.sessions} session ON session.id=binding.session_id AND session.user_id=launch.owner_user_id
    WHERE launch.growth_cycle_id=?1 AND launch.owner_user_id=?2`).bind(cycleId,userId).all<FollowUpProtocolRow & {
      id:string;recheck_id:string;changed_condition:string;session_id:string|null;context_id:string|null;baseline_context_id:string;
      is_completed:number|null;completion_id:string|number|null;completed_evaluation_id:number|null;
    }>() : {results:[]};
  const assistanceSummaries = new Map(await Promise.all((rechecks.results ?? []).map(async row => {
    const launch=followUpLaunches.results?.find(item=>item.recheck_id===row.id);
    const readContext=cycle.origin_kind==='SPARRING'&&launch?.context_id&&typeof launch.completion_id==='number'
      ? {db,owner:userId,launchId:launch.id,recheckId:row.id,baselineContextId:launch.baseline_context_id,
        followUpContextId:launch.context_id,completedMessageId:launch.completion_id,
        completedEvaluationId:launch.completed_evaluation_id,recordRevision:launch.assistance_capture_revision} : undefined;
    return [row.id, await projectRecheckAssistance(row.assistance_signal, cycle.origin_attempt_id, row.follow_up_attempt_id, cycle.origin_kind, readContext)] as const;
  })));
  // The final authorization read closes the revocation/archive window between
  // independent D1 detail projections and the returned public projection.
  await activeCycle(db, userId, spaceId, cycleId);
  return {
    ...asSummary(cycle),
    observations: (observations.results ?? []).map((row): GrowthObservationProjection => ({
      id: row.id, capabilityId: row.capability_id, capabilityRevision: row.capability_revision,
      rubricRevisionId: row.rubric_revision_id, status: row.status, valueNumeric: row.value_numeric,
      valueScale: row.value_scale, evidenceEventIds: publicStringArray(row.evidence_event_ids_json),
      inferenceRuleId: row.inference_rule_id, inferenceRuleRevision: row.inference_rule_revision,
      inferenceValidation: row.inference_validation, confidence: row.confidence, observedAt: row.observed_at,
      recordedAt: row.recorded_at,
    })),
    hypotheses: (hypotheses.results ?? []).map((row): GrowthGapHypothesisProjection => ({
      id: row.id, observationId: row.observation_id, capabilityId: row.capability_id,
      capabilityRevision: row.capability_revision, gapRuleId: row.gap_rule_id, gapRuleRevision: row.gap_rule_revision,
      statement: row.statement, state: row.state, supportingEventIds: publicStringArray(row.supporting_event_ids_json),
      contradictingEventIds: publicStringArray(row.contradicting_event_ids_json), participantRationale: row.participant_rationale,
      sourceRevision: row.source_revision, revisesHypothesisId: row.revises_hypothesis_id,
      revisionRationale: row.revision_rationale, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    focuses: (focuses.results ?? []).map((row): GrowthFocusProjection => ({
      id: row.id, capabilityId: row.capability_id, capabilityRevision: row.capability_revision,
      selectionKind: row.selection_kind, statement: row.focus_statement, reason: row.selection_reason,
      createdAt: row.created_at,
    })),
    quests: (quests.results ?? []).map((row): GrowthPracticeQuestProjection => ({
      id: row.id, gapHypothesisId: row.gap_hypothesis_id, focusSelectionId: row.focus_selection_id,
      practiceRuleId: row.practice_rule_id, practiceRuleRevision: row.practice_rule_revision, questType: row.quest_type,
      selectionReason: row.selection_reason, learningPurpose: row.learning_purpose, status: row.status,
      targetRetentionHorizonHours: row.target_retention_horizon_hours, revisitAt: row.revisit_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    rechecks: (rechecks.results ?? []).map((row): GrowthRecheckProjection => ({
      id: row.id, practiceQuestId: row.practice_quest_id, targetHorizonHours: row.target_horizon_hours,
      scheduledFor: row.scheduled_for, variantPolicyRevision: row.variant_policy_revision,
      assistance: assistanceSummaries.get(row.id),
      followUpLaunch: (() => { const launch=followUpLaunches.results?.find(item=>item.recheck_id===row.id); return launch ? {
        originKind:cycle.origin_kind,id:launch.id,changedCondition:launch.changed_condition,sessionId:launch.session_id,completed:launch.is_completed===1,sessionCompleted:launch.is_completed===1,recheckRecorded:launch.completion_id!=null,semanticValidation:'UNKNOWN' as const,protocol:projectFollowUpProtocol(launch,cycle.origin_kind),
      } : null; })(),
      followUpOriginKind: row.follow_up_origin_kind, followUpAttemptId: row.follow_up_attempt_id,
      openingObservationId: row.opening_observation_id, recheckObservationId: row.recheck_observation_id,
      evidenceEventIds: publicStringArray(row.evidence_event_ids_json), outcome: row.outcome,
      createdAt: row.created_at, recordedAt: row.recorded_at,
    })),
    timeline: (timeline.results ?? []).map((row): GrowthTimelineEventProjection => {
      if (row.visibility !== 'PRIVATE' || (row.previous_state !== null && !isState(row.previous_state))
        || (row.next_state !== null && !isState(row.next_state))) {
        fail(503, 'GROWTH_PUBLIC_PROJECTION_INVALID', 'unavailable', true);
      }
      return {
        id: row.id, eventType: row.event_type, objectType: row.object_type, objectId: row.object_id,
        objectRevision: row.object_revision, lifecycleAction: row.lifecycle_action,
        previousState: row.previous_state as GrowthState | null, nextState: row.next_state as GrowthState | null,
        transitionSubjectType: row.transition_subject_type, transitionSubjectId: row.transition_subject_id,
        occurredAt: row.occurred_at, recordedAt: row.recorded_at,
        sourceCategory: publicSourceCategory(row.source_system), visibility: row.visibility,
        consentReceiptId: row.consent_receipt_id,
      };
    }),
  };
}

export async function openGrowthCycle(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  input: OpenGrowthCycleInput,
  idempotencyKey: string,
): Promise<MutationResult> {
  const membership = await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const source = await loadOwnedOrigin(db, userId, input);
  await requireOriginSeedContract(db, source.kind);
  const originTuple = {
    actorId: userId,
    spaceId: membership.space_id,
    originKind: source.kind,
    originAttemptId: source.attemptId,
    turnNumber: source.turn,
    originEventIdentity: source.identity,
  };
  const request = { spaceId, origin: originTuple };
  const prior = await replay(db, security, userId, ROUTE.open, idempotencyKey, request);
  if (prior) {
    await assertRetainedOpenReplayAccess(db, userId, spaceId, prior);
    return prior;
  }
  const lookupDigest = await hmac(security, 'growth-cycle:origin-lookup:v1', originTuple);
  const originRequestDigest = await hmac(security, 'growth-cycle:origin-request:v1', originTuple);
  const schema = await cycleSchema(db);
  const tombstone = await db.prepare(`
    SELECT origin_request_digest
    FROM growth_cycle_resurrection_tombstones
    WHERE origin_lookup_digest = ?1
  `).bind(lookupDigest).first<{ origin_request_digest: string }>();
  if (tombstone) {
    if (tombstone.origin_request_digest === originRequestDigest) {
      fail(410, 'GROWTH_ORIGIN_TERMINALLY_DELETED', 'policy');
    }
    fail(409, 'GROWTH_ORIGIN_TOMBSTONE_CONFLICT', 'conflict');
  }
  const existing = await existingOpenOrigin(db, lookupDigest);
  if (existing) {
    return bindOpenAliasReceipt(db, security, userId, spaceId, idempotencyKey, request, existing, originRequestDigest);
  }

  const createdAt = now();
  const cycleId = id('growth-cycle');
  const cycle: Cycle = {
    id: cycleId,
    space_id: membership.space_id,
    participant_membership_id: membership.id,
    path_revision_id: source.pathId,
    consent_receipt_id: membership.consent_receipt_id,
    state: 'EVIDENCE_PENDING',
    aggregate_revision: 1,
    origin_kind: source.kind,
    origin_attempt_id: source.attemptId,
    origin_turn_number: source.turn,
    origin_event_identity: source.identity,
    origin_lookup_digest: lookupDigest,
    origin_request_digest: originRequestDigest,
    opened_at: createdAt,
    updated_at: createdAt,
    closed_at: null,
  };
  const finalResponse = cycleResult(cycle, 'GAP_UNKNOWN', 2, { originKind: source.kind });
  const routeReceipt = await receiptStatement(db, security, {
    userId,
    routeAction: ROUTE.open,
    idempotencyKey,
    cycleId,
    expectedRevision: 0,
    lifecycleAction: null,
    request,
    response: finalResponse,
    resultType: 'GROWTH_CYCLE',
    resultId: cycleId,
    resultRevision: 2,
    createdAt,
  });
  const [rawIdempotencyKey, unknownIdempotencyKey] = await Promise.all([
    internalIdempotencyKey(security, idempotencyKey, 'open:raw-evidence'),
    internalIdempotencyKey(security, idempotencyKey, 'open:record-unknown'),
  ]);
  const raw = await rawEvidencePlan(db, security, cycle, membership, userId, source, rawIdempotencyKey, createdAt);
  const unknown = unknownEvidencePlan(db, cycle, source, raw.id, createdAt);
  const transition = await lifecyclePlan(db, security, {
    cycle,
    userId,
    actor: null,
    action: 'PROVISIONAL_OR_INSUFFICIENT_SIGNAL_RECORDED',
    routeAction: ROUTE.system,
    idempotencyKey: unknownIdempotencyKey,
    request: { origin: originTuple, rawGrowthEventId: raw.id, outcome: 'UNKNOWN' },
    response: finalResponse,
    subject: ['GAP_HYPOTHESIS', unknown.hypothesisId],
    createdAt,
  });
  const cycleStatement = schema.hasOriginDigests ? db.prepare(`
    INSERT INTO growth_cycles (
      id, space_id, participant_membership_id, path_revision_id, origin_kind,
      origin_attempt_id, origin_turn_number, origin_event_identity, origin_lookup_digest,
      origin_request_digest, state, aggregate_revision, consent_receipt_id, opened_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'EVIDENCE_PENDING', 1, ?11, ?12, ?12)
  `).bind(
    cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
    cycle.origin_kind, cycle.origin_attempt_id, cycle.origin_turn_number,
    cycle.origin_event_identity, cycle.origin_lookup_digest, cycle.origin_request_digest,
    cycle.consent_receipt_id, createdAt,
  ) : db.prepare(`
    INSERT INTO growth_cycles (
      id, space_id, participant_membership_id, path_revision_id, origin_kind,
      origin_attempt_id, origin_turn_number, origin_event_identity, state,
      aggregate_revision, consent_receipt_id, opened_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'EVIDENCE_PENDING', 1, ?9, ?10, ?10)
  `).bind(
    cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
    cycle.origin_kind, cycle.origin_attempt_id, cycle.origin_turn_number,
    cycle.origin_event_identity, cycle.consent_receipt_id, createdAt,
  );
  const originIdentityStatement = schema.hasOriginDigests ? [] : [db.prepare(`
    INSERT INTO growth_cycle_origin_identities (
      growth_cycle_id, origin_lookup_digest, origin_request_digest, created_at
    ) VALUES (?1, ?2, ?3, ?4)
  `).bind(cycle.id, lookupDigest, originRequestDigest, createdAt)];
  try {
    await commitBatch(db, [
      cycleStatement,
      ...originIdentityStatement,
      ...routeReceipt.statements,
      ...raw.statements,
      ...unknown.statements,
      ...transition.statements,
    ]);
  } catch (error) {
    if (error instanceof GrowthServiceError && error.code === 'GROWTH_PERSISTENCE_CONFLICT') {
      return recoverOpenFirstCommitConflict(
        db, security, userId, spaceId, idempotencyKey, request, lookupDigest, originRequestDigest,
      );
    }
    throw error;
  }
  return finalResponse;
}

async function prepareValidatedGapOffer(
  db: D1Database,
  security: GrowthCycleSecurity,
  input: {
    cycle: Cycle;
    actor: Member;
    userId: string;
    hypothesisId: string;
    idempotencyKey: string;
    request: Row;
    createdAt: number;
  },
): Promise<{ response: MutationResult; statements: D1PreparedStatement[] }> {
  const hypothesis = await db.prepare(`
    SELECT id, state, capability_id, capability_revision, supporting_event_ids_json
    FROM growth_gap_hypotheses
    WHERE id = ?1 AND growth_cycle_id = ?2
  `).bind(input.hypothesisId, input.cycle.id).first<{
    id: string;
    state: string;
    capability_id: string;
    capability_revision: number;
    supporting_event_ids_json: string;
  }>();
  if (!hypothesis || hypothesis.state !== 'PROPOSED') fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
  const code = capabilityCode(input.cycle, hypothesis.capability_id);
  if (!code || hypothesis.capability_revision !== 1) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
  const rule = await validatedGapPracticeRule(db, input.cycle);
  const questId = id('growth-quest');
  const finalResponse = cycleResult(input.cycle, 'PRACTICE_OFFERED', input.cycle.aggregate_revision + 2, {
    hypothesisId: input.hypothesisId,
    practiceQuestId: questId,
  });
  const accept = await lifecyclePlan(db, security, {
    cycle: input.cycle,
    userId: input.userId,
    actor: input.actor,
    action: 'ACCEPT',
    routeAction: ROUTE.gap,
    idempotencyKey: input.idempotencyKey,
    request: input.request,
    response: finalResponse,
    subject: ['GAP_HYPOTHESIS', input.hypothesisId],
    createdAt: input.createdAt,
  });
  const acceptedCycle: Cycle = {
    ...input.cycle,
    state: 'GAP_ACCEPTED',
    aggregate_revision: input.cycle.aggregate_revision + 1,
  };
  const offerIdempotencyKey = await internalIdempotencyKey(security, input.idempotencyKey, 'gap:offer-practice');
  const offer = await lifecyclePlan(db, security, {
    cycle: acceptedCycle,
    userId: input.userId,
    actor: null,
    action: 'OFFER_PRACTICE',
    routeAction: ROUTE.system,
    idempotencyKey: offerIdempotencyKey,
    request: { hypothesisId: input.hypothesisId, questId, ruleId: rule.id },
    response: finalResponse,
    subject: ['PRACTICE_QUEST', questId],
    createdAt: input.createdAt,
  });
  const sourcePacketJson = canonicalText({
    source: 'validated_gap_evidence',
    immutableOriginIdentity: input.cycle.origin_event_identity,
    supportingEventIds: hypothesis.supporting_event_ids_json,
  });
  return {
    response: finalResponse,
    statements: [
      db.prepare(`
        UPDATE growth_gap_hypotheses
        SET state = 'ACCEPTED', participant_rationale = NULL, updated_at = ?2
        WHERE id = ?1
      `).bind(input.hypothesisId, input.createdAt),
      ...accept.statements,
      practiceQuestStatement(db, {
        id: questId,
        cycle: input.cycle,
        gapHypothesisId: input.hypothesisId,
        focusSelectionId: null,
        ruleId: rule.id,
        ruleRevision: rule.revision,
        questType: rule.questTypes[code],
        sourcePacketJson,
        selectionReason: 'validated gap accepted by participant',
        learningPurpose: 'Practice the accepted validated capability gap.',
        horizonHours: rule.horizonHours,
        createdAt: input.createdAt,
      }),
      ...offer.statements,
    ],
  };
}

export async function respondToGap(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  cycleId: string,
  input: GapResponseInput,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const request: Row = {
    spaceId,
    cycleId,
    expectedRevision,
    action: input.action,
    hypothesisId: input.hypothesisId ?? null,
    rationale: input.rationale ?? null,
  };
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const cycle = await activeCycle(db, userId, spaceId, cycleId);
  const actor = await activeMember(db, userId, spaceId, cycleId);
  const prior = await replay(db, security, userId, ROUTE.gap, idempotencyKey, request);
  if (prior) {
    await assertActiveCycleReplayAccess(db, userId, spaceId, cycleId);
    return prior;
  }
  requireRevision(cycle, expectedRevision);
  const createdAt = now();

  if (input.action === 'retry_evidence') {
    if (cycle.state !== 'GAP_UNKNOWN') fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    fail(503, 'GROWTH_VALIDATION_RULE_UNAVAILABLE', 'unavailable', true);
  }
  if (input.action === 'accept') {
    if (cycle.state !== 'GAP_PROPOSED' || !text(input.hypothesisId)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    const offer = await prepareValidatedGapOffer(db, security, {
      cycle, actor, userId, hypothesisId: input.hypothesisId!, idempotencyKey, request, createdAt,
    });
    await commitBatch(db, offer.statements);
    return offer.response;
  }
  if (input.action === 'resume') {
    if (cycle.state !== 'GAP_DEFERRED' || !text(input.hypothesisId)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    const hypothesesSchema = await hypothesisSchema(db);
    const deferred = await db.prepare(`
      SELECT observation_id, capability_id, capability_revision, gap_rule_id, gap_rule_revision, statement,
        supporting_event_ids_json, contradicting_event_ids_json, generator_revision, model_revision,
        prompt_revision, source_revision
      FROM growth_gap_hypotheses
      WHERE id = ?1 AND growth_cycle_id = ?2 AND state = 'DEFERRED'
    `).bind(input.hypothesisId, cycleId).first<{
      observation_id: string | null; capability_id: string; capability_revision: number; gap_rule_id: string;
      gap_rule_revision: number; statement: string; supporting_event_ids_json: string;
      contradicting_event_ids_json: string; generator_revision: string | null; model_revision: string | null;
      prompt_revision: string | null; source_revision: string | null;
    }>();
    if (!deferred) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
    const resumedId = id('growth-hypothesis');
    const response = cycleResult(cycle, 'GAP_PROPOSED', cycle.aggregate_revision + 1, { hypothesisId: resumedId });
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action: 'RESUME', routeAction: ROUTE.gap, idempotencyKey,
      request, response, subject: ['GAP_HYPOTHESIS', resumedId], createdAt,
    });
    const resumeHypothesis = hypothesesSchema.hasRevisionLineage
      ? db.prepare(`
        INSERT INTO growth_gap_hypotheses (
          id, growth_cycle_id, observation_id, capability_id, capability_revision,
          gap_rule_id, gap_rule_revision, statement, state, supporting_event_ids_json,
          contradicting_event_ids_json, generator_revision, model_revision, prompt_revision,
          source_revision, revises_hypothesis_id, revision_rationale, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROPOSED', ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, 'participant resumed deferred validated hypothesis', ?16, ?16)
      `).bind(
        resumedId, cycleId, deferred.observation_id, deferred.capability_id, deferred.capability_revision,
        deferred.gap_rule_id, deferred.gap_rule_revision, deferred.statement,
        deferred.supporting_event_ids_json, deferred.contradicting_event_ids_json,
        deferred.generator_revision, deferred.model_revision, deferred.prompt_revision,
        deferred.source_revision, input.hypothesisId, createdAt,
      )
      : db.prepare(`
        INSERT INTO growth_gap_hypotheses (
          id, growth_cycle_id, observation_id, capability_id, capability_revision,
          gap_rule_id, gap_rule_revision, statement, state, supporting_event_ids_json,
          contradicting_event_ids_json, generator_revision, model_revision, prompt_revision,
          source_revision, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROPOSED', ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?15)
      `).bind(
        resumedId, cycleId, deferred.observation_id, deferred.capability_id, deferred.capability_revision,
        deferred.gap_rule_id, deferred.gap_rule_revision, deferred.statement,
        deferred.supporting_event_ids_json, deferred.contradicting_event_ids_json,
        deferred.generator_revision, deferred.model_revision, deferred.prompt_revision,
        deferred.source_revision, createdAt,
      );
    const resumeLineage = hypothesesSchema.hasRevisionLineage
      ? []
      : [db.prepare(`
        INSERT INTO growth_gap_hypothesis_revision_lineage (
          growth_hypothesis_id, revises_hypothesis_id, revision_rationale, created_at
        ) VALUES (?1, ?2, 'participant resumed deferred validated hypothesis', ?3)
      `).bind(resumedId, input.hypothesisId, createdAt)];
    await commitBatch(db, [
      resumeHypothesis,
      ...resumeLineage,
      ...transition.statements,
    ]);
    return response;
  }
  if (input.action === 'close_unknown' && (cycle.state === 'GAP_CONTESTED' || cycle.state === 'GAP_DEFERRED')) {
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action: 'CLOSE_UNKNOWN', routeAction: ROUTE.gap,
      idempotencyKey, request, createdAt,
    });
    await commitBatch(db, transition.statements);
    return transition.response;
  }

  const actionMap: Record<string, { from: GrowthState[]; action: string; hypothesisState?: string }> = {
    contest: { from: ['GAP_PROPOSED'], action: 'CONTEST', hypothesisState: 'CONTESTED' },
    dismiss: { from: ['GAP_PROPOSED', 'GAP_CONTESTED', 'GAP_DEFERRED'], action: 'DISMISS', hypothesisState: 'DISMISSED' },
    defer: { from: ['GAP_PROPOSED'], action: 'DEFER', hypothesisState: 'DEFERRED' },
    close_unknown: { from: ['GAP_UNKNOWN'], action: 'DISMISS_AND_CLOSE_UNKNOWN' },
    close: { from: ['GAP_DISMISSED'], action: 'CLOSE' },
  };
  const mapped = actionMap[input.action];
  if (!mapped || !mapped.from.includes(cycle.state)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
  if (mapped.hypothesisState) {
    if (!text(input.hypothesisId)) fail(400, 'GROWTH_HYPOTHESIS_ID_REQUIRED', 'validation');
    if (input.action === 'contest' && !text(input.rationale)) fail(400, 'GROWTH_CONTEST_RATIONALE_REQUIRED', 'validation');
    const hypothesis = await db.prepare(`
      SELECT state FROM growth_gap_hypotheses WHERE id = ?1 AND growth_cycle_id = ?2
    `).bind(input.hypothesisId, cycleId).first<{ state: string }>();
    const expectedHypothesisState = input.action === 'dismiss'
      ? cycle.state === 'GAP_PROPOSED' ? 'PROPOSED' : cycle.state === 'GAP_CONTESTED' ? 'CONTESTED' : 'DEFERRED'
      : 'PROPOSED';
    if (!hypothesis || hypothesis.state !== expectedHypothesisState) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
    const response = cycleResult(cycle, mapped.hypothesisState === 'CONTESTED' ? 'GAP_CONTESTED' : mapped.hypothesisState === 'DISMISSED' ? 'GAP_DISMISSED' : 'GAP_DEFERRED', cycle.aggregate_revision + 1, { hypothesisId: input.hypothesisId });
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action: mapped.action, routeAction: ROUTE.gap, idempotencyKey,
      request, response, subject: ['GAP_HYPOTHESIS', input.hypothesisId!], createdAt,
    });
    await commitBatch(db, [
      db.prepare(`
        UPDATE growth_gap_hypotheses
        SET state = ?2, participant_rationale = ?3, updated_at = ?4 WHERE id = ?1
      `).bind(input.hypothesisId, mapped.hypothesisState, text(input.rationale) || null, createdAt),
      ...transition.statements,
    ]);
    return response;
  }
  const transition = await lifecyclePlan(db, security, {
    cycle, userId, actor, action: mapped.action, routeAction: ROUTE.gap, idempotencyKey,
    request, createdAt,
  });
  await commitBatch(db, transition.statements);
  return transition.response;
}

export async function selectGrowthFocus(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  cycleId: string,
  input: GrowthFocusInput,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const request: Row = {
    spaceId,
    cycleId,
    expectedRevision,
    capabilityId: input.capabilityId ?? null,
    capabilityRevision: input.capabilityRevision ?? null,
    statement: input.statement,
    reason: input.reason ?? null,
  };
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const cycle = await activeCycle(db, userId, spaceId, cycleId);
  const actor = await activeMember(db, userId, spaceId, cycleId);
  const prior = await replay(db, security, userId, ROUTE.focus, idempotencyKey, request);
  if (prior) {
    await assertActiveCycleReplayAccess(db, userId, spaceId, cycleId);
    return prior;
  }
  requireRevision(cycle, expectedRevision);
  if (cycle.state !== 'GAP_UNKNOWN' || !text(input.statement) || !input.capabilityId || input.capabilityRevision !== 1) {
    fail(409, 'GROWTH_FOCUS_REQUIRES_EXPLICIT_CAPABILITY', 'conflict');
  }
  const code = capabilityCode(cycle, input.capabilityId);
  if (!code) fail(400, 'GROWTH_FOCUS_CAPABILITY_OUT_OF_PATH', 'validation');
  const [raw, rule, offerIdempotencyKey] = await Promise.all([
    firstOwnedRawEvidence(db, cycle),
    learnerFocusRule(db, cycle),
    internalIdempotencyKey(security, idempotencyKey, 'focus:offer-practice'),
  ]);
  const focusId = id('growth-focus');
  const questId = id('growth-quest');
  const createdAt = now();
  const focusesSchema = await focusSchema(db);
  const finalResponse = cycleResult(cycle, 'PRACTICE_OFFERED', cycle.aggregate_revision + 2, {
    focusSelectionId: focusId,
    practiceQuestId: questId,
    outcome: 'UNKNOWN',
  });
  const choose = await lifecyclePlan(db, security, {
    cycle, userId, actor, action: 'CHOOSE_FOCUS', routeAction: ROUTE.focus, idempotencyKey,
    request, response: finalResponse, subject: ['FOCUS_SELECTION', focusId], createdAt,
  });
  const focusCycle: Cycle = { ...cycle, state: 'FOCUS_SELECTED', aggregate_revision: cycle.aggregate_revision + 1 };
  const offer = await lifecyclePlan(db, security, {
    cycle: focusCycle, userId, actor: null, action: 'OFFER_PRACTICE', routeAction: ROUTE.system,
    idempotencyKey: offerIdempotencyKey,
    request: { focusSelectionId: focusId, practiceQuestId: questId, ruleId: rule.id, outcome: 'UNKNOWN' },
    response: finalResponse, subject: ['PRACTICE_QUEST', questId], createdAt,
  });
  const focusStatement = focusesSchema.hasSelectionKind
    ? db.prepare(`
      INSERT INTO growth_focus_selections (
        id, growth_cycle_id, participant_membership_id, capability_id, capability_revision,
        selection_kind, focus_statement, selection_reason, created_at
      ) VALUES (?1, ?2, ?3, ?4, 1, 'INITIAL', ?5, ?6, ?7)
    `).bind(focusId, cycleId, actor.id, input.capabilityId, input.statement.trim(), text(input.reason) || null, createdAt)
    : db.prepare(`
      INSERT INTO growth_focus_selections (
        id, growth_cycle_id, participant_membership_id, capability_id, capability_revision,
        focus_statement, selection_reason, created_at
      ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)
    `).bind(focusId, cycleId, actor.id, input.capabilityId, input.statement.trim(), text(input.reason) || null, createdAt);
  await commitBatch(db, [
    focusStatement,
    ...choose.statements,
    practiceQuestStatement(db, {
      id: questId,
      cycle,
      gapHypothesisId: null,
      focusSelectionId: focusId,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      questType: rule.questTypes[code],
      sourcePacketJson: sourcePacket(cycle, raw),
      selectionReason: 'learner-chosen focus',
      learningPurpose: 'Practice the learner-selected capability with a variant task.',
      horizonHours: rule.horizonHours,
      createdAt,
    }),
    ...offer.statements,
  ]);
  return finalResponse;
}

async function questForCycle(
  db: D1Database,
  cycleId: string,
  questId: string,
): Promise<{
  id: string;
  status: string;
  target_retention_horizon_hours: number;
  practice_rule_id: string;
  practice_rule_revision: number;
}> {
  const quest = await db.prepare(`
    SELECT id, status, target_retention_horizon_hours, practice_rule_id, practice_rule_revision
    FROM growth_practice_quests WHERE id = ?1 AND growth_cycle_id = ?2
  `).bind(questId, cycleId).first<{
    id: string;
    status: string;
    target_retention_horizon_hours: number;
    practice_rule_id: string;
    practice_rule_revision: number;
  }>();
  if (!quest) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
  return quest;
}

async function acceptPracticeAndSchedule(
  db: D1Database,
  security: GrowthCycleSecurity,
  input: {
    cycle: Cycle;
    actor: Member;
    userId: string;
    quest: Awaited<ReturnType<typeof questForCycle>>;
    idempotencyKey: string;
    request: Row;
    action: 'ACCEPT' | 'RETRY_RECHECK_SCHEDULING';
    createdAt: number;
  },
): Promise<MutationResult> {
  if (!(await recheckSchema(db)).hasObservationLinks) {
    fail(503, 'GROWTH_RECHECK_POLICY_GUARDS_UNAVAILABLE', 'unavailable', true);
  }
  const recheckId = id('growth-recheck');
  const finalResponse = cycleResult(input.cycle, 'RECHECK_SCHEDULED', input.cycle.aggregate_revision + 2, {
    practiceQuestId: input.quest.id,
    recheckId,
    outcome: 'UNKNOWN',
  });
  const first = await lifecyclePlan(db, security, {
    cycle: input.cycle, userId: input.userId, actor: input.actor, action: input.action,
    routeAction: ROUTE.practice, idempotencyKey: input.idempotencyKey, request: input.request,
    response: finalResponse, subject: ['PRACTICE_QUEST', input.quest.id], createdAt: input.createdAt,
  });
  const afterFirst: Cycle = {
    ...input.cycle,
    state: 'PRACTICE_ACCEPTED',
    aggregate_revision: input.cycle.aggregate_revision + 1,
  };
  const due = input.createdAt + input.quest.target_retention_horizon_hours * 60 * 60 * 1000;
  const scheduleIdempotencyKey = await internalIdempotencyKey(security, input.idempotencyKey, 'practice:schedule-recheck');
  const schedule = await lifecyclePlan(db, security, {
    cycle: afterFirst, userId: input.userId, actor: null, action: 'SCHEDULE_RECHECK',
    routeAction: ROUTE.system, idempotencyKey: scheduleIdempotencyKey,
    request: { practiceQuestId: input.quest.id, recheckId, due, outcome: 'UNKNOWN' },
    response: finalResponse, subject: ['RECHECK', recheckId], createdAt: input.createdAt,
  });
  const statements: D1PreparedStatement[] = [];
  if (input.action === 'ACCEPT') {
    statements.push(db.prepare(`
      UPDATE growth_practice_quests
      SET status = 'ACCEPTED', revisit_at = NULL, updated_at = ?2 WHERE id = ?1
    `).bind(input.quest.id, input.createdAt));
  }
  statements.push(
    ...first.statements,
    db.prepare(`
      INSERT INTO growth_rechecks (
        id, growth_cycle_id, practice_quest_id, target_horizon_hours, scheduled_for,
        variant_policy_revision, evidence_event_ids_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7)
    `).bind(
      recheckId, input.cycle.id, input.quest.id, input.quest.target_retention_horizon_hours,
      due, `${input.quest.practice_rule_id}:${input.quest.practice_rule_revision}`, input.createdAt,
    ),
    ...schedule.statements,
  );
  await commitBatch(db, statements);
  return finalResponse;
}

export async function respondToPractice(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  cycleId: string,
  input: PracticeResponseInput,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const request: Row = {
    spaceId,
    cycleId,
    expectedRevision,
    action: input.action,
    practiceQuestId: input.practiceQuestId ?? null,
    revisitAt: input.revisitAt ?? null,
  };
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const cycle = await activeCycle(db, userId, spaceId, cycleId);
  const actor = await activeMember(db, userId, spaceId, cycleId);
  const prior = await replay(db, security, userId, ROUTE.practice, idempotencyKey, request);
  if (prior) {
    await assertActiveCycleReplayAccess(db, userId, spaceId, cycleId);
    return prior;
  }
  requireRevision(cycle, expectedRevision);
  const createdAt = now();
  if (input.action === 'retry_schedule') {
    if (cycle.state !== 'PRACTICE_ACCEPTED' || !text(input.practiceQuestId)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    const quest = await questForCycle(db, cycleId, input.practiceQuestId!);
    if (quest.status !== 'ACCEPTED') fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
    return acceptPracticeAndSchedule(db, security, {
      cycle, actor, userId, quest, idempotencyKey, request, action: 'RETRY_RECHECK_SCHEDULING', createdAt,
    });
  }
  if (input.action === 'accept') {
    if (cycle.state !== 'PRACTICE_OFFERED' || !text(input.practiceQuestId)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    const quest = await questForCycle(db, cycleId, input.practiceQuestId!);
    if (quest.status !== 'OFFERED') fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
    return acceptPracticeAndSchedule(db, security, {
      cycle, actor, userId, quest, idempotencyKey, request, action: 'ACCEPT', createdAt,
    });
  }
  if (input.action === 'close_unknown' && cycle.state === 'PRACTICE_ACCEPTED') {
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action: 'CANCEL_AND_CLOSE_UNKNOWN', routeAction: ROUTE.practice,
      idempotencyKey, request, createdAt,
    });
    await commitBatch(db, transition.statements);
    return transition.response;
  }
  const mappings: Record<string, { from: GrowthState; action: string; status?: 'OFFERED' | 'DECLINED' | 'DEFERRED'; requiresQuest: boolean }> = {
    decline: { from: 'PRACTICE_OFFERED', action: 'DECLINE', status: 'DECLINED', requiresQuest: true },
    defer: { from: 'PRACTICE_OFFERED', action: 'DEFER', status: 'DEFERRED', requiresQuest: true },
    resume: { from: 'PRACTICE_DEFERRED', action: 'RESUME', status: 'OFFERED', requiresQuest: true },
    close_unknown: { from: 'PRACTICE_DEFERRED', action: 'CLOSE_UNKNOWN', requiresQuest: false },
    close: { from: 'PRACTICE_DECLINED', action: 'CLOSE', requiresQuest: false },
  };
  const mapped = mappings[input.action];
  if (!mapped || cycle.state !== mapped.from) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
  let quest: Awaited<ReturnType<typeof questForCycle>> | null = null;
  if (mapped.requiresQuest) {
    if (!text(input.practiceQuestId)) fail(400, 'GROWTH_PRACTICE_QUEST_ID_REQUIRED', 'validation');
    quest = await questForCycle(db, cycleId, input.practiceQuestId!);
    const expectedStatus = input.action === 'resume' ? 'DEFERRED' : 'OFFERED';
    if (quest.status !== expectedStatus) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
    if (input.action === 'defer' && (!Number.isInteger(input.revisitAt) || input.revisitAt! <= createdAt)) {
      fail(400, 'GROWTH_REVISIT_TIME_REQUIRED', 'validation');
    }
  }
  const response = cycleResult(cycle, mapped.status === 'DECLINED' ? 'PRACTICE_DECLINED'
    : mapped.status === 'DEFERRED' ? 'PRACTICE_DEFERRED'
      : mapped.status === 'OFFERED' ? 'PRACTICE_OFFERED' : 'CLOSED', cycle.aggregate_revision + 1,
  quest ? { practiceQuestId: quest.id } : {});
  const transition = await lifecyclePlan(db, security, {
    cycle, userId, actor, action: mapped.action, routeAction: ROUTE.practice, idempotencyKey,
    request, response, subject: quest ? ['PRACTICE_QUEST', quest.id] : undefined, createdAt,
  });
  const statements: D1PreparedStatement[] = [];
  if (quest && mapped.status) {
    statements.push(db.prepare(`
      UPDATE growth_practice_quests SET status = ?2, revisit_at = ?3, updated_at = ?4 WHERE id = ?1
    `).bind(quest.id, mapped.status, mapped.status === 'DEFERRED' ? input.revisitAt : null, createdAt));
  }
  statements.push(...transition.statements);
  await commitBatch(db, statements);
  return response;
}

export async function launchRecheckFollowUp(
  db: D1Database, security: GrowthCycleSecurity, userId: string, spaceId: string, cycleId: string,
  input: { recheckId: string; changedCondition: string }, idempotencyKey: string, expectedRevision: number,
): Promise<MutationResult> {
  const changedCondition = typeof input.changedCondition === 'string' ? input.changedCondition.trim() : '';
  if (!text(input.recheckId) || changedCondition.length < 10 || changedCondition.length > 1000) fail(400,'GROWTH_FOLLOW_UP_CONDITION_REQUIRED','validation');
  const request = { spaceId,cycleId,expectedRevision,recheckId:input.recheckId,changedCondition };
  await assertOwnedActiveGrowthSpace(db,userId,spaceId);
  const cycle=await activeCycle(db,userId,spaceId,cycleId); const actor=await activeMember(db,userId,spaceId,cycleId);
  const prior=await replay(db,security,userId,ROUTE.followUpLaunch,idempotencyKey,request);
  if(prior) { await assertActiveCycleReplayAccess(db,userId,spaceId,cycleId); return prior; }
  requireRevision(cycle,expectedRevision);
  if(cycle.state!=='RECHECK_SCHEDULED') fail(409,'GROWTH_TRANSITION_NOT_ALLOWED','conflict');
  const tables=followUpTables(cycle.origin_kind);
  const assistanceRevision=cycle.origin_kind==='SPARRING' ? SPARRING_ASSISTANCE_CAPTURE_POLICY_REVISION : ASSISTANCE_CAPTURE_POLICY_REVISION;
  const recheck=await db.prepare('SELECT scheduled_for FROM growth_rechecks WHERE id=?1 AND growth_cycle_id=?2 AND recorded_at IS NULL').bind(input.recheckId,cycleId).first<{scheduled_for:number}>();
  if(!recheck) fail(409,'GROWTH_TRANSITION_SUBJECT_INVALID','conflict');
  const createdAt=now();
  if(!Number.isSafeInteger(recheck.scheduled_for) || createdAt<recheck.scheduled_for) fail(409,'GROWTH_RECHECK_NOT_DUE','conflict');
  await requireFollowUpProtocolSchema(db,cycle.origin_kind);
  const context=cycle.origin_kind==='SPARRING' ? await loadOwnedSparringContext(db,cycle.origin_attempt_id,userId) : await loadOwnedTrainingSessionContext(db,cycle.origin_attempt_id,userId);
  const existing=await db.prepare(`SELECT id FROM ${tables.launches} WHERE recheck_id=?1`).bind(input.recheckId).first<{id:string}>();
  if(existing) fail(409,'GROWTH_FOLLOW_UP_ALREADY_LAUNCHED','conflict');
  const launchId=id('growth-follow-up');
  const response=cycleResult(cycle,'RECHECK_SCHEDULED',cycle.aggregate_revision+1,{launchId,originKind:cycle.origin_kind,recheckId:input.recheckId,changedCondition,semanticValidation:'UNKNOWN',protocol:projectFollowUpProtocol({protocol_revision:FOLLOW_UP_PROTOCOL_REVISION,assistance_policy_revision:assistanceRevision,...(cycle.origin_kind==='SPARRING'?{assistance_capture_revision:SPARRING_ASSISTANCE_RECORD_REVISION}:{}),created_at:createdAt,changed_condition:changedCondition},cycle.origin_kind)});
  const transition=await lifecyclePlan(db,security,{cycle,userId,actor,action:'LAUNCH_RECHECK_FOLLOW_UP',routeAction:ROUTE.followUpLaunch,idempotencyKey,request,response,createdAt});
  await commitBatch(db,[db.prepare(`INSERT INTO ${tables.launches}
    (id,growth_cycle_id,recheck_id,owner_user_id,baseline_session_id,baseline_context_id,changed_condition,created_at,protocol_revision,assistance_policy_revision${cycle.origin_kind==='SPARRING'?',assistance_capture_revision':''})
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10${cycle.origin_kind==='SPARRING'?',?11':''})`).bind(launchId,cycleId,input.recheckId,userId,cycle.origin_attempt_id,context.id,changedCondition,createdAt,FOLLOW_UP_PROTOCOL_REVISION,assistanceRevision,...(cycle.origin_kind==='SPARRING'?[SPARRING_ASSISTANCE_RECORD_REVISION]:[])),...transition.statements]);
  return response;
}

export async function recordRecheck(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  cycleId: string,
  input: RecordRecheckInput,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const request: Row = {
    spaceId,
    cycleId,
    expectedRevision,
    action: input.action,
    recheckId: input.recheckId ?? null,
    followUpOrigin: input.followUpOrigin ?? null,
    ...(input.followUpLaunchId ? { followUpLaunchId: input.followUpLaunchId } : {}),
    revisitAt: input.revisitAt ?? null,
  };
  if (!(await recheckSchema(db)).hasObservationLinks) {
    fail(503, 'GROWTH_RECHECK_POLICY_GUARDS_UNAVAILABLE', 'unavailable', true);
  }
  await assertOwnedActiveGrowthSpace(db, userId, spaceId);
  const cycle = await activeCycle(db, userId, spaceId, cycleId);
  const actor = await activeMember(db, userId, spaceId, cycleId);
  const prior = await replay(db, security, userId, ROUTE.recheck, idempotencyKey, request);
  if (prior) {
    await assertActiveCycleReplayAccess(db, userId, spaceId, cycleId);
    return prior;
  }
  requireRevision(cycle, expectedRevision);
  const createdAt = now();
  if (input.action === 'retry_transfer') {
    if (cycle.state !== 'TRANSFER_PENDING') fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    fail(503, 'GROWTH_TRANSFER_VALIDATION_UNAVAILABLE', 'unavailable', true);
  }
  if (input.action === 'close' || input.action === 'close_unknown') {
    const action = cycle.state === 'RECHECKED'
      ? 'CLOSE_WITHOUT_VALIDATED_COMPARISON'
      : cycle.state === 'RECHECK_SCHEDULED' ? 'CANCEL_AND_CLOSE_UNKNOWN' : null;
    if (!action) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action, routeAction: ROUTE.recheck, idempotencyKey, request, createdAt,
    });
    await commitBatch(db, transition.statements);
    return transition.response;
  }
  if (cycle.state !== 'RECHECK_SCHEDULED' || !text(input.recheckId)) fail(409, 'GROWTH_TRANSITION_NOT_ALLOWED', 'conflict');
  const recheck = await db.prepare(`
    SELECT id, practice_quest_id, scheduled_for
    FROM growth_rechecks WHERE id = ?1 AND growth_cycle_id = ?2 AND recorded_at IS NULL
  `).bind(input.recheckId, cycleId).first<{ id: string; practice_quest_id: string; scheduled_for: number }>();
  if (!recheck) fail(409, 'GROWTH_TRANSITION_SUBJECT_INVALID', 'conflict');
  const followUpStorage = followUpTables(cycle.origin_kind);
  if (input.action === 'reschedule') {
    if (await hasFollowUpLaunchSchema(db,cycle.origin_kind) && await db.prepare(`SELECT launch.id FROM ${followUpStorage.launches} launch JOIN ${followUpStorage.bindings} binding ON binding.launch_id=launch.id WHERE launch.recheck_id=?1`).bind(input.recheckId).first()) fail(409,'GROWTH_FOLLOW_UP_ALREADY_STARTED','conflict');
    if (!Number.isInteger(input.revisitAt) || input.revisitAt! <= createdAt) fail(400, 'GROWTH_REVISIT_TIME_REQUIRED', 'validation');
    const response = cycleResult(cycle, 'RECHECK_SCHEDULED', cycle.aggregate_revision + 1, { recheckId: input.recheckId });
    const transition = await lifecyclePlan(db, security, {
      cycle, userId, actor, action: 'DEFER_OR_RESCHEDULE', routeAction: ROUTE.recheck,
      idempotencyKey, request, response, subject: ['RECHECK', input.recheckId!], createdAt,
    });
    await commitBatch(db, [
      db.prepare(`UPDATE growth_rechecks SET scheduled_for = ?2 WHERE id = ?1`).bind(input.recheckId, input.revisitAt),
      ...transition.statements,
    ]);
    return response;
  }
  if (input.action !== 'record' || (!input.followUpOrigin && !input.followUpLaunchId)) fail(400, 'GROWTH_FOLLOW_UP_ORIGIN_REQUIRED', 'validation');
  if (!(await recheckSchema(db)).hasObservationLinks) {
    fail(503, 'GROWTH_RECHECK_EVIDENCE_LINKS_UNAVAILABLE', 'unavailable', true);
  }
  if (!Number.isSafeInteger(recheck.scheduled_for) || createdAt < recheck.scheduled_for) {
    fail(409, 'GROWTH_RECHECK_NOT_DUE', 'conflict');
  }
  if (!input.followUpLaunchId && await hasFollowUpLaunchSchema(db,cycle.origin_kind)
    && await db.prepare(`SELECT id FROM ${followUpStorage.launches} WHERE recheck_id=?1 AND growth_cycle_id=?2`).bind(input.recheckId,cycleId).first()) {
    fail(422,'GROWTH_FOLLOW_UP_BINDING_REQUIRED','evidence');
  }
  const launch = input.followUpLaunchId ? await loadOwnedFollowUpLaunch(db,userId,input.followUpLaunchId,cycle.origin_kind) : null;
  if (launch && (launch.growth_cycle_id!==cycleId || launch.recheck_id!==input.recheckId || !launch.session_id || input.followUpOrigin)) fail(422,'GROWTH_FOLLOW_UP_BINDING_REQUIRED','evidence');
  const followUpOrigin = launch?.session_id ? {originKind:cycle.origin_kind,originAttemptId:launch.session_id} : input.followUpOrigin!;
  const source = await loadOwnedOrigin(db, userId, followUpOrigin);
  const completion = launch ? await db.prepare(cycle.origin_kind==='TRAINING' ? 'SELECT id FROM training_turns WHERE session_id=?1 ORDER BY turn_number DESC,id DESC LIMIT 1' : `SELECT message.id, (SELECT id FROM evaluations WHERE session_id=?1 AND user_id=?2 AND turn=message.turn ORDER BY created_at DESC,id DESC LIMIT 1) AS evaluation_id FROM messages message WHERE session_id=?1 AND role='user' AND turn=(SELECT session_completion_turn FROM sessions WHERE id=?1 AND user_id=?2 AND is_completed=1) ORDER BY turn DESC,id DESC LIMIT 1`).bind(...(cycle.origin_kind==='TRAINING' ? [source.attemptId] : [source.attemptId,userId])).first<{id:string|number;evaluation_id?:number|null}>() : null;
  if(launch && !completion) fail(422,'GROWTH_FOLLOW_UP_COMPLETION_REQUIRED','evidence');
  await requireOriginSeedContract(db, source.kind);
  if (source.kind !== cycle.origin_kind || source.identity === cycle.origin_event_identity) {
    fail(422, 'GROWTH_RECHECK_ORIGIN_KIND_OR_IDENTITY_MISMATCH', 'evidence');
  }
  const contextComparison = await compareRecheckContexts(db, { owner: userId, kind: source.kind,
    baselineSessionId: cycle.origin_attempt_id, followUpSessionId: source.attemptId,
    scheduledFor: recheck.scheduled_for, recordedAt: createdAt });
  if (launch) {
    source.payload = { ...source.payload,
      changedContextDefinition: { source: 'LEARNER_DECLARED', text: launch.changed_condition, semanticValidation: 'UNKNOWN' },
      followUpProtocol: projectFollowUpProtocol(launch,cycle.origin_kind),
      followUpCapture: { launchId: launch.id, scheduledFor: recheck.scheduled_for, recordedAt: createdAt },
      assistance: await (cycle.origin_kind==='SPARRING' ? captureSparringRecheckAssistance : captureRecheckAssistance)(db, {
      owner: userId, baselineSessionId: cycle.origin_attempt_id, baselineContextId: contextComparison.baseline.contextId,
      followUpSessionId: source.attemptId, followUpContextId: contextComparison.followUp.contextId,
      ...(cycle.origin_kind==='SPARRING' ? {recordRevision:launch.assistance_capture_revision,binding:{launchId:launch.id,recheckId:input.recheckId!,
        baselineContextId:contextComparison.baseline.contextId,followUpContextId:contextComparison.followUp.contextId,
        completedMessageId:Number(completion!.id),completedEvaluationId:completion!.evaluation_id??null}} : {}),
    }) };
  }
  const target = await db.prepare(`
    SELECT COALESCE(focus.capability_id, hypothesis.capability_id) AS capability_id,
      COALESCE(focus.capability_revision, hypothesis.capability_revision) AS capability_revision
    FROM growth_practice_quests quest
    LEFT JOIN growth_focus_selections focus ON focus.id = quest.focus_selection_id
    LEFT JOIN growth_gap_hypotheses hypothesis ON hypothesis.id = quest.gap_hypothesis_id
    WHERE quest.id = ?1 AND quest.growth_cycle_id = ?2
  `).bind(recheck.practice_quest_id, cycleId).first<{ capability_id: string; capability_revision: number }>();
  if (!target || !text(target.capability_id) || target.capability_revision !== 1) {
    fail(409, 'GROWTH_RECHECK_TARGET_CAPABILITY_REQUIRED', 'conflict');
  }
  const opening = await db.prepare(`
    SELECT id FROM growth_capability_observations
    WHERE growth_cycle_id = ?1 AND capability_id = ?2 AND capability_revision = ?3
    ORDER BY observed_at ASC, recorded_at ASC, id ASC LIMIT 1
  `).bind(cycleId, target.capability_id, target.capability_revision).first<{ id: string }>();
  const rawIdempotencyKey = await internalIdempotencyKey(security, idempotencyKey, 'recheck:raw-evidence');
  const raw = await rawEvidencePlan(db, security, cycle, actor, userId, source, rawIdempotencyKey, createdAt);
  const observationId = id('growth-recheck-observation');
  const response = cycleResult(cycle, 'RECHECKED', cycle.aggregate_revision + 1, {
    recheckId: input.recheckId,
    recheckObservationId: observationId,
    outcome: 'UNKNOWN',
  });
  const transition = await lifecyclePlan(db, security, {
    cycle, userId, actor, action: 'RECORD_RECHECK', routeAction: ROUTE.recheck, idempotencyKey,
    request, response, subject: ['RECHECK', input.recheckId!], createdAt,
  });
  await commitBatch(db, [
    ...raw.statements,
    db.prepare(`
      INSERT INTO growth_capability_observations (
        id, growth_cycle_id, capability_id, capability_revision, rubric_revision_id,
        status, evidence_event_ids_json, inference_rule_id, inference_rule_revision,
        inference_validation, confidence, raw_signal_json, observed_at, recorded_at
      ) VALUES (?1, ?2, ?3, ?4, NULL, 'UNKNOWN', ?5, ?6, ?7,
        'PROVISIONAL_UNCALIBRATED', NULL, ?8, ?9, ?9)
    `).bind(
      observationId, cycleId, target.capability_id, target.capability_revision, JSON.stringify([raw.id]),
      source.observationRuleId, source.observationRuleRevision, canonicalText({
        label: 'DESCRIPTIVE_ONLY', reason: source.signal.reason,
        tieRule: 'stable_capability_code_ascending', tiedCapabilities: source.signal.ties,
        targetCapability: target.capability_id, storedSourcePayload: source.payload, contextComparison,
      }), createdAt,
    ),
    db.prepare(`
      UPDATE growth_rechecks
      SET follow_up_origin_kind = ?2, follow_up_attempt_id = ?3, opening_observation_id = ?4,
        recheck_observation_id = ?5, evidence_event_ids_json = ?6, outcome = 'UNKNOWN', recorded_at = ?7
      WHERE id = ?1
    `).bind(
      input.recheckId, source.kind, source.attemptId, opening?.id ?? null, observationId,
      JSON.stringify([raw.id]), createdAt,
    ),
    ...(launch && completion ? [cycle.origin_kind==='SPARRING'
      ? db.prepare('UPDATE growth_recheck_sparring_follow_up_bindings SET completed_message_id=?2,completed_evaluation_id=?3 WHERE launch_id=?1').bind(launch.id,completion.id,completion.evaluation_id??null)
      : db.prepare('UPDATE growth_recheck_follow_up_bindings SET completed_turn_id=?2 WHERE launch_id=?1').bind(launch.id,completion.id)] : []),
    ...transition.statements,
  ]);
  return response;
}

export async function deleteGrowthCycle(
  db: D1Database,
  security: GrowthCycleSecurity,
  userId: string,
  spaceId: string,
  cycleId: string,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<MutationResult> {
  requireIdempotencyKey(idempotencyKey);
  const [deletionStorage, cycleStorage, hypothesesStorage] = await Promise.all([
    deletionSchema(db), cycleSchema(db), hypothesisSchema(db),
  ]);
  const lookupDigest = await hmac(security, 'growth-cycle:deletion-idempotency:v1', {
    actorId: userId,
    routeAction: ROUTE.deletion,
    idempotencyKey,
  });
  const request = { actorId: userId, routeAction: ROUTE.deletion, spaceId, cycleId, idempotencyKey, expectedRevision };
  const requestDigest = await hmac(security, 'growth-cycle:deletion-request:v1', request);
  const tombstone = await db.prepare(deletionStorage.hasCurrentIdempotencyColumns ? `
    SELECT id, request_digest, completed_at, created_at
    FROM growth_deletion_receipts WHERE idempotency_lookup_digest = ?1
  ` : `
    SELECT receipt.id, record.request_digest, receipt.completed_at, receipt.created_at
    FROM growth_deletion_idempotency_records record
    INNER JOIN growth_deletion_receipts receipt ON receipt.id = record.deletion_receipt_id
    WHERE record.idempotency_lookup_digest = ?1
  `).bind(lookupDigest).first<{ id: string; request_digest: string; completed_at: number | null; created_at: number }>();
  if (tombstone) {
    if (tombstone.request_digest !== requestDigest) fail(409, 'GROWTH_DELETION_INPUT_CONFLICT', 'conflict');
    const completedAt = finiteInteger(tombstone.completed_at);
    const createdAt = finiteInteger(tombstone.created_at);
    if (completedAt === null || createdAt === null || completedAt < createdAt) {
      fail(503, 'GROWTH_DELETION_REPLAY_INCOMPLETE', 'unavailable', true);
    }
    return { deleted: true, terminal: true, deletionReceiptId: tombstone.id, completedAt: tombstone.completed_at };
  }
  // This owner lookup intentionally excludes active-consent and active-space requirements:
  // revocation fail-closes mutations but may not block a participant's privacy deletion.
  const cycle = await db.prepare(cycleStorage.hasOriginDigests ? `
    SELECT cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
      cycle.consent_receipt_id, cycle.state, cycle.aggregate_revision, cycle.origin_kind,
      cycle.origin_attempt_id, cycle.origin_turn_number, cycle.origin_event_identity,
      cycle.origin_lookup_digest, cycle.origin_request_digest, cycle.opened_at, cycle.updated_at,
      cycle.closed_at
    FROM growth_cycles cycle
    INNER JOIN growth_spaces space ON space.id = cycle.space_id
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    WHERE cycle.id = ?1 AND cycle.space_id = ?2 AND space.host_user_id = ?3 AND membership.user_id = ?3
      AND membership.role = 'HOST' AND membership.status = 'ACTIVE'
  ` : `
    SELECT cycle.id, cycle.space_id, cycle.participant_membership_id, cycle.path_revision_id,
      cycle.consent_receipt_id, cycle.state, cycle.aggregate_revision, cycle.origin_kind,
      cycle.origin_attempt_id, cycle.origin_turn_number, cycle.origin_event_identity,
      '' AS origin_lookup_digest, '' AS origin_request_digest, cycle.opened_at, cycle.updated_at,
      cycle.closed_at
    FROM growth_cycles cycle
    INNER JOIN growth_spaces space ON space.id = cycle.space_id
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    WHERE cycle.id = ?1 AND cycle.space_id = ?2 AND space.host_user_id = ?3 AND membership.user_id = ?3
      AND membership.role = 'HOST' AND membership.status = 'ACTIVE'
  `).bind(cycleId, spaceId, userId).first<Cycle>();
  if (!cycle) fail(404, 'GROWTH_RESOURCE_NOT_FOUND', 'authorization');
  requireRevision(cycle, expectedRevision);
  const deletionHypothesisStatements = await childFirstHypothesisDeleteStatements(
    db, cycleId, hypothesesStorage.hasRevisionLineage,
  );
  const deletionReceiptId = id('growth-delete-receipt');
  // Receipt creation and completion use the database clock. App timestamps below
  // describe the request only and cannot govern receipt chronology.
  const createdAt = Math.floor(now() / 1000) * 1000;
  const deletionReceiptStatements = deletionStorage.hasCurrentIdempotencyColumns ? [db.prepare(`
      INSERT INTO growth_deletion_receipts (
        id, idempotency_lookup_digest, request_digest, policy_revision, created_at
      ) VALUES (?1, ?2, ?3, 1, strftime('%s','now') * 1000)
    `).bind(deletionReceiptId, lookupDigest, requestDigest)] : [
    db.prepare(`
      INSERT INTO growth_deletion_receipts (
        id${deletionStorage.hasLegacyReceiptRetryLookup ? ', retry_lookup_digest' : ''}, policy_revision, created_at
      ) VALUES (?1${deletionStorage.hasLegacyReceiptRetryLookup ? ', ?2' : ''}, 1, strftime('%s','now') * 1000)
    `).bind(...(deletionStorage.hasLegacyReceiptRetryLookup
      ? [deletionReceiptId, lookupDigest]
      : [deletionReceiptId])),
    db.prepare(`
      INSERT INTO growth_deletion_idempotency_records (
        idempotency_lookup_digest, deletion_receipt_id, request_digest, created_at
      ) VALUES (?1, ?2, ?3, ?4)
    `).bind(lookupDigest, deletionReceiptId, requestDigest, createdAt),
  ];
  const deletionContextStatement = deletionStorage.hasCurrentIdempotencyColumns ? db.prepare(`
      INSERT INTO growth_deletion_context (
        growth_cycle_id, requested_by_user_id, request_id, route_action, idempotency_key,
        expected_aggregate_revision, request_digest, idempotency_lookup_digest,
        deletion_receipt_id, requested_at, reason_code, created_at
      ) VALUES (?1, ?2, ?3, 'DELETE_GROWTH_CYCLE', ?4, ?5, ?6, ?7, ?8, ?9, 'OWNER_REQUESTED', ?9)
    `).bind(
      cycleId, userId, id('growth-delete-request'), idempotencyKey, expectedRevision,
      requestDigest, lookupDigest, deletionReceiptId, createdAt,
    ) : db.prepare(`
      INSERT INTO growth_deletion_context (
        growth_cycle_id, requested_by_user_id, request_id, route_action, idempotency_key,
        expected_aggregate_revision, request_digest${deletionStorage.hasLegacyContextRetryLookup ? ', retry_lookup_digest' : ''},
        deletion_receipt_id, requested_at, reason_code, created_at
      ) VALUES (?1, ?2, ?3, 'DELETE_GROWTH_CYCLE', ?4, ?5, ?6${deletionStorage.hasLegacyContextRetryLookup ? ', ?7' : ''}, ?${deletionStorage.hasLegacyContextRetryLookup ? '8' : '7'}, ?${deletionStorage.hasLegacyContextRetryLookup ? '9' : '8'}, 'OWNER_REQUESTED', ?${deletionStorage.hasLegacyContextRetryLookup ? '9' : '8'})
    `).bind(...(deletionStorage.hasLegacyContextRetryLookup ? [
      cycleId, userId, id('growth-delete-request'), idempotencyKey, expectedRevision,
      requestDigest, lookupDigest, deletionReceiptId, createdAt,
    ] : [
      cycleId, userId, id('growth-delete-request'), idempotencyKey, expectedRevision,
      requestDigest, deletionReceiptId, createdAt,
    ]));
  await commitBatch(db, [
    ...deletionReceiptStatements,
    deletionContextStatement,
    // Legacy 0047 contains intra-cycle RESTRICT edges. Delete the dependent
    // graph in referential order while the controlled deletion context exists.
    db.prepare(`
      DELETE FROM growth_recheck_evidence
      WHERE growth_recheck_id IN (SELECT id FROM growth_rechecks WHERE growth_cycle_id = ?1)
    `).bind(cycleId),
    db.prepare(`
      DELETE FROM growth_gap_hypothesis_evidence
      WHERE gap_hypothesis_id IN (SELECT id FROM growth_gap_hypotheses WHERE growth_cycle_id = ?1)
    `).bind(cycleId),
    db.prepare(`
      DELETE FROM growth_observation_evidence
      WHERE observation_id IN (SELECT id FROM growth_capability_observations WHERE growth_cycle_id = ?1)
    `).bind(cycleId),
    db.prepare(`DELETE FROM growth_rechecks WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`DELETE FROM growth_practice_quests WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`
      DELETE FROM growth_gap_hypothesis_revision_lineage
      WHERE growth_hypothesis_id IN (
        SELECT id FROM growth_gap_hypotheses WHERE growth_cycle_id = ?1
      )
    `).bind(cycleId),
    ...deletionHypothesisStatements,
    db.prepare(`DELETE FROM growth_focus_selections WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`DELETE FROM growth_capability_observations WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`DELETE FROM growth_events WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`DELETE FROM growth_mutation_receipts WHERE growth_cycle_id = ?1`).bind(cycleId),
    db.prepare(`DELETE FROM growth_cycles WHERE id = ?1`).bind(cycleId),
  ]);
  const completed = await db.prepare(`
    SELECT created_at, completed_at FROM growth_deletion_receipts WHERE id = ?1
  `).bind(deletionReceiptId).first<{ created_at: number; completed_at: number | null }>();
  const completedAt = finiteInteger(completed?.completed_at);
  const receiptCreatedAt = finiteInteger(completed?.created_at);
  if (completedAt === null || receiptCreatedAt === null || completedAt < receiptCreatedAt) {
    fail(503, 'GROWTH_DELETION_COMPLETION_UNAVAILABLE', 'unavailable', true);
  }
  return {
    deleted: true,
    terminal: true,
    deletionReceiptId,
    completedAt,
  };
}
