import {
  canonicalAuthorityContentIdentity,
  contentIdentity,
  sha256Hex,
  type ContentIdentity,
} from './identity';
import { canonicalDocument, parseAuthorityJson, type CanonicalJsonValue } from './canonical-json';
import {
  canonicalBytesEqual,
  validateEvidenceRecord,
} from './evidence-spine-validation';
import type {
  ArtifactBindingsV1,
  ArtifactCaptureBindingV1,
  ArtifactCapturePlanV1,
  ArtifactKind,
  ArtifactKindDetailsV1,
  ArtifactOutcome,
  ArtifactStatus,
  ContentBoundSubjectIdentity,
  EvidenceScopeV1,
  ExternalArtifactObservationV1,
  ExternalCaptureCarrierV1,
  ProducerIdentityV1,
  EvidenceSpineRootV1,
  DetachedRecordCandidate,
  IntegrationReceiptResolutionCarrierV1,
  IntegrationReceiptResolutionV1,
  SourceReceiptKind,
  SourceReceiptRefV1,
} from './evidence-spine-types';
import {
  isAIRouteAllowedForLane,
  type AIRouteId,
  type AIRouteLane,
} from '../ai-router';

export type ReceiptIntegrityProofV1 =
  | Readonly<{
      proofKind: 'D1_IMMUTABLE_CORE';
      protectedSubjectIdentity: ContentIdentity;
      guardSetIdentity: ContentIdentity;
      supportingReceiptRefs: readonly SourceReceiptRefV1[];
    }>
  | Readonly<{
      proofKind: 'COMMITTED_EXTERNAL_CONTAINER';
      protectedSubjectIdentity: ContentIdentity;
      containerIdentity: ContentIdentity;
      policyIdentity: ContentIdentity;
      independentReadbackIdentity: ContentIdentity;
    }>;

type SourceManifestCausalV1 = Readonly<{
  sessionContextIdentity: ContentIdentity;
  manifestIdentity: ContentIdentity;
  sourceItemIdentities: readonly ContentIdentity[];
}>;

type LearningContextCausalV1 = Readonly<{
  sessionIdentity: ContentIdentity;
  contextIdentity: ContentIdentity;
  cacheNamespaceIdentity: ContentIdentity;
  routePlanIdentity: ContentIdentity;
}>;

type AttemptCausalV1 = Readonly<{
  sessionIdentity: ContentIdentity;
  contextIdentity: ContentIdentity;
  turnNumber: number;
  cacheNamespaceIdentity: ContentIdentity;
  terminalOutcome: 'success' | 'failure';
  routeTargetIdentity: ContentIdentity;
}>;

interface CausalByReceiptKindV1 {
  SOURCE_MANIFEST: SourceManifestCausalV1;
  LEARNING_SESSION_CONTEXT: LearningContextCausalV1;
  AI_INVOCATION_ATTEMPT: AttemptCausalV1;
  GROWTH_CONSENT: Readonly<{ originIdentity: ContentIdentity; privateSpaceIdentity: ContentIdentity; purposeIdentity: ContentIdentity; retentionIdentity: ContentIdentity; consentState: string; consentReceiptIdentity: ContentIdentity }>;
  GROWTH_CYCLE: Readonly<{ originIdentity: ContentIdentity; privateSpaceIdentity: ContentIdentity; cycleIdentity: ContentIdentity; aggregateRevision: number; cycleState: string }>;
  GROWTH_EVENT: Readonly<{ cycleIdentity: ContentIdentity; aggregateRevision: number; eventIdentity: ContentIdentity; transitionIdentity: ContentIdentity }>;
  MUTATION_RECEIPT: Readonly<{ cycleIdentity: ContentIdentity; aggregateRevision: number; mutationIdentity: ContentIdentity; replayPayloadIdentity: ContentIdentity }>;
  RECHECK: Readonly<{ cycleIdentity: ContentIdentity; scheduleIdentity: ContentIdentity; ruleIdentity: ContentIdentity; horizonAt: string; receiptIdentity: ContentIdentity }>;
  DELETION: Readonly<{ declaredStoreManifestIdentity: ContentIdentity; beforeIdentity: ContentIdentity; afterIdentity: ContentIdentity; residueProbeIdentity: ContentIdentity; terminalState: string }>;
  BUILD: Readonly<{ buildIdentity: ContentIdentity }>;
  DEPLOYMENT: Readonly<{ buildIdentity: ContentIdentity; deploymentIdentity: ContentIdentity }>;
  CONTROL_PLANE: Readonly<{ deploymentIdentity: ContentIdentity; routeManifestIdentity: ContentIdentity; controlPlaneIdentity: ContentIdentity }>;
  BROWSER_ACTION_LOG: Readonly<{ controlId: string; beforeIdentity: ContentIdentity; afterIdentity: ContentIdentity; actionLogIdentity: ContentIdentity; networkEvidenceIdentity: ContentIdentity; targetLink: CanonicalJsonValue }>;
  ACCESSIBILITY: Readonly<{ controlId: string; encryptedContainerIdentity: ContentIdentity; policyIdentity: ContentIdentity; targetLink: CanonicalJsonValue }>;
  REVIEW: Readonly<{ candidateIdentity: ContentIdentity; reviewerIdentity: ContentIdentity; reviewerFamily: string; verdict: string; reasonCodes: readonly string[] }>;
  GRADE_OUTPUT: Readonly<{ packetIdentity: ContentIdentity; graderIdentity: ContentIdentity; graderFamily: string; verdict: string; reasonCodes: readonly string[] }>;
}

type ReceiptPayloadFor<K extends SourceReceiptKind> = Readonly<{
  receiptKind: K;
  subjectIdentity: ContentIdentity;
  accountScopeIdentity: ContentIdentity;
  causal: CausalByReceiptKindV1[K];
}>;

export type ResolvedReceiptPayloadV1 = {
  [K in SourceReceiptKind]: ReceiptPayloadFor<K>;
}[SourceReceiptKind];

export type ReceiptResolution =
  | Readonly<{
      status: 'RESOLVED';
      ref: SourceReceiptRefV1;
      subjectIdentity: ContentIdentity;
      committedAt: string;
      privacy: 'PUBLIC_METADATA' | 'ENCRYPTED_PRIVATE_CONTAINER';
      integrityProof: ReceiptIntegrityProofV1;
      canonicalBytes: Uint8Array;
      payload: ResolvedReceiptPayloadV1;
    }>
  | Readonly<{
      status: 'UNRESOLVED';
      reason:
        | 'MISSING'
        | 'STALE'
        | 'MUTABLE'
        | 'OWNER_MISMATCH'
        | 'SCOPE_MISMATCH'
        | 'CONTENT_MISMATCH'
        | 'PRIVATE_CONTAINER_REQUIRED';
    }>;

export interface VerifiedRuntimeTargetV1 {
  readonly rootIdentity: ContentIdentity;
  readonly implementationPlanIdentity: ContentIdentity;
  readonly buildIdentity: ContentIdentity;
  readonly deploymentIdentity: ContentIdentity;
  readonly routeManifestIdentity: ContentIdentity;
  readonly controlPlaneIdentity: ContentIdentity;
  readonly buildRef: SourceReceiptRefV1;
  readonly deploymentRef: SourceReceiptRefV1;
  readonly controlPlaneRef: SourceReceiptRefV1;
}

export interface DerivedRuntimeProvenanceV1 {
  readonly rootIdentity: ContentIdentity;
  readonly subjectIdentity: ContentIdentity;
  readonly accountScopeIdentity: ContentIdentity;
  readonly sourceManifestRef: SourceReceiptRefV1;
  readonly trainingContextRef: SourceReceiptRefV1;
  readonly trainingSessionIdentity: ContentIdentity;
  readonly turnAttemptRefs: readonly SourceReceiptRefV1[];
  readonly growthOriginIdentity: ContentIdentity;
  readonly privateSpaceIdentity: ContentIdentity;
  readonly growthCycleRef: SourceReceiptRefV1;
  readonly aggregateRevision: number;
  readonly target: VerifiedRuntimeTargetV1;
  readonly receiptRefs: readonly SourceReceiptRefV1[];
}

export type NonPassingReason =
  | 'MISSING_SOURCE'
  | 'MUTABLE_SOURCE'
  | 'CONTENT_MISMATCH'
  | 'SUBJECT_GRAPH_DISCONNECTED'
  | 'TARGET_MISMATCH'
  | 'PRIVACY_BOUNDARY'
  | 'CONTROL_MISMATCH'
  | 'AUTHORITY_MISSING'
  | 'UNASSESSABLE';

export interface NonPassingObservation {
  readonly outcome: 'FAIL' | 'UNKNOWN' | 'UNGRADABLE';
  readonly reason: NonPassingReason;
  readonly failureTellIds: readonly string[];
  readonly receiptRefs: readonly SourceReceiptRefV1[];
}

interface ContextRow {
  id: string;
  session_id: string;
  owner_user_id: string;
  evidence_manifest_sha256: string;
  route_plan_json: string;
  prompt_cache_namespace: string;
  evidence_policy_revision: string;
  status: string;
  created_at: number;
  updated_at: number;
  training_mode: string;
  session_owner_user_id: string;
}

interface PackRow {
  session_id: string;
  evidence_query: string;
  evidence_status: string;
  evidence_manifest_sha256: string;
  source_count: number;
  book_count: number;
}

interface EvidenceRow {
  source_id: string;
  selection_index: number;
  book_id: string;
  chunk_id: string;
  book_title: string;
  book_author: string;
  chunk_index: number;
  excerpt: string;
  content_sha256: string;
  relevance_score: number;
  lifecycle_status: string | null;
}

interface AttemptRow {
  id: string;
  owner_user_id: string;
  session_context_id: string | null;
  session_id: string | null;
  turn_number: number | null;
  prompt_cache_namespace: string | null;
  lane: string;
  route_id: string;
  provider: string;
  model: string;
  outcome: string;
  started_at: number;
  completed_at: number;
  created_at: number;
  context_id: string | null;
  context_session_id: string | null;
  context_cache_namespace: string | null;
  route_plan_json: string | null;
}

