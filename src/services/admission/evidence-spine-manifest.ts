import {
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from './canonical-json';
import {
  canonicalAuthorityContentIdentity,
  contentIdentity,
  recordSha256,
  type ContentIdentity,
} from './identity';
import {
  assertContentIdentity,
  canonicalBytesEqual,
  validateEvidenceRecord,
} from './evidence-spine-validation';
import type {
  CorrectionAuthorityBodyV1,
  CorrectionEvidenceRecordV1,
  CorrectionSupportingReviewBodyV1,
  DetachedRecordCandidate,
  DetachedCorrectionAuthorityV1,
  DetachedCorrectionSupportingReviewV1,
  EvidenceManifestEntryV1,
  EvidenceRecordV1,
  IndependentRecordReviewBodyV1,
  IndependentRecordReviewV1,
  ManifestPrefixCarrierV1,
  ManifestDispositionV1,
  ManifestPrefixReplayPacketV1,
  ExactCanonicalBlobV1,
  VerifiedManifestPrefixCarrierV1,
  VerifiedManifestPrefix,
} from './evidence-spine-types';

const ENTRY_KEYS = Object.freeze([
  'schema_version',
  'root_identity',
  'ordinal',
  'predecessor_identity',
  'candidate_identity',
  'review_identity',
  'reviewer_identity',
  'reviewer_vendor_family',
  'builder_identity',
  'builder_vendor_family',
  'independence_verified',
  'disposition',
  'reason_codes',
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

const REVIEW_CARRIER_KEYS = Object.freeze([
  'review',
  'canonical_bytes',
  'review_identity',
  'correction_authority',
  'correction_reviews',
] as const);

const CORRECTION_AUTHORITY_KEYS = Object.freeze([
  'schema_version',
  'root_identity',
  'target_record_id',
  'target_record_identity',
  'defect_code',
  'replacement_record_ids',
  'effective_manifest_head_identity',
  'approver_identity',
  'approver_vendor_family',
  'decision',
] as const);

const CORRECTION_REVIEW_KEYS = Object.freeze([
  'schema_version',
  'root_identity',
  'target_record_id',
  'target_record_identity',
  'defect_code',
  'replacement_record_ids',
  'approval_identity',
  'effective_manifest_head_identity',
  'builder_identity',
  'reviewer_identity',
  'reviewer_vendor_family',
  'separation',
  'verdict',
  'reason_codes',
] as const);

function asCanonical(value: unknown): CanonicalJsonValue {
  return value as CanonicalJsonValue;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function identityEqual(left: ContentIdentity | null, right: ContentIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  if (!validIdentity(left) || !validIdentity(right)) return false;
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function identityArrayEqual(left: readonly ContentIdentity[], right: readonly ContentIdentity[]): boolean {
  return left.length === right.length && left.every((identity, index) => identityEqual(identity, right[index]));
}

function stringArrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validIdentity(value: unknown): value is ContentIdentity {
  try {
    assertContentIdentity(value);
    return true;
  } catch {
    return false;
  }
}

function ascii(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && /^[\x20-\x7e]+$/.test(value);
}

function validReasonCodes(value: unknown, allowEmpty: boolean): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  let previous: string | null = null;
  for (const reason of value) {
    if (!ascii(reason)) return false;
    if (previous !== null && previous >= reason) return false;
    previous = reason;
  }
  return true;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  // Typed-array elements cannot be frozen by this runtime. Callers receive
  // private copies; their byte authority is always re-established by reparse.
  if (value instanceof Uint8Array) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

function entryIdentityBytes(entry: EvidenceManifestEntryV1): Uint8Array {
  return canonicalDocument(asCanonical(entry));
}

function validEntryShape(entry: unknown): entry is EvidenceManifestEntryV1 {
  if (!hasExactKeys(entry, ENTRY_KEYS)) return false;
  if (entry.schema_version !== 'MES-1'
    || !validIdentity(entry.root_identity)
    || !Number.isSafeInteger(entry.ordinal)
    || (entry.ordinal as number) < 0
    || !['ADMITTED', 'REJECTED', 'UNKNOWN'].includes(String(entry.disposition))) return false;
  for (const key of ['predecessor_identity', 'candidate_identity', 'review_identity'] as const) {
    if (entry[key] !== null && !validIdentity(entry[key])) return false;
  }
  if (typeof entry.independence_verified !== 'boolean') return false;
  const disposition = entry.disposition as ManifestDispositionV1;
  if (!validReasonCodes(entry.reason_codes, disposition === 'ADMITTED')) return false;
  if (entry.ordinal === 0) {
    return entry.predecessor_identity === null
      && entry.candidate_identity === null
      && entry.review_identity === null
      && entry.reviewer_identity === null
      && entry.reviewer_vendor_family === null
      && entry.builder_identity === null
      && entry.builder_vendor_family === null
      && entry.independence_verified === false
      && disposition === 'ADMITTED'
      && (entry.reason_codes as readonly unknown[]).length === 0;
  }
  return entry.predecessor_identity !== null
    && entry.candidate_identity !== null
    && entry.review_identity !== null
    && ascii(entry.reviewer_identity)
    && entry.reviewer_identity !== 'UNKNOWN'
    && ascii(entry.reviewer_vendor_family)
    && entry.reviewer_vendor_family !== 'UNKNOWN'
    && ascii(entry.builder_identity)
    && entry.builder_identity !== 'UNKNOWN'
    && ascii(entry.builder_vendor_family)
    && entry.builder_vendor_family !== 'UNKNOWN'
    && entry.reviewer_identity !== entry.builder_identity
    && entry.independence_verified === true
    && (disposition !== 'ADMITTED' || (entry.reason_codes as readonly unknown[]).length === 0)
    && (disposition === 'ADMITTED' || (entry.reason_codes as readonly unknown[]).length > 0);
}

function makePrefix(input: {
  status: 'VERIFIED' | 'UNKNOWN';
  rootIdentity: ContentIdentity;
  entries: readonly EvidenceManifestEntryV1[];
  entryIdentities: readonly ContentIdentity[];
  records?: Readonly<Record<string, EvidenceRecordV1>>;
  reviews?: Readonly<Record<string, IndependentRecordReviewBodyV1>>;
  correctionAuthorities?: Readonly<Record<string, CorrectionAuthorityBodyV1>>;
  correctionReviews?: Readonly<Record<string, CorrectionSupportingReviewBodyV1>>;
  conflicts?: readonly string[];
}): VerifiedManifestPrefix {
  return deepFreeze({
    schema_version: 'MES-MANIFEST-PREFIX-1' as const,
    status: input.status,
    root_identity: snapshot(input.rootIdentity),
    entries: snapshot(input.entries),
    entry_identities: snapshot(input.entryIdentities),
    head_identity: input.entryIdentities.length === 0
      ? null
      : snapshot(input.entryIdentities[input.entryIdentities.length - 1]),
    records_by_identity: snapshot(input.records ?? {}),
    reviews_by_identity: snapshot(input.reviews ?? {}),
    correction_authorities_by_identity: snapshot(input.correctionAuthorities ?? {}),
    correction_reviews_by_identity: snapshot(input.correctionReviews ?? {}),
    conflict_codes: [...new Set(input.conflicts ?? [])].sort(),
  });
}

function unknownAppend(prefix: VerifiedManifestPrefix) {
  return Object.freeze({
    disposition: 'UNKNOWN' as const,
    proposedPrefix: prefix,
    proposedEntry: null,
  });
}

export function createGenesisEntry(rootIdentity: ContentIdentity): EvidenceManifestEntryV1 {
  const root = snapshot(rootIdentity);
  assertContentIdentity(root);
  return deepFreeze({
    schema_version: 'MES-1' as const,
    root_identity: root,
    ordinal: 0,
    predecessor_identity: null,
    candidate_identity: null,
    review_identity: null,
    reviewer_identity: null,
    reviewer_vendor_family: null,
    builder_identity: null,
    builder_vendor_family: null,
    independence_verified: false,
    disposition: 'ADMITTED' as const,
    reason_codes: [] as const,
  });
}

export async function verifyManifestPrefix(
  rootIdentity: ContentIdentity,
  entries: readonly EvidenceManifestEntryV1[],
): Promise<VerifiedManifestPrefix> {
  const root = snapshot(rootIdentity);
  const entrySnapshot = snapshot(entries);
  assertContentIdentity(root);
  const identities: ContentIdentity[] = [];
  const conflicts: string[] = [];
  const successors = new Set<string>();

  if (!Array.isArray(entrySnapshot) || entrySnapshot.length === 0) {
    conflicts.push('MES_MANIFEST_MISSING_ENTRY');
  }

  for (let index = 0; index < entrySnapshot.length; index += 1) {
    const entry = entrySnapshot[index];
    if (!validEntryShape(entry)) {
      conflicts.push('MES_MANIFEST_ENTRY_INVALID');
      continue;
    }
    let identity: ContentIdentity;
    try {
      identity = await contentIdentity(entryIdentityBytes(entry));
    } catch {
      conflicts.push('MES_MANIFEST_ENTRY_INVALID');
      continue;
    }
    identities.push(identity);
    if (!identityEqual(entry.root_identity, root)) conflicts.push('MES_MANIFEST_ROOT_MISMATCH');
    if (entry.ordinal !== index) conflicts.push('MES_MANIFEST_ORDINAL_GAP');
    if (index === 0) {
      if (entry.ordinal !== 0 || entry.predecessor_identity !== null) {
        conflicts.push('MES_MANIFEST_GENESIS_INVALID');
      }
    } else {
      const predecessor = identities[index - 1];
      if (!predecessor || !identityEqual(entry.predecessor_identity, predecessor)) {
        conflicts.push('MES_MANIFEST_PREDECESSOR_MISMATCH');
      } else {
        const key = predecessor.sha256;
        if (successors.has(key)) conflicts.push('MES_MANIFEST_ALTERNATE_SUCCESSOR');
        successors.add(key);
      }
    }
  }

  if (entrySnapshot.length > 1) conflicts.push('MES_MANIFEST_RECORD_BYTES_UNAVAILABLE');
  return makePrefix({
    status: conflicts.length === 0 ? 'VERIFIED' : 'UNKNOWN',
    rootIdentity: root,
    entries: entrySnapshot,
    entryIdentities: identities,
    conflicts,
  });
}

async function evidenceKey(record: EvidenceRecordV1): Promise<string> {
  const common = {
    schema_version: 'MES-EVIDENCE-KEY-1',
    record_family: record.record_family,
    root_identity: record.root_identity,
  };
  switch (record.record_family) {
    case 'ARTIFACT':
      return recordSha256(asCanonical({
        ...common,
        artifact_kind: record.payload.kind,
        subject_identity: record.subject_identity,
        requirement_ids: record.payload.evidence_requirement_ids,
      }));
    case 'NEGATIVE_CONTROL_RESULT':
      return recordSha256(asCanonical({
        ...common,
        control_id: record.payload.control_id,
        subject_identity: record.subject_identity,
      }));
    case 'GRADE':
      return recordSha256(asCanonical({ ...common, grade_run_id: record.payload.id }));
    case 'CORRECTION':
      return recordSha256(asCanonical({ ...common, target_record_id: record.payload.target_record_id }));
  }
}

async function validPendingReview(record: EvidenceRecordV1): Promise<boolean> {
  const pendingIdentity = await contentIdentity(canonicalDocument(asCanonical({
    schema_version: 'MES-REVIEW-PENDING-1',
  })));
  const review = record.independent_review;
  return review.builder_identity === record.producer_identity.producer_id
    && review.reviewer_identity === 'UNKNOWN'
    && review.separation === 'UNKNOWN'
    && identityEqual(review.review_output_identity, pendingIdentity)
    && review.verdict === 'UNKNOWN'
    && review.vendor_family === 'UNKNOWN';
}

async function validateCandidate(input: DetachedRecordCandidate): Promise<{
  record: EvidenceRecordV1;
  identity: ContentIdentity;
  bytes: Uint8Array;
} | null> {
  try {
    const bytes = cloneBytes(input.canonical_bytes);
    const suppliedRecord = validateEvidenceRecord(input.record);
    const parsed = validateEvidenceRecord(parseAuthorityJson(bytes));
    const canonicalIdentity = await canonicalAuthorityContentIdentity(bytes);
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(suppliedRecord)), bytes)
      || !canonicalBytesEqual(canonicalDocument(asCanonical(parsed)), bytes)
      || !identityEqual(canonicalIdentity, input.record_identity)) return null;
    const { record_id: _recordId, ...body } = parsed;
    if (parsed.record_id !== await recordSha256(asCanonical(body))) return null;
    if (parsed.evidence_key !== await evidenceKey(parsed)) return null;
    if (!await validPendingReview(parsed)) return null;
    return { record: parsed, identity: canonicalIdentity, bytes };
  } catch {
    return null;
  }
}

async function validateReview(
  input: IndependentRecordReviewV1,
  candidate: { record: EvidenceRecordV1; identity: ContentIdentity },
  root: ContentIdentity,
): Promise<{ review: IndependentRecordReviewBodyV1; identity: ContentIdentity } | null> {
  try {
    if (!hasExactKeys(input, REVIEW_CARRIER_KEYS)
      || (input.correction_authority !== null && !isRecord(input.correction_authority))
      || !Array.isArray(input.correction_reviews)) return null;
    const bytes = cloneBytes(input.canonical_bytes);
    const supplied = snapshot(input.review);
    const parsed = parseAuthorityJson(bytes);
    if (!hasExactKeys(supplied, REVIEW_KEYS) || !hasExactKeys(parsed, REVIEW_KEYS)) return null;
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(supplied)), bytes)
      || !canonicalBytesEqual(canonicalDocument(parsed), bytes)) return null;
    const identity = await canonicalAuthorityContentIdentity(bytes);
    if (!identityEqual(identity, input.review_identity)) return null;
    const review = parsed as unknown as IndependentRecordReviewBodyV1;
    if (review.schema_version !== 'MES-REVIEW-1'
      || !validIdentity(review.root_identity)
      || !validIdentity(review.candidate_identity)
      || !identityEqual(review.root_identity, root)
      || !identityEqual(review.root_identity, candidate.record.root_identity)
      || !identityEqual(review.candidate_identity, candidate.identity)
      || !ascii(review.builder_identity)
      || review.builder_identity === 'UNKNOWN'
      || !ascii(review.reviewer_identity)
      || review.reviewer_identity === review.builder_identity
      || review.reviewer_identity === 'UNKNOWN'
      || !ascii(review.builder_vendor_family)
      || review.builder_vendor_family === 'UNKNOWN'
      || !ascii(review.reviewer_vendor_family)
      || review.reviewer_vendor_family === 'UNKNOWN'
      || review.separation !== 'VERIFIED'
      || !['ADMIT', 'REJECT', 'UNKNOWN'].includes(review.verdict)
      || review.builder_identity !== candidate.record.producer_identity.producer_id
      || review.builder_vendor_family !== candidate.record.producer_identity.vendor_family
      || !validReasonCodes(review.reason_codes, review.verdict === 'ADMIT')
      || (review.verdict === 'ADMIT' && review.reason_codes.length !== 0)
      || (review.verdict !== 'ADMIT' && review.reason_codes.length === 0)) return null;
    return { review: deepFreeze(review), identity };
  } catch {
    return null;
  }
}

