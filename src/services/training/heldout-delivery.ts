import { loadTrainingCaseContractProjection } from './scenario-evidence';

const CASE_ID = 'HH-INVEST-100B';
const CASE_VERSION = '1.1.0-synthetic';
const LOCALE = 'ko-KR';
const RUBRIC_VERSION = 'HH-RUBRIC-1.0.0';
const BASELINE_VERSION = 'HH-SYNTHETIC-BASE-1.0.0';
const MEASUREMENT_ID = 'M4';
const ADAPTER_MANIFEST_SHA256 = '0d9c12c648d457392af3d3832afdee4be028a4e61ac6a06a953427110d411645';
const OPAQUE_VARIANT_IDS = new Set(['HH-V-IMMEDIATE-01', 'HH-V-IMMEDIATE-02']);
const CONTAMINATION_CODES = new Set(['LEARNER_REPORTED_EXPOSURE', 'LOCAL_ASSISTANCE_REFERENCE', 'GLOBAL_VARIANT_QUARANTINE'] as const);

export type HeldOutState = 'ARMED' | 'IN_PROGRESS' | 'SUBMITTED' | 'ABANDONED' | 'QUARANTINED' | 'UNAVAILABLE';
export type HeldOutMissingness = 'NONE' | 'NO_RESPONSE' | 'NOT_STARTED' | 'PAYLOAD_UNAVAILABLE' | 'CONTAMINATED' | 'UNKNOWN';
export type HeldOutContaminationCode = 'LEARNER_REPORTED_EXPOSURE' | 'LOCAL_ASSISTANCE_REFERENCE' | 'GLOBAL_VARIANT_QUARANTINE';
type HeldOutEventType = 'ARM' | 'OPEN' | 'SUBMIT' | 'STOP' | 'QUARANTINE';

type AttemptRow = {
  id: string;
  base_session_id: string;
  owner_user_id: string;
  operator_user_id: string;
  case_id: string;
  case_version: string;
  locale: string;
  rubric_version: string;
  baseline_version: string;
  measurement_id: string;
  opaque_variant_id: string;
  adapter_manifest_sha256: string;
  source_manifest_sha256: string;
  task_text: string;
  task_sha256: string;
  created_at: number;
};

type EventRow = {
  id: string;
  attempt_id: string;
  revision: number;
  event_type: HeldOutEventType;
  actor_user_id: string;
  mutation_key: string;
  missingness: HeldOutMissingness;
  response_text: string | null;
  response_sha256: string | null;
  assistance_ids_json: string;
  contamination_code: HeldOutContaminationCode | 'LEGACY_QUARANTINE' | null;
  reason: string | null;
  created_at: number;
};

export class HeldOutDeliveryError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly body: Record<string, unknown> = {}) {
    super(code);
  }
}

export type ArmHeldOutAttemptInput = {
  baseSessionId: string;
  ownerUserId: string;
  opaqueVariantId: string;
  taskText: string;
  mutationKey: string;
};

export type AttemptMutationInput = { expectedRevision: number; mutationKey: string };
export type SubmitHeldOutAttemptInput = AttemptMutationInput & { response: string };
export type QuarantineHeldOutAttemptInput = AttemptMutationInput & { contaminationCode: string };

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validMutationKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= 128;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 160;
}

function contaminationCode(value: unknown): value is HeldOutContaminationCode {
  return typeof value === 'string' && CONTAMINATION_CODES.has(value as HeldOutContaminationCode);
}

