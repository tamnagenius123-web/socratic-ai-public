import { describe, expect, it } from 'vitest';
import {
  createGenesisEntry,
  deriveManifestAppend,
  verifyManifestPrefix,
  type DetachedRecordCandidate,
  type IndependentRecordReviewV1,
} from '../../src/services/admission/evidence-spine-manifest';
import {
  canonicalDocument,
  type CanonicalJsonValue,
} from '../../src/services/admission/canonical-json';
import {
  contentIdentity,
  recordSha256,
  type ContentIdentity,
} from '../../src/services/admission/identity';

type JsonObject = Record<string, unknown>;

const sha = (digit: string): string => digit.repeat(64);
const identity = (digit: string, byteLength = 1): ContentIdentity => ({
  byte_length: byteLength,
  sha256: sha(digit),
});
const rootIdentity = identity('0');
const otherRootIdentity = identity('f');

function json(value: unknown): CanonicalJsonValue {
  return value as CanonicalJsonValue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function evidenceKeyFor(record: JsonObject): Promise<string> {
  const family = record.record_family;
  const payload = record.payload as JsonObject;
  const common = {
    schema_version: 'MES-EVIDENCE-KEY-1',
    record_family: family,
    root_identity: record.root_identity,
  };
  if (family === 'GRADE') {
    return recordSha256(json({ ...common, grade_run_id: payload.id }));
  }
  if (family === 'CORRECTION') {
    return recordSha256(json({ ...common, target_record_id: payload.target_record_id }));
  }
  throw new Error('TEST_RECORD_FAMILY_UNSUPPORTED');
}

async function pendingReviewIdentity(): Promise<ContentIdentity> {
  return contentIdentity(canonicalDocument(json({ schema_version: 'MES-REVIEW-PENDING-1' })));
}

async function candidateFromRecord(
  recordInput: JsonObject,
  normalizePendingReview = true,
): Promise<DetachedRecordCandidate> {
  const record = clone(recordInput);
  if (normalizePendingReview) {
    (record.independent_review as JsonObject).review_output_identity = await pendingReviewIdentity();
  }
  record.evidence_key = await evidenceKeyFor(record);
  const { record_id: _discardedRecordId, ...recordBody } = record;
  record.record_id = await recordSha256(json(recordBody));
  const canonical_bytes = canonicalDocument(json(record));
  const record_identity = await contentIdentity(canonical_bytes);
  return Object.freeze({
    record: record as unknown as DetachedRecordCandidate['record'],
    canonical_bytes,
    record_identity,
  });
}

async function gradeCandidate(
  id: string,
  root: ContentIdentity = rootIdentity,
  verdict = 'SAME GRADE',
) {
  return candidateFromRecord({
    schema_version: 'MES-1',
    record_family: 'GRADE',
    record_id: sha('1'),
    root_identity: root,
    evidence_key: 'pending',
    subject_identity: {
      subject_type: 'grade-run',
      subject_key: `subject-${id}`,
      content_identity: identity('1'),
    },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: {
      producer_id: 'builder-a',
      role: 'BUILDER',
      vendor_family: 'OPENAI',
      attestation: 'UNKNOWN',
    },
    source_receipts: [{
      receipt_kind: 'GRADE_OUTPUT',
      receipt_id: `receipt-${id}`,
      content_identity: identity('2'),
    }],
    limitations: ['offline fixture only'],
    independent_review: {
      builder_identity: 'builder-a',
      reviewer_identity: 'UNKNOWN',
      separation: 'UNKNOWN',
      review_output_identity: identity('3'),
      verdict: 'UNKNOWN',
      vendor_family: 'UNKNOWN',
    },
    payload: {
      id,
      slice_ids: ['N0'],
      frozen_rubric_sha256: sha('4'),
      matrix_sha256: sha('5'),
      artifact_ids: ['artifact-a'],
      builder_vendor_family: 'OPENAI',
      grader_vendor_family: 'ANTHROPIC',
      grader_is_non_builder: true,
      builder_report_used: false,
      branding_treatment: 'STRIPPED',
      same_state_material: true,
      mapping_commitment: sha('6'),
      prompt_sha256: sha('7'),
      verdict,
      reasons: ['fixture-reason'],
      unassessable_dimensions: verdict === 'UNGRADABLE' ? ['unknown-axis'] : [],
      timestamp: '2026-09-02T00:00:00.000Z',
      output_sha256: sha('8'),
    },
  });
}

async function correctionCandidate(input: {
  id: string;
  target: Awaited<ReturnType<typeof candidateFromRecord>>;
  replacements: readonly Awaited<ReturnType<typeof candidateFromRecord>>[];
  effectiveHead: ContentIdentity;
  root?: ContentIdentity;
  approvalIdentity?: ContentIdentity;
  reviewOutputIdentities?: readonly ContentIdentity[];
}) {
  return candidateFromRecord({
    schema_version: 'MES-1',
    record_family: 'CORRECTION',
    record_id: sha('9'),
    root_identity: input.root ?? rootIdentity,
    evidence_key: 'pending',
    subject_identity: {
      subject_type: 'correction',
      subject_key: input.id,
      content_identity: identity('9'),
    },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: {
      producer_id: 'builder-a',
      role: 'BUILDER',
      vendor_family: 'OPENAI',
      attestation: 'UNKNOWN',
    },
    source_receipts: [{
      receipt_kind: 'REVIEW',
      receipt_id: `receipt-${input.id}`,
      content_identity: identity('a'),
    }],
    limitations: ['offline fixture only'],
    independent_review: {
      builder_identity: 'builder-a',
      reviewer_identity: 'UNKNOWN',
      separation: 'UNKNOWN',
      review_output_identity: identity('b'),
      verdict: 'UNKNOWN',
      vendor_family: 'UNKNOWN',
    },
    payload: {
      target_record_id: input.target.record.record_id,
      target_record_identity: input.target.record_identity,
      defect_code: 'FIXTURE_DEFECT',
      reason: 'Replace the exact defective fixture record.',
      replacement_record_ids: input.replacements.map((item) => item.record.record_id).sort(),
      approval_identity: input.approvalIdentity ?? identity('c'),
      review_output_identities: input.reviewOutputIdentities ?? [identity('d')],
      effective_manifest_head_identity: input.effectiveHead,
    },
  });
}

async function correctionCarriers(input: {
  target: Awaited<ReturnType<typeof candidateFromRecord>>;
  replacements: readonly Awaited<ReturnType<typeof candidateFromRecord>>[];
  effectiveHead: ContentIdentity;
  root?: ContentIdentity;
}) {
  const root = input.root ?? rootIdentity;
  const authority = {
    schema_version: 'MES-CORRECTION-AUTHORITY-1',
    root_identity: root,
    target_record_id: input.target.record.record_id,
    target_record_identity: input.target.record_identity,
    defect_code: 'FIXTURE_DEFECT',
    replacement_record_ids: input.replacements.map((item) => item.record.record_id).sort(),
    effective_manifest_head_identity: input.effectiveHead,
    approver_identity: 'owner-a',
    approver_vendor_family: 'HUMAN_OWNER',
    decision: 'APPROVE',
  } as const;
  const authorityBytes = canonicalDocument(json(authority));
  const authorityCarrier = {
    authority,
    canonical_bytes: authorityBytes,
    approval_identity: await contentIdentity(authorityBytes),
  };
  const supportingReview = {
    schema_version: 'MES-CORRECTION-REVIEW-1',
    root_identity: root,
    target_record_id: input.target.record.record_id,
    target_record_identity: input.target.record_identity,
    defect_code: 'FIXTURE_DEFECT',
    replacement_record_ids: input.replacements.map((item) => item.record.record_id).sort(),
    approval_identity: authorityCarrier.approval_identity,
    effective_manifest_head_identity: input.effectiveHead,
    builder_identity: 'builder-a',
    reviewer_identity: 'reviewer-c',
    reviewer_vendor_family: 'GOOGLE',
    separation: 'VERIFIED',
    verdict: 'APPROVE',
    reason_codes: [],
  } as const;
  const reviewBytes = canonicalDocument(json(supportingReview));
  return {
    authority: authorityCarrier,
    reviews: [{
      review: supportingReview,
      canonical_bytes: reviewBytes,
      review_output_identity: await contentIdentity(reviewBytes),
    }],
  };
}

async function correctionSubmission(input: {
  id: string;
  target: Awaited<ReturnType<typeof candidateFromRecord>>;
  replacements: readonly Awaited<ReturnType<typeof candidateFromRecord>>[];
  effectiveHead: ContentIdentity;
  root?: ContentIdentity;
}) {
  const carriers = await correctionCarriers(input);
  const candidate = await correctionCandidate({
    ...input,
    approvalIdentity: carriers.authority.approval_identity,
    reviewOutputIdentities: carriers.reviews.map((item) => item.review_output_identity),
  });
  return {
    candidate,
    carriers,
    review: await reviewFor(candidate, {}, carriers),
  };
}

async function reviewFor(
  candidate: Awaited<ReturnType<typeof candidateFromRecord>>,
  overrides: Partial<IndependentRecordReviewV1['review']> = {},
  correction: Awaited<ReturnType<typeof correctionCarriers>> | null = null,
): Promise<IndependentRecordReviewV1> {
  const review: IndependentRecordReviewV1['review'] = {
    schema_version: 'MES-REVIEW-1',
    root_identity: candidate.record.root_identity,
    candidate_identity: candidate.record_identity,
    builder_identity: 'builder-a',
    builder_vendor_family: 'OPENAI',
    reviewer_identity: 'reviewer-b',
    reviewer_vendor_family: 'ANTHROPIC',
    separation: 'VERIFIED',
    verdict: 'ADMIT',
    reason_codes: [],
    ...overrides,
  };
  const canonical_bytes = canonicalDocument(json(review));
  const review_identity = await contentIdentity(canonical_bytes);
  return Object.freeze({
    review,
    canonical_bytes,
    review_identity,
    correction_authority: correction?.authority ?? null,
    correction_reviews: correction?.reviews ?? [],
  }) as unknown as IndependentRecordReviewV1;
}

async function genesisPrefix() {
  const genesis = createGenesisEntry(rootIdentity);
  const prefix = await verifyManifestPrefix(rootIdentity, [genesis]);
  return { genesis, prefix };
}

async function append(
  prefix: Awaited<ReturnType<typeof verifyManifestPrefix>>,
  candidate: Awaited<ReturnType<typeof candidateFromRecord>>,
  review?: Awaited<ReturnType<typeof reviewFor>>,
  expectedHead = prefix.head_identity,
) {
  if (expectedHead === null) throw new Error('TEST_HEAD_REQUIRED');
  const actualReview = review ?? await reviewFor(candidate);
  return deriveManifestAppend({ prefix, expectedHead, candidate, review: actualReview });
}

describe('Critical Path B evidence manifest', () => {
  it('creates the exact genesis and verifies only its structural prefix', async () => {
    const { genesis, prefix } = await genesisPrefix();
    expect(genesis).toEqual({
      schema_version: 'MES-1',
      root_identity: rootIdentity,
      ordinal: 0,
      predecessor_identity: null,
      candidate_identity: null,
      review_identity: null,
      reviewer_identity: null,
      reviewer_vendor_family: null,
      builder_identity: null,
      builder_vendor_family: null,
      independence_verified: false,
      disposition: 'ADMITTED',
      reason_codes: [],
    });
    expect(prefix.status).toBe('VERIFIED');
    expect(prefix.entries).toHaveLength(1);
    expect(prefix.head_identity).toEqual(prefix.entry_identities[0]);
    expect(Object.isFrozen(prefix)).toBe(true);
  });

  it('derives an admitted append from exact candidate and review bytes', async () => {
    const { prefix } = await genesisPrefix();
    const candidate = await gradeCandidate('grade-a');
    const result = await append(prefix, candidate);
    expect(result.disposition).toBe('ADMITTED');
    expect(result.proposedEntry?.ordinal).toBe(1);
    expect(result.proposedEntry?.predecessor_identity).toEqual(prefix.head_identity);
    expect(result.proposedPrefix.status).toBe('VERIFIED');
    expect(result.proposedPrefix.entries).toHaveLength(2);
  });

  it('makes exact current-candidate replay idempotent', async () => {
    const { prefix } = await genesisPrefix();
    const candidate = await gradeCandidate('grade-a');
    const first = await append(prefix, candidate);
    const replay = await append(first.proposedPrefix, candidate);
    expect(replay.disposition).toBe('ADMITTED');
    expect(replay.proposedEntry).toBeNull();
    expect(replay.proposedPrefix).toBe(first.proposedPrefix);
  });

  it('fails closed on empty, gapped, wrong-predecessor, alternate-successor, and entry-only prefixes', async () => {
    const { genesis, prefix } = await genesisPrefix();
    const candidateA = await gradeCandidate('grade-a');
    const candidateB = await gradeCandidate('grade-b');
    const appendA = await append(prefix, candidateA);
    const appendB = await append(prefix, candidateB);
    const entryA = appendA.proposedEntry!;
    const entryB = appendB.proposedEntry!;

    await expect(verifyManifestPrefix(rootIdentity, [])).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(verifyManifestPrefix(rootIdentity, [genesis, { ...entryA, ordinal: 2 }])).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(verifyManifestPrefix(rootIdentity, [genesis, { ...entryA, predecessor_identity: identity('e') }])).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(verifyManifestPrefix(rootIdentity, [genesis, entryA, entryB])).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(verifyManifestPrefix(rootIdentity, [genesis, entryA])).resolves.toMatchObject({ status: 'UNKNOWN' });
    await expect(verifyManifestPrefix(rootIdentity, [{ ...genesis, ordinal: -0 }])).resolves.toMatchObject({ status: 'UNKNOWN' });
  });

  it('does not freeze or otherwise mutate caller-owned prefixes on an UNKNOWN append', async () => {
    const { prefix } = await genesisPrefix();
    const mutablePrefix = clone(prefix);
    const before = clone(mutablePrefix);
    const candidate = await gradeCandidate('grade-a');
    const result = await deriveManifestAppend({
      prefix: mutablePrefix,
      expectedHead: identity('e'),
      candidate,
      review: await reviewFor(candidate),
    });
    expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
    expect(result.proposedPrefix).toBe(mutablePrefix);
    expect(mutablePrefix).toEqual(before);
    expect(Object.isFrozen(mutablePrefix)).toBe(false);
    expect(Object.isFrozen(mutablePrefix.entries)).toBe(false);
  });

  it('fails closed on stale heads and same record ID with changed candidate bytes', async () => {
    const { prefix } = await genesisPrefix();
    const candidate = await gradeCandidate('grade-a');
    const stale = await append(prefix, candidate, await reviewFor(candidate), identity('e'));
    expect(stale).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });

    const first = await append(prefix, candidate);
    const changedRecord = clone(candidate.record) as unknown as JsonObject;
    (changedRecord.payload as JsonObject).reasons = ['changed-reason'];
    const changed = await candidateFromRecord(changedRecord);
    (changed.record as unknown as JsonObject).record_id = candidate.record.record_id;
    const changedBytes = canonicalDocument(json(changed.record));
    const changedIdentity = await contentIdentity(changedBytes);
    const replay = await append(first.proposedPrefix, {
      record: changed.record,
      canonical_bytes: changedBytes,
      record_identity: changedIdentity,
    });
    expect(replay).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
  });

  it.each(['candidate', 'review', 'prefix-head', 'expected-head'])(
    'rejects extra-key ContentIdentity at the %s boundary',
    async (boundary) => {
      const { prefix } = await genesisPrefix();
      const candidate = await gradeCandidate(`grade-identity-${boundary}`);
      const review = await reviewFor(candidate);
      const forgedIdentity = {
        ...(boundary === 'review' ? review.review_identity : candidate.record_identity),
        extra_authority: true,
      } as unknown as ContentIdentity;
      const forgedCandidate = boundary === 'candidate'
        ? { ...candidate, record_identity: forgedIdentity }
        : candidate;
      const forgedReview = boundary === 'review'
        ? { ...review, review_identity: forgedIdentity }
        : review;
      const forgedPrefix = clone(prefix);
      if (boundary === 'prefix-head') {
        forgedPrefix.head_identity = {
          ...forgedPrefix.head_identity!, extra_authority: true,
        } as unknown as ContentIdentity;
      }
      const expectedHead = boundary === 'expected-head'
        ? { ...prefix.head_identity!, extra_authority: true } as unknown as ContentIdentity
        : prefix.head_identity!;
      await expect(deriveManifestAppend({
        prefix: forgedPrefix,
        expectedHead,
        candidate: forgedCandidate,
        review: forgedReview,
      })).resolves.toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
    },
  );

  it.each([
    ['candidate root', { root_identity: otherRootIdentity }],
    ['candidate identity', { candidate_identity: identity('e') }],
    ['builder identity', { builder_identity: 'other-builder' }],
    ['reviewer equality', { reviewer_identity: 'builder-a' }],
    ['unknown separation', { separation: 'UNKNOWN' }],
    ['unknown reviewer vendor', { reviewer_vendor_family: 'UNKNOWN' }],
    ['unknown builder vendor', { builder_vendor_family: 'UNKNOWN' }],
  ])('rejects %s review mismatch before append', async (_label, override) => {
    const { prefix } = await genesisPrefix();
    const candidate = await gradeCandidate('grade-a');
    const result = await append(prefix, candidate, await reviewFor(
      candidate,
      override as Partial<IndependentRecordReviewV1['review']>,
    ));
    expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
  });

  it.each([
    ['review identity', { review_output_identity: identity('e') }],
    ['reviewer identity', { reviewer_identity: 'reviewer-z' }],
    ['separation', { separation: 'VERIFIED' }],
    ['verdict', { verdict: 'ADMIT' }],
    ['vendor family', { vendor_family: 'GOOGLE' }],
  ])('requires the exact acyclic embedded pending-review marker: %s', async (_label, mutation) => {
    const { prefix } = await genesisPrefix();
    const valid = await gradeCandidate(`grade-pending-${_label}`);
    const changedRecord = clone(valid.record) as unknown as JsonObject;
    Object.assign(changedRecord.independent_review as JsonObject, mutation);
    const changed = await candidateFromRecord(changedRecord, false);
    const result = await append(prefix, changed, await reviewFor(changed));
    expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
  });

  it.each([
    ['missing code', { verdict: 'REJECT', reason_codes: [] }],
    ['unsorted codes', { verdict: 'REJECT', reason_codes: ['Z_REASON', 'A_REASON'] }],
    ['duplicate codes', { verdict: 'REJECT', reason_codes: ['A_REASON', 'A_REASON'] }],
    ['control code', { verdict: 'REJECT', reason_codes: ['BAD\u0007CODE'] }],
  ])('rejects malformed reason codes: %s', async (_label, override) => {
    const { prefix } = await genesisPrefix();
    const candidate = await gradeCandidate('grade-a');
    const result = await append(prefix, candidate, await reviewFor(
      candidate,
      override as Partial<IndependentRecordReviewV1['review']>,
    ));
    expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
  });

  it('maps exact reject and unknown reviews without favorable inference', async () => {
    const { prefix } = await genesisPrefix();
    const rejectedCandidate = await gradeCandidate('grade-a');
    const unknownCandidate = await gradeCandidate('grade-b');
    const rejected = await append(prefix, rejectedCandidate, await reviewFor(rejectedCandidate, {
      verdict: 'REJECT', reason_codes: ['REVIEW_REJECTED'],
    }));
    const unknown = await append(prefix, unknownCandidate, await reviewFor(unknownCandidate, {
      verdict: 'UNKNOWN', reason_codes: ['REVIEW_UNKNOWN'],
    }));
    expect(rejected.disposition).toBe('REJECTED');
    expect(unknown.disposition).toBe('UNKNOWN');
  });

  it('admits only a byte-resolved same-root correction with an active target and admitted replacements', async () => {
    const { prefix } = await genesisPrefix();
    const target = await gradeCandidate('grade-a');
    const replacement = await gradeCandidate('grade-b');
    const targetAppend = await append(prefix, target);
    const replacementAppend = await append(targetAppend.proposedPrefix, replacement);
    const correction = await correctionSubmission({
      id: 'correction-a', target, replacements: [replacement],
      effectiveHead: replacementAppend.proposedPrefix.head_identity!,
    });
    const result = await append(
      replacementAppend.proposedPrefix,
      correction.candidate,
      correction.review,
    );
    expect(result.disposition).toBe('ADMITTED');
    expect(result.proposedEntry).not.toBeNull();
    const afterCorrection = await append(result.proposedPrefix, await gradeCandidate('grade-c'));
    expect(afterCorrection.disposition).toBe('ADMITTED');
  });

  it('fails closed when correction authority and supporting reviews are unresolved placeholders', async () => {
    const { prefix } = await genesisPrefix();
    const target = await gradeCandidate('grade-a');
    const replacement = await gradeCandidate('grade-b');
    const targetAppend = await append(prefix, target);
    const replacementAppend = await append(targetAppend.proposedPrefix, replacement);
    const correction = await correctionCandidate({
      id: 'correction-unresolved', target, replacements: [replacement],
      effectiveHead: replacementAppend.proposedPrefix.head_identity!,
    });
    await expect(append(replacementAppend.proposedPrefix, correction)).resolves.toMatchObject({
      disposition: 'UNKNOWN', proposedEntry: null,
    });
  });

  it.each([
    'authority-bytes',
    'authority-identity',
    'authority-target',
    'supporting-review-bytes',
    'supporting-review-identity',
    'supporting-review-builder',
    'supporting-review-verdict',
  ])('fails closed for correction carrier mismatch: %s', async (mode) => {
    const { prefix } = await genesisPrefix();
    const target = await gradeCandidate('grade-a');
    const replacement = await gradeCandidate('grade-b');
    const targetAppend = await append(prefix, target);
    const replacementAppend = await append(targetAppend.proposedPrefix, replacement);
    const carriers = await correctionCarriers({
      target, replacements: [replacement],
      effectiveHead: replacementAppend.proposedPrefix.head_identity!,
    });
    const correction = await correctionCandidate({
      id: `correction-${mode}`, target, replacements: [replacement],
      effectiveHead: replacementAppend.proposedPrefix.head_identity!,
      approvalIdentity: carriers.authority.approval_identity,
      reviewOutputIdentities: carriers.reviews.map((item) => item.review_output_identity),
    });
    const forged = clone(carriers);
    if (mode === 'authority-bytes') forged.authority.canonical_bytes[0] ^= 1;
    if (mode === 'authority-identity') {
      forged.authority.approval_identity = {
        ...forged.authority.approval_identity, extra_authority: true,
      } as unknown as ContentIdentity;
    }
    if (mode === 'authority-target') {
      (forged.authority.authority as unknown as JsonObject).target_record_id = sha('e');
    }
    if (mode === 'supporting-review-bytes') forged.reviews[0].canonical_bytes[0] ^= 1;
    if (mode === 'supporting-review-identity') {
      forged.reviews[0].review_output_identity = {
        ...forged.reviews[0].review_output_identity, extra_authority: true,
      } as unknown as ContentIdentity;
    }
    if (mode === 'supporting-review-builder') {
      (forged.reviews[0].review as unknown as JsonObject).reviewer_identity = 'builder-a';
    }
    if (mode === 'supporting-review-verdict') {
      (forged.reviews[0].review as unknown as JsonObject).verdict = 'REJECT';
    }
    const result = await append(
      replacementAppend.proposedPrefix,
      correction,
      await reviewFor(correction, {}, forged),
    );
    expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
  });

  it.each(['missing-target', 'cross-root', 'missing-replacement'])(
    'fails closed for malformed correction relation: %s',
    async (mode) => {
      const { prefix } = await genesisPrefix();
      const target = await gradeCandidate('grade-a');
      const replacement = await gradeCandidate('grade-b');
      const targetAppend = await append(prefix, target);
      const replacementAppend = await append(targetAppend.proposedPrefix, replacement);
      const wrongTarget = mode === 'missing-target' ? await gradeCandidate('grade-missing') : target;
      const wrongReplacement = mode === 'missing-replacement' ? await gradeCandidate('grade-missing') : replacement;
      const correction = await correctionSubmission({
        id: `correction-${mode}`, target: wrongTarget, replacements: [wrongReplacement],
        effectiveHead: replacementAppend.proposedPrefix.head_identity!,
        root: mode === 'cross-root' ? otherRootIdentity : rootIdentity,
      });
      const result = await append(replacementAppend.proposedPrefix, correction.candidate, correction.review);
      expect(result).toMatchObject({ disposition: 'UNKNOWN', proposedEntry: null });
    },
  );

  it('rejects competing corrections and correction cycles', async () => {
    const { prefix } = await genesisPrefix();
    const recordA = await gradeCandidate('grade-a');
    const recordB = await gradeCandidate('grade-b');
    const appendA = await append(prefix, recordA);
    const appendB = await append(appendA.proposedPrefix, recordB);
    const correctionA = await correctionSubmission({
      id: 'correction-a', target: recordA, replacements: [recordB],
      effectiveHead: appendB.proposedPrefix.head_identity!,
    });
    const appendCorrectionA = await append(appendB.proposedPrefix, correctionA.candidate, correctionA.review);
    expect(appendCorrectionA.disposition).toBe('ADMITTED');

    const competing = await correctionSubmission({
      id: 'correction-competing', target: recordA, replacements: [recordB],
      effectiveHead: appendCorrectionA.proposedPrefix.head_identity!,
    });
    expect(await append(appendCorrectionA.proposedPrefix, competing.candidate, competing.review)).toMatchObject({
      disposition: 'UNKNOWN', proposedEntry: null,
    });

    const cycle = await correctionSubmission({
      id: 'correction-cycle', target: recordB, replacements: [recordA],
      effectiveHead: appendCorrectionA.proposedPrefix.head_identity!,
    });
    expect(await append(appendCorrectionA.proposedPrefix, cycle.candidate, cycle.review)).toMatchObject({
      disposition: 'UNKNOWN', proposedEntry: null,
    });
  });
});