type ResolvedCorrectionCarriers = Readonly<{
  authority: CorrectionAuthorityBodyV1;
  reviews: readonly CorrectionSupportingReviewBodyV1[];
}>;

async function validateCorrectionAuthority(
  input: DetachedCorrectionAuthorityV1,
  record: CorrectionEvidenceRecordV1,
  expectedHead: ContentIdentity,
): Promise<CorrectionAuthorityBodyV1 | null> {
  try {
    if (!hasExactKeys(input, ['authority', 'canonical_bytes', 'approval_identity'])) return null;
    const supplied = snapshot(input.authority);
    const bytes = cloneBytes(input.canonical_bytes);
    const parsed = parseAuthorityJson(bytes);
    if (!hasExactKeys(supplied, CORRECTION_AUTHORITY_KEYS)
      || !hasExactKeys(parsed, CORRECTION_AUTHORITY_KEYS)
      || !canonicalBytesEqual(canonicalDocument(asCanonical(supplied)), bytes)
      || !canonicalBytesEqual(canonicalDocument(parsed), bytes)) return null;
    const identity = await canonicalAuthorityContentIdentity(bytes);
    if (!identityEqual(identity, input.approval_identity)
      || !identityEqual(identity, record.payload.approval_identity)) return null;
    const authority = parsed as unknown as CorrectionAuthorityBodyV1;
    return authority.schema_version === 'MES-CORRECTION-AUTHORITY-1'
      && validIdentity(authority.root_identity)
      && identityEqual(authority.root_identity, record.root_identity)
      && authority.target_record_id === record.payload.target_record_id
      && validIdentity(authority.target_record_identity)
      && identityEqual(authority.target_record_identity, record.payload.target_record_identity)
      && authority.defect_code === record.payload.defect_code
      && Array.isArray(authority.replacement_record_ids)
      && stringArrayEqual(authority.replacement_record_ids, record.payload.replacement_record_ids)
      && validIdentity(authority.effective_manifest_head_identity)
      && identityEqual(authority.effective_manifest_head_identity, expectedHead)
      && identityEqual(authority.effective_manifest_head_identity, record.payload.effective_manifest_head_identity)
      && ascii(authority.approver_identity)
      && authority.approver_identity !== 'UNKNOWN'
      && ascii(authority.approver_vendor_family)
      && authority.approver_vendor_family !== 'UNKNOWN'
      && authority.decision === 'APPROVE'
      ? authority
      : null;
  } catch {
    return null;
  }
}