function stateFor(event: Pick<EventRow, 'event_type'>): Exclude<HeldOutState, 'UNAVAILABLE'> {
  switch (event.event_type) {
    case 'ARM': return 'ARMED';
    case 'OPEN': return 'IN_PROGRESS';
    case 'SUBMIT': return 'SUBMITTED';
    case 'STOP': return 'ABANDONED';
    case 'QUARANTINE': return 'QUARANTINED';
  }
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function now(): number { return Date.now(); }
function id(prefix: string): string { return `${prefix}${crypto.randomUUID()}`; }

async function rows(db: D1Database, attemptId: string): Promise<EventRow[]> {
  const result = await db.prepare(`SELECT id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness,
    response_text, response_sha256, assistance_ids_json, contamination_code, reason, created_at
    FROM training_heldout_attempt_events WHERE attempt_id = ?1 ORDER BY revision ASC`).bind(attemptId).all<EventRow>();
  return result.results || [];
}

async function attempt(db: D1Database, attemptId: string): Promise<AttemptRow | null> {
  return db.prepare(`SELECT id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, locale,
    rubric_version, baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256,
    source_manifest_sha256, task_text, task_sha256, created_at
    FROM training_heldout_attempts WHERE id = ?1`).bind(attemptId).first<AttemptRow>();
}

async function attemptForBase(db: D1Database, baseSessionId: string): Promise<AttemptRow | null> {
  return db.prepare(`SELECT id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, locale,
    rubric_version, baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256,
    source_manifest_sha256, task_text, task_sha256, created_at
    FROM training_heldout_attempts WHERE base_session_id = ?1`).bind(baseSessionId).first<AttemptRow>();
}

function last(events: EventRow[]): EventRow {
  const event = events.at(-1);
  if (!event) throw new HeldOutDeliveryError(503, 'TRAINING_HELDOUT_EVENT_HISTORY_UNAVAILABLE');
  return event;
}

function safeAttempt(row: AttemptRow, events: EventRow[], visibility: 'summary' | 'owner' | 'audit', globallyQuarantined = false) {
  const event = last(events);
  const state = stateFor(event);
  const base = {
    id: row.id,
    baseSessionId: row.base_session_id,
    caseId: row.case_id,
    caseVersion: row.case_version,
    locale: row.locale,
    rubricVersion: row.rubric_version,
    baselineVersion: row.baseline_version,
    measurement: row.measurement_id,
    opaqueVariantId: row.opaque_variant_id,
    adapterManifestSha256: row.adapter_manifest_sha256,
    sourceManifestSha256: row.source_manifest_sha256,
    state,
    revision: event.revision,
    createdAt: row.created_at,
    startedAt: events.find(item => item.event_type === 'OPEN')?.created_at ?? null,
    completedAt: events.find(item => item.event_type === 'SUBMIT')?.created_at ?? null,
    missingness: event.missingness,
    contaminationCode: event.contamination_code,
    assistanceIds: [] as string[],
    assessmentState: 'UNKNOWN' as const,
  };
  if (visibility === 'summary') return base;
  const payloadAvailable = !globallyQuarantined && state !== 'QUARANTINED';
  const ownerPayload = payloadAvailable && events.some(item => item.event_type === 'OPEN') ? { taskText: row.task_text, taskHash: row.task_sha256 } : {};
  const response = payloadAvailable && event.event_type === 'SUBMIT'
    ? { response: event.response_text, responseHash: event.response_sha256 }
    : {};
  if (visibility === 'owner') return { ...base, ...ownerPayload, ...response };
  const auditPayload = payloadAvailable
    ? { taskText: row.task_text, ...response }
    : { taskHash: row.task_sha256, ...(event.event_type === 'SUBMIT' ? { responseHash: event.response_sha256 } : {}) };
  return { ...base, ...auditPayload, taskHash: row.task_sha256, ownerUserId: row.owner_user_id, operatorUserId: row.operator_user_id, eventLog: events.map(item => ({
    revision: item.revision, type: item.event_type, actorUserId: item.actor_user_id, missingness: item.missingness,
    mutationKey: item.mutation_key, contaminationCode: item.contamination_code, createdAt: item.created_at,
  })) };
}

function attemptUnavailable(): { status: 'UNAVAILABLE'; attempt: null } {
  return { status: 'UNAVAILABLE', attempt: null };
}

async function assertBaseBinding(db: D1Database, baseSessionId: string, ownerUserId: string) {
  const base = await db.prepare(`SELECT id, user_id, is_completed, training_mode FROM training_sessions WHERE id = ?1`)
    .bind(baseSessionId).first<{ id: string; user_id: string; is_completed: number; training_mode: string }>();
  if (!base || base.user_id !== ownerUserId) throw new HeldOutDeliveryError(404, 'TRAINING_HELDOUT_BASE_NOT_FOUND');
  if (Number(base.is_completed) !== 1 || base.training_mode !== 'scenario') {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_BASE_NOT_COMPLETED');
  }
  const accepted = await db.prepare('SELECT 1 AS present FROM training_turns WHERE session_id = ?1 LIMIT 1').bind(baseSessionId).first();
  if (!accepted) throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_BASE_ACCEPTED_RESPONSE_REQUIRED');
  const projection = await loadTrainingCaseContractProjection(db, baseSessionId);
  if (projection.status !== 'ready' || !projection.caseContract
    || projection.caseContract.caseId !== CASE_ID
    || projection.caseContract.caseVersion !== CASE_VERSION
    || projection.caseContract.locale !== LOCALE
    || projection.caseContract.rubricVersion !== RUBRIC_VERSION
    || projection.caseContract.baselineVersion !== BASELINE_VERSION) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_CASE_BINDING_INVALID');
  }
  const completedAssistedRevisionPath = await db.prepare(`SELECT 1 AS present
    FROM training_interventions intervention
    JOIN training_support_responses support ON support.intervention_id = intervention.id AND support.session_id = intervention.session_id
    JOIN training_learner_revision_events revision ON revision.session_id = intervention.session_id
    JOIN training_turns follow_up ON follow_up.session_id = revision.session_id AND follow_up.learner_revision_event_id = revision.id
    WHERE intervention.session_id = ?1 AND intervention.action = 'HELP'
    LIMIT 1`).bind(baseSessionId).first();
  if (!completedAssistedRevisionPath) throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_ASSISTED_REVISION_PATH_REQUIRED');
  const pack = await db.prepare(`SELECT evidence_manifest_sha256 FROM training_scenario_packs
    WHERE session_id = ?1 AND mode = 'scenario' AND evidence_status = 'ready'`).bind(baseSessionId)
    .first<{ evidence_manifest_sha256: string }>();
  if (!pack || !isSha256(pack.evidence_manifest_sha256)) throw new HeldOutDeliveryError(503, 'TRAINING_HELDOUT_SOURCE_MANIFEST_UNAVAILABLE');
  const context = await db.prepare(`SELECT evidence_manifest_sha256 FROM training_session_contexts
    WHERE session_id = ?1 AND owner_user_id = ?2 AND status = 'ACTIVE'`).bind(baseSessionId, ownerUserId)
    .first<{ evidence_manifest_sha256: string }>();
  if (!context || !isSha256(context.evidence_manifest_sha256) || context.evidence_manifest_sha256 !== pack.evidence_manifest_sha256) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_SOURCE_MANIFEST_INVALID');
  }
  return { sourceManifestSha256: pack.evidence_manifest_sha256 };
}

