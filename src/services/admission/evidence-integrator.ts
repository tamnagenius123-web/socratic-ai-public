import {
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from './canonical-json';
import {
  deriveManifestAppend,
  verifyManifestPrefixCarrier,
  type DetachedRecordCandidate,
  type IndependentRecordReviewV1,
} from './evidence-spine-manifest';
import {
  verifyIntegrationReceiptResolutionCarrier,
} from './product-receipts';
import {
  canonicalBytesEqual,
  validateEvidenceRecord,
} from './evidence-spine-validation';
import { contentIdentity, type ContentIdentity } from './identity';
import type {
  EvidenceRecordV1,
  EvidenceSpineRootV1,
  IntegrateReviewedCandidateInput,
  IntegrationAdmissionPolicyV1,
  ReviewedManifestAppendProposalV1,
} from './evidence-spine-types';

const POLICY_KEYS = Object.freeze([
  'schemaVersion',
  'rootIdentity',
  'policyId',
  'nonBuilderRule',
  'crossVendorRule',
  'sourceReceiptRule',
] as const);

const INPUT_KEYS = Object.freeze([
  'candidateBytes',
  'reviewBytes',
  'expectedRootIdentity',
  'expectedHeadIdentity',
  'independencePolicyBytes',
  'independencePolicyIdentity',
  'receiptResolutionCarrierBytes',
  'receiptResolutionCarrierIdentity',
  'integratorAttribution',
  'prefixCarrierBytes',
  'prefixCarrierIdentity',
] as const);

const REVIEW_KEYS = Object.freeze([
  'schema_version',
  'root_identity',
  'candidate_identity',
  'builder_identity',
  'builder_vendor_family',
  'reviewer_identity',
  'reviewer_vendor_family',
  'separation',
  'verdict',
  'reason_codes',
] as const);

type ObjectValue = Record<string, unknown>;

type Attribute = Readonly<{
  actorIdentity: string;
  sessionIdentity: string;
}>;

type ReviewFacts = Readonly<{
  review: IndependentRecordReviewV1['review'];
  identity: ContentIdentity;
}>;

type PreparedInput = Readonly<{
  root: EvidenceSpineRootV1;
  candidateBytes: Uint8Array;
  reviewBytes: Uint8Array;
  expectedRootIdentity: ContentIdentity;
  expectedHeadIdentity: ContentIdentity;
  independencePolicyBytes: Uint8Array;
  independencePolicyIdentity: ContentIdentity;
  receiptResolutionCarrierBytes: Uint8Array;
  receiptResolutionCarrierIdentity: ContentIdentity;
  prefixCarrierBytes: Uint8Array;
  prefixCarrierIdentity: ContentIdentity;
  attribution: Attribute;
}>;

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function printable(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && /^[\x20-\x7e]+$/.test(value)
    && value.trim() === value
    && value.normalize('NFC') === value
    && value !== 'UNKNOWN';
}

function exactObject(value: unknown, keys: readonly string[]): value is ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const objectValue = value as object;
  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(objectValue);
  if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length !== keys.length) return false;
  const expected = [...keys].sort();
  const actual = (ownKeys as string[]).sort();
  if (!actual.every((key, index) => key === expected[index])) return false;
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function exactInputObject(value: unknown): value is ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const objectValue = value as object;
  const prototype = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(objectValue);
  if (ownKeys.some((key) => typeof key !== 'string') || ownKeys.length !== INPUT_KEYS.length) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...INPUT_KEYS].sort();
  if (!actual.every((key, index) => key === expected[index])) return false;
  return actual.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    return Boolean(descriptor
      && descriptor.enumerable
      && (('value' in descriptor) || (typeof descriptor.get === 'function' && descriptor.set === undefined)));
  });
}