async function validateCorrectionSupportingReview(
  input: DetachedCorrectionSupportingReviewV1,
  record: CorrectionEvidenceRecordV1,
  authorityIdentity: ContentIdentity,
  expectedHead: ContentIdentity,
): Promise<CorrectionSupportingReviewBodyV1 | null> {
  try {
    if (!hasExactKeys(input, ['review', 'canonical_bytes', 'review_output_identity'])) return null;
    const supplied = snapshot(input.review);
    const bytes = cloneBytes(input.canonical_bytes);
    const parsed = parseAuthorityJson(bytes);
    if (!hasExactKeys(supplied, CORRECTION_REVIEW_KEYS)
      || !hasExactKeys(parsed, CORRECTION_REVIEW_KEYS)
      || !canonicalBytesEqual(canonicalDocument(asCanonical(supplied)), bytes)
      || !canonicalBytesEqual(canonicalDocument(parsed), bytes)) return null;
    const identity = await canonicalAuthorityContentIdentity(bytes);
    const review = parsed as unknown as CorrectionSupportingReviewBodyV1;
    return identityEqual(identity, input.review_output_identity)
      && review.schema_version === 'MES-CORRECTION-REVIEW-1'
      && validIdentity(review.root_identity)
      && identityEqual(review.root_identity, record.root_identity)
      && review.target_record_id === record.payload.target_record_id
      && validIdentity(review.target_record_identity)
      && identityEqual(review.target_record_identity, record.payload.target_record_identity)
      && review.defect_code === record.payload.defect_code
      && Array.isArray(review.replacement_record_ids)
      && stringArrayEqual(review.replacement_record_ids, record.payload.replacement_record_ids)
      && validIdentity(review.approval_identity)
      && identityEqual(review.approval_identity, authorityIdentity)
      && validIdentity(review.effective_manifest_head_identity)
      && identityEqual(review.effective_manifest_head_identity, expectedHead)
      && identityEqual(review.effective_manifest_head_identity, record.payload.effective_manifest_head_identity)
      && ascii(review.builder_identity)
      && review.builder_identity !== 'UNKNOWN'
      && review.builder_identity === record.producer_identity.producer_id
      && ascii(review.reviewer_identity)
      && review.reviewer_identity !== 'UNKNOWN'
      && review.reviewer_identity !== review.builder_identity
      && ascii(review.reviewer_vendor_family)
      && review.reviewer_vendor_family !== 'UNKNOWN'
      && review.separation === 'VERIFIED'
      && review.verdict === 'APPROVE'
      && validReasonCodes(review.reason_codes, true)
      && review.reason_codes.length === 0
      ? review
      : null;
  } catch {
    return null;
  }
}