function assertArmInput(input: ArmHeldOutAttemptInput): void {
  if (!validId(input.baseSessionId) || !validId(input.ownerUserId) || !OPAQUE_VARIANT_IDS.has(input.opaqueVariantId)
    || !validMutationKey(input.mutationKey) || typeof input.taskText !== 'string') {
    throw new HeldOutDeliveryError(400, 'TRAINING_HELDOUT_ARM_INPUT_INVALID');
  }
  const taskBytes = bytes(input.taskText);
  if (!input.taskText.trim() || input.taskText.length > 16_000 || taskBytes.byteLength > 48_000) {
    throw new HeldOutDeliveryError(400, 'TRAINING_HELDOUT_TASK_INVALID');
  }
}

function assertMutation(input: AttemptMutationInput): void {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !validMutationKey(input.mutationKey)) {
    throw new HeldOutDeliveryError(400, 'TRAINING_HELDOUT_MUTATION_INPUT_INVALID');
  }
}

async function appendEvent(
  db: D1Database,
  row: AttemptRow,
  prior: EventRow[],
  event: { type: HeldOutEventType; actorUserId: string; mutationKey: string; missingness: HeldOutMissingness; response?: string; responseHash?: string; contaminationCode?: HeldOutContaminationCode },
): Promise<'appended' | 'replayed'> {
  try {
    await db.prepare(`INSERT INTO training_heldout_attempt_events (
    id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness,
    response_text, response_sha256, assistance_ids_json, contamination_code, reason, created_at
  ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, NULL, ?11)`).bind(
    id('tho_evt_'), row.id, prior.length + 1, event.type, event.actorUserId, event.mutationKey,
    event.missingness, event.response ?? null, event.responseHash ?? null, event.contaminationCode ?? null, now(),
    ).run();
    return 'appended';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/TRAINING_HELDOUT_(REVISION_CONFLICT|TRANSITION_INVALID)|UNIQUE constraint failed/i.test(message)) throw error;
    const current = await rows(db, row.id);
    const replay = current.find(item => item.mutation_key === event.mutationKey);
    if (replay && replay.event_type === event.type && replay.actor_user_id === event.actorUserId
      && replay.missingness === event.missingness && replay.response_sha256 === (event.responseHash ?? null)
      && replay.contamination_code === (event.contaminationCode ?? null)) return 'replayed';
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
  }
}