function identityCopy(value: unknown): ContentIdentity | null {
  if (!exactObject(value, ['byte_length', 'sha256'])
    || typeof value.byte_length !== 'number'
    || !Number.isSafeInteger(value.byte_length)
    || value.byte_length < 0
    || !Number.isInteger(value.byte_length)
    || typeof value.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  return Object.freeze({ byte_length: value.byte_length, sha256: value.sha256 });
}

function copyBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array && value.byteLength > 0 ? new Uint8Array(value) : null;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  // Typed-array elements cannot be frozen by this runtime. Public byte fields
  // are detached copies and are revalidated from bytes by every authority seam.
  if (value instanceof Uint8Array) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function invalid(): never {
  throw new Error('MES_INTEGRATION_INPUT_INVALID');
}

function snapshotAttribution(value: unknown): Attribute | null {
  if (!exactObject(value, ['actorIdentity', 'sessionIdentity'])
    || !printable(value.actorIdentity)
    || !printable(value.sessionIdentity)) return null;
  return Object.freeze({
    actorIdentity: value.actorIdentity,
    sessionIdentity: value.sessionIdentity,
  });
}

function snapshotInput(root: EvidenceSpineRootV1, input: IntegrateReviewedCandidateInput): PreparedInput {
  if (!exactInputObject(input)) invalid();
  let rootSnapshot: EvidenceSpineRootV1;
  try {
    rootSnapshot = structuredClone(root);
  } catch {
    return invalid();
  }
  const candidateBytes = copyBytes(input.candidateBytes);
  const reviewBytes = copyBytes(input.reviewBytes);
  const expectedRootIdentity = identityCopy(input.expectedRootIdentity);
  const expectedHeadIdentity = identityCopy(input.expectedHeadIdentity);
  const independencePolicyBytes = copyBytes(input.independencePolicyBytes);
  const independencePolicyIdentity = identityCopy(input.independencePolicyIdentity);
  const receiptResolutionCarrierBytes = copyBytes(input.receiptResolutionCarrierBytes);
  const receiptResolutionCarrierIdentity = identityCopy(input.receiptResolutionCarrierIdentity);
  const prefixCarrierBytes = copyBytes(input.prefixCarrierBytes);
  const prefixCarrierIdentity = identityCopy(input.prefixCarrierIdentity);
  const attribution = snapshotAttribution(input.integratorAttribution);
  if (!candidateBytes
    || !reviewBytes
    || !expectedRootIdentity
    || !expectedHeadIdentity
    || !independencePolicyBytes
    || !independencePolicyIdentity
    || !receiptResolutionCarrierBytes
    || !receiptResolutionCarrierIdentity
    || !prefixCarrierBytes
    || !prefixCarrierIdentity
    || !attribution) invalid();
  return Object.freeze({
    root: rootSnapshot,
    candidateBytes,
    reviewBytes,
    expectedRootIdentity,
    expectedHeadIdentity,
    independencePolicyBytes,
    independencePolicyIdentity,
    receiptResolutionCarrierBytes,
    receiptResolutionCarrierIdentity,
    prefixCarrierBytes,
    prefixCarrierIdentity,
    attribution,
  });
}

async function candidateFromBytes(bytes: Uint8Array): Promise<DetachedRecordCandidate | null> {
  try {
    const parsed = validateEvidenceRecord(parseAuthorityJson(bytes));
    if (!canonicalBytesEqual(canonicalDocument(parsed as unknown as CanonicalJsonValue), bytes)) return null;
    const recordIdentity = await contentIdentity(bytes);
    return Object.freeze({
      record: freezeDeep(parsed),
      canonical_bytes: new Uint8Array(bytes),
      record_identity: recordIdentity,
    });
  } catch {
    return null;
  }
}

async function reviewFromBytes(
  bytes: Uint8Array,
  candidate: DetachedRecordCandidate,
  rootIdentity: ContentIdentity,
): Promise<ReviewFacts | null> {
  try {
    const parsed = parseAuthorityJson(bytes);
    if (!canonicalBytesEqual(canonicalDocument(parsed), bytes)
      || !exactObject(parsed, REVIEW_KEYS)) return null;
    const root = identityCopy(parsed.root_identity);
    const candidateIdentity = identityCopy(parsed.candidate_identity);
    if (!root
      || !candidateIdentity
      || !sameIdentity(root, rootIdentity)
      || !sameIdentity(candidateIdentity, candidate.record_identity)
      || !printable(parsed.builder_identity)
      || !printable(parsed.builder_vendor_family)
      || !printable(parsed.reviewer_identity)
      || !printable(parsed.reviewer_vendor_family)
      || parsed.reviewer_identity === parsed.builder_identity
      || parsed.builder_identity !== candidate.record.producer_identity.producer_id
      || parsed.builder_vendor_family !== candidate.record.producer_identity.vendor_family
      || parsed.separation !== 'VERIFIED'
      || !['ADMIT', 'REJECT', 'UNKNOWN'].includes(String(parsed.verdict))
      || !Array.isArray(parsed.reason_codes)
      || !parsed.reason_codes.every((value) => printable(value))
      || (parsed.verdict === 'ADMIT' && parsed.reason_codes.length !== 0)
      || (parsed.verdict !== 'ADMIT' && parsed.reason_codes.length === 0)) return null;
    for (let index = 1; index < parsed.reason_codes.length; index += 1) {
      if (parsed.reason_codes[index - 1] >= parsed.reason_codes[index]) return null;
    }
    return Object.freeze({
      review: freezeDeep(parsed as unknown as IndependentRecordReviewV1['review']),
      identity: await contentIdentity(bytes),
    });
  } catch {
    return null;
  }
}

function requirementIds(record: EvidenceRecordV1): readonly string[] | null {
  if (record.record_family === 'ARTIFACT') {
    const bindings = record.payload.bindings;
    const linked = [
      ...record.payload.evidence_requirement_ids,
      ...bindings.failure_tell_observations.flatMap((item) => item.requirement_ids),
      ...bindings.claim_assertions.flatMap((item) => item.conditional_requirement_ids),
    ];
    return Object.freeze(linked);
  }
  if (record.record_family === 'NEGATIVE_CONTROL_RESULT') {
    return Object.freeze(record.payload.requirement_links.flatMap((item) => item.evidence_requirement_ids));
  }
  return Object.freeze([]);
}

function requirementsMatch(
  root: EvidenceSpineRootV1,
  record: EvidenceRecordV1,
): boolean {
  if (!Array.isArray(root.requirements)) return false;
  const linked = requirementIds(record);
  if (!linked) return false;
  const rows = new Map(root.requirements.map((item) => [item.id, item]));
  if (rows.size !== root.requirements.length || linked.some((id) => !rows.has(id))) return false;
  if (record.record_family === 'ARTIFACT') {
    for (const id of record.payload.evidence_requirement_ids) {
      const row = rows.get(id);
      if (!row || row.slice_id !== record.payload.slice_id || row.gate !== record.payload.gate) return false;
    }
    for (const observation of record.payload.bindings.failure_tell_observations) {
      for (const id of observation.requirement_ids) {
        const row = rows.get(id);
        if (!row || !observation.slice_ids.includes(row.slice_id) || !observation.gate_ids.includes(row.gate)) return false;
      }
    }
    for (const assertion of record.payload.bindings.claim_assertions) {
      const claim = root.conditional_claims.find((item) => item.claim_id === assertion.claim_id);
      if (!claim) return false;
      for (const id of assertion.conditional_requirement_ids) {
        const row = rows.get(id);
        if (!row || claim.requirement_id !== id || claim.slice_id !== row.slice_id || claim.gate !== row.gate) return false;
      }
    }
  }
  if (record.record_family === 'NEGATIVE_CONTROL_RESULT') {
    const definitions = root.negative_controls.filter(
      (definition) => definition.id === record.payload.control_id,
    );
    if (definitions.length !== 1) return false;
    const definition = definitions[0]!;
    if (!canonicalBytesEqual(
      canonicalDocument(definition.applicable_slice_ids as unknown as CanonicalJsonValue),
      canonicalDocument(record.payload.slice_ids as unknown as CanonicalJsonValue),
    ) || !canonicalBytesEqual(
      canonicalDocument(definition.requirement_links as unknown as CanonicalJsonValue),
      canonicalDocument(record.payload.requirement_links as unknown as CanonicalJsonValue),
    )) return false;
  }
  return true;
}

function requiresDifferentVendor(root: EvidenceSpineRootV1, record: EvidenceRecordV1): boolean {
  const linked = requirementIds(record);
  if (!linked) return true;
  const rows = new Map(root.requirements.map((item) => [item.id, item]));
  return linked.some((id) => rows.get(id)?.independence === 'NON_BUILDER_CROSS_VENDOR');
}

/** Verifies the five-field, root-bound policy from its exact canonical bytes. */
export async function verifyIntegrationAdmissionPolicy(
  root: EvidenceSpineRootV1,
  policyBytes: Uint8Array,
  policyIdentity: ContentIdentity,
): Promise<IntegrationAdmissionPolicyV1 | null> {
  try {
    if (!root || typeof root !== 'object' || !(policyBytes instanceof Uint8Array) || policyBytes.byteLength === 0) return null;
    const expectedIdentity = identityCopy(policyIdentity);
    if (!expectedIdentity) return null;
    const bytes = new Uint8Array(policyBytes);
    const rootIdentity = await contentIdentity(canonicalDocument(root as unknown as CanonicalJsonValue));
    const parsed = parseAuthorityJson(bytes);
    if (!canonicalBytesEqual(canonicalDocument(parsed), bytes)
      || !exactObject(parsed, POLICY_KEYS)
      || parsed.schemaVersion !== 'MES-INTEGRATION-ADMISSION-POLICY-1'
      || parsed.policyId !== 'ROOT_REQUIREMENT_INDEPENDENCE_V1'
      || parsed.nonBuilderRule !== 'REVIEWER_IDENTITY_DISTINCT_AND_SEPARATION_VERIFIED'
      || parsed.crossVendorRule !== 'ANY_LINKED_CROSS_VENDOR_REQUIREMENT_REQUIRES_DISTINCT_VENDOR_FAMILY'
      || parsed.sourceReceiptRule !== 'EXACT_RESOLVED_CARRIER_REQUIRED') return null;
    const policyRoot = identityCopy(parsed.rootIdentity);
    const actualIdentity = await contentIdentity(bytes);
    if (!policyRoot
      || !sameIdentity(actualIdentity, expectedIdentity)
      || !sameIdentity(policyRoot, rootIdentity)) return null;
    return freezeDeep(parsed as unknown as IntegrationAdmissionPolicyV1);
  } catch {
    return null;
  }
}

/**
 * Reconstructs one proposed manifest entry from reverified bytes only. It
 * never writes a manifest and returns no admitted authority.
 */
export async function prepareReviewedManifestAppend(
  root: EvidenceSpineRootV1,
  input: IntegrateReviewedCandidateInput,
): Promise<ReviewedManifestAppendProposalV1> {
  try {
    const prepared = snapshotInput(root, input);
    const rootIdentity = await contentIdentity(canonicalDocument(prepared.root as unknown as CanonicalJsonValue));
    if (!sameIdentity(rootIdentity, prepared.expectedRootIdentity)) invalid();
    const candidate = await candidateFromBytes(prepared.candidateBytes);
    if (!candidate || !sameIdentity(candidate.record.root_identity, rootIdentity)) invalid();
    const review = await reviewFromBytes(prepared.reviewBytes, candidate, rootIdentity);
    if (!review) invalid();
    const prefix = await verifyManifestPrefixCarrier(
      prepared.expectedRootIdentity,
      prepared.expectedHeadIdentity,
      prepared.prefixCarrierBytes,
      prepared.prefixCarrierIdentity,
    );
    if (!prefix) invalid();
    const policy = await verifyIntegrationAdmissionPolicy(
      prepared.root,
      prepared.independencePolicyBytes,
      prepared.independencePolicyIdentity,
    );
    if (!policy || !requirementsMatch(prepared.root, candidate.record)) invalid();
    if (review.review.separation !== 'VERIFIED'
      || review.review.reviewer_identity === candidate.record.producer_identity.producer_id
      || (requiresDifferentVendor(prepared.root, candidate.record)
        && review.review.reviewer_vendor_family === candidate.record.producer_identity.vendor_family)) invalid();
    const receipts = await verifyIntegrationReceiptResolutionCarrier(
      prepared.root,
      candidate,
      prepared.receiptResolutionCarrierBytes,
      prepared.receiptResolutionCarrierIdentity,
    );
    if (!receipts) invalid();
    const append = await deriveManifestAppend({
      prefix: prefix.prefix,
      expectedHead: prepared.expectedHeadIdentity,
      candidate,
      review: Object.freeze({
        review: review.review,
        canonical_bytes: new Uint8Array(prepared.reviewBytes),
        review_identity: review.identity,
        correction_authority: null,
        correction_reviews: [],
      }),
    });
    if (append.proposedEntry === null
      || append.proposedPrefix.status !== 'VERIFIED'
      || append.proposedPrefix.entries.length !== prefix.prefix.entries.length + 1
      || append.proposedPrefix.head_identity === null
      || sameIdentity(append.proposedPrefix.head_identity, prepared.expectedHeadIdentity)) invalid();
    const proposedEntryBytes = canonicalDocument(append.proposedEntry as unknown as CanonicalJsonValue);
    const proposedHeadIdentity = await contentIdentity(proposedEntryBytes);
    if (!sameIdentity(proposedHeadIdentity, append.proposedPrefix.head_identity)) invalid();
    return freezeDeep({
      status: 'PROPOSED_NOT_ADMITTED' as const,
      rootIdentity,
      expectedHeadIdentity: prepared.expectedHeadIdentity,
      candidateIdentity: candidate.record_identity,
      reviewIdentity: review.identity,
      prefixCarrierIdentity: prepared.prefixCarrierIdentity,
      independencePolicyIdentity: prepared.independencePolicyIdentity,
      receiptResolutionCarrierIdentity: prepared.receiptResolutionCarrierIdentity,
      proposedEntryBytes: new Uint8Array(proposedEntryBytes),
      proposedHeadIdentity,
      integratorAttribution: prepared.attribution,
    });
  } catch {
    return invalid();
  }
}