async function validateCorrectionCarriers(
  input: IndependentRecordReviewV1,
  record: CorrectionEvidenceRecordV1,
  expectedHead: ContentIdentity,
): Promise<ResolvedCorrectionCarriers | null> {
  if (input.correction_authority === null
    || !Array.isArray(input.correction_reviews)
    || input.correction_reviews.length === 0
    || input.correction_reviews.length !== record.payload.review_output_identities.length) return null;
  const authority = await validateCorrectionAuthority(input.correction_authority, record, expectedHead);
  if (!authority) return null;
  const reviews: CorrectionSupportingReviewBodyV1[] = [];
  const identities: ContentIdentity[] = [];
  for (const carrier of input.correction_reviews) {
    const review = await validateCorrectionSupportingReview(
      carrier,
      record,
      record.payload.approval_identity,
      expectedHead,
    );
    if (!review) return null;
    reviews.push(review);
    identities.push(carrier.review_output_identity);
  }
  return identityArrayEqual(identities, record.payload.review_output_identities)
    ? deepFreeze({ authority, reviews })
    : null;
}

function entryForRecordId(prefix: VerifiedManifestPrefix, recordId: string) {
  const matches = Object.entries(prefix.records_by_identity)
    .filter(([, record]) => record.record_id === recordId);
  if (matches.length !== 1) return null;
  const [candidateSha, record] = matches[0];
  const entry = prefix.entries.find((item) => item.candidate_identity?.sha256 === candidateSha);
  return entry ? { candidateSha, record, entry } : null;
}

function admittedCorrections(prefix: VerifiedManifestPrefix): CorrectionEvidenceRecordV1[] {
  return prefix.entries.flatMap((entry) => {
    if (entry.disposition !== 'ADMITTED' || entry.candidate_identity === null) return [];
    const record = prefix.records_by_identity[entry.candidate_identity.sha256];
    return record?.record_family === 'CORRECTION' ? [record] : [];
  });
}

function activeRecord(prefix: VerifiedManifestPrefix, recordId: string): ReturnType<typeof entryForRecordId> {
  const found = entryForRecordId(prefix, recordId);
  if (!found || found.entry.disposition !== 'ADMITTED') return null;
  return admittedCorrections(prefix).some((record) => record.payload.target_record_id === recordId)
    ? null
    : found;
}