type ContaminationEvent = { actorUserId: string; mutationKey: string; contaminationCode: HeldOutContaminationCode };

async function reconcileContaminationVariantQuarantine(
  db: D1Database, row: AttemptRow, event: ContaminationEvent, quarantinedAt: number,
): Promise<void> {
  const index = await db.prepare(`SELECT contamination_code FROM training_heldout_variant_quarantines
    WHERE opaque_variant_id = ?1`).bind(row.opaque_variant_id).first<{ contamination_code: string }>();
  if (index && index.contamination_code !== event.contaminationCode) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_VARIANT_QUARANTINED');
  }
  if (!index) {
    await db.prepare(`INSERT INTO training_heldout_variant_quarantines (opaque_variant_id, contamination_code, quarantined_at)
      VALUES (?1, ?2, ?3)`).bind(row.opaque_variant_id, event.contaminationCode, quarantinedAt).run();
  }
}

async function appendContaminationAndVariantQuarantine(
  db: D1Database, row: AttemptRow, prior: EventRow[], event: ContaminationEvent,
): Promise<'appended' | 'replayed'> {
  const createdAt = now();
  const eventId = id('tho_evt_');
  const insertEvent = db.prepare(`INSERT INTO training_heldout_attempt_events (
    id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness,
    response_text, response_sha256, assistance_ids_json, contamination_code, reason, created_at
  ) VALUES (?1, ?2, ?3, 'QUARANTINE', ?4, ?5, 'CONTAMINATED', NULL, NULL, '[]', ?6, NULL, ?7)`).bind(
    eventId, row.id, prior.length + 1, event.actorUserId, event.mutationKey, event.contaminationCode, createdAt,
  );
  const insertIndex = db.prepare(`INSERT INTO training_heldout_variant_quarantines (
    opaque_variant_id, contamination_code, quarantined_at
  ) VALUES (?1, ?2, ?3)`).bind(row.opaque_variant_id, event.contaminationCode, createdAt);
  try {
    await db.batch([insertEvent, insertIndex]);
    return 'appended';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/TRAINING_HELDOUT_(REVISION_CONFLICT|TRANSITION_INVALID)|UNIQUE constraint failed/i.test(message)) throw error;
    const current = await rows(db, row.id);
    const replay = current.find(item => item.mutation_key === event.mutationKey);
    if (!replay || replay.event_type !== 'QUARANTINE' || replay.actor_user_id !== event.actorUserId
      || replay.missingness !== 'CONTAMINATED' || replay.contamination_code !== event.contaminationCode) {
      throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
    }
    await reconcileContaminationVariantQuarantine(db, row, event, createdAt);
    return 'replayed';
  }
}

