import { launchRecheckFollowUp } from '../services/growth-cycle';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Bindings } from '../types';
import { resolveAuthUser, type AuthUser } from '../middleware/auth';
import {
  GrowthServiceError,
  deleteGrowthCycle,
  ensureSoloGrowthSpace,
  listGrowthCycles,
  listGrowthSpaces,
  loadGrowthCycle,
  loadGrowthSpace,
  openGrowthCycle,
  recordPrivateSoloConsent,
  recordRecheck,
  requestGrowthHumanReview,
  respondToGap,
  respondToPractice,
  revokePrivateSoloConsent,
  selectGrowthFocus,
} from '../services/growth-cycle';
import { createGrowthCycleSecurity } from '../services/growth-cycle-security';
import type {
  GapResponseInput,
  GrowthFocusInput,
  GrowthHttpStatus,
  GrowthOriginKind,
  GrowthState,
  ListGrowthCyclesFilters,
  OpenGrowthCycleInput,
  PracticeResponseInput,
  PrivateSoloConsentInput,
  RecordRecheckInput,
} from '../services/growth-cycle-types';

type GrowthEnvironment = {
  Bindings: Bindings;
  Variables: {
    authUser: AuthUser | null;
  };
};

const growthRoute = new Hono<GrowthEnvironment>();
type GrowthContext = Context<GrowthEnvironment>;
type JsonRecord = Record<string, unknown>;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_LONG_TEXT_LENGTH = 2_000;
const MAX_DATA_CLASSES = 16;
const MAX_POLICY_REVISION = 1_000_000;
const MAX_PAGE_LIMIT = 100;

const growthStates = new Set<GrowthState>([
  'EVIDENCE_PENDING', 'GAP_PROPOSED', 'GAP_ACCEPTED', 'GAP_CONTESTED', 'GAP_DISMISSED',
  'GAP_DEFERRED', 'GAP_UNKNOWN', 'FOCUS_SELECTED', 'PRACTICE_OFFERED', 'PRACTICE_ACCEPTED',
  'PRACTICE_DECLINED', 'PRACTICE_DEFERRED', 'RECHECK_SCHEDULED', 'RECHECKED',
  'TRANSFER_PENDING', 'CLOSED',
]);
const originKinds = new Set<GrowthOriginKind>(['TRAINING', 'SPARRING']);
const gapActions = new Set<GapResponseInput['action']>([
  'accept', 'contest', 'dismiss', 'defer', 'resume', 'retry_evidence', 'close_unknown', 'close',
]);
const practiceActions = new Set<PracticeResponseInput['action']>([
  'accept', 'decline', 'defer', 'resume', 'retry_schedule', 'close_unknown', 'close',
]);
const recheckActions = new Set<RecordRecheckInput['action']>([
  'record', 'reschedule', 'close_unknown', 'close', 'retry_transfer',
]);

function growthFailure(
  status: GrowthHttpStatus,
  code: string,
  phase: GrowthServiceError['phase'],
  retryable = false,
  details?: Record<string, unknown>,
): never {
  throw new GrowthServiceError({ status, code, phase, retryable, details });
}

function requestId(c: GrowthContext): string {
  const existing = c.res.headers.get('X-Request-Id');
  if (existing) return existing;
  const generated = crypto.randomUUID();
  c.header('X-Request-Id', generated);
  return generated;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function requiredObject(value: unknown, allowed: readonly string[]): JsonRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) {
    growthFailure(400, 'GROWTH_REQUEST_BODY_INVALID', 'validation');
  }
  return value;
}

async function jsonObject(c: GrowthContext, allowed: readonly string[]): Promise<JsonRecord> {
  try {
    return requiredObject(await c.req.json<unknown>(), allowed);
  } catch (error) {
    if (error instanceof GrowthServiceError) throw error;
    growthFailure(400, 'GROWTH_REQUEST_BODY_INVALID', 'validation');
  }
}

function requiredText(value: unknown, code: string, maximumLength: number): string {
  if (typeof value !== 'string') growthFailure(400, code, 'validation');
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) growthFailure(400, code, 'validation');
  return normalized;
}

function optionalText(value: unknown, code: string, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, code, maximumLength);
}

function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) growthFailure(400, code, 'validation');
  return value;
}

function optionalId(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredId(value, code);
}

