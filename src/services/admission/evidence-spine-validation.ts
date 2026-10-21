import { AuthorityJsonError, canonicalDocument, type CanonicalJsonValue } from './canonical-json';
import type { ContentIdentity } from './identity';
import {
  RECORD_FAMILIES,
  type ArtifactKind,
  type EvidenceRecordFamily,
  type EvidenceRecordV1,
  type SourceReceiptRefV1,
  type SourceReceiptKind,
} from './evidence-spine-types';

type DataObject = Record<string, unknown>;

const encoder = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const receiptKinds = new Set([
  'SOURCE_MANIFEST', 'LEARNING_SESSION_CONTEXT', 'AI_INVOCATION_ATTEMPT',
  'GROWTH_CONSENT', 'GROWTH_CYCLE', 'GROWTH_EVENT', 'MUTATION_RECEIPT',
  'RECHECK', 'DELETION', 'BUILD', 'DEPLOYMENT', 'CONTROL_PLANE',
  'BROWSER_ACTION_LOG', 'ACCESSIBILITY', 'REVIEW', 'GRADE_OUTPUT',
]);

function fail(code: string): never {
  throw new AuthorityJsonError(code);
}

function byteCompare(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function assertPlainDataObject(value: unknown, code: string): DataObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  const objectValue = value as object;
  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(objectValue).length !== 0) fail(code);
  for (const key of Object.getOwnPropertyNames(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value as DataObject;
}

function assertExactObject(value: unknown, keys: readonly string[], code: string): DataObject {
  const objectValue = assertPlainDataObject(value, code);
  const names = Object.getOwnPropertyNames(objectValue);
  if (names.length !== keys.length) fail(code);
  const expected = new Set(keys);
  for (const key of names) {
    if (!expected.has(key)) fail(code);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(objectValue, key)) fail(code);
  }
  return objectValue;
}

function field(objectValue: DataObject, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  return descriptor.value;
}

function assertDataArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    if (name === 'length') continue;
    if (!/^(0|[1-9]\d*)$/.test(name)) fail(code);
    const index = Number(name);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0xffffffff || String(index) !== name) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail(code);
  }
  return value;
}

function deepFrozenSnapshot(value: unknown, seen = new WeakMap<object, object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object') fail('MES_SNAPSHOT_INVALID');
  const objectValue = value as object;
  const prior = seen.get(objectValue);
  if (prior) return prior;

  const copy: object = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(objectValue));
  seen.set(objectValue, copy);
  let arrayLength: PropertyDescriptor | undefined;
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor) fail('MES_SNAPSHOT_INVALID');
    if (Array.isArray(value) && key === 'length') {
      arrayLength = descriptor;
      continue;
    }
    const copiedDescriptor = 'value' in descriptor
      ? { ...descriptor, value: deepFrozenSnapshot(descriptor.value, seen) }
      : descriptor;
    Object.defineProperty(copy, key, copiedDescriptor);
  }
  if (arrayLength) Object.defineProperty(copy, 'length', arrayLength);
  return Object.freeze(copy);
}

function assertCanonicalText(value: unknown, code: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(code);
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      fail(code);
    }
    if (current < 0x20 || (current >= 0x7f && current <= 0x9f)) fail(code);
  }
  if (value.normalize('NFC') !== value) fail(code);
  return value;
}

function assertPrintableAscii(value: unknown, code: string, nonEmpty = true): string {
  const text = assertCanonicalText(value, code, nonEmpty);
  for (let index = 0; index < text.length; index += 1) {
    const current = text.charCodeAt(index);
    if (current < 0x20 || current > 0x7e) fail(code);
  }
  return text;
}

function assertLiteral(value: unknown, allowed: readonly string[], code: string): string {
  const text = assertPrintableAscii(value, code);
  if (!allowed.includes(text)) fail(code);
  return text;
}

function assertTimestamp(value: unknown, code: string): string {
  const text = assertPrintableAscii(value, code);
  if (!timestampPattern.test(text) || new Date(text).toISOString() !== text) fail(code);
  return text;
}

function assertSafeNonnegativeInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    fail(code);
  }
  return value;
}