async function quarantineForPayloadDamage(db: D1Database, row: AttemptRow, events: EventRow[], actorUserId: string) {
  const state = stateFor(last(events));
  if (state === 'QUARANTINED') return;
  await appendEvent(db, row, events, {
    type: 'QUARANTINE', actorUserId, mutationKey: `system-digest-${crypto.randomUUID()}`,
    missingness: 'PAYLOAD_UNAVAILABLE',
  });
}

async function assertTaskIntact(db: D1Database, row: AttemptRow, events: EventRow[], actorUserId: string): Promise<void> {
  if (await sha256(row.task_text) === row.task_sha256) return;
  await quarantineForPayloadDamage(db, row, events, actorUserId);
  throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_PAYLOAD_QUARANTINED');
}

async function assertVariantAvailableForDisclosure(
  db: D1Database, row: AttemptRow, events: EventRow[], ownerUserId: string,
): Promise<void> {
  const quarantine = await db.prepare(`SELECT 1 AS present FROM training_heldout_variant_quarantines
    WHERE opaque_variant_id = ?1`).bind(row.opaque_variant_id).first();
  if (!quarantine) return;
  if (stateFor(last(events)) !== 'QUARANTINED') {
    await appendEvent(db, row, events, {
      type: 'QUARANTINE', actorUserId: ownerUserId, mutationKey: `system-global-variant-${crypto.randomUUID()}`,
      missingness: 'CONTAMINATED', contaminationCode: 'GLOBAL_VARIANT_QUARANTINE',
    });
  }
  throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_VARIANT_QUARANTINED');
}

export async function armHeldOutAttempt(db: D1Database, operatorUserId: string, input: ArmHeldOutAttemptInput) {
  assertArmInput(input);
  if (operatorUserId === input.ownerUserId) throw new HeldOutDeliveryError(403, 'TRAINING_HELDOUT_OPERATOR_OWNER_CONFLICT');
  const taskHash = await sha256(input.taskText);
  const variantQuarantine = await db.prepare('SELECT 1 AS present FROM training_heldout_variant_quarantines WHERE opaque_variant_id = ?1').bind(input.opaqueVariantId).first();
  if (variantQuarantine) throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_VARIANT_QUARANTINED');
  const existing = await attemptForBase(db, input.baseSessionId);
  if (existing) {
    const events = await rows(db, existing.id);
    const arm = events[0];
    if (existing.owner_user_id === input.ownerUserId && existing.operator_user_id === operatorUserId
      && existing.opaque_variant_id === input.opaqueVariantId && existing.task_sha256 === taskHash
      && arm?.mutation_key === input.mutationKey) return { attempt: safeAttempt(existing, events, 'summary'), replayed: true };
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_ASSIGNMENT_CONFLICT');
  }
  const binding = await assertBaseBinding(db, input.baseSessionId, input.ownerUserId);
  const row: AttemptRow = {
    id: id('tho_'), base_session_id: input.baseSessionId, owner_user_id: input.ownerUserId, operator_user_id: operatorUserId,
    case_id: CASE_ID, case_version: CASE_VERSION, locale: LOCALE, rubric_version: RUBRIC_VERSION,
    baseline_version: BASELINE_VERSION, measurement_id: MEASUREMENT_ID, opaque_variant_id: input.opaqueVariantId,
    adapter_manifest_sha256: ADAPTER_MANIFEST_SHA256, source_manifest_sha256: binding.sourceManifestSha256,
    task_text: input.taskText, task_sha256: taskHash, created_at: now(),
  };
  try {
    await db.batch([
      db.prepare(`INSERT INTO training_heldout_attempts (
        id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, locale, rubric_version,
        baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256, source_manifest_sha256,
        task_text, task_sha256, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`).bind(
        row.id, row.base_session_id, row.owner_user_id, row.operator_user_id, row.case_id, row.case_version,
        row.locale, row.rubric_version, row.baseline_version, row.measurement_id, row.opaque_variant_id,
        row.adapter_manifest_sha256, row.source_manifest_sha256, row.task_text, row.task_sha256, row.created_at,
      ),
      db.prepare(`INSERT INTO training_heldout_attempt_events (
        id, attempt_id, revision, event_type, actor_user_id, mutation_key, missingness, response_text,
        response_sha256, assistance_ids_json, reason, created_at
      ) VALUES (?1, ?2, 1, 'ARM', ?3, ?4, 'NOT_STARTED', NULL, NULL, '[]', NULL, ?5)`).bind(
        id('tho_evt_'), row.id, operatorUserId, input.mutationKey, row.created_at,
      ),
    ]);
  } catch (error) {
    const raced = await attemptForBase(db, input.baseSessionId);
    if (!raced) throw error;
    const events = await rows(db, raced.id);
    const arm = events[0];
    if (raced.owner_user_id === input.ownerUserId && raced.operator_user_id === operatorUserId
      && raced.opaque_variant_id === input.opaqueVariantId && raced.task_sha256 === taskHash
      && arm?.mutation_key === input.mutationKey) return { attempt: safeAttempt(raced, events, 'summary'), replayed: true };
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_ASSIGNMENT_CONFLICT');
  }
  return { attempt: safeAttempt(row, [{ id: '', attempt_id: row.id, revision: 1, event_type: 'ARM', actor_user_id: operatorUserId, mutation_key: input.mutationKey, missingness: 'NOT_STARTED', response_text: null, response_sha256: null, assistance_ids_json: '[]', contamination_code: null, reason: null, created_at: row.created_at }], 'summary'), replayed: false };
}