function requiredSafeInteger(value: unknown, code: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    growthFailure(400, code, 'validation');
  }
  return value;
}

function optionalSafeInteger(value: unknown, code: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  return requiredSafeInteger(value, code, minimum, maximum);
}

function idempotencyKey(c: GrowthContext): string {
  const key = c.req.header('Idempotency-Key');
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    growthFailure(400, 'GROWTH_IDEMPOTENCY_KEY_INVALID', 'validation');
  }
  return key;
}

function pathId(c: GrowthContext, name: string): string {
  return requiredId(c.req.param(name), `GROWTH_${name.toUpperCase()}_INVALID`);
}

function parseOrigin(value: unknown): OpenGrowthCycleInput {
  const source = requiredObject(value, ['originKind', 'originAttemptId']);
  if (typeof source.originKind !== 'string' || !originKinds.has(source.originKind as GrowthOriginKind)) {
    growthFailure(400, 'GROWTH_ORIGIN_KIND_INVALID', 'validation');
  }
  return {
    originKind: source.originKind as GrowthOriginKind,
    originAttemptId: requiredId(source.originAttemptId, 'GROWTH_ORIGIN_ATTEMPT_ID_INVALID'),
  };
}

function parseConsent(value: JsonRecord): PrivateSoloConsentInput {
  const purpose = requiredText(value.purpose, 'GROWTH_CONSENT_PURPOSE_INVALID', MAX_SHORT_TEXT_LENGTH);
  const retentionPolicy = requiredText(value.retentionPolicy, 'GROWTH_RETENTION_POLICY_INVALID', MAX_SHORT_TEXT_LENGTH);
  const policyRevision = requiredSafeInteger(value.policyRevision, 'GROWTH_POLICY_REVISION_INVALID', 1, MAX_POLICY_REVISION);
  if (!Array.isArray(value.dataClasses) || value.dataClasses.length === 0 || value.dataClasses.length > MAX_DATA_CLASSES) {
    growthFailure(400, 'GROWTH_DATA_CLASSES_INVALID', 'validation');
  }
  const dataClasses = value.dataClasses.map((item) => requiredText(item, 'GROWTH_DATA_CLASSES_INVALID', MAX_SHORT_TEXT_LENGTH));
  if (new Set(dataClasses).size !== dataClasses.length) growthFailure(400, 'GROWTH_DATA_CLASSES_INVALID', 'validation');
  return { purpose, dataClasses, policyRevision, retentionPolicy };
}