function correctionCycle(
  prefix: VerifiedManifestPrefix,
  targetRecordId: string,
  replacementRecordIds: readonly string[],
): boolean {
  const edges = new Map<string, readonly string[]>();
  for (const correction of admittedCorrections(prefix)) {
    edges.set(correction.payload.target_record_id, correction.payload.replacement_record_ids);
  }
  edges.set(targetRecordId, replacementRecordIds);
  const visit = (start: string, current: string, seen: Set<string>): boolean => {
    if (seen.has(current)) return current === start;
    seen.add(current);
    return (edges.get(current) ?? []).some((next) => next === start || visit(start, next, new Set(seen)));
  };
  return visit(targetRecordId, targetRecordId, new Set());
}

function validCorrection(
  prefix: VerifiedManifestPrefix,
  record: CorrectionEvidenceRecordV1,
  expectedHead: ContentIdentity,
): boolean {
  const payload = record.payload;
  const target = activeRecord(prefix, payload.target_record_id);
  if (!target
    || !identityEqual(target.entry.candidate_identity, payload.target_record_identity)
    || !identityEqual(payload.effective_manifest_head_identity, expectedHead)
    || admittedCorrections(prefix).some((item) => item.payload.target_record_id === payload.target_record_id)
    || correctionCycle(prefix, payload.target_record_id, payload.replacement_record_ids)) return false;
  for (const replacementId of payload.replacement_record_ids) {
    const replacement = activeRecord(prefix, replacementId);
    if (!replacement || !identityEqual(replacement.record.root_identity, record.root_identity)) return false;
  }
  return true;
}

function dispositionFor(verdict: IndependentRecordReviewBodyV1['verdict']): ManifestDispositionV1 {
  if (verdict === 'ADMIT') return 'ADMITTED';
  if (verdict === 'REJECT') return 'REJECTED';
  return 'UNKNOWN';
}

async function validateDerivedPrefix(prefix: VerifiedManifestPrefix): Promise<boolean> {
  try {
    if (!hasExactKeys(prefix, [
      'schema_version', 'status', 'root_identity', 'entries', 'entry_identities',
      'head_identity', 'records_by_identity', 'reviews_by_identity',
      'correction_authorities_by_identity', 'correction_reviews_by_identity', 'conflict_codes',
    ])
      || prefix.schema_version !== 'MES-MANIFEST-PREFIX-1'
      || prefix.status !== 'VERIFIED'
      || !validIdentity(prefix.root_identity)
      || !Array.isArray(prefix.entries)
      || prefix.entries.length === 0
      || !Array.isArray(prefix.entry_identities)
      || prefix.entry_identities.length !== prefix.entries.length
      || !isRecord(prefix.records_by_identity)
      || !isRecord(prefix.reviews_by_identity)
      || !isRecord(prefix.correction_authorities_by_identity)
      || !isRecord(prefix.correction_reviews_by_identity)
      || !Array.isArray(prefix.conflict_codes)
      || prefix.conflict_codes.length !== 0) return false;

    const candidateKeys = new Set<string>();
    const reviewKeys = new Set<string>();
    const correctionAuthorityKeys = new Set<string>();
    const correctionReviewKeys = new Set<string>();
    for (let index = 0; index < prefix.entries.length; index += 1) {
      const entry = prefix.entries[index];
      if (!validEntryShape(entry)
        || entry.ordinal !== index
        || !identityEqual(entry.root_identity, prefix.root_identity)) return false;
      const computedEntryIdentity = await contentIdentity(entryIdentityBytes(entry));
      if (!identityEqual(computedEntryIdentity, prefix.entry_identities[index])) return false;
      if (index === 0) {
        if (entry.predecessor_identity !== null) return false;
        continue;
      }
      if (!identityEqual(entry.predecessor_identity, prefix.entry_identities[index - 1])
        || entry.candidate_identity === null
        || entry.review_identity === null) return false;
      const candidateKey = entry.candidate_identity.sha256;
      const reviewKey = entry.review_identity.sha256;
      if (candidateKeys.has(candidateKey) || reviewKeys.has(reviewKey)) return false;
      candidateKeys.add(candidateKey);
      reviewKeys.add(reviewKey);
      const record = prefix.records_by_identity[candidateKey];
      const reviewBody = prefix.reviews_by_identity[reviewKey];
      if (!record || !reviewBody) return false;
      const candidateBytes = canonicalDocument(asCanonical(record));
      const candidate = await validateCandidate({
        record,
        canonical_bytes: candidateBytes,
        record_identity: entry.candidate_identity,
      });
      if (!candidate) return false;
      const reviewBytes = canonicalDocument(asCanonical(reviewBody));
      const correctionAuthorityBody = candidate.record.record_family === 'CORRECTION'
        ? prefix.correction_authorities_by_identity[candidate.record.payload.approval_identity.sha256]
        : null;
      const correctionReviewBodies = candidate.record.record_family === 'CORRECTION'
        ? candidate.record.payload.review_output_identities.map(
          (identity) => prefix.correction_reviews_by_identity[identity.sha256],
        )
        : [];
      if (candidate.record.record_family === 'CORRECTION'
        && (!correctionAuthorityBody || correctionReviewBodies.some((body) => !body))) return false;
      const reviewCarrier: IndependentRecordReviewV1 = {
        review: reviewBody,
        canonical_bytes: reviewBytes,
        review_identity: entry.review_identity,
        correction_authority: candidate.record.record_family === 'CORRECTION'
          ? {
            authority: correctionAuthorityBody!,
            canonical_bytes: canonicalDocument(asCanonical(correctionAuthorityBody!)),
            approval_identity: candidate.record.payload.approval_identity,
          }
          : null,
        correction_reviews: candidate.record.record_family === 'CORRECTION'
          ? candidate.record.payload.review_output_identities.map((identity, reviewIndex) => ({
            review: correctionReviewBodies[reviewIndex]!,
            canonical_bytes: canonicalDocument(asCanonical(correctionReviewBodies[reviewIndex]!)),
            review_output_identity: identity,
          }))
          : [],
      };
      const review = await validateReview(reviewCarrier, candidate, prefix.root_identity);
      if (!review
        || entry.reviewer_identity !== review.review.reviewer_identity
        || entry.reviewer_vendor_family !== review.review.reviewer_vendor_family
        || entry.builder_identity !== review.review.builder_identity
        || entry.builder_vendor_family !== review.review.builder_vendor_family
        || entry.disposition !== dispositionFor(review.review.verdict)
        || JSON.stringify(entry.reason_codes) !== JSON.stringify(review.review.reason_codes)) return false;
      if (candidate.record.record_family === 'CORRECTION') {
        const correction = await validateCorrectionCarriers(
          reviewCarrier,
          candidate.record,
          entry.predecessor_identity!,
        );
        const priorPrefix = makePrefix({
          status: 'VERIFIED',
          rootIdentity: prefix.root_identity,
          entries: prefix.entries.slice(0, index),
          entryIdentities: prefix.entry_identities.slice(0, index),
          records: prefix.records_by_identity,
          reviews: prefix.reviews_by_identity,
          correctionAuthorities: prefix.correction_authorities_by_identity,
          correctionReviews: prefix.correction_reviews_by_identity,
        });
        if (!correction || !validCorrection(priorPrefix, candidate.record, entry.predecessor_identity!)) {
          return false;
        }
        correctionAuthorityKeys.add(candidate.record.payload.approval_identity.sha256);
        for (const identity of candidate.record.payload.review_output_identities) {
          correctionReviewKeys.add(identity.sha256);
        }
      }
    }
    if (!identityEqual(prefix.head_identity, prefix.entry_identities[prefix.entry_identities.length - 1])) {
      return false;
    }
    return Object.keys(prefix.records_by_identity).length === candidateKeys.size
      && Object.keys(prefix.reviews_by_identity).length === reviewKeys.size
      && Object.keys(prefix.correction_authorities_by_identity).length === correctionAuthorityKeys.size
      && Object.keys(prefix.correction_reviews_by_identity).length === correctionReviewKeys.size
      && Object.keys(prefix.records_by_identity).every((key) => candidateKeys.has(key))
      && Object.keys(prefix.reviews_by_identity).every((key) => reviewKeys.has(key))
      && Object.keys(prefix.correction_authorities_by_identity).every(
        (key) => correctionAuthorityKeys.has(key),
      )
      && Object.keys(prefix.correction_reviews_by_identity).every((key) => correctionReviewKeys.has(key));
  } catch {
    return false;
  }
}