async function ownedAttempt(db: D1Database, attemptId: string, ownerUserId: string) {
  const row = await attempt(db, attemptId);
  if (!row || row.owner_user_id !== ownerUserId) throw new HeldOutDeliveryError(404, 'TRAINING_HELDOUT_NOT_FOUND');
  const events = await rows(db, row.id);
  return { row, events };
}

export async function openHeldOutAttempt(db: D1Database, ownerUserId: string, attemptId: string, input: AttemptMutationInput) {
  assertMutation(input);
  const owned = await ownedAttempt(db, attemptId, ownerUserId);
  await assertVariantAvailableForDisclosure(db, owned.row, owned.events, ownerUserId);
  await assertTaskIntact(db, owned.row, owned.events, ownerUserId);
  const replay = owned.events.find(event => event.mutation_key === input.mutationKey);
  if (replay) {
    if (replay.event_type !== 'OPEN') throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_MUTATION_CONFLICT');
    return { attempt: safeAttempt(owned.row, owned.events, 'owner'), replayed: true };
  }
  if (stateFor(last(owned.events)) !== 'ARMED' || last(owned.events).revision !== input.expectedRevision) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
  }
  const binding = await assertBaseBinding(db, owned.row.base_session_id, ownerUserId);
  if (binding.sourceManifestSha256 !== owned.row.source_manifest_sha256 || owned.row.adapter_manifest_sha256 !== ADAPTER_MANIFEST_SHA256) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_BINDING_INVALID');
  }
  const outcome = await appendEvent(db, owned.row, owned.events, { type: 'OPEN', actorUserId: ownerUserId, mutationKey: input.mutationKey, missingness: 'NO_RESPONSE' });
  return { attempt: safeAttempt(owned.row, await rows(db, owned.row.id), 'owner'), replayed: outcome === 'replayed' };
}