export function assertContentIdentity(value: unknown, code = 'MES_IDENTITY_INVALID'): ContentIdentity {
  const objectValue = assertExactObject(value, ['byte_length', 'sha256'], code);
  const byteLength = assertSafeNonnegativeInteger(field(objectValue, 'byte_length', code), code);
  const sha256 = field(objectValue, 'sha256', code);
  if (typeof sha256 !== 'string' || !hashPattern.test(sha256)) fail(code);
  return { byte_length: byteLength, sha256 };
}

function identityKey(identity: ContentIdentity): string {
  return `${identity.sha256}\u0000${identity.byte_length}`;
}

function assertIdentityArray(value: unknown, code: string, mode: 'ordered' | 'set', nonEmpty = false): readonly ContentIdentity[] {
  const values = assertDataArray(value, code);
  if (nonEmpty && values.length === 0) fail(code);
  const identities = values.map((item) => assertContentIdentity(item, code));
  const keys = identities.map(identityKey);
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index] === keys[index - 1] || (mode === 'set' && byteCompare(keys[index - 1], keys[index]) >= 0)) fail(code);
  }
  if (mode === 'ordered' && new Set(keys).size !== keys.length) fail(code);
  return identities;
}

function assertStringArray(value: unknown, code: string, mode: 'ordered' | 'set', nonEmpty = false, ascii = true): readonly string[] {
  const values = assertDataArray(value, code);
  if (nonEmpty && values.length === 0) fail(code);
  const strings = values.map((item) => (
    ascii ? assertPrintableAscii(item, code) : assertCanonicalText(item, code)
  ));
  for (let index = 1; index < strings.length; index += 1) {
    if (strings[index] === strings[index - 1] || (mode === 'set' && byteCompare(strings[index - 1], strings[index]) >= 0)) {
      fail(code);
    }
  }
  if (mode === 'ordered' && new Set(strings).size !== strings.length) fail(code);
  return strings;
}

function assertSubjectIdentity(value: unknown, code: string): void {
  const objectValue = assertExactObject(value, ['subject_type', 'subject_key', 'content_identity'], code);
  assertPrintableAscii(field(objectValue, 'subject_type', code), code);
  assertCanonicalText(field(objectValue, 'subject_key', code), code);
  assertContentIdentity(field(objectValue, 'content_identity', code), code);
}

function assertScope(value: unknown, code: string): void {
  const objectValue = assertExactObject(value, [
    'purpose_identity', 'subject_identity', 'time_identity', 'environment_identity', 'exclusion_identities',
  ], code);
  assertContentIdentity(field(objectValue, 'purpose_identity', code), code);
  assertContentIdentity(field(objectValue, 'subject_identity', code), code);
  assertContentIdentity(field(objectValue, 'time_identity', code), code);
  assertContentIdentity(field(objectValue, 'environment_identity', code), code);
  assertIdentityArray(field(objectValue, 'exclusion_identities', code), code, 'set');
}

function assertSourceReceipts(value: unknown, code: string): readonly SourceReceiptRefV1[] {
  const values = assertDataArray(value, code);
  const receipts = values.map((item) => {
    const objectValue = assertExactObject(item, ['receipt_kind', 'receipt_id', 'content_identity'], code);
    const receiptKind = assertLiteral(field(objectValue, 'receipt_kind', code), [...receiptKinds], code);
    const receiptId = assertPrintableAscii(field(objectValue, 'receipt_id', code), code);
    const contentIdentity = assertContentIdentity(field(objectValue, 'content_identity', code), code);
    return { receipt_kind: receiptKind as SourceReceiptKind, receipt_id: receiptId, content_identity: contentIdentity };
  });
  let previous: string | null = null;
  for (const receipt of receipts) {
    const key = `${receipt.receipt_kind}\u0000${receipt.receipt_id}`;
    if (previous !== null && byteCompare(previous, key) >= 0) fail(code);
    previous = key;
  }
  return receipts;
}

function sameReceipts(left: readonly SourceReceiptRefV1[], right: readonly SourceReceiptRefV1[]): boolean {
  return left.length === right.length && left.every((receipt, index) => {
    const other = right[index];
    return other !== undefined
      && receipt.receipt_kind === other.receipt_kind
      && receipt.receipt_id === other.receipt_id
      && receipt.content_identity.byte_length === other.content_identity.byte_length
      && receipt.content_identity.sha256 === other.content_identity.sha256;
  });
}