export async function deriveManifestAppend(input: Readonly<{
  prefix: VerifiedManifestPrefix;
  expectedHead: ContentIdentity;
  candidate: DetachedRecordCandidate;
  review: IndependentRecordReviewV1;
}>): Promise<Readonly<{
  disposition: ManifestDispositionV1;
  proposedPrefix: VerifiedManifestPrefix;
  proposedEntry: EvidenceManifestEntryV1 | null;
}>> {
  const originalPrefix = input.prefix;
  let prefix: VerifiedManifestPrefix;
  let expectedHead: ContentIdentity;
  let candidateInput: DetachedRecordCandidate;
  let reviewInput: IndependentRecordReviewV1;
  try {
    prefix = snapshot(input.prefix);
    expectedHead = snapshot(input.expectedHead);
    candidateInput = {
      record: snapshot(input.candidate.record),
      canonical_bytes: cloneBytes(input.candidate.canonical_bytes),
      record_identity: snapshot(input.candidate.record_identity),
    };
    reviewInput = snapshot(input.review);
  } catch {
    return unknownAppend(originalPrefix);
  }
  if (!await validateDerivedPrefix(prefix)
    || prefix.head_identity === null
    || !identityEqual(prefix.head_identity, expectedHead)) {
    return unknownAppend(originalPrefix);
  }

  const candidate = await validateCandidate(candidateInput);
  if (!candidate || !identityEqual(candidate.record.root_identity, prefix.root_identity)) {
    return unknownAppend(originalPrefix);
  }
  const review = await validateReview(reviewInput, candidate, prefix.root_identity);
  if (!review) return unknownAppend(originalPrefix);

  const sameIdEntries = Object.entries(prefix.records_by_identity)
    .filter(([, record]) => record.record_id === candidate.record.record_id);
  let correctionResolution: ResolvedCorrectionCarriers | null = null;
  if (candidate.record.record_family === 'CORRECTION') {
    const carrierHead = sameIdEntries.length === 1
      && sameIdEntries[0][0] === candidate.identity.sha256
      ? candidate.record.payload.effective_manifest_head_identity
      : expectedHead;
    correctionResolution = await validateCorrectionCarriers(
      reviewInput,
      candidate.record,
      carrierHead,
    );
    if (!correctionResolution) return unknownAppend(originalPrefix);
  } else if (reviewInput.correction_authority !== null || reviewInput.correction_reviews.length !== 0) {
    return unknownAppend(originalPrefix);
  }
  if (sameIdEntries.length > 0) {
    if (sameIdEntries.length !== 1 || sameIdEntries[0][0] !== candidate.identity.sha256) {
      return unknownAppend(originalPrefix);
    }
    const existingEntry = prefix.entries.find(
      (entry) => entry.candidate_identity?.sha256 === candidate.identity.sha256,
    );
    const existingReview = prefix.reviews_by_identity[review.identity.sha256];
    if (!existingEntry || !existingReview) return unknownAppend(originalPrefix);
    return Object.freeze({
      disposition: existingEntry.disposition,
      proposedPrefix: originalPrefix,
      proposedEntry: null,
    });
  }

  if (candidate.record.record_family === 'CORRECTION'
    && (!correctionResolution || !validCorrection(prefix, candidate.record, expectedHead))) {
    return unknownAppend(originalPrefix);
  }

  const disposition = dispositionFor(review.review.verdict);
  const entry = deepFreeze({
    schema_version: 'MES-1' as const,
    root_identity: snapshot(prefix.root_identity),
    ordinal: prefix.entries.length,
    predecessor_identity: snapshot(expectedHead),
    candidate_identity: snapshot(candidate.identity),
    review_identity: snapshot(review.identity),
    reviewer_identity: review.review.reviewer_identity,
    reviewer_vendor_family: review.review.reviewer_vendor_family,
    builder_identity: review.review.builder_identity,
    builder_vendor_family: review.review.builder_vendor_family,
    independence_verified: true,
    disposition,
    reason_codes: [...review.review.reason_codes],
  } satisfies EvidenceManifestEntryV1);
  const entryIdentity = await contentIdentity(entryIdentityBytes(entry));
  const records = { ...prefix.records_by_identity, [candidate.identity.sha256]: candidate.record };
  const reviews = { ...prefix.reviews_by_identity, [review.identity.sha256]: review.review };
  const correctionAuthorities = { ...prefix.correction_authorities_by_identity };
  const correctionReviews = { ...prefix.correction_reviews_by_identity };
  if (candidate.record.record_family === 'CORRECTION' && correctionResolution) {
    correctionAuthorities[candidate.record.payload.approval_identity.sha256] = correctionResolution.authority;
    candidate.record.payload.review_output_identities.forEach((identity, index) => {
      correctionReviews[identity.sha256] = correctionResolution!.reviews[index];
    });
  }
  const proposedPrefix = makePrefix({
    status: 'VERIFIED',
    rootIdentity: prefix.root_identity,
    entries: [...prefix.entries, entry],
    entryIdentities: [...prefix.entry_identities, entryIdentity],
    records,
    reviews,
    correctionAuthorities,
    correctionReviews,
  });
  return deepFreeze({ disposition, proposedPrefix, proposedEntry: entry });
}