export async function submitHeldOutAttempt(db: D1Database, ownerUserId: string, attemptId: string, input: SubmitHeldOutAttemptInput) {
  assertMutation(input);
  if (typeof input.response !== 'string' || !input.response.trim() || input.response.length > 8_000 || bytes(input.response).byteLength > 24_000) {
    throw new HeldOutDeliveryError(400, 'TRAINING_HELDOUT_RESPONSE_INVALID');
  }
  const owned = await ownedAttempt(db, attemptId, ownerUserId);
  await assertVariantAvailableForDisclosure(db, owned.row, owned.events, ownerUserId);
  await assertTaskIntact(db, owned.row, owned.events, ownerUserId);
  const responseHash = await sha256(input.response);
  const replay = owned.events.find(event => event.mutation_key === input.mutationKey);
  if (replay) {
    if (replay.event_type !== 'SUBMIT' || replay.response_sha256 !== responseHash) throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_MUTATION_CONFLICT');
    return { attempt: safeAttempt(owned.row, owned.events, 'owner'), replayed: true };
  }
  if (stateFor(last(owned.events)) !== 'IN_PROGRESS' || last(owned.events).revision !== input.expectedRevision) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
  }
  const outcome = await appendEvent(db, owned.row, owned.events, { type: 'SUBMIT', actorUserId: ownerUserId, mutationKey: input.mutationKey, missingness: 'NONE', response: input.response, responseHash });
  return { attempt: safeAttempt(owned.row, await rows(db, owned.row.id), 'owner'), replayed: outcome === 'replayed' };
}

export async function stopHeldOutAttempt(db: D1Database, ownerUserId: string, attemptId: string, input: AttemptMutationInput) {
  assertMutation(input);
  const owned = await ownedAttempt(db, attemptId, ownerUserId);
  await assertVariantAvailableForDisclosure(db, owned.row, owned.events, ownerUserId);
  await assertTaskIntact(db, owned.row, owned.events, ownerUserId);
  const replay = owned.events.find(event => event.mutation_key === input.mutationKey);
  if (replay) {
    if (replay.event_type !== 'STOP') throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_MUTATION_CONFLICT');
    return { attempt: safeAttempt(owned.row, owned.events, 'owner'), replayed: true };
  }
  const current = last(owned.events);
  const state = stateFor(current);
  if (!['ARMED', 'IN_PROGRESS'].includes(state) || current.revision !== input.expectedRevision) {
    throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
  }
  const outcome = await appendEvent(db, owned.row, owned.events, { type: 'STOP', actorUserId: ownerUserId, mutationKey: input.mutationKey, missingness: state === 'ARMED' ? 'NOT_STARTED' : 'NO_RESPONSE' });
  return { attempt: safeAttempt(owned.row, await rows(db, owned.row.id), 'owner'), replayed: outcome === 'replayed' };
}

export async function reportHeldOutContamination(db: D1Database, ownerUserId: string, attemptId: string, input: QuarantineHeldOutAttemptInput) {
  assertMutation(input);
  if (!contaminationCode(input.contaminationCode)) throw new HeldOutDeliveryError(400, 'TRAINING_HELDOUT_CONTAMINATION_INPUT_INVALID');
  const owned = await ownedAttempt(db, attemptId, ownerUserId);
  await assertTaskIntact(db, owned.row, owned.events, ownerUserId);
  const replay = owned.events.find(event => event.mutation_key === input.mutationKey);
  if (replay) {
    if (replay.event_type !== 'QUARANTINE' || replay.actor_user_id !== ownerUserId
      || replay.missingness !== 'CONTAMINATED' || replay.contamination_code !== input.contaminationCode) {
      throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_MUTATION_CONFLICT');
    }
    await reconcileContaminationVariantQuarantine(db, owned.row, {
      actorUserId: ownerUserId, mutationKey: input.mutationKey, contaminationCode: input.contaminationCode,
    }, now());
    return { attempt: safeAttempt(owned.row, owned.events, 'owner'), replayed: true };
  }
  const current = last(owned.events);
  if (!['ARMED', 'IN_PROGRESS'].includes(stateFor(current)) || current.revision !== input.expectedRevision) throw new HeldOutDeliveryError(409, 'TRAINING_HELDOUT_REVISION_CONFLICT');
  const outcome = await appendContaminationAndVariantQuarantine(db, owned.row, owned.events, { actorUserId: ownerUserId, mutationKey: input.mutationKey, contaminationCode: input.contaminationCode });
  return { attempt: safeAttempt(owned.row, await rows(db, owned.row.id), 'owner'), replayed: outcome === 'replayed' };
}