const encoder = new TextEncoder();
const verifiedResolutionBrand = new WeakSet<object>();
const verifiedResolutionBytes = new WeakMap<object, Uint8Array>();

interface GuardDefinition {
  readonly name: string;
  readonly sha256: string;
}

const guard = (name: string, sha256: string): GuardDefinition => Object.freeze({ name, sha256 });
const guardDefinitions = Object.freeze({
  attemptExisting: guard('ai_invocation_attempts_context_existing_identity_guard', '92a44e032e5c64129e34e9d433ec32fe9cadbcdaae79ce3857b8e58937a6eafa'),
  attemptDelete: guard('ai_invocation_attempts_context_immutable_delete', '40fd1e910e6099bc74bd51fdc1f1d90a83a9c44fd2efad1b12be6580b66ee1fb'),
  attemptUpdate: guard('ai_invocation_attempts_context_immutable_update', '9e70c4849eee8c4e002a83f5275fc94a9b6bc372619372949ef34cfae2c009f8'),
  attemptLink: guard('ai_invocation_attempts_context_link_guard', '8cf21cf3cde64af9bc44448fd936bd13cb9b2008e82a99c2231d82d6d70e56fb'),
  evidenceExisting: guard('training_scenario_evidence_bound_existing_identity_guard', '069d858a05cb0e22c77644ee1a57d2106cdd40cf4a2cfd2ca9f001c997b55d8a'),
  evidenceDelete: guard('training_scenario_evidence_bound_governed_delete', '1ccb1a70d9945080f8ca22d4600c4a5b485ba04a876baf26aa09988dad5ecfda'),
  evidenceUpdate: guard('training_scenario_evidence_bound_immutable_update', '63cd4aa6e0f1d40684e32b195c66633c350a6579dc7d089e383f2d1094dac882'),
  packDeleteDependencies: guard('training_scenario_packs_bound_delete_dependencies_first', '886461bbcbfbf65340e66c65b8144f912cbdb7aebc3dc888448b53ddbde667c5'),
  packExisting: guard('training_scenario_packs_bound_existing_identity_guard', 'fc47d8a9c9544cc4ddc853754d73543b868d83f71c98865194efee2925542fc1'),
  packDelete: guard('training_scenario_packs_bound_governed_delete', '40bf2de376cb7f071cf83b48b5ff3dcde933e8323180534f93c3e2f8de1ea45b'),
  packUpdate: guard('training_scenario_packs_bound_immutable_update', '46cb578aaa4d1208c19e395af845863f15508fb314ddeb2a8238efec5e0d9904'),
  contextDeleteDependencies: guard('training_session_contexts_delete_dependencies_first', '8c6d90ec733b1750ca9d8be478839740e4ef36c346c7d126a6eb49aca509d021'),
  contextExisting: guard('training_session_contexts_existing_identity_guard', 'fb62a4e2e655299045afd55fdb9edfb891f2d9124bf5636c4292a677df18a9d1'),
  contextDelete: guard('training_session_contexts_governed_delete_only', '86ca912d8b92e8117edae6ebb52591798fe85bca98528384983e82d34679f5aa'),
  contextUpdate: guard('training_session_contexts_immutable_update', '709c1d75768ab065a3b133f0fbba87fc2081fbe719d28d0462bb6f8d8c65df40'),
  contextOwnerPack: guard('training_session_contexts_owner_and_pack_guard', 'e761a233e4c5ef4ae28d4a01a64dae5125e65a11e58f7d09e44e4be1ae57e916'),
});
const contextGuards = Object.freeze([
  guardDefinitions.contextExisting,
  guardDefinitions.contextOwnerPack,
  guardDefinitions.contextUpdate,
  guardDefinitions.contextDeleteDependencies,
  guardDefinitions.contextDelete,
]);
const packEvidenceGuards = Object.freeze([
  guardDefinitions.packExisting,
  guardDefinitions.packUpdate,
  guardDefinitions.packDeleteDependencies,
  guardDefinitions.packDelete,
  guardDefinitions.evidenceExisting,
  guardDefinitions.evidenceUpdate,
  guardDefinitions.evidenceDelete,
]);
const guardSets = Object.freeze({
  SOURCE_MANIFEST: Object.freeze([
    ...contextGuards,
    ...packEvidenceGuards,
  ]),
  LEARNING_SESSION_CONTEXT: Object.freeze([
    ...contextGuards,
    ...packEvidenceGuards,
  ]),
  AI_INVOCATION_ATTEMPT: Object.freeze([
    ...contextGuards,
    guardDefinitions.attemptExisting,
    guardDefinitions.attemptUpdate,
    guardDefinitions.attemptDelete,
    guardDefinitions.attemptLink,
  ]),
});

function freezeIdentity(value: ContentIdentity): ContentIdentity {
  return Object.freeze({ byte_length: value.byte_length, sha256: value.sha256 });
}

function freezeRef(value: SourceReceiptRefV1): SourceReceiptRefV1 {
  return Object.freeze({
    receipt_kind: value.receipt_kind,
    receipt_id: value.receipt_id,
    content_identity: freezeIdentity(value.content_identity),
  });
}

function unresolved(reason: Extract<ReceiptResolution, { status: 'UNRESOLVED' }>['reason']): ReceiptResolution {
  return Object.freeze({ status: 'UNRESOLVED', reason });
}

export function nonPassing(
  outcome: NonPassingObservation['outcome'],
  reason: NonPassingReason,
  receiptRefs: readonly SourceReceiptRefV1[] = [],
): NonPassingObservation {
  return Object.freeze({
    outcome,
    reason,
    failureTellIds: Object.freeze([]),
    receiptRefs: Object.freeze(receiptRefs.map(freezeRef)),
  });
}

const captureKinds = Object.freeze(['BUILD', 'DEPLOYMENT', 'CONTROL_PLANE'] as const);
const artifactKinds = Object.freeze([
  'STATIC', 'RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'LONGITUDINAL',
  'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT',
] as const);
const captureStatuses = Object.freeze(['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'] as const);
const captureOutcomes = Object.freeze([
  'CLAIM_SUPPORTED', 'CLAIM_CONTRADICTED', 'EXPECTED_RESULT_OBSERVED',
  'EXPECTED_RESULT_NOT_OBSERVED', 'NO_RESULT', 'UNKNOWN', 'UNGRADABLE',
] as const);
const captureStatusOutcomes = new Set([
  'PASS:CLAIM_SUPPORTED', 'PASS:EXPECTED_RESULT_OBSERVED',
  'FAIL:CLAIM_CONTRADICTED', 'FAIL:EXPECTED_RESULT_NOT_OBSERVED',
  'PENDING:NO_RESULT', 'UNKNOWN:UNKNOWN', 'UNGRADABLE:UNGRADABLE',
]);
const captureLabels = Object.freeze(['CODE_VERIFIED', 'DOCS_VERIFIED', 'LIVE_VERIFIED', 'UNKNOWN'] as const);
const captureGates = Object.freeze(['D', 'S', 'R', 'P', 'A', 'L', 'V0'] as const);
const captureSlices = Object.freeze(['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10'] as const);
const captureReceiptKinds = Object.freeze([
  'SOURCE_MANIFEST', 'LEARNING_SESSION_CONTEXT', 'AI_INVOCATION_ATTEMPT',
  'GROWTH_CONSENT', 'GROWTH_CYCLE', 'GROWTH_EVENT', 'MUTATION_RECEIPT',
  'RECHECK', 'DELETION', 'BUILD', 'DEPLOYMENT', 'CONTROL_PLANE',
  'BROWSER_ACTION_LOG', 'ACCESSIBILITY', 'REVIEW', 'GRADE_OUTPUT',
] as const satisfies readonly SourceReceiptKind[]);
const captureTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const captureLocatorPattern = /^(?:repo|encrypted):\/\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%-]*)+$/;
const captureHashPattern = /^[0-9a-f]{64}$/;
const captureEncoder = new TextEncoder();

type CaptureObject = Record<string, unknown>;

type CommittedExternalContainerProofV1 = Extract<
  ReceiptIntegrityProofV1,
  { proofKind: 'COMMITTED_EXTERNAL_CONTAINER' }
>;

interface ParsedExternalCaptureCarrier {
  readonly carrier: ExternalCaptureCarrierV1;
  readonly carrierBytes: Uint8Array;
  readonly carrierIdentity: ContentIdentity;
  readonly plan: ArtifactCapturePlanV1;
  readonly planIdentity: ContentIdentity;
  readonly integrityProof: CommittedExternalContainerProofV1;
}

function captureObject(value: unknown): value is CaptureObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const objectValue = value as object;
  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(objectValue).length !== 0) return false;
  for (const key of Object.getOwnPropertyNames(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) return false;
  }
  return true;
}

function captureExact(value: unknown, keys: readonly string[]): value is CaptureObject {
  if (!captureObject(value)) return false;
  const names = Object.getOwnPropertyNames(value);
  return names.length === keys.length && keys.every((key) => names.includes(key));
}

function captureString(value: unknown, nonEmpty = true): value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function captureText(value: unknown, nonEmpty = true): value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return value.normalize('NFC') === value;
}

function captureIdentity(value: unknown): value is ContentIdentity {
  if (!captureExact(value, ['byte_length', 'sha256'])) return false;
  const objectValue = value as CaptureObject;
  return typeof objectValue.byte_length === 'number'
    && Number.isSafeInteger(objectValue.byte_length)
    && !Object.is(objectValue.byte_length, -0)
    && objectValue.byte_length >= 0
    && typeof objectValue.sha256 === 'string'
    && captureHashPattern.test(objectValue.sha256);
}

function captureIdentityCopy(value: ContentIdentity): ContentIdentity {
  return Object.freeze({ byte_length: value.byte_length, sha256: value.sha256 });
}

function captureSameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function captureUtf8Compare(left: string, right: string): number {
  const leftBytes = captureEncoder.encode(left);
  const rightBytes = captureEncoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function captureSortedUniqueStrings(value: unknown, nonEmpty = false): value is readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) return false;
  if (!value.every((item) => captureString(item))) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (captureUtf8Compare(value[index - 1], value[index]) >= 0) return false;
  }
  return true;
}

function captureSortedUniqueIdentities(value: unknown): value is readonly ContentIdentity[] {
  if (!Array.isArray(value) || !value.every((item) => captureIdentity(item))) return false;
  const keys = value.map((item) => `${item.sha256}\u0000${item.byte_length}`);
  for (let index = 1; index < keys.length; index += 1) {
    if (captureUtf8Compare(keys[index - 1], keys[index]) >= 0) return false;
  }
  return true;
}

function captureTimestamp(value: unknown): value is string {
  return captureString(value) && captureTimestampPattern.test(value) && new Date(value).toISOString() === value;
}

function captureRef(value: unknown): value is SourceReceiptRefV1 {
  return captureExact(value, ['receipt_kind', 'receipt_id', 'content_identity'])
    && captureReceiptKinds.includes(value.receipt_kind as SourceReceiptKind)
    && captureString(value.receipt_id)
    && captureIdentity(value.content_identity);
}

function captureSortedRefs(value: unknown): value is readonly SourceReceiptRefV1[] {
  if (!Array.isArray(value) || !value.every((item) => captureRef(item))) return false;
  for (let index = 1; index < value.length; index += 1) {
    const previous = `${value[index - 1].receipt_kind}\u0000${value[index - 1].receipt_id}`;
    const current = `${value[index].receipt_kind}\u0000${value[index].receipt_id}`;
    if (captureUtf8Compare(previous, current) >= 0) return false;
  }
  return true;
}

function captureSubject(value: unknown): value is ContentBoundSubjectIdentity {
  return captureExact(value, ['subject_type', 'subject_key', 'content_identity'])
    && captureString(value.subject_type)
    && captureText(value.subject_key)
    && captureIdentity(value.content_identity);
}

function captureScope(value: unknown): value is EvidenceScopeV1 {
  return captureExact(value, [
    'purpose_identity', 'subject_identity', 'time_identity', 'environment_identity', 'exclusion_identities',
  ])
    && captureIdentity(value.purpose_identity)
    && captureIdentity(value.subject_identity)
    && captureIdentity(value.time_identity)
    && captureIdentity(value.environment_identity)
    && captureSortedUniqueIdentities(value.exclusion_identities);
}

function captureProducer(value: unknown): value is ProducerIdentityV1 {
  return captureExact(value, ['producer_id', 'role', 'vendor_family', 'attestation'])
    && captureString(value.producer_id)
    && captureString(value.role)
    && captureString(value.vendor_family)
    && captureString(value.attestation);
}

function captureStringArray(value: unknown, mode: 'ordered' | 'set', nonEmpty = false, ascii = true): value is readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) return false;
  const valid = value.every((item) => ascii ? captureString(item) : captureText(item));
  if (!valid) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (mode === 'set' && captureUtf8Compare(value[index - 1], value[index]) >= 0) return false;
    if (mode === 'ordered' && value[index - 1] === value[index]) return false;
  }
  return new Set(value).size === value.length;
}

function captureKindDetails(value: unknown, kind: ArtifactKind): boolean {
  switch (kind) {
    case 'STATIC':
      return captureExact(value, ['kind', 'source_subject_ids', 'source_snapshot_identity', 'code_bound'])
        && value.kind === 'STATIC'
        && captureStringArray(value.source_subject_ids, 'set', true)
        && captureIdentity(value.source_snapshot_identity)
        && typeof value.code_bound === 'boolean';
    case 'RUNTIME':
      return captureExact(value, ['kind', 'invocation_receipt_ids', 'action_log_artifact_id', 'started_at', 'completed_at'])
        && value.kind === 'RUNTIME'
        && captureStringArray(value.invocation_receipt_ids, 'set', true)
        && captureString(value.action_log_artifact_id)
        && captureTimestamp(value.started_at)
        && captureTimestamp(value.completed_at)
        && Date.parse(value.started_at) <= Date.parse(value.completed_at);
    case 'DEPLOYMENT':
      return captureExact(value, ['kind', 'control_plane_artifact_id', 'production_probe_artifact_ids', 'route_ids'])
        && value.kind === 'DEPLOYMENT'
        && captureString(value.control_plane_artifact_id)
        && captureStringArray(value.production_probe_artifact_ids, 'set', true)
        && captureStringArray(value.route_ids, 'set', true);
    case 'AUTHENTICATED_E2E':
      return captureExact(value, ['kind', 'journey_id', 'step_ids', 'action_log_artifact_id', 'capture_artifact_ids', 'korean_comprehension_artifact_id', 'isolation_result_ids'])
        && value.kind === 'AUTHENTICATED_E2E'
        && captureString(value.journey_id)
        && captureStringArray(value.step_ids, 'ordered', true)
        && captureString(value.action_log_artifact_id)
        && captureStringArray(value.capture_artifact_ids, 'set', true)
        && captureString(value.korean_comprehension_artifact_id)
        && captureStringArray(value.isolation_result_ids, 'set', true);
    case 'LONGITUDINAL':
      return captureExact(value, ['kind', 'protocol_id', 'baseline_artifact_id', 'followup_artifact_ids', 'scheduled_at', 'observed_at', 'horizon_seconds', 'changed_context', 'outcome_status'])
        && value.kind === 'LONGITUDINAL'
        && captureString(value.protocol_id)
        && captureString(value.baseline_artifact_id)
        && captureStringArray(value.followup_artifact_ids, 'ordered', true)
        && captureTimestamp(value.scheduled_at)
        && captureTimestamp(value.observed_at)
        && Date.parse(value.scheduled_at) <= Date.parse(value.observed_at)
        && typeof value.horizon_seconds === 'number'
        && Number.isSafeInteger(value.horizon_seconds)
        && value.horizon_seconds >= 0
        && typeof value.changed_context === 'boolean'
        && captureStatuses.includes(value.outcome_status as ArtifactStatus);
    case 'ACCESSIBILITY':
      return captureExact(value, ['kind', 'evaluation_id', 'route_ids', 'viewport_artifact_ids', 'input_mode_artifact_ids', 'assistive_technology_artifact_ids', 'korean_comprehension_artifact_ids', 'issue_ids'])
        && value.kind === 'ACCESSIBILITY'
        && captureString(value.evaluation_id)
        && captureStringArray(value.route_ids, 'set', true)
        && captureStringArray(value.viewport_artifact_ids, 'set', true)
        && captureStringArray(value.input_mode_artifact_ids, 'set', true)
        && captureStringArray(value.assistive_technology_artifact_ids, 'set', true)
        && captureStringArray(value.korean_comprehension_artifact_ids, 'set', true)
        && captureStringArray(value.issue_ids, 'set');
    case 'DELETION':
      return captureExact(value, ['kind', 'deletion_receipt_id', 'declared_store_ids', 'before_manifest_artifact_id', 'after_manifest_artifact_id', 'residue_probe_ids', 'authorized_actor', 'completed_at'])
        && value.kind === 'DELETION'
        && captureString(value.deletion_receipt_id)
        && captureStringArray(value.declared_store_ids, 'set', true)
        && captureString(value.before_manifest_artifact_id)
        && captureString(value.after_manifest_artifact_id)
        && captureStringArray(value.residue_probe_ids, 'set', true)
        && captureString(value.authorized_actor)
        && captureTimestamp(value.completed_at);
    case 'GRADE_INPUT':
      return captureExact(value, ['kind', 'presentation_packet_id', 'randomized_mapping_commitment', 'presented_artifact_ids', 'same_state_material'])
        && value.kind === 'GRADE_INPUT'
        && captureString(value.presentation_packet_id)
        && typeof value.randomized_mapping_commitment === 'string'
        && captureHashPattern.test(value.randomized_mapping_commitment)
        && captureStringArray(value.presented_artifact_ids, 'ordered', true)
        && value.same_state_material === true;
  }
}

function captureFailureTell(value: unknown): boolean {
  return captureExact(value, [
    'failure_tell_id', 'slice_ids', 'gate_ids', 'requirement_ids', 'subject_identity',
    'observed', 'artifact_ids', 'scope', 'review_output_identities',
  ])
    && captureString(value.failure_tell_id)
    && captureStringArray(value.slice_ids, 'set', true)
    && captureStringArray(value.gate_ids, 'set', true)
    && captureStringArray(value.requirement_ids, 'set', true)
    && captureSubject(value.subject_identity)
    && value.observed === true
    && captureStringArray(value.artifact_ids, 'set', true)
    && captureScope(value.scope)
    && captureSortedUniqueIdentities(value.review_output_identities);
}

function captureClaimAssertion(value: unknown): boolean {
  if (!captureExact(value, [
    'claim_id', 'conditional_requirement_ids', 'subject_identity', 'assertion_state',
    'artifact_ids', 'review_output_identities',
  ])) return false;
  if (!captureString(value.claim_id)
    || !captureStringArray(value.conditional_requirement_ids, 'set', true)
    || !captureSubject(value.subject_identity)
    || !['ASSERTED', 'NOT_ASSERTED', 'UNKNOWN'].includes(value.assertion_state as string)
    || !captureStringArray(value.artifact_ids, 'set')
    || !captureSortedUniqueIdentities(value.review_output_identities)) return false;
  return value.assertion_state === 'ASSERTED'
    ? value.artifact_ids.length > 0
    : value.artifact_ids.length === 0;
}