function assertProducerIdentity(value: unknown, code: string): void {
  const objectValue = assertExactObject(value, ['producer_id', 'role', 'vendor_family', 'attestation'], code);
  assertPrintableAscii(field(objectValue, 'producer_id', code), code);
  assertPrintableAscii(field(objectValue, 'role', code), code);
  assertPrintableAscii(field(objectValue, 'vendor_family', code), code);
  assertPrintableAscii(field(objectValue, 'attestation', code), code);
}

function assertIndependentReview(value: unknown, producerId: string, code: string): void {
  const objectValue = assertExactObject(value, [
    'builder_identity', 'reviewer_identity', 'separation', 'review_output_identity', 'verdict', 'vendor_family',
  ], code);
  const builderIdentity = assertPrintableAscii(field(objectValue, 'builder_identity', code), code);
  const reviewerIdentity = assertPrintableAscii(field(objectValue, 'reviewer_identity', code), code);
  if (builderIdentity !== producerId || reviewerIdentity === builderIdentity || reviewerIdentity === producerId) fail(code);
  assertLiteral(field(objectValue, 'separation', code), ['VERIFIED', 'UNKNOWN'], code);
  assertContentIdentity(field(objectValue, 'review_output_identity', code), code);
  assertLiteral(field(objectValue, 'verdict', code), ['ADMIT', 'REJECT', 'UNKNOWN'], code);
  assertPrintableAscii(field(objectValue, 'vendor_family', code), code);
}

type KindValidation = Readonly<{
  codeBound: boolean;
  invocationReceiptIds: readonly string[];
}>;