export async function quarantineHeldOutAssistanceReference(db: D1Database, ownerUserId: string, attemptOrBaseSessionId: string): Promise<boolean> {
  const row = await attempt(db, attemptOrBaseSessionId) || await attemptForBase(db, attemptOrBaseSessionId);
  if (!row || row.owner_user_id !== ownerUserId) return false;
  const events = await rows(db, row.id);
  const state = stateFor(last(events));
  if (state === 'ARMED' || state === 'IN_PROGRESS') {
    await assertTaskIntact(db, row, events, ownerUserId);
    const indexed = await db.prepare(`SELECT 1 AS present FROM training_heldout_variant_quarantines
      WHERE opaque_variant_id = ?1`).bind(row.opaque_variant_id).first();
    if (indexed) {
      await appendEvent(db, row, events, {
        type: 'QUARANTINE', actorUserId: ownerUserId, mutationKey: `system-global-variant-${crypto.randomUUID()}`,
        missingness: 'CONTAMINATED', contaminationCode: 'GLOBAL_VARIANT_QUARANTINE',
      });
      return true;
    }
    await appendContaminationAndVariantQuarantine(db, row, events, {
      actorUserId: ownerUserId, mutationKey: `system-assistance-${crypto.randomUUID()}`,
      contaminationCode: 'LOCAL_ASSISTANCE_REFERENCE',
    });
  }
  return true;
}

export async function readOwnedHeldOutAttempt(db: D1Database, ownerUserId: string, baseSessionId: string) {
  try {
    const row = await db.prepare(`SELECT id, base_session_id, owner_user_id, operator_user_id, case_id, case_version, locale,
      rubric_version, baseline_version, measurement_id, opaque_variant_id, adapter_manifest_sha256,
      source_manifest_sha256, task_text, task_sha256, created_at
      FROM training_heldout_attempts WHERE base_session_id = ?1 AND owner_user_id = ?2`).bind(baseSessionId, ownerUserId).first<AttemptRow>();
    if (!row) return { status: 'NONE' as const, attempt: null };
    const events = await rows(db, row.id);
    await assertVariantAvailableForDisclosure(db, row, events, ownerUserId);
    await assertTaskIntact(db, row, events, ownerUserId);
    return { status: 'AVAILABLE' as const, attempt: safeAttempt(row, await rows(db, row.id), 'owner') };
  } catch (error) {
    if (error instanceof HeldOutDeliveryError && error.code === 'TRAINING_HELDOUT_PAYLOAD_QUARANTINED') {
      const row = await attemptForBase(db, baseSessionId);
      if (row && row.owner_user_id === ownerUserId) return { status: 'AVAILABLE' as const, attempt: safeAttempt(row, await rows(db, row.id), 'summary') };
    }
    return attemptUnavailable();
  }
}

export async function readHeldOutAttemptSummary(db: D1Database, ownerUserId: string, baseSessionId: string) {
  const projection = await readOwnedHeldOutAttempt(db, ownerUserId, baseSessionId);
  if (projection.status !== 'AVAILABLE' || !projection.attempt) return projection;
  const row = await attempt(db, String(projection.attempt.id));
  if (!row) return attemptUnavailable();
  return { status: 'AVAILABLE' as const, attempt: safeAttempt(row, await rows(db, row.id), 'summary') };
}

export async function readOperatorHeldOutAttempt(db: D1Database, operatorUserId: string, attemptId: string) {
  const row = await attempt(db, attemptId);
  if (!row || row.operator_user_id !== operatorUserId) throw new HeldOutDeliveryError(404, 'TRAINING_HELDOUT_NOT_FOUND');
  const events = await rows(db, row.id);
  await assertTaskIntact(db, row, events, operatorUserId);
  const variantQuarantine = await db.prepare(`SELECT 1 AS present FROM training_heldout_variant_quarantines
    WHERE opaque_variant_id = ?1`).bind(row.opaque_variant_id).first();
  return { attempt: safeAttempt(row, await rows(db, row.id), 'audit', Boolean(variantQuarantine)) };
}