function captureBindings(value: unknown, kind: ArtifactKind): value is ArtifactBindingsV1 {
  if (!captureExact(value, [
    'source_receipts', 'build_identity', 'deployment_identity', 'account_scope_identity',
    'capture_environment_identity', 'retention_policy_identity', 'access_policy_identity',
    'negative_control_result_ids', 'failure_tell_observations', 'claim_assertions', 'kind_details',
  ])) return false;
  if (!captureSortedRefs(value.source_receipts)
    || !captureKindDetails(value.kind_details, kind)
    || !captureStringArray(value.negative_control_result_ids, 'set')
    || !Array.isArray(value.failure_tell_observations)
    || !value.failure_tell_observations.every((item) => captureFailureTell(item))
    || !Array.isArray(value.claim_assertions)
    || !value.claim_assertions.every((item) => captureClaimAssertion(item))) return false;
  for (let index = 1; index < value.failure_tell_observations.length; index += 1) {
    if (captureUtf8Compare(value.failure_tell_observations[index - 1].failure_tell_id, value.failure_tell_observations[index].failure_tell_id) >= 0) return false;
  }
  for (let index = 1; index < value.claim_assertions.length; index += 1) {
    if (captureUtf8Compare(value.claim_assertions[index - 1].claim_id, value.claim_assertions[index].claim_id) >= 0) return false;
  }
  const staticCodeBound = kind === 'STATIC'
    && captureObject(value.kind_details)
    && value.kind_details.kind === 'STATIC'
    && value.kind_details.code_bound === true;
  const requiredIdentity = staticCodeBound || ['RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'GRADE_INPUT'].includes(kind);
  const deploymentRequired = ['DEPLOYMENT', 'AUTHENTICATED_E2E', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT'].includes(kind);
  const accountRequired = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'DELETION'].includes(kind);
  const environmentRequired = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'GRADE_INPUT'].includes(kind);
  const privateArtifact = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION'].includes(kind);
  if ((requiredIdentity && !captureIdentity(value.build_identity)) || (!requiredIdentity && value.build_identity !== null)) return false;
  if ((deploymentRequired && !captureIdentity(value.deployment_identity)) || (!deploymentRequired && value.deployment_identity !== null)) return false;
  if ((accountRequired && !captureIdentity(value.account_scope_identity)) || (!accountRequired && value.account_scope_identity !== null)) return false;
  if ((environmentRequired && !captureIdentity(value.capture_environment_identity)) || (!environmentRequired && value.capture_environment_identity !== null)) return false;
  const requiresPolicies = privateArtifact;
  if ((requiresPolicies && !captureIdentity(value.retention_policy_identity)) || (!requiresPolicies && value.retention_policy_identity !== null)) return false;
  if ((requiresPolicies && !captureIdentity(value.access_policy_identity)) || (!requiresPolicies && value.access_policy_identity !== null)) return false;
  if (kind !== 'STATIC' && value.source_receipts.length === 0) return false;
  if (kind === 'RUNTIME') {
    const kindDetails = value.kind_details as { invocation_receipt_ids: readonly string[] };
    const sourceReceipts = value.source_receipts as readonly SourceReceiptRefV1[];
    const invocationIds = kindDetails.invocation_receipt_ids;
    if (!invocationIds.every((id: string) => sourceReceipts.some((ref: SourceReceiptRefV1) => ref.receipt_kind === 'AI_INVOCATION_ATTEMPT' && ref.receipt_id === id))) return false;
  }
  return true;
}

function captureBinding(value: unknown): value is ArtifactCaptureBindingV1 {
  if (!captureExact(value, [
    'artifactId', 'sliceId', 'gateId', 'requirementIds', 'artifactKind',
    'requiredCaptureKinds', 'requiredReceiptKinds', 'maximumClaim',
  ])) return false;
  return captureString(value.artifactId)
    && captureSlices.includes(value.sliceId as typeof captureSlices[number])
    && captureGates.includes(value.gateId as typeof captureGates[number])
    && captureStringArray(value.requirementIds, 'set', true)
    && artifactKinds.includes(value.artifactKind as ArtifactKind)
    && captureStringArray(value.requiredCaptureKinds, 'set', true)
    && value.requiredCaptureKinds.every((item) => captureKinds.includes(item as typeof captureKinds[number]))
    && captureStringArray(value.requiredReceiptKinds, 'set', true)
    && value.requiredReceiptKinds.every((item) => captureReceiptKinds.includes(item as SourceReceiptKind))
    && captureString(value.maximumClaim);
}

function capturePlan(value: unknown): value is ArtifactCapturePlanV1 {
  if (!captureExact(value, [
    'schemaVersion', 'rootIdentity', 'implementationPlanIdentity', 'subject', 'accountScopeIdentity',
    'buildIdentity', 'deploymentIdentity', 'routeManifestIdentity', 'controlPlaneIdentity', 'bindings',
  ])) return false;
  if (value.schemaVersion !== 'MES-ARTIFACT-CAPTURE-PLAN-1'
    || !captureIdentity(value.rootIdentity)
    || !captureIdentity(value.implementationPlanIdentity)
    || !captureSubject(value.subject)
    || !captureIdentity(value.accountScopeIdentity)
    || !captureIdentity(value.buildIdentity)
    || !captureIdentity(value.deploymentIdentity)
    || !captureIdentity(value.routeManifestIdentity)
    || !captureIdentity(value.controlPlaneIdentity)
    || !Array.isArray(value.bindings)
    || value.bindings.length === 0
    || !value.bindings.every((item) => captureBinding(item))) return false;
  const artifactIds = value.bindings.map((binding) => binding.artifactId);
  return new Set(artifactIds).size === artifactIds.length;
}

function captureObservation(value: unknown): value is ExternalArtifactObservationV1 {
  if (!captureExact(value, [
    'bindingIndex', 'artifactId', 'capturedAt', 'privacySafeLocator', 'artifactBytesIdentity',
    'evidenceLabel', 'status', 'outcome', 'producer', 'scope', 'limitations', 'artifactBindings',
  ])) return false;
  const objectValue = value as CaptureObject;
  const artifactBindings = objectValue.artifactBindings;
  const bindingKind = captureObject(artifactBindings) && captureObject(artifactBindings.kind_details)
    ? artifactBindings.kind_details.kind as ArtifactKind
    : undefined;
  const result = typeof objectValue.bindingIndex === 'number'
    && Number.isSafeInteger(objectValue.bindingIndex)
    && objectValue.bindingIndex >= 0
    && captureString(objectValue.artifactId)
    && captureTimestamp(objectValue.capturedAt)
    && captureString(objectValue.privacySafeLocator)
    && captureLocatorPattern.test(objectValue.privacySafeLocator)
    && captureIdentity(objectValue.artifactBytesIdentity)
    && captureLabels.includes(objectValue.evidenceLabel as typeof captureLabels[number])
    && captureStatuses.includes(objectValue.status as ArtifactStatus)
    && captureOutcomes.includes(objectValue.outcome as ArtifactOutcome)
    && captureStatusOutcomes.has(`${objectValue.status}:${objectValue.outcome}`)
    && (objectValue.evidenceLabel !== 'UNKNOWN'
      || ['PENDING', 'UNKNOWN', 'UNGRADABLE'].includes(objectValue.status as string))
    && captureProducer(objectValue.producer)
    && captureScope(objectValue.scope)
    && captureStringArray(objectValue.limitations, 'ordered', false, false)
    && (objectValue.status === 'PASS'
      || (Array.isArray(objectValue.limitations) && objectValue.limitations.length > 0))
    && captureBindings(artifactBindings, bindingKind as ArtifactKind)
    && (!String(objectValue.privacySafeLocator).startsWith('encrypted://')
      || (captureObject(artifactBindings)
        && captureIdentity(artifactBindings.retention_policy_identity)
        && captureIdentity(artifactBindings.access_policy_identity)));
  return result;
}

function captureCarrier(value: unknown): value is ExternalCaptureCarrierV1 {
  if (!captureExact(value, [
    'schemaVersion', 'rootIdentity', 'implementationPlanIdentity', 'artifactCapturePlan',
    'artifactCapturePlanIdentity', 'subject', 'accountScopeIdentity', 'buildRef', 'deploymentRef',
    'controlPlaneRef', 'externalContainerIdentity', 'policyIdentity', 'independentReadbackIdentity',
    'observations',
  ])) return false;
  if (value.schemaVersion !== 'MES-EXTERNAL-CAPTURE-1'
    || !captureIdentity(value.rootIdentity)
    || !captureIdentity(value.implementationPlanIdentity)
    || !capturePlan(value.artifactCapturePlan)
    || !captureIdentity(value.artifactCapturePlanIdentity)
    || !captureSubject(value.subject)
    || !captureIdentity(value.accountScopeIdentity)
    || !captureRef(value.buildRef)
    || value.buildRef.receipt_kind !== 'BUILD'
    || !captureRef(value.deploymentRef)
    || value.deploymentRef.receipt_kind !== 'DEPLOYMENT'
    || !captureRef(value.controlPlaneRef)
    || value.controlPlaneRef.receipt_kind !== 'CONTROL_PLANE'
    || !captureIdentity(value.externalContainerIdentity)
    || !captureIdentity(value.policyIdentity)
    || !captureIdentity(value.independentReadbackIdentity)
    || !Array.isArray(value.observations)
    || !value.observations.every((item) => captureObservation(item))) return false;
  return value.observations.every((observation, index) => observation.bindingIndex === index);
}

function committedExternalContainerProof(
  carrier: ExternalCaptureCarrierV1,
): CommittedExternalContainerProofV1 {
  return Object.freeze({
    proofKind: 'COMMITTED_EXTERNAL_CONTAINER' as const,
    protectedSubjectIdentity: captureIdentityCopy(carrier.subject.content_identity),
    containerIdentity: captureIdentityCopy(carrier.externalContainerIdentity),
    policyIdentity: captureIdentityCopy(carrier.policyIdentity),
    independentReadbackIdentity: captureIdentityCopy(carrier.independentReadbackIdentity),
  });
}

function captureDeepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  const objectValue = value as unknown as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) captureDeepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function captureStrings(value: unknown, output: string[], seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) captureStrings(descriptor.value, output, seen);
  }
}