function parseGap(value: JsonRecord): { input: GapResponseInput; expectedRevision: number } {
  if (typeof value.action !== 'string' || !gapActions.has(value.action as GapResponseInput['action'])) {
    growthFailure(400, 'GROWTH_GAP_ACTION_INVALID', 'validation');
  }
  return {
    input: {
      action: value.action as GapResponseInput['action'],
      hypothesisId: optionalId(value.hypothesisId, 'GROWTH_HYPOTHESIS_ID_INVALID'),
      rationale: optionalText(value.rationale, 'GROWTH_GAP_RATIONALE_INVALID', MAX_LONG_TEXT_LENGTH),
    },
    expectedRevision: requiredSafeInteger(value.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID'),
  };
}

function parseFocus(value: JsonRecord): { input: GrowthFocusInput; expectedRevision: number } {
  return {
    input: {
      capabilityId: optionalId(value.capabilityId, 'GROWTH_CAPABILITY_ID_INVALID'),
      capabilityRevision: optionalSafeInteger(value.capabilityRevision, 'GROWTH_CAPABILITY_REVISION_INVALID', 1, MAX_POLICY_REVISION),
      statement: requiredText(value.statement, 'GROWTH_FOCUS_STATEMENT_INVALID', MAX_LONG_TEXT_LENGTH),
      reason: optionalText(value.reason, 'GROWTH_FOCUS_REASON_INVALID', MAX_LONG_TEXT_LENGTH),
    },
    expectedRevision: requiredSafeInteger(value.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID'),
  };
}

function parsePractice(value: JsonRecord): { input: PracticeResponseInput; expectedRevision: number } {
  if (typeof value.action !== 'string' || !practiceActions.has(value.action as PracticeResponseInput['action'])) {
    growthFailure(400, 'GROWTH_PRACTICE_ACTION_INVALID', 'validation');
  }
  return {
    input: {
      action: value.action as PracticeResponseInput['action'],
      practiceQuestId: optionalId(value.practiceQuestId, 'GROWTH_PRACTICE_QUEST_ID_INVALID'),
      revisitAt: optionalSafeInteger(value.revisitAt, 'GROWTH_REVISIT_AT_INVALID', 0),
    },
    expectedRevision: requiredSafeInteger(value.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID'),
  };
}

function parseRecheck(value: JsonRecord): { input: RecordRecheckInput; expectedRevision: number } {
  if (typeof value.action !== 'string' || !recheckActions.has(value.action as RecordRecheckInput['action'])) {
    growthFailure(400, 'GROWTH_RECHECK_ACTION_INVALID', 'validation');
  }
  let followUpOrigin: OpenGrowthCycleInput | undefined;
  if (value.followUpOrigin !== undefined) followUpOrigin = parseOrigin(value.followUpOrigin);
  return {
    input: {
      action: value.action as RecordRecheckInput['action'],
      recheckId: optionalId(value.recheckId, 'GROWTH_RECHECK_ID_INVALID'),
      followUpOrigin,
      followUpLaunchId: optionalId(value.followUpLaunchId, 'GROWTH_FOLLOW_UP_LAUNCH_ID_INVALID'),
      revisitAt: optionalSafeInteger(value.revisitAt, 'GROWTH_REVISIT_AT_INVALID', 0),
    },
    expectedRevision: requiredSafeInteger(value.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID'),
  };
}

function parseListFilters(c: GrowthContext): ListGrowthCyclesFilters {
  const url = new URL(c.req.url);
  const allowed = new Set(['state', 'originKind', 'limit', 'cursorUpdatedAt', 'cursorId']);
  for (const [key] of url.searchParams) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      growthFailure(400, 'GROWTH_QUERY_INVALID', 'validation');
    }
  }
  const state = url.searchParams.get('state');
  if (state !== null && !growthStates.has(state as GrowthState)) growthFailure(400, 'GROWTH_STATE_FILTER_INVALID', 'validation');
  const originKind = url.searchParams.get('originKind');
  if (originKind !== null && !originKinds.has(originKind as GrowthOriginKind)) {
    growthFailure(400, 'GROWTH_ORIGIN_FILTER_INVALID', 'validation');
  }
  const limitValue = url.searchParams.get('limit');
  let limit: number | undefined;
  if (limitValue !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limitValue)) growthFailure(400, 'GROWTH_LIMIT_INVALID', 'validation');
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_LIMIT) growthFailure(400, 'GROWTH_LIMIT_INVALID', 'validation');
  }
  const cursorUpdatedAt = url.searchParams.get('cursorUpdatedAt');
  const cursorId = url.searchParams.get('cursorId');
  if ((cursorUpdatedAt === null) !== (cursorId === null)) growthFailure(400, 'GROWTH_CURSOR_INVALID', 'validation');
  let parsedCursorUpdatedAt: number | undefined;
  let parsedCursorId: string | undefined;
  if (cursorUpdatedAt !== null && cursorId !== null) {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(cursorUpdatedAt)) growthFailure(400, 'GROWTH_CURSOR_INVALID', 'validation');
    parsedCursorUpdatedAt = Number(cursorUpdatedAt);
    if (!Number.isSafeInteger(parsedCursorUpdatedAt)) growthFailure(400, 'GROWTH_CURSOR_INVALID', 'validation');
    parsedCursorId = requiredId(cursorId, 'GROWTH_CURSOR_INVALID');
  }
  return {
    state: state === null ? undefined : state as GrowthState,
    originKind: originKind === null ? undefined : originKind as GrowthOriginKind,
    limit,
    cursorUpdatedAt: parsedCursorUpdatedAt,
    cursorId: parsedCursorId,
  };
}

function rejectQuery(c: GrowthContext): void {
  if (new URL(c.req.url).search) growthFailure(400, 'GROWTH_QUERY_INVALID', 'validation');
}

async function requireEmptyBody(c: GrowthContext): Promise<void> {
  if ((await c.req.text()).length !== 0) growthFailure(400, 'GROWTH_REQUEST_BODY_INVALID', 'validation');
}