function assertKindDetails(value: unknown, kind: ArtifactKind, code: string): KindValidation {
  switch (kind) {
    case 'STATIC': {
      const details = assertExactObject(value, ['kind', 'source_subject_ids', 'source_snapshot_identity', 'code_bound'], code);
      assertLiteral(field(details, 'kind', code), ['STATIC'], code);
      assertStringArray(field(details, 'source_subject_ids', code), code, 'set', true);
      assertContentIdentity(field(details, 'source_snapshot_identity', code), code);
      const codeBound = field(details, 'code_bound', code);
      if (typeof codeBound !== 'boolean') fail(code);
      return { codeBound, invocationReceiptIds: [] };
    }
    case 'RUNTIME': {
      const details = assertExactObject(value, ['kind', 'invocation_receipt_ids', 'action_log_artifact_id', 'started_at', 'completed_at'], code);
      assertLiteral(field(details, 'kind', code), ['RUNTIME'], code);
      const invocationReceiptIds = assertStringArray(field(details, 'invocation_receipt_ids', code), code, 'set', true);
      assertPrintableAscii(field(details, 'action_log_artifact_id', code), code);
      const startedAt = assertTimestamp(field(details, 'started_at', code), code);
      const completedAt = assertTimestamp(field(details, 'completed_at', code), code);
      if (Date.parse(startedAt) > Date.parse(completedAt)) fail(code);
      return { codeBound: false, invocationReceiptIds };
    }
    case 'DEPLOYMENT': {
      const details = assertExactObject(value, ['kind', 'control_plane_artifact_id', 'production_probe_artifact_ids', 'route_ids'], code);
      assertLiteral(field(details, 'kind', code), ['DEPLOYMENT'], code);
      assertPrintableAscii(field(details, 'control_plane_artifact_id', code), code);
      assertStringArray(field(details, 'production_probe_artifact_ids', code), code, 'set', true);
      assertStringArray(field(details, 'route_ids', code), code, 'set', true);
      return { codeBound: false, invocationReceiptIds: [] };
    }
    case 'AUTHENTICATED_E2E': {
      const details = assertExactObject(value, ['kind', 'journey_id', 'step_ids', 'action_log_artifact_id', 'capture_artifact_ids', 'korean_comprehension_artifact_id', 'isolation_result_ids'], code);
      assertLiteral(field(details, 'kind', code), ['AUTHENTICATED_E2E'], code);
      assertPrintableAscii(field(details, 'journey_id', code), code);
      assertStringArray(field(details, 'step_ids', code), code, 'ordered', true);
      assertPrintableAscii(field(details, 'action_log_artifact_id', code), code);
      assertStringArray(field(details, 'capture_artifact_ids', code), code, 'set', true);
      assertPrintableAscii(field(details, 'korean_comprehension_artifact_id', code), code);
      assertStringArray(field(details, 'isolation_result_ids', code), code, 'set', true);
      return { codeBound: false, invocationReceiptIds: [] };
    }
    case 'LONGITUDINAL': {
      const details = assertExactObject(value, ['kind', 'protocol_id', 'baseline_artifact_id', 'followup_artifact_ids', 'scheduled_at', 'observed_at', 'horizon_seconds', 'changed_context', 'outcome_status'], code);
      assertLiteral(field(details, 'kind', code), ['LONGITUDINAL'], code);
      assertPrintableAscii(field(details, 'protocol_id', code), code);
      assertPrintableAscii(field(details, 'baseline_artifact_id', code), code);
      assertStringArray(field(details, 'followup_artifact_ids', code), code, 'ordered', true);
      const scheduledAt = assertTimestamp(field(details, 'scheduled_at', code), code);
      const observedAt = assertTimestamp(field(details, 'observed_at', code), code);
      if (Date.parse(scheduledAt) > Date.parse(observedAt)) fail(code);
      assertSafeNonnegativeInteger(field(details, 'horizon_seconds', code), code);
      if (typeof field(details, 'changed_context', code) !== 'boolean') fail(code);
      assertLiteral(field(details, 'outcome_status', code), ['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'], code);
      return { codeBound: false, invocationReceiptIds: [] };
    }
    case 'ACCESSIBILITY': {
      const details = assertExactObject(value, ['kind', 'evaluation_id', 'route_ids', 'viewport_artifact_ids', 'input_mode_artifact_ids', 'assistive_technology_artifact_ids', 'korean_comprehension_artifact_ids', 'issue_ids'], code);
      assertLiteral(field(details, 'kind', code), ['ACCESSIBILITY'], code);
      assertPrintableAscii(field(details, 'evaluation_id', code), code);
      assertStringArray(field(details, 'route_ids', code), code, 'set', true);
      assertStringArray(field(details, 'viewport_artifact_ids', code), code, 'set', true);
      assertStringArray(field(details, 'input_mode_artifact_ids', code), code, 'set', true);
      assertStringArray(field(details, 'assistive_technology_artifact_ids', code), code, 'set', true);
      assertStringArray(field(details, 'korean_comprehension_artifact_ids', code), code, 'set', true);
      assertStringArray(field(details, 'issue_ids', code), code, 'set');
      return { codeBound: false, invocationReceiptIds: [] };
    }
    case 'DELETION': {
      const details = assertExactObject(value, ['kind', 'deletion_receipt_id', 'declared_store_ids', 'before_manifest_artifact_id', 'after_manifest_artifact_id', 'residue_probe_ids', 'authorized_actor', 'completed_at'], code);
      assertLiteral(field(details, 'kind', code), ['DELETION'], code);
      assertPrintableAscii(field(details, 'deletion_receipt_id', code), code);
      assertStringArray(field(details, 'declared_store_ids', code), code, 'set', true);
      assertPrintableAscii(field(details, 'before_manifest_artifact_id', code), code);
      assertPrintableAscii(field(details, 'after_manifest_artifact_id', code), code);
      assertStringArray(field(details, 'residue_probe_ids', code), code, 'set', true);
      assertPrintableAscii(field(details, 'authorized_actor', code), code);
      assertTimestamp(field(details, 'completed_at', code), code);
      return { codeBound: false, invocationReceiptIds: [] };
    }
    case 'GRADE_INPUT': {
      const details = assertExactObject(value, ['kind', 'presentation_packet_id', 'randomized_mapping_commitment', 'presented_artifact_ids', 'same_state_material'], code);
      assertLiteral(field(details, 'kind', code), ['GRADE_INPUT'], code);
      assertPrintableAscii(field(details, 'presentation_packet_id', code), code);
      const commitment = field(details, 'randomized_mapping_commitment', code);
      if (typeof commitment !== 'string' || !hashPattern.test(commitment)) fail(code);
      assertStringArray(field(details, 'presented_artifact_ids', code), code, 'ordered', true);
      if (field(details, 'same_state_material', code) !== true) fail(code);
      return { codeBound: false, invocationReceiptIds: [] };
    }
  }
}

function assertNullableIdentity(value: unknown, required: boolean, code: string): void {
  if (required) {
    assertContentIdentity(value, code);
  } else if (value !== null) {
    fail(code);
  }
}