async function captureHasPrivacyCanary(value: unknown): Promise<boolean> {
  const strings: string[] = [];
  captureStrings(value, strings);
  if (strings.some((item) => /(?:canary|password|credential|prompt|response|learner|browser|private-account|raw-data)/i.test(item))) return true;
  const hashes = new Set(strings.filter((item) => captureHashPattern.test(item)));
  for (const text of strings) {
    if (captureHashPattern.test(text)) continue;
    if (hashes.has(await sha256Hex(captureEncoder.encode(text)))) return true;
  }
  return false;
}

/** @internal Pure byte verifier used by the detached adapter. */
export async function parseExternalCaptureCarrier(
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
): Promise<ParsedExternalCaptureCarrier | null> {
  if (!(carrierBytes instanceof Uint8Array) || !captureIdentity(carrierIdentity)) return null;
  let parsed: unknown;
  try {
    parsed = parseAuthorityJson(carrierBytes);
    const canonical = canonicalDocument(parsed as CanonicalJsonValue);
    if (!equalBytes(canonical, carrierBytes)) return null;
    const canonicalIdentity = await canonicalAuthorityContentIdentity(carrierBytes);
    if (!captureSameIdentity(canonicalIdentity, carrierIdentity)) return null;
  } catch {
    return null;
  }
  try {
    if (!captureCarrier(parsed)) return null;
    if (await captureHasPrivacyCanary(parsed)) return null;
    const carrier = parsed as ExternalCaptureCarrierV1;
    let planBytes: Uint8Array;
    let planIdentity: ContentIdentity;
    planBytes = canonicalDocument(carrier.artifactCapturePlan as unknown as CanonicalJsonValue);
    planIdentity = await contentIdentity(planBytes);
    if (!captureSameIdentity(planIdentity, carrier.artifactCapturePlanIdentity)) return null;
    const proofIdentities = [carrier.externalContainerIdentity, carrier.policyIdentity, carrier.independentReadbackIdentity];
    if (new Set(proofIdentities.map((item) => `${item.sha256}\u0000${item.byte_length}`)).size !== proofIdentities.length) return null;
    return Object.freeze({
      carrier: captureDeepFreeze(carrier),
      carrierBytes: new Uint8Array(carrierBytes),
      carrierIdentity: captureIdentityCopy(carrierIdentity),
      plan: captureDeepFreeze(carrier.artifactCapturePlan),
      planIdentity: captureIdentityCopy(planIdentity),
      integrityProof: committedExternalContainerProof(carrier),
    });
  } catch {
    return null;
  }
}

function exactRef(value: SourceReceiptRefV1): boolean {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== 'content_identity\0receipt_id\0receipt_kind') return false;
  const identity = value.content_identity;
  return typeof value.receipt_id === 'string'
    && value.receipt_id.length > 0
    && typeof identity === 'object'
    && identity !== null
    && Object.keys(identity).sort().join('\0') === 'byte_length\0sha256'
    && Number.isSafeInteger(identity.byte_length)
    && identity.byte_length >= 0
    && /^[0-9a-f]{64}$/.test(identity.sha256);
}

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function sameSubject(left: ResolvedReceiptPayloadV1, right: ResolvedReceiptPayloadV1): boolean {
  return sameIdentity(left.subjectIdentity, right.subjectIdentity)
    && sameIdentity(left.accountScopeIdentity, right.accountScopeIdentity);
}

async function identity(value: CanonicalJsonValue): Promise<ContentIdentity> {
  return freezeIdentity(await contentIdentity(canonicalDocument(value)));
}