function database(c: GrowthContext): D1Database {
  if (!c.env.DB) growthFailure(503, 'GROWTH_DATABASE_UNAVAILABLE', 'unavailable', true);
  return c.env.DB;
}

function security(c: GrowthContext) {
  database(c);
  const secret = c.env.GROWTH_CYCLE_HMAC_SECRET;
  if (typeof secret !== 'string' || !secret.trim()) {
    growthFailure(503, 'GROWTH_SECURITY_HMAC_UNAVAILABLE', 'unavailable', true);
  }
  try {
    return createGrowthCycleSecurity(secret);
  } catch {
    growthFailure(503, 'GROWTH_SECURITY_HMAC_UNAVAILABLE', 'unavailable', true);
  }
}

function authenticatedUser(c: GrowthContext): string {
  const auth = c.get('authUser');
  if (!auth || typeof auth.userId !== 'string' || !auth.userId) {
    growthFailure(401, 'GROWTH_AUTHENTICATION_REQUIRED', 'authorization');
  }
  return auth.userId;
}

function safeDetails(value: Record<string, unknown> | undefined): Record<string, number> | undefined {
  const expectedRevision = value?.expectedRevision;
  if (typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0) {
    return { expectedRevision };
  }
  return undefined;
}

function errorResponse(c: GrowthContext, error: unknown): Response {
  const id = requestId(c);
  if (error instanceof GrowthServiceError) {
    const details = safeDetails(error.details);
    return c.json({
      status: error.status,
      code: error.code,
      phase: error.phase,
      requestId: id,
      retryable: error.retryable,
      error: 'The Growth request could not be completed.',
      ...(details ? { details } : {}),
    }, error.status);
  }
  return c.json({
    status: 500,
    code: 'GROWTH_INTERNAL_ERROR',
    phase: 'unavailable',
    requestId: id,
    retryable: true,
    error: 'The Growth request could not be completed.',
  }, 500);
}

function success(c: GrowthContext, value: Record<string, unknown>, status: ContentfulStatusCode = 200): Response {
  requestId(c);
  return c.json(value, status);
}

function route(handler: (c: GrowthContext) => Promise<Response>) {
  return async (c: GrowthContext): Promise<Response> => {
    try {
      return await handler(c);
    } catch (error) {
      return errorResponse(c, error);
    }
  };
}

growthRoute.use('/api/growth/*', async (c, next) => {
  requestId(c);
  const configuredSecret = c.env.JWT_SECRET;
  if (typeof configuredSecret !== 'string' || !configuredSecret.trim()) {
    return errorResponse(c, new GrowthServiceError({
      status: 503,
      code: 'GROWTH_AUTHENTICATION_UNAVAILABLE',
      phase: 'unavailable',
      retryable: true,
    }));
  }
  try {
    const auth = await resolveAuthUser(c);
    if (!auth) {
      return errorResponse(c, new GrowthServiceError({
        status: 401,
        code: 'GROWTH_AUTHENTICATION_REQUIRED',
        phase: 'authorization',
      }));
    }
    c.set('authUser', auth);
    await next();
  } catch {
    return errorResponse(c, new GrowthServiceError({
      status: 503,
      code: 'GROWTH_AUTHENTICATION_UNAVAILABLE',
      phase: 'unavailable',
      retryable: true,
    }));
  }
});

// Static routes precede parameterised routes so the public API cannot rely on matcher ordering.
growthRoute.get('/api/growth/spaces', route(async (c) => {
  rejectQuery(c);
  const spaces = await listGrowthSpaces(database(c), authenticatedUser(c));
  return success(c, { spaces });
}));

growthRoute.post('/api/growth/privacy/consent', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['purpose', 'dataClasses', 'policyRevision', 'retentionPolicy']);
  const result = await recordPrivateSoloConsent(db, secure, authenticatedUser(c), parseConsent(body), idempotencyKey(c));
  return success(c, result);
}));

growthRoute.post('/api/growth/privacy/consent/:consentReceiptId/revoke', route(async (c) => {
  rejectQuery(c);
  await requireEmptyBody(c);
  const db = database(c);
  const secure = security(c);
  const result = await revokePrivateSoloConsent(
    db, secure, authenticatedUser(c), pathId(c, 'consentReceiptId'), idempotencyKey(c),
  );
  return success(c, result);
}));