function assertFailureTellObservation(value: unknown, code: string): string {
  const observation = assertExactObject(value, [
    'failure_tell_id', 'slice_ids', 'gate_ids', 'requirement_ids', 'subject_identity', 'observed', 'artifact_ids', 'scope', 'review_output_identities',
  ], code);
  const failureTellId = assertPrintableAscii(field(observation, 'failure_tell_id', code), code);
  assertStringArray(field(observation, 'slice_ids', code), code, 'set', true);
  assertStringArray(field(observation, 'gate_ids', code), code, 'set', true);
  assertStringArray(field(observation, 'requirement_ids', code), code, 'set', true);
  assertSubjectIdentity(field(observation, 'subject_identity', code), code);
  if (field(observation, 'observed', code) !== true) fail(code);
  assertStringArray(field(observation, 'artifact_ids', code), code, 'set', true);
  assertScope(field(observation, 'scope', code), code);
  assertIdentityArray(field(observation, 'review_output_identities', code), code, 'set', true);
  return failureTellId;
}

function assertClaimAssertion(value: unknown, code: string): string {
  const assertion = assertExactObject(value, [
    'claim_id', 'conditional_requirement_ids', 'subject_identity', 'assertion_state', 'artifact_ids', 'review_output_identities',
  ], code);
  const claimId = assertPrintableAscii(field(assertion, 'claim_id', code), code);
  assertStringArray(field(assertion, 'conditional_requirement_ids', code), code, 'set', true);
  assertSubjectIdentity(field(assertion, 'subject_identity', code), code);
  const state = assertLiteral(field(assertion, 'assertion_state', code), ['ASSERTED', 'NOT_ASSERTED', 'UNKNOWN'], code);
  const artifacts = assertStringArray(field(assertion, 'artifact_ids', code), code, 'set');
  if ((state === 'ASSERTED' && artifacts.length === 0) || (state !== 'ASSERTED' && artifacts.length !== 0)) fail(code);
  assertIdentityArray(field(assertion, 'review_output_identities', code), code, 'set', true);
  return claimId;
}