async function hasExactGuards(db: D1Database, expected: readonly GuardDefinition[]): Promise<boolean> {
  try {
    const result = await db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${expected.map((_, index) => `?${index + 1}`).join(', ')})
      ORDER BY name ASC
    `).bind(...expected.map((definition) => definition.name)).all<{ name: string; sql: string }>();
    const actual = (result.results ?? []).sort((left, right) => left.name.localeCompare(right.name));
    const sortedExpected = [...expected].sort((left, right) => left.name.localeCompare(right.name));
    if (actual.length !== sortedExpected.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      if (
        actual[index].name !== sortedExpected[index].name
        || typeof actual[index].sql !== 'string'
        || await sha256Hex(encoder.encode(actual[index].sql)) !== sortedExpected[index].sha256
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isoTime(value: number): string | null {
  if (!safeInteger(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const executionLanes = Object.freeze([
  'interactive_generation',
  'learner_evaluation',
  'release_critic',
  'background_reasoning',
] as const satisfies readonly AIRouteLane[]);

function parseRoutePlan(value: string): CanonicalJsonValue | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    if (
      keys.some((key) => typeof key !== 'string')
      || (keys as string[]).sort().join('\0') !== [...executionLanes].sort().join('\0')
    ) return null;
    const closed = {} as Record<AIRouteLane, readonly AIRouteId[]>;
    for (const lane of executionLanes) {
      const routes = record[lane];
      if (!Array.isArray(routes)) return null;
      const unique = new Set<string>();
      const accepted: AIRouteId[] = [];
      for (const route of routes) {
        if (!isAIRouteAllowedForLane(route, lane) || unique.has(route)) return null;
        unique.add(route);
        accepted.push(route);
      }
      closed[lane] = Object.freeze(accepted);
    }
    return Object.freeze(closed) as unknown as CanonicalJsonValue;
  } catch {
    return null;
  }
}

async function protectedProof(
  subjectIdentity: ContentIdentity,
  guards: readonly GuardDefinition[],
): Promise<ReceiptIntegrityProofV1> {
  return Object.freeze({
    proofKind: 'D1_IMMUTABLE_CORE' as const,
    protectedSubjectIdentity: freezeIdentity(subjectIdentity),
    guardSetIdentity: await identity({
      trigger_definitions: [...guards]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((definition) => ({ name: definition.name, sha256: definition.sha256 })),
    }),
    supportingReceiptRefs: Object.freeze([]),
  });
}

async function resolved(
  ref: SourceReceiptRefV1,
  committedAt: number,
  payload: ResolvedReceiptPayloadV1,
  guards: readonly GuardDefinition[],
): Promise<ReceiptResolution> {
  const canonicalBytes = canonicalDocument(payload as unknown as CanonicalJsonValue);
  const actual = await contentIdentity(canonicalBytes);
  if (!sameIdentity(actual, ref.content_identity)) return unresolved('CONTENT_MISMATCH');
  const timestamp = isoTime(committedAt);
  if (!timestamp) return unresolved('CONTENT_MISMATCH');
  const result = Object.freeze({
    status: 'RESOLVED' as const,
    ref: freezeRef(ref),
    subjectIdentity: freezeIdentity(payload.subjectIdentity),
    committedAt: timestamp,
    privacy: 'PUBLIC_METADATA' as const,
    integrityProof: await protectedProof(payload.subjectIdentity, guards),
    canonicalBytes: new Uint8Array(canonicalBytes),
    payload: Object.freeze(payload),
  });
  verifiedResolutionBrand.add(result);
  verifiedResolutionBytes.set(result, new Uint8Array(canonicalBytes));
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

async function contextFacts(row: ContextRow): Promise<Readonly<{
  subjectIdentity: ContentIdentity;
  accountScopeIdentity: ContentIdentity;
  sessionIdentity: ContentIdentity;
  contextIdentity: ContentIdentity;
  cacheNamespaceIdentity: ContentIdentity;
  routePlanIdentity: ContentIdentity;
  routePlan: CanonicalJsonValue;
}> | null> {
  if (
    row.status !== 'ACTIVE'
    || row.training_mode !== 'scenario'
    || row.session_owner_user_id !== row.owner_user_id
    || !safeInteger(row.created_at)
    || row.updated_at !== row.created_at
    || !/^[0-9a-f]{64}$/.test(row.evidence_manifest_sha256)
    || typeof row.prompt_cache_namespace !== 'string'
    || row.prompt_cache_namespace.length === 0
  ) return null;
  const routePlan = parseRoutePlan(row.route_plan_json);
  if (!routePlan) return null;
  const subjectIdentity = await identity({ session_id: row.session_id, subject_kind: 'TRAINING_SESSION' });
  return Object.freeze({
    subjectIdentity,
    accountScopeIdentity: await identity({ account_key: row.owner_user_id, scope_kind: 'OWNER' }),
    sessionIdentity: await identity({ session_id: row.session_id }),
    contextIdentity: await identity({
      context_id: row.id,
      evidence_manifest_sha256: row.evidence_manifest_sha256,
      evidence_policy_revision: row.evidence_policy_revision,
      prompt_cache_namespace: row.prompt_cache_namespace,
      route_plan: routePlan,
      session_id: row.session_id,
    }),
    cacheNamespaceIdentity: await identity({ prompt_cache_namespace: row.prompt_cache_namespace }),
    routePlanIdentity: await identity(routePlan),
    routePlan,
  });
}

async function loadContext(db: D1Database, by: 'id' | 'session', value: string): Promise<ContextRow | null> {
  const predicate = by === 'id' ? 'context.id = ?1' : 'context.session_id = ?1';
  return db.prepare(`
    SELECT context.*, session.training_mode, session.user_id AS session_owner_user_id
    FROM training_session_contexts context
    INNER JOIN training_sessions session ON session.id = context.session_id
    WHERE ${predicate}
  `).bind(value).first<ContextRow>();
}

async function readTrainingContext(
  db: D1Database,
  ownerKey: string,
  ref: SourceReceiptRefV1,
): Promise<ReceiptResolution> {
  const row = await loadContext(db, 'id', ref.receipt_id);
  if (!row) return unresolved('MISSING');
  if (row.owner_user_id !== ownerKey) return unresolved('OWNER_MISMATCH');
  if (!await hasExactGuards(db, guardSets.LEARNING_SESSION_CONTEXT)) return unresolved('MUTABLE');
  const facts = await contextFacts(row);
  if (!facts) return unresolved('CONTENT_MISMATCH');
  const payload: ResolvedReceiptPayloadV1 = Object.freeze({
    receiptKind: 'LEARNING_SESSION_CONTEXT',
    subjectIdentity: facts.subjectIdentity,
    accountScopeIdentity: facts.accountScopeIdentity,
    causal: Object.freeze({
      cacheNamespaceIdentity: facts.cacheNamespaceIdentity,
      contextIdentity: facts.contextIdentity,
      routePlanIdentity: facts.routePlanIdentity,
      sessionIdentity: facts.sessionIdentity,
    }),
  });
  return resolved(ref, row.created_at, payload, guardSets.LEARNING_SESSION_CONTEXT);
}

async function readSourceManifest(
  db: D1Database,
  ownerKey: string,
  ref: SourceReceiptRefV1,
): Promise<ReceiptResolution> {
  const context = await loadContext(db, 'session', ref.receipt_id);
  if (!context) return unresolved('MISSING');
  if (context.owner_user_id !== ownerKey) return unresolved('OWNER_MISMATCH');
  if (!await hasExactGuards(db, guardSets.SOURCE_MANIFEST)) return unresolved('MUTABLE');
  const facts = await contextFacts(context);
  if (!facts) return unresolved('CONTENT_MISMATCH');
  const pack = await db.prepare(`
    SELECT session_id, evidence_query, evidence_status, evidence_manifest_sha256, source_count, book_count
    FROM training_scenario_packs WHERE session_id = ?1
  `).bind(context.session_id).first<PackRow>();
  const result = await db.prepare(`
    SELECT source_id, selection_index, book_id, chunk_id, book_title, book_author,
      chunk_index, excerpt, content_sha256, relevance_score, lifecycle_status
    FROM training_scenario_evidence WHERE session_id = ?1 ORDER BY selection_index ASC
  `).bind(context.session_id).all<EvidenceRow>();
  const rows = result.results ?? [];
  if (rows.some((row) => row.lifecycle_status !== 'active')) return unresolved('STALE');
  if (
    !pack
    || pack.evidence_status !== 'ready'
    || pack.evidence_manifest_sha256 !== context.evidence_manifest_sha256
    || !safeInteger(pack.source_count)
    || !safeInteger(pack.book_count)
    || pack.source_count !== rows.length
    || new Set(rows.map((row) => row.book_id)).size !== pack.book_count
  ) return unresolved('CONTENT_MISMATCH');
  if (rows.some((row, index) => (
    row.selection_index !== index
    || row.source_id !== `library:${row.book_id}:${row.chunk_id}`
    || !safeInteger(row.chunk_index)
    || typeof row.excerpt !== 'string'
    || typeof row.relevance_score !== 'number'
    || !Number.isFinite(row.relevance_score)
  ))) return unresolved('CONTENT_MISMATCH');
  for (const row of rows) {
    if (await sha256Hex(encoder.encode(row.excerpt)) !== row.content_sha256) {
      return unresolved('CONTENT_MISMATCH');
    }
  }
  const actualManifest = await sha256Hex(encoder.encode(JSON.stringify({
    query: pack.evidence_query,
    sources: [...rows]
      .sort((left, right) => left.source_id.localeCompare(right.source_id))
      .map((row) => ({
        sourceId: row.source_id,
        selectionIndex: row.selection_index,
        bookId: row.book_id,
        bookTitle: row.book_title,
        bookAuthor: row.book_author,
        chunkId: row.chunk_id,
        chunkIndex: row.chunk_index,
        contentSha256: row.content_sha256,
        relevanceScore: row.relevance_score,
      })),
  })));
  if (actualManifest !== pack.evidence_manifest_sha256) return unresolved('CONTENT_MISMATCH');
  const sourceItemIdentities = await Promise.all(rows.map((row) => identity({
    book_author: row.book_author,
    book_id: row.book_id,
    book_title: row.book_title,
    chunk_id: row.chunk_id,
    chunk_index: row.chunk_index,
    content_sha256: row.content_sha256,
    relevance_score_micros: Math.round(row.relevance_score * 1_000_000),
    selection_index: row.selection_index,
    source_id: row.source_id,
  })));
  const payload: ResolvedReceiptPayloadV1 = Object.freeze({
    receiptKind: 'SOURCE_MANIFEST',
    subjectIdentity: facts.subjectIdentity,
    accountScopeIdentity: facts.accountScopeIdentity,
    causal: Object.freeze({
      manifestIdentity: await identity({ evidence_manifest_sha256: pack.evidence_manifest_sha256 }),
      sessionContextIdentity: facts.contextIdentity,
      sourceItemIdentities: Object.freeze(sourceItemIdentities),
    }),
  });
  return resolved(ref, context.created_at, payload, guardSets.SOURCE_MANIFEST);
}

function routeContains(routePlan: CanonicalJsonValue, lane: string, routeId: string): boolean {
  if (!routePlan || typeof routePlan !== 'object' || Array.isArray(routePlan)) return false;
  const routes = (routePlan as Record<string, CanonicalJsonValue>)[lane];
  return Array.isArray(routes) && routes.includes(routeId);
}

async function readAttempt(
  db: D1Database,
  ownerKey: string,
  ref: SourceReceiptRefV1,
): Promise<ReceiptResolution> {
  const row = await db.prepare(`
    SELECT attempt.*, context.owner_user_id, context.id AS context_id,
      context.session_id AS context_session_id,
      context.prompt_cache_namespace AS context_cache_namespace,
      context.route_plan_json
    FROM ai_invocation_attempts attempt
    LEFT JOIN training_session_contexts context ON context.id = attempt.session_context_id
    WHERE attempt.id = ?1
  `).bind(ref.receipt_id).first<AttemptRow>();
  if (!row) return unresolved('MISSING');
  if (
    !row.session_context_id
    || !row.session_id
    || row.context_id !== row.session_context_id
    || row.context_session_id !== row.session_id
    || !safeInteger(row.turn_number)
    || !row.prompt_cache_namespace
    || row.context_cache_namespace !== row.prompt_cache_namespace
    || !safeInteger(row.started_at)
    || !safeInteger(row.completed_at)
    || row.completed_at < row.started_at
    || (row.outcome !== 'success' && row.outcome !== 'failure')
  ) return unresolved('MUTABLE');
  if (row.owner_user_id !== ownerKey) return unresolved('OWNER_MISMATCH');
  if (!await hasExactGuards(db, guardSets.AI_INVOCATION_ATTEMPT)) return unresolved('MUTABLE');
  const context = await loadContext(db, 'id', row.session_context_id);
  if (!context) return unresolved('MUTABLE');
  const facts = await contextFacts(context);
  if (!facts || !routeContains(facts.routePlan, row.lane, row.route_id)) {
    return unresolved('CONTENT_MISMATCH');
  }
  const payload: ResolvedReceiptPayloadV1 = Object.freeze({
    receiptKind: 'AI_INVOCATION_ATTEMPT',
    subjectIdentity: facts.subjectIdentity,
    accountScopeIdentity: facts.accountScopeIdentity,
    causal: Object.freeze({
      cacheNamespaceIdentity: facts.cacheNamespaceIdentity,
      contextIdentity: facts.contextIdentity,
      routeTargetIdentity: await identity({
        lane: row.lane,
        model: row.model,
        provider: row.provider,
        route_id: row.route_id,
      }),
      sessionIdentity: facts.sessionIdentity,
      terminalOutcome: row.outcome,
      turnNumber: row.turn_number,
    }),
  });
  return resolved(ref, row.completed_at, payload, guardSets.AI_INVOCATION_ATTEMPT);
}

const INTEGRATION_CARRIER_KEYS = Object.freeze([
  'schemaVersion',
  'rootIdentity',
  'candidateIdentity',
  'resolutions',
] as const);

const INTEGRATION_RESOLUTION_KEYS = Object.freeze([
  'ref',
  'subjectIdentity',
  'committedAt',
  'privacy',
  'integrityProof',
  'canonicalBytesBase64',
  'payload',
] as const);

function integrationBase64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function integrationStrictBase64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    const binary = atob(value);
    if (binary.length === 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return integrationBase64FromBytes(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function integrationRefEqual(left: SourceReceiptRefV1, right: SourceReceiptRefV1): boolean {
  return left.receipt_kind === right.receipt_kind
    && left.receipt_id === right.receipt_id
    && captureSameIdentity(left.content_identity, right.content_identity);
}

function integrationIdentitySetDistinct(values: readonly ContentIdentity[]): boolean {
  return new Set(values.map((item) => `${item.sha256}\u0000${item.byte_length}`)).size === values.length;
}

function integrationCausal(value: unknown, kind: SourceReceiptKind): boolean {
  switch (kind) {
    case 'SOURCE_MANIFEST':
      return captureExact(value, ['sessionContextIdentity', 'manifestIdentity', 'sourceItemIdentities'])
        && captureIdentity(value.sessionContextIdentity)
        && captureIdentity(value.manifestIdentity)
        && captureSortedUniqueIdentities(value.sourceItemIdentities);
    case 'LEARNING_SESSION_CONTEXT':
      return captureExact(value, ['sessionIdentity', 'contextIdentity', 'cacheNamespaceIdentity', 'routePlanIdentity'])
        && captureIdentity(value.sessionIdentity)
        && captureIdentity(value.contextIdentity)
        && captureIdentity(value.cacheNamespaceIdentity)
        && captureIdentity(value.routePlanIdentity);
    case 'AI_INVOCATION_ATTEMPT':
      return captureExact(value, ['sessionIdentity', 'contextIdentity', 'turnNumber', 'cacheNamespaceIdentity', 'terminalOutcome', 'routeTargetIdentity'])
        && captureIdentity(value.sessionIdentity)
        && captureIdentity(value.contextIdentity)
        && typeof value.turnNumber === 'number'
        && Number.isSafeInteger(value.turnNumber)
        && value.turnNumber >= 0
        && captureIdentity(value.cacheNamespaceIdentity)
        && (value.terminalOutcome === 'success' || value.terminalOutcome === 'failure')
        && captureIdentity(value.routeTargetIdentity);
    case 'GROWTH_CONSENT':
      return captureExact(value, ['originIdentity', 'privateSpaceIdentity', 'purposeIdentity', 'retentionIdentity', 'consentState', 'consentReceiptIdentity'])
        && captureIdentity(value.originIdentity)
        && captureIdentity(value.privateSpaceIdentity)
        && captureIdentity(value.purposeIdentity)
        && captureIdentity(value.retentionIdentity)
        && captureString(value.consentState)
        && captureIdentity(value.consentReceiptIdentity);
    case 'GROWTH_CYCLE':
      return captureExact(value, ['originIdentity', 'privateSpaceIdentity', 'cycleIdentity', 'aggregateRevision', 'cycleState'])
        && captureIdentity(value.originIdentity)
        && captureIdentity(value.privateSpaceIdentity)
        && captureIdentity(value.cycleIdentity)
        && typeof value.aggregateRevision === 'number'
        && Number.isSafeInteger(value.aggregateRevision)
        && value.aggregateRevision >= 0
        && captureString(value.cycleState);
    case 'GROWTH_EVENT':
      return captureExact(value, ['cycleIdentity', 'aggregateRevision', 'eventIdentity', 'transitionIdentity'])
        && captureIdentity(value.cycleIdentity)
        && typeof value.aggregateRevision === 'number'
        && Number.isSafeInteger(value.aggregateRevision)
        && value.aggregateRevision >= 0
        && captureIdentity(value.eventIdentity)
        && captureIdentity(value.transitionIdentity);
    case 'MUTATION_RECEIPT':
      return captureExact(value, ['cycleIdentity', 'aggregateRevision', 'mutationIdentity', 'replayPayloadIdentity'])
        && captureIdentity(value.cycleIdentity)
        && typeof value.aggregateRevision === 'number'
        && Number.isSafeInteger(value.aggregateRevision)
        && value.aggregateRevision >= 0
        && captureIdentity(value.mutationIdentity)
        && captureIdentity(value.replayPayloadIdentity);
    case 'RECHECK':
      return captureExact(value, ['cycleIdentity', 'scheduleIdentity', 'ruleIdentity', 'horizonAt', 'receiptIdentity'])
        && captureIdentity(value.cycleIdentity)
        && captureIdentity(value.scheduleIdentity)
        && captureIdentity(value.ruleIdentity)
        && captureTimestamp(value.horizonAt)
        && captureIdentity(value.receiptIdentity);
    case 'DELETION':
      return captureExact(value, ['declaredStoreManifestIdentity', 'beforeIdentity', 'afterIdentity', 'residueProbeIdentity', 'terminalState'])
        && captureIdentity(value.declaredStoreManifestIdentity)
        && captureIdentity(value.beforeIdentity)
        && captureIdentity(value.afterIdentity)
        && captureIdentity(value.residueProbeIdentity)
        && captureString(value.terminalState);
    case 'BUILD':
      return captureExact(value, ['buildIdentity']) && captureIdentity(value.buildIdentity);
    case 'DEPLOYMENT':
      return captureExact(value, ['buildIdentity', 'deploymentIdentity'])
        && captureIdentity(value.buildIdentity)
        && captureIdentity(value.deploymentIdentity);
    case 'CONTROL_PLANE':
      return captureExact(value, ['deploymentIdentity', 'routeManifestIdentity', 'controlPlaneIdentity'])
        && captureIdentity(value.deploymentIdentity)
        && captureIdentity(value.routeManifestIdentity)
        && captureIdentity(value.controlPlaneIdentity);
    case 'BROWSER_ACTION_LOG':
      return captureExact(value, ['controlId', 'beforeIdentity', 'afterIdentity', 'actionLogIdentity', 'networkEvidenceIdentity', 'targetLink'])
        && captureString(value.controlId)
        && captureIdentity(value.beforeIdentity)
        && captureIdentity(value.afterIdentity)
        && captureIdentity(value.actionLogIdentity)
        && captureIdentity(value.networkEvidenceIdentity)
        && value.targetLink !== null;
    case 'ACCESSIBILITY':
      return captureExact(value, ['controlId', 'encryptedContainerIdentity', 'policyIdentity', 'targetLink'])
        && captureString(value.controlId)
        && captureIdentity(value.encryptedContainerIdentity)
        && captureIdentity(value.policyIdentity)
        && value.targetLink !== null;
    case 'REVIEW':
      return captureExact(value, ['candidateIdentity', 'reviewerIdentity', 'reviewerFamily', 'verdict', 'reasonCodes'])
        && captureIdentity(value.candidateIdentity)
        && captureIdentity(value.reviewerIdentity)
        && captureString(value.reviewerFamily)
        && captureString(value.verdict)
        && captureStringArray(value.reasonCodes, 'set');
    case 'GRADE_OUTPUT':
      return captureExact(value, ['packetIdentity', 'graderIdentity', 'graderFamily', 'verdict', 'reasonCodes'])
        && captureIdentity(value.packetIdentity)
        && captureIdentity(value.graderIdentity)
        && captureString(value.graderFamily)
        && captureString(value.verdict)
        && captureStringArray(value.reasonCodes, 'set');
  }
}

function integrationPayload(
  value: unknown,
  ref: SourceReceiptRefV1,
  subjectIdentity: ContentIdentity,
): value is ResolvedReceiptPayloadV1 {
  return captureExact(value, ['receiptKind', 'subjectIdentity', 'accountScopeIdentity', 'causal'])
    && value.receiptKind === ref.receipt_kind
    && captureIdentity(value.subjectIdentity)
    && captureIdentity(value.accountScopeIdentity)
    && captureSameIdentity(value.subjectIdentity, subjectIdentity)
    && integrationCausal(value.causal, ref.receipt_kind);
}

function integrationStrings(value: unknown, output: string[], seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) integrationStrings(descriptor.value, output, seen);
  }
}

async function integrationHasPrivateCanary(value: unknown): Promise<boolean> {
  const strings: string[] = [];
  integrationStrings(value, strings);
  if (strings.some((item) => /(?:canary|password|credential|prompt|response|learner|private-account|raw-data)/i.test(item))) return true;
  const hashes = new Set(strings.filter((item) => captureHashPattern.test(item)));
  for (const item of strings) {
    if (captureHashPattern.test(item)) continue;
    if (hashes.has(await sha256Hex(captureEncoder.encode(item)))) return true;
  }
  return false;
}

async function integrationProof(
  value: unknown,
  resolution: IntegrationReceiptResolutionV1,
  payload: ResolvedReceiptPayloadV1,
): Promise<boolean> {
  if (resolution.privacy === 'PUBLIC_METADATA') {
    if (!captureExact(value, ['proofKind', 'protectedSubjectIdentity', 'guardSetIdentity', 'supportingReceiptRefs'])
      || value.proofKind !== 'D1_IMMUTABLE_CORE'
      || !captureIdentity(value.protectedSubjectIdentity)
      || !captureSameIdentity(value.protectedSubjectIdentity, resolution.subjectIdentity)
      || !captureSameIdentity(value.protectedSubjectIdentity, payload.subjectIdentity)
      || !captureIdentity(value.guardSetIdentity)
      || !captureSortedRefs(value.supportingReceiptRefs)
      || value.supportingReceiptRefs.length !== 0) return false;
    const guards = guardSets[resolution.ref.receipt_kind as keyof typeof guardSets];
    if (!guards) return false;
    const expectedGuardIdentity = await identity({
      trigger_definitions: [...guards]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((definition) => ({ name: definition.name, sha256: definition.sha256 })),
    });
    return captureSameIdentity(value.guardSetIdentity, expectedGuardIdentity);
  }
  if (resolution.privacy !== 'ENCRYPTED_PRIVATE_CONTAINER'
    || !captureExact(value, ['proofKind', 'protectedSubjectIdentity', 'containerIdentity', 'policyIdentity', 'independentReadbackIdentity'])
    || value.proofKind !== 'COMMITTED_EXTERNAL_CONTAINER'
    || !captureIdentity(value.protectedSubjectIdentity)
    || !captureSameIdentity(value.protectedSubjectIdentity, resolution.subjectIdentity)
    || !captureSameIdentity(value.protectedSubjectIdentity, payload.subjectIdentity)
    || !captureIdentity(value.containerIdentity)
    || !captureIdentity(value.policyIdentity)
    || !captureIdentity(value.independentReadbackIdentity)) return false;
  return integrationIdentitySetDistinct([
    value.containerIdentity,
    value.policyIdentity,
    value.independentReadbackIdentity,
  ]);
}

type IntegrationCandidateSnapshot = Readonly<{
  record: unknown;
  canonicalBytes: Uint8Array;
  recordIdentity: ContentIdentity;
}>;

type VerifiedIntegrationReceiptCarrierProjection = Readonly<{
  carrierBytes: Uint8Array;
  carrierIdentity: ContentIdentity;
  candidateBytes: Uint8Array;
  candidateIdentity: ContentIdentity;
  candidateRefs: readonly SourceReceiptRefV1[];
  resolutions: readonly ReceiptResolution[];
}>;

function integrationCandidateSnapshot(value: unknown): IntegrationCandidateSnapshot | null {
  if (!captureExact(value, ['record', 'canonical_bytes', 'record_identity'])) return null;
  const candidate = value as CaptureObject;
  if (!(candidate.canonical_bytes instanceof Uint8Array)
    || candidate.canonical_bytes.byteLength === 0
    || !captureIdentity(candidate.record_identity)) return null;
  return Object.freeze({
    record: structuredClone(candidate.record),
    canonicalBytes: new Uint8Array(candidate.canonical_bytes),
    recordIdentity: captureIdentityCopy(candidate.record_identity),
  });
}

async function integrationCandidate(value: IntegrationCandidateSnapshot): Promise<DetachedRecordCandidate | null> {
  try {
    const bytes = new Uint8Array(value.canonicalBytes);
    const parsed = validateEvidenceRecord(parseAuthorityJson(bytes));
    if (!canonicalBytesEqual(canonicalDocument(parsed as unknown as CanonicalJsonValue), bytes)
      || !canonicalBytesEqual(canonicalDocument(value.record as CanonicalJsonValue), bytes)) return null;
    const actual = await contentIdentity(bytes);
    if (!captureSameIdentity(actual, value.recordIdentity)) return null;
    return Object.freeze({
      record: captureDeepFreeze(parsed),
      canonical_bytes: bytes,
      record_identity: captureIdentityCopy(actual),
    });
  } catch {
    return null;
  }
}

async function integrationReceiptCarrierProjection(
  root: EvidenceSpineRootV1,
  candidateSnapshot: IntegrationCandidateSnapshot,
  bytes: Uint8Array,
  expectedCarrierIdentity: ContentIdentity,
): Promise<VerifiedIntegrationReceiptCarrierProjection | null> {
  const rootBytes = canonicalDocument(root as unknown as CanonicalJsonValue);
  const rootIdentity = await contentIdentity(rootBytes);
  const settledCandidate = await integrationCandidate(candidateSnapshot);
  if (!settledCandidate) return null;
  const parsed = parseAuthorityJson(bytes);
  if (!canonicalBytesEqual(canonicalDocument(parsed as CanonicalJsonValue), bytes)
    || !captureExact(parsed, INTEGRATION_CARRIER_KEYS)
    || parsed.schemaVersion !== 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1'
    || !captureIdentity(parsed.rootIdentity)
    || !captureIdentity(parsed.candidateIdentity)
    || !Array.isArray(parsed.resolutions)) return null;
  const actualCarrierIdentity = await contentIdentity(bytes);
  if (!captureSameIdentity(actualCarrierIdentity, expectedCarrierIdentity)
    || !captureSameIdentity(parsed.rootIdentity, rootIdentity)
    || !captureSameIdentity(parsed.candidateIdentity, settledCandidate.record_identity)
    || !captureSameIdentity(settledCandidate.record.root_identity, rootIdentity)) return null;

  const expectedRefs = settledCandidate.record.source_receipts;
  if (parsed.resolutions.length !== expectedRefs.length) return null;
  const resolved: ReceiptResolution[] = [];
  for (let index = 0; index < parsed.resolutions.length; index += 1) {
    const value = parsed.resolutions[index];
    const expectedRef = expectedRefs[index];
    if (!expectedRef
      || !captureExact(value, INTEGRATION_RESOLUTION_KEYS)
      || !captureRef(value.ref)
      || !integrationRefEqual(value.ref, expectedRef)
      || !captureIdentity(value.subjectIdentity)
      || !captureTimestamp(value.committedAt)
      || (value.privacy !== 'PUBLIC_METADATA' && value.privacy !== 'ENCRYPTED_PRIVATE_CONTAINER')
      || typeof value.canonicalBytesBase64 !== 'string') return null;
    const receiptBytes = integrationStrictBase64(value.canonicalBytesBase64);
    if (!receiptBytes) return null;
    const receiptIdentity = await contentIdentity(receiptBytes);
    if (!captureSameIdentity(receiptIdentity, expectedRef.content_identity)) return null;
    const payload = parseAuthorityJson(receiptBytes);
    if (!canonicalBytesEqual(canonicalDocument(payload), receiptBytes)
      || !canonicalBytesEqual(canonicalDocument(value.payload as CanonicalJsonValue), receiptBytes)
      || !integrationPayload(payload, expectedRef, value.subjectIdentity)
      || !captureSameIdentity(value.subjectIdentity, settledCandidate.record.subject_identity.content_identity)) return null;
    const resolution = value as unknown as IntegrationReceiptResolutionV1;
    if (!await integrationProof(resolution.integrityProof, resolution, payload)) return null;
    resolved.push(Object.freeze({
      status: 'RESOLVED' as const,
      ref: freezeRef(expectedRef),
      subjectIdentity: freezeIdentity(value.subjectIdentity),
      committedAt: value.committedAt,
      privacy: value.privacy,
      integrityProof: captureDeepFreeze(resolution.integrityProof),
      canonicalBytes: new Uint8Array(receiptBytes),
      payload: captureDeepFreeze(payload as ResolvedReceiptPayloadV1),
    }));
  }
  if (await integrationHasPrivateCanary(parsed)) return null;
  return Object.freeze({
    carrierBytes: new Uint8Array(bytes),
    carrierIdentity: captureIdentityCopy(actualCarrierIdentity),
    candidateBytes: new Uint8Array(settledCandidate.canonical_bytes),
    candidateIdentity: captureIdentityCopy(settledCandidate.record_identity),
    candidateRefs: Object.freeze(expectedRefs.map((ref) => freezeRef(ref))),
    resolutions: Object.freeze(resolved),
  });
}

/**
 * Resolves a supplied receipt carrier without a database, ambient map, or
 * in-process authority token. Returned receipt objects are convenience data.
 */
export async function verifyIntegrationReceiptResolutionCarrier(
  root: EvidenceSpineRootV1,
  candidate: DetachedRecordCandidate,
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
): Promise<readonly ReceiptResolution[] | null> {
  try {
    if (!root
      || typeof root !== 'object'
      || !(carrierBytes instanceof Uint8Array)
      || carrierBytes.byteLength === 0
      || !captureIdentity(carrierIdentity)) return null;
    const rootSnapshot = structuredClone(root) as EvidenceSpineRootV1;
    const candidateSnapshot = integrationCandidateSnapshot(candidate);
    if (!candidateSnapshot) return null;
    const bytes = new Uint8Array(carrierBytes);
    const expectedCarrierIdentity = captureIdentityCopy(carrierIdentity);
    const projection = await integrationReceiptCarrierProjection(
      rootSnapshot,
      candidateSnapshot,
      bytes,
      expectedCarrierIdentity,
    );
    return projection?.resolutions ?? null;
  } catch {
    return null;
  }
}

export async function readCommittedReceipt(
  db: D1Database,
  ownerKey: string,
  ref: SourceReceiptRefV1,
): Promise<ReceiptResolution> {
  if (!db || typeof ownerKey !== 'string' || ownerKey.length === 0 || !exactRef(ref)) {
    return unresolved('CONTENT_MISMATCH');
  }
  try {
    switch (ref.receipt_kind) {
      case 'SOURCE_MANIFEST':
        return await readSourceManifest(db, ownerKey, ref);
      case 'LEARNING_SESSION_CONTEXT':
        return await readTrainingContext(db, ownerKey, ref);
      case 'AI_INVOCATION_ATTEMPT':
        return await readAttempt(db, ownerKey, ref);
      case 'ACCESSIBILITY':
      case 'BROWSER_ACTION_LOG':
      case 'BUILD':
      case 'CONTROL_PLANE':
      case 'DEPLOYMENT':
      case 'GRADE_OUTPUT':
      case 'REVIEW':
        return unresolved('PRIVATE_CONTAINER_REQUIRED');
      default:
        return unresolved('MISSING');
    }
  } catch {
    return ref.receipt_kind === 'SOURCE_MANIFEST'
      || ref.receipt_kind === 'LEARNING_SESSION_CONTEXT'
      || ref.receipt_kind === 'AI_INVOCATION_ATTEMPT'
      ? unresolved('MUTABLE')
      : unresolved('MISSING');
  }
}

function reasonForUnresolved(value: Extract<ReceiptResolution, { status: 'UNRESOLVED' }>): NonPassingObservation {
  switch (value.reason) {
    case 'CONTENT_MISMATCH':
      return nonPassing('UNKNOWN', 'CONTENT_MISMATCH');
    case 'MUTABLE':
      return nonPassing('UNGRADABLE', 'MUTABLE_SOURCE');
    case 'OWNER_MISMATCH':
    case 'SCOPE_MISMATCH':
      return nonPassing('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED');
    case 'PRIVATE_CONTAINER_REQUIRED':
      return nonPassing('UNGRADABLE', 'AUTHORITY_MISSING');
    case 'MISSING':
    case 'STALE':
      return nonPassing('UNKNOWN', 'MISSING_SOURCE');
  }
}

export function deriveRuntimeProvenance(
  root: EvidenceSpineRootV1,
  receipts: readonly ReceiptResolution[],
): DerivedRuntimeProvenanceV1 | NonPassingObservation {
  if (!root || root.schema_version !== 'MES-1' || !Array.isArray(receipts)) {
    return nonPassing('UNGRADABLE', 'AUTHORITY_MISSING');
  }
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object') return nonPassing('UNGRADABLE', 'AUTHORITY_MISSING');
    if (receipt.status === 'UNRESOLVED') return reasonForUnresolved(receipt);
    const settledBytes = verifiedResolutionBytes.get(receipt);
    if (
      !verifiedResolutionBrand.has(receipt)
      || !settledBytes
      || !equalBytes(receipt.canonicalBytes, settledBytes)
    ) return nonPassing('UNGRADABLE', 'AUTHORITY_MISSING');
  }
  const resolvedReceipts = receipts as readonly Extract<ReceiptResolution, { status: 'RESOLVED' }>[];
  const refKeys = resolvedReceipts.map((value) => `${value.ref.receipt_kind}\0${value.ref.receipt_id}`);
  if (new Set(refKeys).size !== refKeys.length) {
    return nonPassing('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED', resolvedReceipts.map((value) => value.ref));
  }
  const first = resolvedReceipts[0];
  if (first && resolvedReceipts.some((value) => !sameSubject(first.payload, value.payload))) {
    return nonPassing('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED', resolvedReceipts.map((value) => value.ref));
  }
  const byKind = new Set(resolvedReceipts.map((value) => value.ref.receipt_kind));
  if (
    !byKind.has('SOURCE_MANIFEST')
    || !byKind.has('LEARNING_SESSION_CONTEXT')
    || !byKind.has('AI_INVOCATION_ATTEMPT')
  ) return nonPassing('UNKNOWN', 'MISSING_SOURCE', resolvedReceipts.map((value) => value.ref));

  // The approved plan does not yet provide a committed external target resolver,
  // nor a synchronous way to bind this root object to its canonical root identity.
  // Returning a promotable provenance object here would fabricate authority.
  return nonPassing('UNGRADABLE', 'AUTHORITY_MISSING', resolvedReceipts.map((value) => value.ref));
}