growthRoute.post('/api/growth/spaces/solo', route(async (c) => {
  rejectQuery(c);
  await requireEmptyBody(c);
  const db = database(c);
  const secure = security(c);
  const result = await ensureSoloGrowthSpace(db, secure, authenticatedUser(c), idempotencyKey(c));
  return success(c, result);
}));

growthRoute.get('/api/growth/spaces/:spaceId', route(async (c) => {
  rejectQuery(c);
  const space = await loadGrowthSpace(database(c), authenticatedUser(c), pathId(c, 'spaceId'));
  return success(c, { space });
}));

growthRoute.get('/api/growth/spaces/:spaceId/cycles', route(async (c) => {
  const cycles = await listGrowthCycles(
    database(c), authenticatedUser(c), pathId(c, 'spaceId'), parseListFilters(c),
  );
  return success(c, { cycles });
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['originKind', 'originAttemptId']);
  const result = await openGrowthCycle(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), parseOrigin(body), idempotencyKey(c),
  );
  return success(c, result);
}));

// Action routes precede the generic cycle route.
growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['action', 'hypothesisId', 'rationale', 'expectedRevision']);
  const parsed = parseGap(body);
  const result = await respondToGap(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
    parsed.input, idempotencyKey(c), parsed.expectedRevision,
  );
  return success(c, result);
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/focus', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['capabilityId', 'capabilityRevision', 'statement', 'reason', 'expectedRevision']);
  const parsed = parseFocus(body);
  const result = await selectGrowthFocus(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
    parsed.input, idempotencyKey(c), parsed.expectedRevision,
  );
  return success(c, result);
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['action', 'practiceQuestId', 'revisitAt', 'expectedRevision']);
  const parsed = parsePractice(body);
  const result = await respondToPractice(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
    parsed.input, idempotencyKey(c), parsed.expectedRevision,
  );
  return success(c, result);
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/recheck-follow-up-launches', route(async (c) => {
  rejectQuery(c);
  const body=await jsonObject(c,['recheckId','changedCondition','expectedRevision']);
  const recheckId=optionalId(body.recheckId,'GROWTH_RECHECK_ID_INVALID');
  if(!recheckId || typeof body.changedCondition!=='string') growthFailure(400,'GROWTH_FOLLOW_UP_CONDITION_REQUIRED','validation');
  return success(c,await launchRecheckFollowUp(database(c),security(c),authenticatedUser(c),pathId(c,'spaceId'),pathId(c,'cycleId'),
    {recheckId,changedCondition:body.changedCondition},idempotencyKey(c),requiredSafeInteger(body.expectedRevision,'GROWTH_EXPECTED_REVISION_INVALID')));
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['action', 'recheckId', 'followUpOrigin', 'followUpLaunchId', 'revisitAt', 'expectedRevision']);
  const parsed = parseRecheck(body);
  const result = await recordRecheck(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
    parsed.input, idempotencyKey(c), parsed.expectedRevision,
  );
  return success(c, result);
}));

growthRoute.post('/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['expectedRevision']);
  const request = await requestGrowthHumanReview(
    db,
    secure,
    authenticatedUser(c),
    pathId(c, 'spaceId'),
    pathId(c, 'cycleId'),
    requiredSafeInteger(body.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID', 1),
    idempotencyKey(c),
  );
  return success(c, { request });
}));

growthRoute.delete('/api/growth/spaces/:spaceId/cycles/:cycleId', route(async (c) => {
  rejectQuery(c);
  const db = database(c);
  const secure = security(c);
  const body = await jsonObject(c, ['expectedRevision']);
  const result = await deleteGrowthCycle(
    db, secure, authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
    idempotencyKey(c), requiredSafeInteger(body.expectedRevision, 'GROWTH_EXPECTED_REVISION_INVALID'),
  );
  return success(c, result);
}));

growthRoute.get('/api/growth/spaces/:spaceId/cycles/:cycleId', route(async (c) => {
  rejectQuery(c);
  const cycle = await loadGrowthCycle(
    database(c), authenticatedUser(c), pathId(c, 'spaceId'), pathId(c, 'cycleId'),
  );
  return success(c, { cycle });
}));

export { growthRoute };
export default growthRoute;