function assertArtifactPayload(value: unknown, receipts: readonly SourceReceiptRefV1[], code: string): void {
  const payload = assertExactObject(value, [
    'id', 'slice_id', 'evidence_requirement_ids', 'gate', 'kind', 'path_or_url', 'sha256', 'captured_at', 'evidence_label', 'outcome', 'status', 'scope', 'limitations', 'bindings',
  ], code);
  assertPrintableAscii(field(payload, 'id', code), code);
  assertPrintableAscii(field(payload, 'slice_id', code), code);
  assertStringArray(field(payload, 'evidence_requirement_ids', code), code, 'set', true);
  assertLiteral(field(payload, 'gate', code), ['D', 'S', 'R', 'P', 'A', 'L', 'V0'], code);
  const kind = assertLiteral(field(payload, 'kind', code), [
    'STATIC', 'RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT',
  ], code) as ArtifactKind;
  const locator = assertPrintableAscii(field(payload, 'path_or_url', code), code);
  if (!/^(?:repo|encrypted):\/\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%-]*)+$/.test(locator)) fail(code);
  const sha256 = field(payload, 'sha256', code);
  if (typeof sha256 !== 'string' || !hashPattern.test(sha256)) fail(code);
  assertTimestamp(field(payload, 'captured_at', code), code);
  const evidenceLabel = assertLiteral(field(payload, 'evidence_label', code), ['CODE_VERIFIED', 'DOCS_VERIFIED', 'LIVE_VERIFIED', 'UNKNOWN'], code);
  const outcome = assertLiteral(field(payload, 'outcome', code), [
    'CLAIM_SUPPORTED', 'CLAIM_CONTRADICTED', 'EXPECTED_RESULT_OBSERVED', 'EXPECTED_RESULT_NOT_OBSERVED', 'NO_RESULT', 'UNKNOWN', 'UNGRADABLE',
  ], code);
  const status = assertLiteral(field(payload, 'status', code), ['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'], code);
  if (!new Set([
    'PASS:CLAIM_SUPPORTED', 'PASS:EXPECTED_RESULT_OBSERVED', 'FAIL:CLAIM_CONTRADICTED',
    'FAIL:EXPECTED_RESULT_NOT_OBSERVED', 'PENDING:NO_RESULT', 'UNKNOWN:UNKNOWN', 'UNGRADABLE:UNGRADABLE',
  ]).has(`${status}:${outcome}`)) fail(code);
  if (evidenceLabel === 'UNKNOWN' && !['PENDING', 'UNKNOWN', 'UNGRADABLE'].includes(status)) fail(code);
  assertScope(field(payload, 'scope', code), code);
  const limitations = assertStringArray(field(payload, 'limitations', code), code, 'ordered', false, false);
  if (status !== 'PASS' && limitations.length === 0) fail(code);

  const bindings = assertExactObject(field(payload, 'bindings', code), [
    'source_receipts', 'build_identity', 'deployment_identity', 'account_scope_identity', 'capture_environment_identity', 'retention_policy_identity', 'access_policy_identity', 'negative_control_result_ids', 'failure_tell_observations', 'claim_assertions', 'kind_details',
  ], code);
  const bindingReceipts = assertSourceReceipts(field(bindings, 'source_receipts', code), code);
  if (!sameReceipts(receipts, bindingReceipts)) fail(code);
  if (kind !== 'STATIC' && receipts.length === 0) fail(code);
  const kindValidation = assertKindDetails(field(bindings, 'kind_details', code), kind, code);
  if (kind === 'RUNTIME') {
    for (const receiptId of kindValidation.invocationReceiptIds) {
      if (!receipts.some((receipt) => receipt.receipt_kind === 'AI_INVOCATION_ATTEMPT' && receipt.receipt_id === receiptId)) fail(code);
    }
  }
  assertNullableIdentity(field(bindings, 'build_identity', code), kindValidation.codeBound || ['RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'GRADE_INPUT'].includes(kind), code);
  assertNullableIdentity(field(bindings, 'deployment_identity', code), ['DEPLOYMENT', 'AUTHENTICATED_E2E', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT'].includes(kind), code);
  assertNullableIdentity(field(bindings, 'account_scope_identity', code), ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'DELETION'].includes(kind), code);
  assertNullableIdentity(field(bindings, 'capture_environment_identity', code), ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'GRADE_INPUT'].includes(kind), code);
  const privateArtifact = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION'].includes(kind);
  const requiresPrivatePolicies = privateArtifact || !locator.startsWith('repo://');
  assertNullableIdentity(field(bindings, 'retention_policy_identity', code), requiresPrivatePolicies, code);
  assertNullableIdentity(field(bindings, 'access_policy_identity', code), requiresPrivatePolicies, code);
  assertStringArray(field(bindings, 'negative_control_result_ids', code), code, 'set');
  let previousFailureTell: string | null = null;
  for (const observation of assertDataArray(field(bindings, 'failure_tell_observations', code), code)) {
    const failureTellId = assertFailureTellObservation(observation, code);
    if (previousFailureTell !== null && byteCompare(previousFailureTell, failureTellId) >= 0) fail(code);
    previousFailureTell = failureTellId;
  }
  let previousClaim: string | null = null;
  for (const assertion of assertDataArray(field(bindings, 'claim_assertions', code), code)) {
    const claimId = assertClaimAssertion(assertion, code);
    if (previousClaim !== null && byteCompare(previousClaim, claimId) >= 0) fail(code);
    previousClaim = claimId;
  }
}

function assertNegativeControlPayload(value: unknown, code: string): void {
  const payload = assertExactObject(value, [
    'control_id', 'slice_ids', 'requirement_links', 'subject_identity', 'expected_outcome', 'observed_outcome', 'before_state_identity', 'after_state_identity', 'action_log_identity', 'network_evidence', 'artifact_ids', 'scope', 'status',
  ], code);
  assertPrintableAscii(field(payload, 'control_id', code), code);
  assertStringArray(field(payload, 'slice_ids', code), code, 'set', true);
  const requirementLinks = assertDataArray(field(payload, 'requirement_links', code), code);
  if (requirementLinks.length === 0) fail(code);
  const requirementLinkKeys = new Set<string>();
  let previousRequirementLink: string | null = null;
  for (const link of requirementLinks) {
    const linkValue = assertExactObject(link, ['slice_id', 'gate', 'evidence_requirement_ids'], code);
    const sliceId = assertPrintableAscii(field(linkValue, 'slice_id', code), code);
    const gate = assertLiteral(field(linkValue, 'gate', code), ['D', 'S', 'R', 'P', 'A', 'L', 'V0'], code);
    const requirementIds = assertStringArray(field(linkValue, 'evidence_requirement_ids', code), code, 'set', true);
    const linkKey = `${sliceId}\u0000${gate}\u0000${requirementIds.join('\u0000')}`;
    if (requirementLinkKeys.has(linkKey) || (previousRequirementLink !== null && byteCompare(previousRequirementLink, linkKey) >= 0)) fail(code);
    requirementLinkKeys.add(linkKey);
    previousRequirementLink = linkKey;
  }
  assertSubjectIdentity(field(payload, 'subject_identity', code), code);
  const expected = assertPrintableAscii(field(payload, 'expected_outcome', code), code);
  const observed = field(payload, 'observed_outcome', code);
  if (observed !== null) assertPrintableAscii(observed, code);
  assertContentIdentity(field(payload, 'before_state_identity', code), code);
  assertContentIdentity(field(payload, 'after_state_identity', code), code);
  assertContentIdentity(field(payload, 'action_log_identity', code), code);
  const network = assertExactObject(field(payload, 'network_evidence', code), ['kind', 'content_identity', 'reason'], code);
  const networkKind = assertLiteral(field(network, 'kind', code), ['LOG', 'NOT_APPLICABLE'], code);
  if (networkKind === 'LOG') {
    assertContentIdentity(field(network, 'content_identity', code), code);
    if (field(network, 'reason', code) !== null) fail(code);
  } else {
    if (field(network, 'content_identity', code) !== null) fail(code);
    assertLiteral(field(network, 'reason', code), ['LOCAL_STATIC_ONLY', 'NO_NETWORK_SURFACE'], code);
  }
  assertStringArray(field(payload, 'artifact_ids', code), code, 'set', true);
  assertScope(field(payload, 'scope', code), code);
  const status = assertLiteral(field(payload, 'status', code), ['PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'], code);
  if ((status === 'PASS' && observed !== expected) || (status === 'FAIL' && (observed === null || observed === expected)) || (status === 'UNKNOWN' && observed !== null)) fail(code);
}

function assertGradePayload(value: unknown, code: string): void {
  const payload = assertExactObject(value, [
    'id', 'slice_ids', 'frozen_rubric_sha256', 'matrix_sha256', 'artifact_ids', 'builder_vendor_family', 'grader_vendor_family', 'grader_is_non_builder', 'builder_report_used', 'branding_treatment', 'same_state_material', 'mapping_commitment', 'prompt_sha256', 'verdict', 'reasons', 'unassessable_dimensions', 'timestamp', 'output_sha256',
  ], code);
  assertPrintableAscii(field(payload, 'id', code), code);
  assertStringArray(field(payload, 'slice_ids', code), code, 'set', true);
  for (const key of ['frozen_rubric_sha256', 'matrix_sha256', 'mapping_commitment', 'prompt_sha256', 'output_sha256']) {
    const hash = field(payload, key, code);
    if (typeof hash !== 'string' || !hashPattern.test(hash)) fail(code);
  }
  assertStringArray(field(payload, 'artifact_ids', code), code, 'ordered', true);
  assertPrintableAscii(field(payload, 'builder_vendor_family', code), code);
  assertPrintableAscii(field(payload, 'grader_vendor_family', code), code);
  if (field(payload, 'grader_is_non_builder', code) !== true || field(payload, 'builder_report_used', code) !== false) fail(code);
  assertLiteral(field(payload, 'branding_treatment', code), ['STRIPPED', 'UNAVOIDABLE_DISCLOSED'], code);
  if (field(payload, 'same_state_material', code) !== true) fail(code);
  const verdict = assertLiteral(field(payload, 'verdict', code), ['SAME GRADE', 'A CLEARLY BETTER', 'B CLEARLY BETTER', 'UNGRADABLE'], code);
  assertStringArray(field(payload, 'reasons', code), code, 'ordered', true, false);
  const unassessableDimensions = assertStringArray(field(payload, 'unassessable_dimensions', code), code, 'set');
  if (verdict === 'SAME GRADE' && unassessableDimensions.length !== 0) fail(code);
  assertTimestamp(field(payload, 'timestamp', code), code);
}

function assertCorrectionPayload(value: unknown, code: string): void {
  const payload = assertExactObject(value, [
    'target_record_id', 'target_record_identity', 'defect_code', 'reason', 'replacement_record_ids', 'approval_identity', 'review_output_identities', 'effective_manifest_head_identity',
  ], code);
  const targetId = field(payload, 'target_record_id', code);
  if (typeof targetId !== 'string' || !hashPattern.test(targetId)) fail(code);
  assertContentIdentity(field(payload, 'target_record_identity', code), code);
  assertPrintableAscii(field(payload, 'defect_code', code), code);
  assertCanonicalText(field(payload, 'reason', code), code);
  assertStringArray(field(payload, 'replacement_record_ids', code), code, 'set', true);
  assertContentIdentity(field(payload, 'approval_identity', code), code);
  assertIdentityArray(field(payload, 'review_output_identities', code), code, 'set', true);
  assertContentIdentity(field(payload, 'effective_manifest_head_identity', code), code);
}

export function validateEvidenceRecord(value: unknown): EvidenceRecordV1 {
  // Capture descriptor data before validation so a proxy cannot make the
  // post-validation snapshot diverge from the graph that was checked.
  const snapshot = deepFrozenSnapshot(value);
  const preliminary = assertPlainDataObject(snapshot, 'MES_RECORD_OBJECT_INVALID');
  const familyValue = Object.getOwnPropertyDescriptor(preliminary, 'record_family');
  if (!familyValue || !('value' in familyValue) || typeof familyValue.value !== 'string' || !RECORD_FAMILIES.includes(familyValue.value as EvidenceRecordFamily)) {
    fail('MES_RECORD_FAMILY_REJECTED');
  }
  const record = assertExactObject(snapshot, [
    'schema_version', 'record_family', 'record_id', 'root_identity', 'evidence_key', 'subject_identity', 'created_at', 'producer_identity', 'source_receipts', 'limitations', 'independent_review', 'payload',
  ], 'MES_RECORD_SHAPE_INVALID');
  assertLiteral(field(record, 'schema_version', 'MES_RECORD_SHAPE_INVALID'), ['MES-1'], 'MES_RECORD_SHAPE_INVALID');
  const family = assertLiteral(field(record, 'record_family', 'MES_RECORD_SHAPE_INVALID'), RECORD_FAMILIES, 'MES_RECORD_FAMILY_REJECTED') as EvidenceRecordFamily;
  const recordId = field(record, 'record_id', 'MES_RECORD_SHAPE_INVALID');
  if (typeof recordId !== 'string' || !hashPattern.test(recordId)) fail('MES_RECORD_SHAPE_INVALID');
  assertContentIdentity(field(record, 'root_identity', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  assertPrintableAscii(field(record, 'evidence_key', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  assertSubjectIdentity(field(record, 'subject_identity', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  assertTimestamp(field(record, 'created_at', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  const producer = assertExactObject(field(record, 'producer_identity', 'MES_RECORD_SHAPE_INVALID'), ['producer_id', 'role', 'vendor_family', 'attestation'], 'MES_RECORD_SHAPE_INVALID');
  const producerId = assertPrintableAscii(field(producer, 'producer_id', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  assertProducerIdentity(producer, 'MES_RECORD_SHAPE_INVALID');
  const receipts = assertSourceReceipts(field(record, 'source_receipts', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID');
  assertStringArray(field(record, 'limitations', 'MES_RECORD_SHAPE_INVALID'), 'MES_RECORD_SHAPE_INVALID', 'ordered', false, false);
  assertIndependentReview(field(record, 'independent_review', 'MES_RECORD_SHAPE_INVALID'), producerId, 'MES_RECORD_SHAPE_INVALID');
  const payload = field(record, 'payload', 'MES_RECORD_SHAPE_INVALID');
  switch (family) {
    case 'ARTIFACT':
      assertArtifactPayload(payload, receipts, 'MES_ARTIFACT_INVALID');
      break;
    case 'NEGATIVE_CONTROL_RESULT':
      assertNegativeControlPayload(payload, 'MES_NEGATIVE_CONTROL_INVALID');
      break;
    case 'GRADE':
      assertGradePayload(payload, 'MES_GRADE_INVALID');
      break;
    case 'CORRECTION':
      assertCorrectionPayload(payload, 'MES_CORRECTION_INVALID');
      break;
    default:
      fail('MES_RECORD_FAMILY_REJECTED');
  }
  return snapshot as EvidenceRecordV1;
}

export function canonicalBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function canonicalBytes(value: CanonicalJsonValue): Uint8Array {
  return canonicalDocument(value);
}