type DecodedExactBlob = Readonly<{
  bytes: Uint8Array;
  identity: ContentIdentity;
}>;

type DecodedReplayPacket = Readonly<{
  entry: DecodedExactBlob;
  candidate: DecodedExactBlob | null;
  review: DecodedExactBlob | null;
  correctionAuthority: DecodedExactBlob | null;
  correctionReviews: readonly DecodedExactBlob[];
}>;

const PREFIX_CARRIER_KEYS = Object.freeze([
  'schemaVersion',
  'rootIdentity',
  'packets',
] as const);

const PREFIX_PACKET_KEYS = Object.freeze([
  'entry',
  'candidate',
  'review',
  'correctionAuthority',
  'correctionReviews',
] as const);

const PREFIX_BLOB_KEYS = Object.freeze([
  'bytesBase64',
  'contentIdentity',
] as const);

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function strictBase64Bytes(value: unknown): Uint8Array | null {
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
    return base64FromBytes(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function decodeExactBlob(value: unknown): Promise<DecodedExactBlob | null> {
  if (!hasExactKeys(value, PREFIX_BLOB_KEYS)
    || !validIdentity(value.contentIdentity)) return null;
  const bytes = strictBase64Bytes(value.bytesBase64);
  if (!bytes) return null;
  try {
    const parsed = parseAuthorityJson(bytes);
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(parsed)), bytes)) return null;
    const identity = await contentIdentity(bytes);
    if (!identityEqual(identity, value.contentIdentity)) return null;
    return Object.freeze({ bytes: cloneBytes(bytes), identity: snapshot(identity) });
  } catch {
    return null;
  }
}

async function decodeReplayPacket(value: unknown): Promise<DecodedReplayPacket | null> {
  if (!hasExactKeys(value, PREFIX_PACKET_KEYS)
    || !Array.isArray(value.correctionReviews)) return null;
  const entry = await decodeExactBlob(value.entry);
  const candidate = value.candidate === null ? null : await decodeExactBlob(value.candidate);
  const review = value.review === null ? null : await decodeExactBlob(value.review);
  const correctionAuthority = value.correctionAuthority === null
    ? null
    : await decodeExactBlob(value.correctionAuthority);
  const correctionReviews: DecodedExactBlob[] = [];
  for (const item of value.correctionReviews) {
    const decoded = await decodeExactBlob(item);
    if (!decoded) return null;
    correctionReviews.push(decoded);
  }
  if (!entry
    || (value.candidate !== null && !candidate)
    || (value.review !== null && !review)
    || (value.correctionAuthority !== null && !correctionAuthority)) return null;
  return Object.freeze({
    entry,
    candidate,
    review,
    correctionAuthority,
    correctionReviews: Object.freeze(correctionReviews),
  });
}

function blobEnvelopeKey(blob: DecodedExactBlob): string {
  return `${blob.identity.sha256}\u0000${blob.identity.byte_length}`;
}

function candidateFromBlob(blob: DecodedExactBlob): DetachedRecordCandidate | null {
  try {
    const record = validateEvidenceRecord(parseAuthorityJson(blob.bytes));
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(record)), blob.bytes)) return null;
    return Object.freeze({
      record,
      canonical_bytes: cloneBytes(blob.bytes),
      record_identity: snapshot(blob.identity),
    });
  } catch {
    return null;
  }
}

function reviewFromPacket(packet: DecodedReplayPacket): IndependentRecordReviewV1 | null {
  if (!packet.review) return null;
  try {
    const review = parseAuthorityJson(packet.review.bytes) as unknown as IndependentRecordReviewBodyV1;
    const correctionAuthority = packet.correctionAuthority === null
      ? null
      : {
        authority: parseAuthorityJson(packet.correctionAuthority.bytes) as unknown as CorrectionAuthorityBodyV1,
        canonical_bytes: cloneBytes(packet.correctionAuthority.bytes),
        approval_identity: snapshot(packet.correctionAuthority.identity),
      };
    const correctionReviews = packet.correctionReviews.map((item) => ({
      review: parseAuthorityJson(item.bytes) as unknown as CorrectionSupportingReviewBodyV1,
      canonical_bytes: cloneBytes(item.bytes),
      review_output_identity: snapshot(item.identity),
    }));
    return Object.freeze({
      review,
      canonical_bytes: cloneBytes(packet.review.bytes),
      review_identity: snapshot(packet.review.identity),
      correction_authority: correctionAuthority,
      correction_reviews: Object.freeze(correctionReviews),
    });
  } catch {
    return null;
  }
}

function validPrefixCarrier(value: unknown): value is ManifestPrefixCarrierV1 {
  return hasExactKeys(value, PREFIX_CARRIER_KEYS)
    && value.schemaVersion === 'MES-MANIFEST-PREFIX-CARRIER-1'
    && validIdentity(value.rootIdentity)
    && Array.isArray(value.packets)
    && value.packets.length > 0;
}

/**
 * Reconstructs a verified prefix only from exact carrier bytes. It is a
 * detached verifier: it has no manifest path, writer, or append authority.
 */
export async function verifyManifestPrefixCarrier(
  expectedRootIdentity: ContentIdentity,
  expectedHeadIdentity: ContentIdentity,
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
): Promise<VerifiedManifestPrefixCarrierV1 | null> {
  if (!validIdentity(expectedRootIdentity)
    || !validIdentity(expectedHeadIdentity)
    || !validIdentity(carrierIdentity)
    || !(carrierBytes instanceof Uint8Array)
    || carrierBytes.byteLength === 0) return null;
  const bytes = cloneBytes(carrierBytes);
  const expectedRoot = snapshot(expectedRootIdentity);
  const expectedHead = snapshot(expectedHeadIdentity);
  const expectedCarrier = snapshot(carrierIdentity);
  try {
    const parsed = parseAuthorityJson(bytes);
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(parsed)), bytes)
      || !validPrefixCarrier(parsed)) return null;
    const actualCarrier = await contentIdentity(bytes);
    if (!identityEqual(actualCarrier, expectedCarrier)
      || !identityEqual(parsed.rootIdentity, expectedRoot)) return null;

    const packets: DecodedReplayPacket[] = [];
    for (const packet of parsed.packets) {
      const decoded = await decodeReplayPacket(packet as ManifestPrefixReplayPacketV1);
      if (!decoded) return null;
      packets.push(decoded);
    }

    // This full scan intentionally precedes all prefix reconstruction.
    const envelopes = new Set<string>();
    for (const packet of packets) {
      const blobs = [
        packet.entry,
        ...(packet.candidate ? [packet.candidate] : []),
        ...(packet.review ? [packet.review] : []),
        ...(packet.correctionAuthority ? [packet.correctionAuthority] : []),
        ...packet.correctionReviews,
      ];
      for (const blob of blobs) {
        const key = blobEnvelopeKey(blob);
        if (envelopes.has(key)) return null;
        envelopes.add(key);
      }
    }

    const first = packets[0];
    if (!first
      || first.candidate !== null
      || first.review !== null
      || first.correctionAuthority !== null
      || first.correctionReviews.length !== 0) return null;
    const genesis = createGenesisEntry(expectedRoot);
    if (!canonicalBytesEqual(canonicalDocument(asCanonical(genesis)), first.entry.bytes)) return null;
    let prefix = await verifyManifestPrefix(expectedRoot, [genesis]);
    if (prefix.status !== 'VERIFIED' || prefix.head_identity === null) return null;

    for (let index = 1; index < packets.length; index += 1) {
      const packet = packets[index]!;
      if (!packet.candidate || !packet.review) return null;
      const candidate = candidateFromBlob(packet.candidate);
      const review = reviewFromPacket(packet);
      if (!candidate || !review || prefix.head_identity === null) return null;
      const append = await deriveManifestAppend({
        prefix,
        expectedHead: prefix.head_identity,
        candidate,
        review,
      });
      if (append.proposedEntry === null
        || append.proposedPrefix.status !== 'VERIFIED'
        || append.proposedPrefix.entries.length !== index + 1
        || append.proposedPrefix.head_identity === null
        || !canonicalBytesEqual(canonicalDocument(asCanonical(append.proposedEntry)), packet.entry.bytes)
        || !identityEqual(append.proposedPrefix.head_identity, packet.entry.identity)) return null;
      prefix = append.proposedPrefix;
    }

    if (prefix.status !== 'VERIFIED'
      || prefix.head_identity === null
      || !identityEqual(prefix.root_identity, expectedRoot)
      || !identityEqual(prefix.head_identity, expectedHead)) return null;
    return deepFreeze({
      carrierBytes: cloneBytes(bytes),
      carrierIdentity: snapshot(expectedCarrier),
      prefix,
    });
  } catch {
    return null;
  }
}

export type {
  DetachedRecordCandidate,
  EvidenceManifestEntryV1,
  IndependentRecordReviewV1,
  VerifiedManifestPrefix,
};
