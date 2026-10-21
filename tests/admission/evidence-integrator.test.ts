import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from '../../src/services/admission/canonical-json';
import {
  createGenesisEntry,
  deriveManifestAppend,
  verifyManifestPrefix,
  type DetachedRecordCandidate,
  type IndependentRecordReviewV1,
  type VerifiedManifestPrefix,
} from '../../src/services/admission/evidence-spine-manifest';
import {
  deriveEvidenceSpineBaseline,
  type DerivedEvidenceSpineBaseline,
  type EvidenceSpineRepositorySources,
} from '../../src/services/admission/evidence-spine-records';
import type {
  ArtifactEvidenceRecordV1,
  CorrectionEvidenceRecordV1,
  EvidenceManifestEntryV1,
  EvidenceRecordV1,
  EvidenceSpineRootV1,
  SourceReceiptRefV1,
} from '../../src/services/admission/evidence-spine-types';
import {
  contentIdentity,
  recordSha256,
  type ContentIdentity,
} from '../../src/services/admission/identity';
import type {
  ReceiptIntegrityProofV1,
  ReceiptResolution,
} from '../../src/services/admission/product-receipts';
import { validateEvidenceRecord } from '../../src/services/admission/evidence-spine-validation';

/**
 * Critical Path B Task 4 RED oracle.
 *
 * The approved composition module is intentionally absent at this stage. Its
 * import is dynamic and caught so collection succeeds, independent controls
 * pass, and the missing verifier/composition surface is the causal RED. Once
 * the approved exports exist, the semantic matrix below runs unchanged.
 */

type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

type TypedRecordCandidate<T extends EvidenceRecordV1> = Omit<DetachedRecordCandidate, 'record'> & {
  record: T;
};

type ArtifactFixtureCandidate = TypedRecordCandidate<ArtifactEvidenceRecordV1>;
type CorrectionFixtureCandidate = TypedRecordCandidate<CorrectionEvidenceRecordV1>;
type ReviewOverrides = Partial<Pick<IndependentRecordReviewV1['review'],
  'reviewer_identity' | 'reviewer_vendor_family' | 'separation'>>;

type ExactCanonicalBlob = {
  bytesBase64: string;
  contentIdentity: ContentIdentity;
};

type PrefixPacket = {
  entry: ExactCanonicalBlob;
  candidate: ExactCanonicalBlob | null;
  review: ExactCanonicalBlob | null;
  correctionAuthority: ExactCanonicalBlob | null;
  correctionReviews: ExactCanonicalBlob[];
};

type PrefixCarrier = {
  schemaVersion: 'MES-MANIFEST-PREFIX-CARRIER-1';
  rootIdentity: ContentIdentity;
  packets: PrefixPacket[];
};

type ReceiptCarrier = {
  schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1';
  rootIdentity: ContentIdentity;
  candidateIdentity: ContentIdentity;
  resolutions: JsonArray;
};

type Policy = {
  schemaVersion: 'MES-INTEGRATION-ADMISSION-POLICY-1';
  rootIdentity: ContentIdentity;
  policyId: 'ROOT_REQUIREMENT_INDEPENDENCE_V1';
  nonBuilderRule: 'REVIEWER_IDENTITY_DISTINCT_AND_SEPARATION_VERIFIED';
  crossVendorRule: 'ANY_LINKED_CROSS_VENDOR_REQUIREMENT_REQUIRES_DISTINCT_VENDOR_FAMILY';
  sourceReceiptRule: 'EXACT_RESOLVED_CARRIER_REQUIRED';
};

type IntegratorAttribution = {
  actorIdentity: string;
  sessionIdentity: string;
};

type IntegrateReviewedCandidateInput = {
  candidateBytes: Uint8Array;
  reviewBytes: Uint8Array;
  expectedRootIdentity: ContentIdentity;
  expectedHeadIdentity: ContentIdentity;
  independencePolicyBytes: Uint8Array;
  independencePolicyIdentity: ContentIdentity;
  receiptResolutionCarrierBytes: Uint8Array;
  receiptResolutionCarrierIdentity: ContentIdentity;
  integratorAttribution: IntegratorAttribution;
  prefixCarrierBytes: Uint8Array;
  prefixCarrierIdentity: ContentIdentity;
};

type VerifiedManifestPrefixCarrier = {
  carrierBytes: Uint8Array;
  carrierIdentity: ContentIdentity;
  prefix: VerifiedManifestPrefix;
};

type ReviewedManifestAppendProposal = {
  status: 'PROPOSED_NOT_ADMITTED';
  rootIdentity: ContentIdentity;
  expectedHeadIdentity: ContentIdentity;
  candidateIdentity: ContentIdentity;
  reviewIdentity: ContentIdentity;
  prefixCarrierIdentity: ContentIdentity;
  independencePolicyIdentity: ContentIdentity;
  receiptResolutionCarrierIdentity: ContentIdentity;
  proposedEntryBytes: Uint8Array;
  proposedHeadIdentity: ContentIdentity;
  integratorAttribution: IntegratorAttribution;
};

type PrefixVerifier = (
  expectedRootIdentity: ContentIdentity,
  expectedHeadIdentity: ContentIdentity,
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
) => Promise<VerifiedManifestPrefixCarrier | null>;

type PolicyVerifier = (
  root: EvidenceSpineRootV1,
  policyBytes: Uint8Array,
  policyIdentity: ContentIdentity,
) => Promise<Policy | null>;

type ReceiptVerifier = (
  root: EvidenceSpineRootV1,
  candidate: DetachedRecordCandidate,
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
) => Promise<readonly ReceiptResolution[] | null>;

type PrepareIntegrator = (
  root: EvidenceSpineRootV1,
  input: IntegrateReviewedCandidateInput,
) => Promise<ReviewedManifestAppendProposal>;

type Api = {
  verifyManifestPrefixCarrier: PrefixVerifier | undefined;
  verifyIntegrationAdmissionPolicy: PolicyVerifier | undefined;
  verifyIntegrationReceiptResolutionCarrier: ReceiptVerifier | undefined;
  prepareReviewedManifestAppend: PrepareIntegrator | undefined;
};

type Namespace = Readonly<Record<string, unknown>>;

const repositoryPaths = Object.freeze({
  specification: 'docs/superpowers/specs/2026-09-01-socratic-ai-minimal-evidence-spine-design.md',
  implementationPlan: 'docs/superpowers/plans/2026-09-01-socratic-ai-critical-path-b.md',
  matrix: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json',
  answerKey: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/COMPOSITE_ANSWER_KEY_CANDIDATE.md',
  historicalTask4Capsule: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/admission/inputs/task-4-cutoff-state-capsule.md',
});

const outputPaths = Object.freeze({
  root: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b/root.json',
  manifest: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b/manifest.jsonl',
  projection: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b/projection.json',
  n9SuccessorPolicy: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b/sources/n9-successor-policy.json',
});

const approvedRootIdentity: ContentIdentity = Object.freeze({
  byte_length: 83_403,
  sha256: 'a428f42f6360c36aefa1854a67fb05277d5ebad891f5ff52716177f2ebcb508b',
});
const approvedGenesisIdentity: ContentIdentity = Object.freeze({
  byte_length: 411,
  sha256: '040a4921908ceecb9a1404b66d11d2c54835155e6bd92b3b0bfb2dad869538c8',
});
const approvedProjectionIdentity: ContentIdentity = Object.freeze({
  byte_length: 8_081,
  sha256: '471665f1d7dec26e5ad4e98364fb5277283a1fcc046f38a9db6c352d3d1ee6c5',
});
const approvedN9PolicyIdentity: ContentIdentity = Object.freeze({
  byte_length: 41_775,
  sha256: 'fff4b2469ddd3ad3e09dda239241a74f7b710b0736145af056cc2d5242d28a60',
});

const sha = (digit: string): string => digit.repeat(64);
const identity = (digit: string, byteLength = 1): ContentIdentity => ({
  byte_length: byteLength,
  sha256: sha(digit),
});

function json(value: unknown): CanonicalJsonValue {
  return value as CanonicalJsonValue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), path)));
}

function repositorySources(): EvidenceSpineRepositorySources {
  return {
    specification: bytes(repositoryPaths.specification),
    implementationPlan: bytes(repositoryPaths.implementationPlan),
    matrix: bytes(repositoryPaths.matrix),
    answerKey: bytes(repositoryPaths.answerKey),
    historicalTask4Capsule: bytes(repositoryPaths.historicalTask4Capsule),
  };
}

const baselinePromise: Promise<DerivedEvidenceSpineBaseline> = deriveEvidenceSpineBaseline(repositorySources());

async function pendingReviewIdentity(): Promise<ContentIdentity> {
  return contentIdentity(canonicalDocument(json({ schema_version: 'MES-REVIEW-PENDING-1' })));
}

async function buildReceiptPayloads(
  subjectIdentity: ContentIdentity,
  accountScopeIdentity: ContentIdentity,
  label: string,
  browserTargetLink: JsonObject = { fixture: `base64-${label}~~~` },
  attemptPayloadReceiptKind: 'AI_INVOCATION_ATTEMPT' | 'BROWSER_ACTION_LOG' = 'AI_INVOCATION_ATTEMPT',
  attemptReceiptId?: string,
) {
  const attemptPayload = {
    receiptKind: attemptPayloadReceiptKind, subjectIdentity, accountScopeIdentity,
    causal: attemptPayloadReceiptKind === 'AI_INVOCATION_ATTEMPT'
      ? {
        sessionIdentity: identity('a', 10), contextIdentity: identity('b', 11), turnNumber: 7,
        cacheNamespaceIdentity: identity('c', 12), terminalOutcome: 'success', routeTargetIdentity: identity('d', 13),
      }
      : {
        controlId: `mismatched-kind-${label}~~~`, beforeIdentity: identity('a', 10), afterIdentity: identity('b', 11),
        actionLogIdentity: identity('c', 12), networkEvidenceIdentity: identity('d', 13), targetLink: { fixture: `mismatched-${label}~~~` },
      },
  } as const;
  const browserPayload = {
    receiptKind: 'BROWSER_ACTION_LOG', subjectIdentity, accountScopeIdentity,
    causal: {
      controlId: `control-${label}~~~`, beforeIdentity: identity('e', 14), afterIdentity: identity('f', 15),
      actionLogIdentity: identity('8', 16), networkEvidenceIdentity: identity('7', 17),
      targetLink: browserTargetLink,
    },
  } as const;
  const attemptBytes = canonicalDocument(json(attemptPayload));
  const browserBytes = canonicalDocument(json(browserPayload));
  return [{
    payload: attemptPayload, canonicalBytes: attemptBytes,
    ref: { receipt_kind: 'AI_INVOCATION_ATTEMPT' as const, receipt_id: attemptReceiptId ?? `attempt-${label}`, content_identity: await contentIdentity(attemptBytes) },
  }, {
    payload: browserPayload, canonicalBytes: browserBytes,
    ref: { receipt_kind: 'BROWSER_ACTION_LOG' as const, receipt_id: sha('a'), content_identity: await contentIdentity(browserBytes) },
  }] as const;
}

async function buildCandidate(options: {
  root: ContentIdentity;
  requirementId?: string;
  sliceId?: string;
  gate?: string;
  receiptId?: string;
  hiddenConditionalRequirementId?: string;
  hiddenN10V1FailureTell?: boolean;
  label?: string;
  browserTargetLink?: JsonObject;
  attemptPayloadReceiptKind?: 'AI_INVOCATION_ATTEMPT' | 'BROWSER_ACTION_LOG';
  attemptReceiptId?: string;
}): Promise<{
  candidate: ArtifactFixtureCandidate;
  record: ArtifactEvidenceRecordV1;
  bytes: Uint8Array;
  identity: ContentIdentity;
  sourceRef: SourceReceiptRefV1;
  sourceRefs: readonly SourceReceiptRefV1[];
  receiptPayloads: Awaited<ReturnType<typeof buildReceiptPayloads>>;
  subjectIdentity: ContentIdentity;
}> {
  const requirementId = options.requirementId ?? 'N0-D1';
  const sliceId = options.sliceId ?? requirementId.split('-')[0];
  const gate = options.gate ?? (requirementId === 'N10-V1' ? 'V0' : requirementId.split('-')[1]?.slice(0, 1));
  const subjectIdentity = identity('1', 21);
  const accountScopeIdentity = identity('9', 2);
  const label = options.label ?? 'integrator-fixture';
  const receiptPayloads = await buildReceiptPayloads(
    subjectIdentity,
    accountScopeIdentity,
    label,
    options.browserTargetLink,
    options.attemptPayloadReceiptKind,
    options.attemptReceiptId,
  );
  const sourceRefs: readonly SourceReceiptRefV1[] = [receiptPayloads[0].ref, receiptPayloads[1].ref];
  const sourceRef = sourceRefs[0];
  const claimAssertions = options.hiddenConditionalRequirementId
    ? [{
      claim_id: 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION',
      conditional_requirement_ids: [options.hiddenConditionalRequirementId],
      subject_identity: {
        subject_type: 'projection-fixture',
        subject_key: 'subject-integrator',
        content_identity: identity('c', 3),
      },
      assertion_state: 'NOT_ASSERTED' as const,
      artifact_ids: [],
      review_output_identities: [identity('d', 4)],
    }]
    : [];
  const recordBody: JsonObject = {
    schema_version: 'MES-1',
    record_family: 'ARTIFACT',
    record_id: sha('2'),
    root_identity: options.root,
    evidence_key: 'pending',
    subject_identity: {
      subject_type: 'grade-input',
      subject_key: 'offline-integrator-fixture',
      content_identity: subjectIdentity,
    },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: {
      producer_id: 'builder-a',
      role: 'BUILDER',
      vendor_family: 'OPENAI',
      attestation: 'OFFLINE_FIXTURE',
    },
    source_receipts: sourceRefs,
    limitations: ['offline fixture only'],
    independent_review: {
      builder_identity: 'builder-a',
      reviewer_identity: 'UNKNOWN',
      separation: 'UNKNOWN',
      review_output_identity: await pendingReviewIdentity(),
      verdict: 'UNKNOWN',
      vendor_family: 'UNKNOWN',
    },
    payload: {
      id: `artifact-${label}~~~`,
      slice_id: sliceId,
      evidence_requirement_ids: [requirementId],
      gate,
      kind: 'STATIC',
      path_or_url: 'repo://fixture/evidence-integrator',
      sha256: sha('3'),
      captured_at: '2026-09-02T00:00:00.000Z',
      evidence_label: 'CODE_VERIFIED',
      outcome: 'CLAIM_SUPPORTED',
      status: 'PASS',
      scope: {
        purpose_identity: identity('4'),
        subject_identity: subjectIdentity,
        time_identity: identity('5'),
        environment_identity: identity('6'),
        exclusion_identities: [],
      },
      limitations: [],
      bindings: {
        source_receipts: sourceRefs,
        build_identity: null,
        deployment_identity: null,
        account_scope_identity: null,
        capture_environment_identity: null,
        retention_policy_identity: null,
        access_policy_identity: null,
        negative_control_result_ids: [],
        failure_tell_observations: options.hiddenN10V1FailureTell ? [{
          failure_tell_id: 'FT-N10-MOCK-AS-PRODUCTION', slice_ids: ['N10'], gate_ids: ['V0'], requirement_ids: ['N10-V1'],
          subject_identity: { subject_type: 'grade-input', subject_key: 'offline-integrator-fixture', content_identity: subjectIdentity },
          observed: true, artifact_ids: [`artifact-${label}~~~`],
          scope: { purpose_identity: identity('4'), subject_identity: subjectIdentity, time_identity: identity('5'), environment_identity: identity('6'), exclusion_identities: [] },
          review_output_identities: [identity('d', 4)],
        }] : [],
        claim_assertions: claimAssertions,
        kind_details: {
          kind: 'STATIC',
          source_subject_ids: ['fixture-source'],
          source_snapshot_identity: identity('7'),
          code_bound: false,
        },
      },
    },
  };
  recordBody.evidence_key = await recordSha256(json({
    schema_version: 'MES-EVIDENCE-KEY-1',
    record_family: 'ARTIFACT',
    root_identity: options.root,
    artifact_kind: 'STATIC',
    subject_identity: recordBody.subject_identity,
    requirement_ids: [requirementId],
  }));
  const { record_id: _discardedRecordId, ...withoutRecordId } = recordBody;
  recordBody.record_id = await recordSha256(json(withoutRecordId));
  const record = validateEvidenceRecord(recordBody);
  if (record.record_family !== 'ARTIFACT') throw new Error('TEST_ARTIFACT_FIXTURE_FAMILY_MISMATCH');
  const canonicalBytes = canonicalDocument(json(record));
  const candidateIdentity = await contentIdentity(canonicalBytes);
  const candidate: ArtifactFixtureCandidate = Object.freeze({
    record,
    canonical_bytes: canonicalBytes,
    record_identity: candidateIdentity,
  });
  return {
    candidate,
    record,
    bytes: canonicalBytes,
    identity: candidateIdentity,
    sourceRef,
    sourceRefs,
    receiptPayloads,
    subjectIdentity,
  };
}

async function buildNegativeControlCandidate(
  baseline: DerivedEvidenceSpineBaseline,
  payload: Readonly<{
    controlId: string;
    sliceIds: readonly string[];
    requirementLinks: readonly JsonObject[];
    expectedOutcome: string;
  }>,
): Promise<{
  candidate: DetachedRecordCandidate;
  bytes: Uint8Array;
  identity: ContentIdentity;
}> {
  const subjectIdentity = identity('1', 21);
  const recordBody: JsonObject = {
    schema_version: 'MES-1',
    record_family: 'NEGATIVE_CONTROL_RESULT',
    record_id: sha('2'),
    root_identity: baseline.rootIdentity,
    evidence_key: 'pending',
    subject_identity: {
      subject_type: 'negative-control-fixture',
      subject_key: 'offline-integrator-negative-control',
      content_identity: subjectIdentity,
    },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: {
      producer_id: 'builder-a',
      role: 'BUILDER',
      vendor_family: 'OPENAI',
      attestation: 'OFFLINE_FIXTURE',
    },
    source_receipts: [],
    limitations: ['offline fixture only'],
    independent_review: {
      builder_identity: 'builder-a',
      reviewer_identity: 'UNKNOWN',
      separation: 'UNKNOWN',
      review_output_identity: await pendingReviewIdentity(),
      verdict: 'UNKNOWN',
      vendor_family: 'UNKNOWN',
    },
    payload: {
      control_id: payload.controlId,
      slice_ids: payload.sliceIds,
      requirement_links: payload.requirementLinks,
      subject_identity: {
        subject_type: 'negative-control-fixture',
        subject_key: 'offline-integrator-negative-control',
        content_identity: subjectIdentity,
      },
      expected_outcome: payload.expectedOutcome,
      observed_outcome: payload.expectedOutcome,
      before_state_identity: identity('3'),
      after_state_identity: identity('4'),
      action_log_identity: identity('5'),
      network_evidence: {
        kind: 'NOT_APPLICABLE',
        content_identity: null,
        reason: 'LOCAL_STATIC_ONLY',
      },
      artifact_ids: ['artifact-negative-control~~~'],
      scope: {
        purpose_identity: identity('6'),
        subject_identity: subjectIdentity,
        time_identity: identity('7'),
        environment_identity: identity('8'),
        exclusion_identities: [],
      },
      status: 'PASS',
    },
  };
  recordBody.evidence_key = await recordSha256(json({
    schema_version: 'MES-EVIDENCE-KEY-1',
    record_family: 'NEGATIVE_CONTROL_RESULT',
    root_identity: baseline.rootIdentity,
    control_id: payload.controlId,
    subject_identity: recordBody.subject_identity,
  }));
  const { record_id: _discardedRecordId, ...withoutRecordId } = recordBody;
  recordBody.record_id = await recordSha256(json(withoutRecordId));
  const record = validateEvidenceRecord(recordBody) as EvidenceRecordV1;
  const bytesValue = canonicalDocument(json(record));
  const recordIdentity = await contentIdentity(bytesValue);
  return {
    candidate: Object.freeze({ record, canonical_bytes: bytesValue, record_identity: recordIdentity }),
    bytes: bytesValue,
    identity: recordIdentity,
  };
}

async function buildReview(candidate: DetachedRecordCandidate, overrides: ReviewOverrides = {}): Promise<{
  body: IndependentRecordReviewV1['review'];
  bytes: Uint8Array;
  identity: ContentIdentity;
}> {
  const body: IndependentRecordReviewV1['review'] = {
    schema_version: 'MES-REVIEW-1',
    root_identity: candidate.record.root_identity,
    candidate_identity: candidate.record_identity,
    builder_identity: 'builder-a',
    builder_vendor_family: 'OPENAI',
    reviewer_identity: 'reviewer-b~~~',
    reviewer_vendor_family: 'ANTHROPIC',
    separation: 'VERIFIED',
    verdict: 'ADMIT',
    reason_codes: [],
    ...overrides,
  };
  const canonicalBytes = canonicalDocument(json(body));
  return { body, bytes: canonicalBytes, identity: await contentIdentity(canonicalBytes) };
}

function blob(canonicalBytes: Uint8Array, content: ContentIdentity): ExactCanonicalBlob {
  return {
    bytesBase64: Buffer.from(canonicalBytes).toString('base64'),
    contentIdentity: content,
  };
}

async function replaceBlobBytes(target: ExactCanonicalBlob, canonicalBytes: Uint8Array): Promise<void> {
  target.bytesBase64 = Buffer.from(canonicalBytes).toString('base64');
  target.contentIdentity = await contentIdentity(canonicalBytes);
}

function nonCanonicalPadBits(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.match(/=+$/u)?.[0] ?? '';
  if (padding.length === 0) throw new Error('TEST_BASE64_PAD_BITS_REQUIRE_PADDING');
  const lastIndex = value.length - padding.length - 1;
  const current = alphabet.indexOf(value[lastIndex] ?? 'A');
  const significantMask = padding.length === 2 ? 0b110000 : 0b111100;
  const replacement = alphabet[(current & significantMask) | 0b000001];
  return `${value.slice(0, lastIndex)}${replacement}${padding}`;
}

function urlSafeAlias(value: string): string {
  const plusIndex = value.indexOf('+');
  if (plusIndex >= 0) return `${value.slice(0, plusIndex)}-${value.slice(plusIndex + 1)}`;
  const slashIndex = value.indexOf('/');
  if (slashIndex >= 0) return `${value.slice(0, slashIndex)}_${value.slice(slashIndex + 1)}`;
  throw new Error('TEST_BASE64_URLSAFE_TARGET_MISSING');
}

function hasUrlSafeAlias(value: string): boolean {
  return value.includes('+') || value.includes('/');
}

function missingPaddingAlias(value: string): string {
  const padding = value.match(/=+$/u)?.[0] ?? '';
  if (padding.length === 0) throw new Error('TEST_BASE64_MISSING_PADDING_REQUIRE_PADDING');
  return value.slice(0, -padding.length);
}

async function attemptGuardSetIdentity(): Promise<ContentIdentity> {
  const trigger_definitions = [
    ['ai_invocation_attempts_context_existing_identity_guard', '92a44e032e5c64129e34e9d433ec32fe9cadbcdaae79ce3857b8e58937a6eafa'],
    ['ai_invocation_attempts_context_immutable_delete', '40fd1e910e6099bc74bd51fdc1f1d90a83a9c44fd2efad1b12be6580b66ee1fb'],
    ['ai_invocation_attempts_context_immutable_update', '9e70c4849eee8c4e002a83f5275fc94a9b6bc372619372949ef34cfae2c009f8'],
    ['ai_invocation_attempts_context_link_guard', '8cf21cf3cde64af9bc44448fd936bd13cb9b2008e82a99c2231d82d6d70e56fb'],
    ['training_session_contexts_delete_dependencies_first', '8c6d90ec733b1750ca9d8be478839740e4ef36c346c7d126a6eb49aca509d021'],
    ['training_session_contexts_existing_identity_guard', 'fb62a4e2e655299045afd55fdb9edfb891f2d9124bf5636c4292a677df18a9d1'],
    ['training_session_contexts_governed_delete_only', '86ca912d8b92e8117edae6ebb52591798fe85bca98528384983e82d34679f5aa'],
    ['training_session_contexts_immutable_update', '709c1d75768ab065a3b133f0fbba87fc2081fbe719d28d0462bb6f8d8c65df40'],
    ['training_session_contexts_owner_and_pack_guard', 'e761a233e4c5ef4ae28d4a01a64dae5125e65a11e58f7d09e44e4be1ae57e916'],
  ].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({ name, sha256: value }));
  return contentIdentity(canonicalDocument(json({ trigger_definitions })));
}

async function buildPrefixCarrier(
  baseline: DerivedEvidenceSpineBaseline,
  candidate: DetachedRecordCandidate,
  review: { body: IndependentRecordReviewV1['review']; bytes: Uint8Array; identity: ContentIdentity },
): Promise<{
  carrier: PrefixCarrier;
  bytes: Uint8Array;
  identity: ContentIdentity;
  headIdentity: ContentIdentity;
  genesisPrefix: VerifiedManifestPrefix;
  appendedEntry: EvidenceManifestEntryV1;
}> {
  const genesis = createGenesisEntry(baseline.rootIdentity);
  const genesisBytes = canonicalDocument(json(genesis));
  const genesisIdentity = await contentIdentity(genesisBytes);
  const genesisPrefix = await verifyManifestPrefix(baseline.rootIdentity, [genesis]);
  const genesisHead = genesisPrefix.head_identity;
  if (genesisHead === null) throw new Error('TEST_GENESIS_PREFIX_HEAD_MISSING');
  const reviewCarrier: IndependentRecordReviewV1 = {
    review: review.body,
    canonical_bytes: review.bytes,
    review_identity: review.identity,
    correction_authority: null,
    correction_reviews: [],
  };
  const derived = await deriveManifestAppend({
    prefix: genesisPrefix,
    expectedHead: genesisHead,
    candidate,
    review: reviewCarrier,
  });
  if (!derived.proposedEntry) throw new Error('TEST_APPEND_FIXTURE_NOT_DERIVED');
  const entryBytes = canonicalDocument(json(derived.proposedEntry));
  const entryIdentity = await contentIdentity(entryBytes);
  const carrier: PrefixCarrier = {
    schemaVersion: 'MES-MANIFEST-PREFIX-CARRIER-1',
    rootIdentity: baseline.rootIdentity,
    packets: [
      {
        entry: blob(genesisBytes, genesisIdentity),
        candidate: null,
        review: null,
        correctionAuthority: null,
        correctionReviews: [],
      },
      {
        entry: blob(entryBytes, entryIdentity),
        candidate: blob(candidate.canonical_bytes, candidate.record_identity),
        review: blob(review.bytes, review.identity),
        correctionAuthority: null,
        correctionReviews: [],
      },
    ],
  };
  const bytesValue = canonicalDocument(json(carrier));
  return {
    carrier,
    bytes: bytesValue,
    identity: await contentIdentity(bytesValue),
    headIdentity: entryIdentity,
    genesisPrefix,
    appendedEntry: derived.proposedEntry,
  };
}

function packetFor(
  entryBytes: Uint8Array,
  entryIdentity: ContentIdentity,
  candidate: DetachedRecordCandidate,
  review: { bytes: Uint8Array; identity: ContentIdentity },
): PrefixPacket {
  return {
    entry: blob(entryBytes, entryIdentity),
    candidate: blob(candidate.canonical_bytes, candidate.record_identity),
    review: blob(review.bytes, review.identity),
    correctionAuthority: null,
    correctionReviews: [],
  };
}

async function buildGrammarValidAlternateSuccessorCarrier(baseline: DerivedEvidenceSpineBaseline) {
  const prior = await buildCandidate({ root: baseline.rootIdentity, label: 'alternate-base~~~' });
  const priorReview = await buildReview(prior.candidate);
  const linear = await buildPrefixCarrier(baseline, prior.candidate, priorReview);
  const forkCandidate = await buildCandidate({ root: baseline.rootIdentity, label: 'alternate-fork~~~' });
  const forkReview = await buildReview(forkCandidate.candidate);
  const forkDerived = await deriveManifestAppend({
    prefix: linear.genesisPrefix,
    expectedHead: linear.genesisPrefix.head_identity!,
    candidate: forkCandidate.candidate,
    review: {
      review: forkReview.body,
      canonical_bytes: forkReview.bytes,
      review_identity: forkReview.identity,
      correction_authority: null,
      correction_reviews: [],
    },
  });
  if (!forkDerived.proposedEntry) throw new Error('TEST_ALTERNATE_SUCCESSOR_NOT_DERIVED');
  const forkEntryBytes = canonicalDocument(json(forkDerived.proposedEntry));
  const forkEntryIdentity = await contentIdentity(forkEntryBytes);
  const carrier: PrefixCarrier = {
    ...linear.carrier,
    packets: [
      ...linear.carrier.packets,
      packetFor(forkEntryBytes, forkEntryIdentity, forkCandidate.candidate, forkReview),
    ],
  };
  const bytesValue = canonicalDocument(json(carrier));
  return {
    carrier,
    bytes: bytesValue,
    identity: await contentIdentity(bytesValue),
    expectedHeadIdentity: forkEntryIdentity,
    forkEntry: forkDerived.proposedEntry,
  };
}

async function buildGrammarValidCorrectionCarrier(baseline: DerivedEvidenceSpineBaseline) {
  const genesis = createGenesisEntry(baseline.rootIdentity);
  const genesisBytes = canonicalDocument(json(genesis));
  const genesisIdentity = await contentIdentity(genesisBytes);
  const genesisPrefix = await verifyManifestPrefix(baseline.rootIdentity, [genesis]);
  const target = await buildCandidate({ root: baseline.rootIdentity, label: 'correction-target~~~' });
  const targetReview = await buildReview(target.candidate);
  const targetAppend = await deriveManifestAppend({
    prefix: genesisPrefix, expectedHead: genesisPrefix.head_identity!, candidate: target.candidate,
    review: {
      review: targetReview.body, canonical_bytes: targetReview.bytes,
      review_identity: targetReview.identity, correction_authority: null, correction_reviews: [],
    },
  });
  if (!targetAppend.proposedEntry) throw new Error('TEST_CORRECTION_TARGET_NOT_DERIVED');
  const replacement = await buildCandidate({ root: baseline.rootIdentity, label: 'correction-replacement~~~' });
  const replacementReview = await buildReview(replacement.candidate);
  const replacementAppend = await deriveManifestAppend({
    prefix: targetAppend.proposedPrefix, expectedHead: targetAppend.proposedPrefix.head_identity!, candidate: replacement.candidate,
    review: {
      review: replacementReview.body, canonical_bytes: replacementReview.bytes,
      review_identity: replacementReview.identity, correction_authority: null, correction_reviews: [],
    },
  });
  if (!replacementAppend.proposedEntry || replacementAppend.proposedPrefix.head_identity === null) {
    throw new Error('TEST_CORRECTION_REPLACEMENT_NOT_DERIVED');
  }
  const effectiveHead = replacementAppend.proposedPrefix.head_identity;
  const replacementRecordIds = [replacement.record.record_id];
  const authority = {
    schema_version: 'MES-CORRECTION-AUTHORITY-1', root_identity: baseline.rootIdentity,
    target_record_id: target.record.record_id, target_record_identity: target.identity,
    defect_code: 'FIXTURE_DEFECT~~~', replacement_record_ids: replacementRecordIds,
    effective_manifest_head_identity: effectiveHead, approver_identity: 'owner-a',
    approver_vendor_family: 'HUMAN_OWNER', decision: 'APPROVE',
  } as const;
  const authorityBytes = canonicalDocument(json(authority));
  const authorityIdentity = await contentIdentity(authorityBytes);
  const supportingReviews = (await Promise.all(['reviewer-c~~~', 'reviewer-d~~~'].map(async (reviewerIdentity) => {
    const review = {
      schema_version: 'MES-CORRECTION-REVIEW-1', root_identity: baseline.rootIdentity,
      target_record_id: target.record.record_id, target_record_identity: target.identity,
      defect_code: 'FIXTURE_DEFECT~~~', replacement_record_ids: replacementRecordIds,
      approval_identity: authorityIdentity, effective_manifest_head_identity: effectiveHead,
      builder_identity: 'builder-a', reviewer_identity: reviewerIdentity, reviewer_vendor_family: 'GOOGLE',
      separation: 'VERIFIED', verdict: 'APPROVE', reason_codes: [],
    } as const;
    const canonicalBytes = canonicalDocument(json(review));
    return { review, canonicalBytes, identity: await contentIdentity(canonicalBytes) };
  }))).sort((left, right) => {
    const leftKey = `${left.identity.sha256}\u0000${left.identity.byte_length}`;
    const rightKey = `${right.identity.sha256}\u0000${right.identity.byte_length}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const recordBody: JsonObject = {
    schema_version: 'MES-1', record_family: 'CORRECTION', record_id: sha('9'), root_identity: baseline.rootIdentity,
    evidence_key: 'pending',
    subject_identity: { subject_type: 'correction', subject_key: 'offline-correction-fixture', content_identity: identity('9') },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: { producer_id: 'builder-a', role: 'BUILDER', vendor_family: 'OPENAI', attestation: 'OFFLINE_FIXTURE' },
    source_receipts: [{ receipt_kind: 'REVIEW', receipt_id: 'correction-support-receipt', content_identity: identity('a') }],
    limitations: ['offline fixture only'],
    independent_review: {
      builder_identity: 'builder-a', reviewer_identity: 'UNKNOWN', separation: 'UNKNOWN',
      review_output_identity: await pendingReviewIdentity(), verdict: 'UNKNOWN', vendor_family: 'UNKNOWN',
    },
    payload: {
      target_record_id: target.record.record_id, target_record_identity: target.identity, defect_code: 'FIXTURE_DEFECT~~~',
      reason: 'Replace the exact defective fixture record.', replacement_record_ids: replacementRecordIds,
      approval_identity: authorityIdentity, review_output_identities: supportingReviews.map((item) => item.identity), effective_manifest_head_identity: effectiveHead,
    },
  };
  recordBody.evidence_key = await recordSha256(json({
    schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'CORRECTION', root_identity: baseline.rootIdentity,
    target_record_id: target.record.record_id,
  }));
  const { record_id: _discardedRecordId, ...withoutRecordId } = recordBody;
  recordBody.record_id = await recordSha256(json(withoutRecordId));
  const correctionRecord = validateEvidenceRecord(recordBody);
  if (correctionRecord.record_family !== 'CORRECTION') throw new Error('TEST_CORRECTION_FIXTURE_FAMILY_MISMATCH');
  const correctionBytes = canonicalDocument(json(correctionRecord));
  const correctionCandidate: CorrectionFixtureCandidate = {
    record: correctionRecord, canonical_bytes: correctionBytes, record_identity: await contentIdentity(correctionBytes),
  };
  const correctionReview = await buildReview(correctionCandidate);
  const correctionReviewCarrier: IndependentRecordReviewV1 = {
    review: correctionReview.body, canonical_bytes: correctionReview.bytes,
    review_identity: correctionReview.identity,
    correction_authority: { authority, canonical_bytes: authorityBytes, approval_identity: authorityIdentity },
    correction_reviews: supportingReviews.map((item) => ({
      review: item.review, canonical_bytes: item.canonicalBytes, review_output_identity: item.identity,
    })),
  };
  const correctionAppend = await deriveManifestAppend({
    prefix: replacementAppend.proposedPrefix, expectedHead: effectiveHead, candidate: correctionCandidate, review: correctionReviewCarrier,
  });
  if (!correctionAppend.proposedEntry) throw new Error('TEST_CORRECTION_NOT_DERIVED');
  const targetEntryBytes = canonicalDocument(json(targetAppend.proposedEntry));
  const targetEntryIdentity = await contentIdentity(targetEntryBytes);
  const replacementEntryBytes = canonicalDocument(json(replacementAppend.proposedEntry));
  const replacementEntryIdentity = await contentIdentity(replacementEntryBytes);
  const correctionEntryBytes = canonicalDocument(json(correctionAppend.proposedEntry));
  const correctionEntryIdentity = await contentIdentity(correctionEntryBytes);
  const correctionPacket = packetFor(correctionEntryBytes, correctionEntryIdentity, correctionCandidate, correctionReview);
  correctionPacket.correctionAuthority = blob(authorityBytes, authorityIdentity);
  correctionPacket.correctionReviews = supportingReviews.map((item) => blob(item.canonicalBytes, item.identity));
  const carrier: PrefixCarrier = {
    schemaVersion: 'MES-MANIFEST-PREFIX-CARRIER-1', rootIdentity: baseline.rootIdentity,
    packets: [
      { entry: blob(genesisBytes, genesisIdentity), candidate: null, review: null, correctionAuthority: null, correctionReviews: [] },
      packetFor(targetEntryBytes, targetEntryIdentity, target.candidate, targetReview),
      packetFor(replacementEntryBytes, replacementEntryIdentity, replacement.candidate, replacementReview),
      correctionPacket,
    ],
  };
  const bytesValue = canonicalDocument(json(carrier));
  return {
    carrier, bytes: bytesValue, identity: await contentIdentity(bytesValue), expectedHeadIdentity: correctionEntryIdentity,
    correctionCandidate,
  };
}

async function buildReceiptCarrier(
  baseline: DerivedEvidenceSpineBaseline,
  candidate: Awaited<ReturnType<typeof buildCandidate>>,
): Promise<{ carrier: ReceiptCarrier; bytes: Uint8Array; identity: ContentIdentity }> {
  const attempt = candidate.receiptPayloads[0];
  const browser = candidate.receiptPayloads[1];
  const d1Resolution = {
    ref: attempt.ref,
    subjectIdentity: candidate.subjectIdentity,
    committedAt: '2026-09-02T00:00:00.000Z',
    privacy: 'PUBLIC_METADATA',
    integrityProof: {
      proofKind: 'D1_IMMUTABLE_CORE', protectedSubjectIdentity: candidate.subjectIdentity,
      guardSetIdentity: await attemptGuardSetIdentity(), supportingReceiptRefs: [],
    } satisfies ReceiptIntegrityProofV1,
    canonicalBytesBase64: Buffer.from(attempt.canonicalBytes).toString('base64'),
    payload: attempt.payload,
  } satisfies JsonObject;
  const externalResolution = {
    ref: browser.ref,
    subjectIdentity: candidate.subjectIdentity,
    committedAt: '2026-09-02T00:00:00.000Z',
    privacy: 'ENCRYPTED_PRIVATE_CONTAINER',
    integrityProof: {
      proofKind: 'COMMITTED_EXTERNAL_CONTAINER',
      protectedSubjectIdentity: candidate.subjectIdentity,
      containerIdentity: identity('e', 30), policyIdentity: identity('f', 31), independentReadbackIdentity: identity('8', 32),
    } satisfies ReceiptIntegrityProofV1,
    canonicalBytesBase64: Buffer.from(browser.canonicalBytes).toString('base64'),
    payload: browser.payload,
  } satisfies JsonObject;
  const carrier: ReceiptCarrier = {
    schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1',
    rootIdentity: baseline.rootIdentity,
    candidateIdentity: candidate.identity,
    resolutions: [d1Resolution, externalResolution],
  };
  const bytesValue = canonicalDocument(json(carrier));
  return { carrier, bytes: bytesValue, identity: await contentIdentity(bytesValue) };
}

async function buildPolicy(root: ContentIdentity): Promise<{ policy: Policy; bytes: Uint8Array; identity: ContentIdentity }> {
  const policy: Policy = {
    schemaVersion: 'MES-INTEGRATION-ADMISSION-POLICY-1',
    rootIdentity: root,
    policyId: 'ROOT_REQUIREMENT_INDEPENDENCE_V1',
    nonBuilderRule: 'REVIEWER_IDENTITY_DISTINCT_AND_SEPARATION_VERIFIED',
    crossVendorRule: 'ANY_LINKED_CROSS_VENDOR_REQUIREMENT_REQUIRES_DISTINCT_VENDOR_FAMILY',
    sourceReceiptRule: 'EXACT_RESOLVED_CARRIER_REQUIRED',
  };
  const bytesValue = canonicalDocument(json(policy));
  return { policy, bytes: bytesValue, identity: await contentIdentity(bytesValue) };
}

async function buildFixture(options: {
  requirementId?: string;
  sliceId?: string;
  gate?: string;
  receiptId?: string;
  hiddenConditionalRequirementId?: string;
  hiddenN10V1FailureTell?: boolean;
  browserTargetLink?: JsonObject;
  attemptPayloadReceiptKind?: 'AI_INVOCATION_ATTEMPT' | 'BROWSER_ACTION_LOG';
  attemptReceiptId?: string;
} = {}) {
  const baseline = await baselinePromise;
  const priorCandidate = await buildCandidate({ root: baseline.rootIdentity, label: 'replayed-prior~~~' });
  const priorReview = await buildReview(priorCandidate.candidate);
  const prefix = await buildPrefixCarrier(baseline, priorCandidate.candidate, priorReview);
  const candidate = await buildCandidate({ root: baseline.rootIdentity, label: 'submitted-new~~~', hiddenN10V1FailureTell: true, ...options });
  const review = await buildReview(candidate.candidate);
  const receipt = await buildReceiptCarrier(baseline, candidate);
  const policy = await buildPolicy(baseline.rootIdentity);
  const input: IntegrateReviewedCandidateInput = {
    candidateBytes: cloneBytes(candidate.bytes),
    reviewBytes: cloneBytes(review.bytes),
    expectedRootIdentity: baseline.rootIdentity,
    expectedHeadIdentity: prefix.headIdentity,
    independencePolicyBytes: cloneBytes(policy.bytes),
    independencePolicyIdentity: policy.identity,
    receiptResolutionCarrierBytes: cloneBytes(receipt.bytes),
    receiptResolutionCarrierIdentity: receipt.identity,
    integratorAttribution: {
      actorIdentity: 'offline-integrator',
      sessionIdentity: 'session-integrator-red',
    },
    prefixCarrierBytes: cloneBytes(prefix.bytes),
    prefixCarrierIdentity: prefix.identity,
  };
  return { baseline, priorCandidate, priorReview, candidate, review, prefix, receipt, policy, input };
}

function canonicalCarrier<T extends JsonObject>(value: T): Promise<{ bytes: Uint8Array; identity: ContentIdentity }> {
  const bytesValue = canonicalDocument(json(value));
  return contentIdentity(bytesValue).then((content) => ({ bytes: bytesValue, identity: content }));
}

function inputWith(
  base: IntegrateReviewedCandidateInput,
  overrides: Partial<IntegrateReviewedCandidateInput>,
): IntegrateReviewedCandidateInput {
  return { ...base, ...overrides };
}

async function expectInputInvalid(apiValue: Api, root: EvidenceSpineRootV1, input: unknown): Promise<void> {
  if (!apiValue.prepareReviewedManifestAppend) throw new Error('TEST_PREPARE_EXPORT_MISSING');
  try {
    await apiValue.prepareReviewedManifestAppend(root, input as IntegrateReviewedCandidateInput);
    throw new Error('TEST_EXPECTED_INTEGRATION_REJECTION');
  } catch (error) {
    if (error instanceof Error && error.message === 'TEST_EXPECTED_INTEGRATION_REJECTION') throw error;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).name).toBe('Error');
    expect((error as Error).message).toBe('MES_INTEGRATION_INPUT_INVALID');
    expect(Object.keys(error as object)).toEqual([]);
  }
}

async function loadNamespace(path: string): Promise<{ namespace: Namespace; error: Error | null }> {
  try {
    const namespace = await import(path) as unknown as Namespace;
    return { namespace, error: null };
  } catch (error) {
    return {
      namespace: Object.freeze({}),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

const loadedModules = await Promise.all([
  loadNamespace('../../src/services/admission/evidence-spine-manifest'),
  loadNamespace('../../src/services/admission/product-receipts'),
  loadNamespace('../../src/services/admission/evidence-integrator'),
]);
const moduleErrors = loadedModules.flatMap((loaded) => loaded.error ? [loaded.error.message] : []);
const namespaces = loadedModules.map((loaded) => loaded.namespace);

function findExport<T>(name: string): T | undefined {
  for (const namespace of namespaces) {
    const value = namespace[name];
    if (typeof value === 'function') return value as T;
  }
  return undefined;
}

const api: Api = Object.freeze({
  verifyManifestPrefixCarrier: findExport<PrefixVerifier>('verifyManifestPrefixCarrier'),
  verifyIntegrationAdmissionPolicy: findExport<PolicyVerifier>('verifyIntegrationAdmissionPolicy'),
  verifyIntegrationReceiptResolutionCarrier: findExport<ReceiptVerifier>('verifyIntegrationReceiptResolutionCarrier'),
  prepareReviewedManifestAppend: findExport<PrepareIntegrator>('prepareReviewedManifestAppend'),
});

const apiReady = Object.values(api).every((value) => typeof value === 'function');

describe('Critical Path B Task 4 RED contract gate', () => {
  it('collects the missing module without an unrelated import, syntax, or helper failure', () => {
    const unexpectedModuleErrors = moduleErrors.filter((message) => !message.includes('evidence-integrator'));
    expect(unexpectedModuleErrors).toEqual([]);
  });

  it('keeps the approved verifier ownership split explicit', () => {
    if (!apiReady) return;
    const manifest = namespaces[0];
    const receipts = namespaces[1];
    const integrator = namespaces[2];
    expect(typeof manifest.verifyManifestPrefixCarrier).toBe('function');
    expect(typeof receipts.verifyIntegrationReceiptResolutionCarrier).toBe('function');
    expect(typeof integrator.verifyIntegrationAdmissionPolicy).toBe('function');
    expect(typeof integrator.prepareReviewedManifestAppend).toBe('function');
  });
});

describe('Task 3 settled fourteen-source baseline controls', () => {
  it('rehashes the reviewed root sources and keeps the N9 source in the root', async () => {
    const baseline = await baselinePromise;
    expect(baseline.rootIdentity).toEqual(approvedRootIdentity);
    expect(Object.keys(baseline.root.source_identities)).toHaveLength(14);
    expect(baseline.root.source_identities.n9_successor_policy).toEqual(approvedN9PolicyIdentity);
    expect(baseline.root.requirements).toHaveLength(64);
    expect(baseline.root.slice_ids).toHaveLength(11);
    expect(baseline.projection.requirements.filter((row) => row.status === 'PENDING')).toHaveLength(59);
    expect(baseline.projection.requirements.filter((row) => row.status === 'BLOCKED_CONTRACT')).toHaveLength(5);
    expect(baseline.projection.active_artifact_count).toBe(0);
    expect(baseline.projection.active_grade_count).toBe(0);
    expect(baseline.projection.same_grade_count).toBe(0);
    expect(baseline.projection.closure_status).toBe('NOT_EVALUATED');
  });

  it('matches the exact generated root, genesis, projection, and source bytes without promotion', async () => {
    const baseline = await baselinePromise;
    const settledRoot = bytes(outputPaths.root);
    const settledManifest = bytes(outputPaths.manifest);
    const settledProjection = bytes(outputPaths.projection);
    const settledPolicy = bytes(outputPaths.n9SuccessorPolicy);
    expect(byteEqual(settledRoot, baseline.documents.root)).toBe(true);
    expect(byteEqual(settledManifest, baseline.documents.manifest)).toBe(true);
    expect(byteEqual(settledProjection, baseline.documents.projection)).toBe(true);
    expect(byteEqual(settledPolicy, baseline.documents.sources.n9SuccessorPolicy)).toBe(true);
    expect(await contentIdentity(settledRoot)).toEqual(approvedRootIdentity);
    expect(await contentIdentity(settledManifest)).toEqual(approvedGenesisIdentity);
    expect(await contentIdentity(settledProjection)).toEqual(approvedProjectionIdentity);
    expect(await contentIdentity(settledPolicy)).toEqual(approvedN9PolicyIdentity);
    expect(byteEqual(canonicalDocument(parseAuthorityJson(settledRoot)), settledRoot)).toBe(true);
    expect(byteEqual(canonicalDocument(parseAuthorityJson(settledProjection)), settledProjection)).toBe(true);
  });

  it('rejects a changed Task 3 source before it can become a different root', async () => {
    const source = repositorySources();
    const changed = new Uint8Array(source.matrix);
    changed[0] ^= 0x01;
    await expect(deriveEvidenceSpineBaseline({ ...source, matrix: changed }))
      .rejects.toThrow('MES_BASELINE_SOURCE_IDENTITY_MISMATCH:matrix');
  });

  it('validates the synthetic candidate and review independently of the absent seam', async () => {
    const fixture = await buildFixture();
    expect(() => validateEvidenceRecord(fixture.candidate.record)).not.toThrow();
    expect(byteEqual(fixture.candidate.bytes, canonicalDocument(json(fixture.candidate.record)))).toBe(true);
    expect(fixture.candidate.identity).toEqual(await contentIdentity(fixture.candidate.bytes));
    expect(fixture.review.identity).toEqual(await contentIdentity(fixture.review.bytes));
    expect(fixture.candidate.identity).not.toEqual(fixture.priorCandidate.identity);
    expect(fixture.input.expectedHeadIdentity).toEqual(fixture.prefix.headIdentity);
    expect(fixture.prefix.carrier.packets).toHaveLength(2);
    expect(fixture.receipt.carrier.resolutions).toHaveLength(2);
    expect((fixture.receipt.carrier.resolutions as readonly JsonObject[])
      .some((resolution) => hasUrlSafeAlias(String(resolution.canonicalBytesBase64)))).toBe(true);
    expect(fixture.candidate.sourceRefs.map((ref) => `${ref.receipt_kind}\u0000${ref.receipt_id}`)).toEqual([
      'AI_INVOCATION_ATTEMPT\u0000attempt-submitted-new~~~', `BROWSER_ACTION_LOG\u0000${sha('a')}`,
    ]);
    expect(fixture.candidate.record.payload.bindings).toMatchObject({
      failure_tell_observations: [{ failure_tell_id: 'FT-N10-MOCK-AS-PRODUCTION', requirement_ids: ['N10-V1'] }],
    });
    const receiptPayloads = fixture.receipt.carrier.resolutions as readonly JsonObject[];
    expect(receiptPayloads).toHaveLength(2);
    const d1PayloadBase64 = String(receiptPayloads[0]!.canonicalBytesBase64);
    const d1PayloadBytes = new Uint8Array(Buffer.from(d1PayloadBase64, 'base64'));
    const d1Payload = parseAuthorityJson(d1PayloadBytes) as JsonObject;
    expect(d1Payload.receiptKind).toBe('AI_INVOCATION_ATTEMPT');
    expect(Object.keys(d1Payload.causal as JsonObject).sort()).toEqual([
      'cacheNamespaceIdentity', 'contextIdentity', 'routeTargetIdentity', 'sessionIdentity', 'terminalOutcome', 'turnNumber',
    ]);
    expect(d1PayloadBytes.every((value) => value <= 0x7d)).toBe(true);
    expect(receiptPayloads.map((resolution) => hasUrlSafeAlias(String(resolution.canonicalBytesBase64))))
      .toEqual([false, true]);
    expect(Object.keys(fixture.input).sort()).toEqual([
      'candidateBytes',
      'expectedHeadIdentity',
      'expectedRootIdentity',
      'independencePolicyBytes',
      'independencePolicyIdentity',
      'integratorAttribution',
      'prefixCarrierBytes',
      'prefixCarrierIdentity',
      'receiptResolutionCarrierBytes',
      'receiptResolutionCarrierIdentity',
      'reviewBytes',
    ]);
  });

  it('derives independently valid alternate-successor and correction-support replay preimages before the missing seam', async () => {
    const fixture = await buildFixture();
    const alternate = await buildGrammarValidAlternateSuccessorCarrier(fixture.baseline);
    expect(byteEqual(alternate.bytes, canonicalDocument(parseAuthorityJson(alternate.bytes)))).toBe(true);
    expect(alternate.forkEntry.predecessor_identity).toEqual(fixture.prefix.genesisPrefix.head_identity);
    const correction = await buildGrammarValidCorrectionCarrier(fixture.baseline);
    expect(() => validateEvidenceRecord(correction.correctionCandidate.record)).not.toThrow();
    expect(correction.carrier.packets).toHaveLength(4);
    expect(correction.carrier.packets[3]!.correctionAuthority).not.toBeNull();
    expect(correction.carrier.packets[3]!.correctionReviews).toHaveLength(2);
    expect(correction.correctionCandidate.record.payload.review_output_identities)
      .toEqual(correction.carrier.packets[3]!.correctionReviews.map((review) => review.contentIdentity));
    expect(hasUrlSafeAlias(correction.carrier.packets[3]!.correctionAuthority!.bytesBase64)).toBe(true);
    expect(correction.carrier.packets[3]!.correctionReviews.every((review) => hasUrlSafeAlias(review.bytesBase64))).toBe(true);
    expect(hasUrlSafeAlias(correction.carrier.packets[3]!.review!.bytesBase64)).toBe(true);
    expect(byteEqual(correction.bytes, canonicalDocument(parseAuthorityJson(correction.bytes)))).toBe(true);
  });

  it('requires the approved integrator module to be present during GREEN', () => {
    const path = resolve(process.cwd(), 'src/services/admission/evidence-integrator.ts');
    expect(existsSync(path)).toBe(true);
  });
});

describe.runIf(existsSync(resolve(process.cwd(), 'src/services/admission/evidence-integrator.ts')))('Task 4 future leaf-only static authority boundary', () => {
  it('keeps only policy/composition in the new leaf and forbids every authority expansion', () => {
    const path = resolve(process.cwd(), 'src/services/admission/evidence-integrator.ts');
    const source = readFileSync(path, 'utf8');
    const barrel = readFileSync(resolve(process.cwd(), 'src/services/admission/evidence-spine.ts'), 'utf8');
    const manifest = readFileSync(resolve(process.cwd(), 'src/services/admission/evidence-spine-manifest.ts'), 'utf8');
    const receipts = readFileSync(resolve(process.cwd(), 'src/services/admission/product-receipts.ts'), 'utf8');
    expect(source).toMatch(/verifyIntegrationAdmissionPolicy/u);
    expect(source).toMatch(/prepareReviewedManifestAppend/u);
    expect(source).toMatch(/\bverifyManifestPrefixCarrier\s*\(/u);
    expect(source).toMatch(/\bverifyIntegrationReceiptResolutionCarrier\s*\(/u);
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+verifyManifestPrefixCarrier/u);
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+verifyIntegrationReceiptResolutionCarrier/u);
    expect(source).not.toMatch(/export\s*\{[^}]*\b(?:verifyManifestPrefixCarrier|verifyIntegrationReceiptResolutionCarrier)\b[^}]*\}/su);
    expect(manifest).toMatch(/export\s+async\s+function\s+verifyManifestPrefixCarrier/u);
    expect(receipts).toMatch(/export\s+async\s+function\s+verifyIntegrationReceiptResolutionCarrier/u);
    expect(barrel).not.toMatch(/evidence-integrator/u);
    expect(source).not.toMatch(/(?:node:fs|node:path|writeFile|appendFile|readFile|D1Database|readCommittedReceipt|fetch\s*\(|XMLHttpRequest|WebSocket|playwright|puppeteer|browser|provider|ai-router|process\.env|globalThis\.|require\s*\()/iu);
    expect(source).not.toMatch(/(?:admitEvidence|markAdmitted|admissionStore|writeAdmission|manifest\.jsonl|projection\.json|grade|closure|canonical-base64|generic(?:Base64|Decoder)|export\s+(?:async\s+)?function\s+\w*(?:decode|parse)\w*Carrier|(?:^|\W)(?:decode|encode)(?:Base64|CanonicalBlob|ReceiptCarrier)\s*\()/iu);
  });
});

describe.skipIf(!apiReady)('Task 4 exact prefix-carrier replay oracle', () => {
  it('returns a byte-bearing verified prefix with the exact two-packet replay', async () => {
    const fixture = await buildFixture();
    const verified = await api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      fixture.prefix.headIdentity,
      fixture.prefix.bytes,
      fixture.prefix.identity,
    );
    expect(verified).not.toBeNull();
    expect(Object.keys(verified!).sort()).toEqual(['carrierBytes', 'carrierIdentity', 'prefix']);
    expect(byteEqual(verified!.carrierBytes, fixture.prefix.bytes)).toBe(true);
    expect(verified!.carrierIdentity).toEqual(fixture.prefix.identity);
    expect(verified!.prefix.status).toBe('VERIFIED');
    expect(verified!.prefix.entries).toHaveLength(2);
    expect(verified!.prefix.entries[0]).toEqual(fixture.baseline.genesisEntry);
    expect(verified!.prefix.head_identity).toEqual(fixture.prefix.headIdentity);
  });

  it.each([
    ['absent bytes', 'absent'],
    ['wrong carrier identity', 'identity'],
    ['wrong expected root', 'root'],
    ['wrong expected head', 'head'],
    ['caller supplied structural prefix', 'structural'],
  ] as const)('fails closed for %s', async (_label, kind) => {
    const fixture = await buildFixture();
    let expectedRoot = fixture.baseline.rootIdentity;
    let expectedHead = fixture.prefix.headIdentity;
    let carrierBytes = fixture.prefix.bytes;
    let carrierIdentity = fixture.prefix.identity;
    if (kind === 'absent') carrierBytes = new Uint8Array();
    if (kind === 'identity') carrierIdentity = identity('f');
    if (kind === 'root') expectedRoot = identity('f');
    if (kind === 'head') expectedHead = identity('f');
    if (kind === 'structural') carrierBytes = fixture.prefix.genesisPrefix as unknown as Uint8Array;
    await expect(api.verifyManifestPrefixCarrier!(expectedRoot, expectedHead, carrierBytes, carrierIdentity))
      .resolves.toBeNull();
  });

  it.each([
    ['whitespace', (value: string) => ` ${value}`],
    ['URL-safe alphabet', urlSafeAlias],
    ['missing required padding', missingPaddingAlias],
    ['interior padding', (value: string) => `${value.slice(0, 1)}=${value.slice(1)}`],
    ['excess trailing padding', (value: string) => `${value}=`],
    ['non-zero pad bits', nonCanonicalPadBits],
  ] as const)('rejects changed strict-base64 aliases on every applicable prefix blob: %s', async (_label, alias) => {
    const fixture = await buildFixture();
    const correction = await buildGrammarValidCorrectionCarrier(fixture.baseline);
    const carrierCases = [
      { carrier: fixture.prefix.carrier, expectedHeadIdentity: fixture.prefix.headIdentity, label: 'ordinary' },
      { carrier: correction.carrier, expectedHeadIdentity: correction.expectedHeadIdentity, label: 'correction' },
    ];
    let exercised = 0;
    let exercisedCorrectionAuthority = false;
    let exercisedCorrectionReview = false;
    let exercisedReview = false;
    for (const carrierCase of carrierCases) {
      const blobPaths = carrierCase.carrier.packets.flatMap((packet, packetIndex) => [
        [`packets.${packetIndex}.entry`, packet.entry] as const,
        ...(packet.candidate ? [[`packets.${packetIndex}.candidate`, packet.candidate] as const] : []),
        ...(packet.review ? [[`packets.${packetIndex}.review`, packet.review] as const] : []),
        ...(packet.correctionAuthority ? [[`packets.${packetIndex}.correctionAuthority`, packet.correctionAuthority] as const] : []),
        ...packet.correctionReviews.map((blobValue, reviewIndex) => [`packets.${packetIndex}.correctionReviews.${reviewIndex}`, blobValue] as const),
      ]);
      const applicable = blobPaths.filter(([, blobValue]) => {
        const padding = blobValue.bytesBase64.match(/=+$/u)?.[0] ?? '';
        if (_label === 'URL-safe alphabet') return hasUrlSafeAlias(blobValue.bytesBase64);
        return !['missing required padding', 'non-zero pad bits'].includes(_label) || padding.length > 0;
      });
      for (const [path, original] of applicable) {
        const carrier = clone(carrierCase.carrier);
        const packetIndex = Number(path.split('.')[1]);
        const packet = carrier.packets[packetIndex]!;
        const target = path.includes('.candidate') ? packet.candidate
          : path.includes('.review') && !path.includes('correctionReviews') ? packet.review
            : path.includes('.correctionAuthority') ? packet.correctionAuthority
              : path.includes('.correctionReviews') ? packet.correctionReviews[Number(path.split('.')[3])]
                : packet.entry;
        if (!target) throw new Error('TEST_PREFIX_BLOB_TARGET_MISSING');
        const changed = alias(original.bytesBase64);
        expect(changed).not.toBe(original.bytesBase64);
        if (_label === 'URL-safe alphabet') {
          expect(byteEqual(new Uint8Array(Buffer.from(changed, 'base64')), new Uint8Array(Buffer.from(original.bytesBase64, 'base64')))).toBe(true);
        }
        target.bytesBase64 = changed;
        const rebuilt = await canonicalCarrier(carrier);
        await expect(api.verifyManifestPrefixCarrier!(
          fixture.baseline.rootIdentity,
          carrierCase.expectedHeadIdentity,
          rebuilt.bytes,
          rebuilt.identity,
        )).resolves.toBeNull();
        exercised += 1;
        exercisedCorrectionAuthority ||= carrierCase.label === 'correction' && path.includes('.correctionAuthority');
        exercisedCorrectionReview ||= carrierCase.label === 'correction' && path.includes('.correctionReviews');
        exercisedReview ||= path.includes('.review');
      }
    }
    expect(exercised).toBeGreaterThan(0);
    if (_label === 'URL-safe alphabet') {
      expect(exercisedCorrectionAuthority).toBe(true);
      expect(exercisedCorrectionReview).toBe(true);
      expect(exercisedReview).toBe(true);
    }
  });

  it.each([
    ['empty nested blob', (blobValue: ExactCanonicalBlob) => { blobValue.bytesBase64 = ''; }],
    ['wrong nested identity', (blobValue: ExactCanonicalBlob) => { blobValue.contentIdentity = identity('f'); }],
  ] as const)('rejects %s after rehashing the outer carrier', async (_label, mutate) => {
    const fixture = await buildFixture();
    const carrier = clone(fixture.prefix.carrier);
    mutate(carrier.packets[1]!.candidate!);
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      fixture.prefix.headIdentity,
      rebuilt.bytes,
      rebuilt.identity,
    )).resolves.toBeNull();
  });

  it.each([
    ['missing genesis', (carrier: PrefixCarrier) => { carrier.packets.shift(); }],
    ['packet reorder', (carrier: PrefixCarrier) => { carrier.packets.reverse(); }],
    ['ordinal gap', async (carrier: PrefixCarrier) => {
      const entry = parseAuthorityJson(Buffer.from(carrier.packets[1].entry.bytesBase64, 'base64')) as JsonObject;
      entry.ordinal = 2;
      await replaceBlobBytes(carrier.packets[1].entry, canonicalDocument(json(entry)));
    }],
    ['predecessor fork', async (carrier: PrefixCarrier) => {
      const entry = parseAuthorityJson(Buffer.from(carrier.packets[1].entry.bytesBase64, 'base64')) as JsonObject;
      entry.predecessor_identity = identity('f');
      await replaceBlobBytes(carrier.packets[1].entry, canonicalDocument(json(entry)));
    }],
    ['missing candidate backing', (carrier: PrefixCarrier) => { carrier.packets[1].candidate = null; }],
    ['missing review backing', (carrier: PrefixCarrier) => { carrier.packets[1].review = null; }],
    ['changed candidate bytes', async (carrier: PrefixCarrier, fixture: Awaited<ReturnType<typeof buildFixture>>) => {
      const changed = await buildCandidate({ root: fixture.baseline.rootIdentity, label: 'changed-candidate~~~' });
      await replaceBlobBytes(carrier.packets[1].candidate!, changed.bytes);
    }],
    ['changed review bytes', async (carrier: PrefixCarrier, fixture: Awaited<ReturnType<typeof buildFixture>>) => {
      const changed = await buildReview(fixture.priorCandidate.candidate, { reviewer_identity: 'reviewer-changed' });
      await replaceBlobBytes(carrier.packets[1].review!, changed.bytes);
    }],
  ] as const)('rejects grammar-valid structural replay mutation: %s', async (_label, mutate) => {
    const fixture = await buildFixture();
    const carrier = clone(fixture.prefix.carrier);
    await mutate(carrier, fixture);
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      fixture.prefix.headIdentity,
      rebuilt.bytes,
      rebuilt.identity,
    )).resolves.toBeNull();
  });

  it('rejects a grammar-valid alternate successor whose exact entry was derived from the same genesis', async () => {
    const fixture = await buildFixture();
    const alternate = await buildGrammarValidAlternateSuccessorCarrier(fixture.baseline);
    expect(alternate.forkEntry.ordinal).toBe(1);
    expect(alternate.forkEntry.predecessor_identity).toEqual(fixture.prefix.genesisPrefix.head_identity);
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      alternate.expectedHeadIdentity,
      alternate.bytes,
      alternate.identity,
    )).resolves.toBeNull();
  });

  it('rejects only missing correction support from an otherwise exact correction replay', async () => {
    const fixture = await buildFixture();
    const correction = await buildGrammarValidCorrectionCarrier(fixture.baseline);
    expect(() => validateEvidenceRecord(correction.correctionCandidate.record)).not.toThrow();
    const carrier = clone(correction.carrier);
    carrier.packets[3]!.correctionReviews = [];
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      correction.expectedHeadIdentity,
      rebuilt.bytes,
      rebuilt.identity,
    )).resolves.toBeNull();
  });

  it('rejects a rehashed transitive duplicate correction-review envelope after every packet remains ordinal/predecessor/replay valid', async () => {
    const fixture = await buildFixture();
    const correction = await buildGrammarValidCorrectionCarrier(fixture.baseline);
    const carrier = clone(correction.carrier);
    expect(carrier.packets[3]!.correctionReviews).toHaveLength(2);
    expect(correction.correctionCandidate.record.payload.review_output_identities)
      .toEqual(carrier.packets[3]!.correctionReviews.map((review) => review.contentIdentity));
    expect(carrier.packets[3]!.correctionReviews[0]).not.toEqual(carrier.packets[3]!.correctionReviews[1]);
    carrier.packets[3]!.correctionReviews[1] = clone(carrier.packets[3]!.correctionReviews[0]!);
    expect(carrier.packets[3]!.correctionReviews).toHaveLength(2);
    expect(carrier.packets[3]!.correctionReviews[1]).toEqual(carrier.packets[3]!.correctionReviews[0]);
    for (const [ordinal, packet] of carrier.packets.entries()) {
      expect(parseAuthorityJson(Buffer.from(packet.entry.bytesBase64, 'base64'))).toMatchObject({ ordinal });
    }
    for (let index = 1; index < carrier.packets.length; index += 1) {
      expect(parseAuthorityJson(Buffer.from(carrier.packets[index]!.entry.bytesBase64, 'base64')))
        .toMatchObject({ predecessor_identity: carrier.packets[index - 1]!.entry.contentIdentity });
    }
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      correction.expectedHeadIdentity,
      rebuilt.bytes,
      rebuilt.identity,
    )).resolves.toBeNull();
  });

  it('rejects stale carrier head and caller-side prefix substitution', async () => {
    const fixture = await buildFixture();
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      fixture.prefix.genesisPrefix.head_identity!,
      fixture.prefix.bytes,
      fixture.prefix.identity,
    )).resolves.toBeNull();
    await expect(api.verifyManifestPrefixCarrier!(
      fixture.baseline.rootIdentity,
      fixture.prefix.headIdentity,
      fixture.prefix.genesisPrefix as unknown as Uint8Array,
      fixture.prefix.identity,
    )).resolves.toBeNull();
    const throwingIdentity = new Proxy({}, {
      ownKeys(): never { throw new Error('TEST_PREFIX_PROXY_TRAP'); },
    }) as ContentIdentity;
    await expect(api.verifyManifestPrefixCarrier!(
      throwingIdentity,
      fixture.prefix.headIdentity,
      fixture.prefix.bytes,
      fixture.prefix.identity,
    )).resolves.toBeNull();
  });
});

describe.skipIf(!apiReady)('Task 4 root-bound policy and schema-aware independence oracle', () => {
  it('accepts only the exact canonical five-field policy bound to the recomputed root', async () => {
    const fixture = await buildFixture();
    const result = await api.verifyIntegrationAdmissionPolicy!(
      fixture.baseline.root,
      fixture.policy.bytes,
      fixture.policy.identity,
    );
    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual([
      'crossVendorRule', 'nonBuilderRule', 'policyId', 'rootIdentity', 'schemaVersion', 'sourceReceiptRule',
    ]);
    expect(result!.rootIdentity).toEqual(fixture.baseline.rootIdentity);
  });

  it.each([
    ['absent policy bytes', 'absent'],
    ['wrong policy identity', 'identity'],
    ['noncanonical policy bytes', 'noncanonical'],
    ['unknown policy field', 'unknown'],
    ['policy root mismatch', 'root'],
  ] as const)('returns null for %s', async (_label, kind) => {
    const fixture = await buildFixture();
    let policyBytes = fixture.policy.bytes;
    let policyIdentity = fixture.policy.identity;
    if (kind === 'absent') policyBytes = new Uint8Array();
    if (kind === 'identity') policyIdentity = identity('f');
    if (kind === 'noncanonical') policyBytes = Buffer.from(` ${JSON.stringify({ schemaVersion: 'MES-INTEGRATION-ADMISSION-POLICY-1' })}\n`);
    if (kind === 'unknown') {
      const rebuilt = await canonicalCarrier({ ...fixture.policy.policy, unknownField: true });
      policyBytes = rebuilt.bytes;
      policyIdentity = rebuilt.identity;
    }
    if (kind === 'root') {
      const rebuilt = await canonicalCarrier({ ...fixture.policy.policy, rootIdentity: identity('f') });
      policyBytes = rebuilt.bytes;
      policyIdentity = rebuilt.identity;
    }
    await expect(api.verifyIntegrationAdmissionPolicy!(fixture.baseline.root, policyBytes, policyIdentity))
      .resolves.toBeNull();
  });

  it.each([
    ['unknown requirement membership', { requirementId: 'N99-D1' }],
    ['slice mismatch', { requirementId: 'N0-D1', sliceId: 'N1', gate: 'D' }],
    ['gate mismatch', { requirementId: 'N0-D1', sliceId: 'N0', gate: 'S' }],
    ['secondary conditional requirement drift', { requirementId: 'N0-D1', hiddenConditionalRequirementId: 'N99-L1' }],
  ] as const)('rejects candidate linkage: %s', async (_label, options) => {
    const fixture = await buildFixture(options);
    await expectInputInvalid(api, fixture.baseline.root, fixture.input);
  });

  it('does not accept a former thirteen-source root or a drifted Task 3 root', async () => {
    const fixture = await buildFixture();
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, {
      expectedRootIdentity: identity('0'),
    }));
    const driftedRoot = clone(fixture.baseline.root);
    driftedRoot.source_identities.n9_successor_policy = identity('f');
    await expectInputInvalid(api, driftedRoot, fixture.input);
  });

  it('accepts ordinary NON_BUILDER linkage with distinct reviewer identity even when the vendor family is unchanged', async () => {
    const ordinary = await buildFixture({ hiddenN10V1FailureTell: false });
    const sameFamilyReview = await buildReview(ordinary.candidate.candidate, {
      reviewer_vendor_family: 'OPENAI',
      reviewer_identity: 'reviewer-distinct',
      separation: 'VERIFIED',
    });
    const proposal = await api.prepareReviewedManifestAppend!(ordinary.baseline.root, inputWith(ordinary.input, {
      reviewBytes: sameFamilyReview.bytes,
    }));
    expect(proposal.status).toBe('PROPOSED_NOT_ADMITTED');

    const sameIdentityReview = await buildReview(ordinary.candidate.candidate, {
      reviewer_identity: 'builder-a',
      reviewer_vendor_family: 'ANTHROPIC',
      separation: 'VERIFIED',
    });
    await expectInputInvalid(api, ordinary.baseline.root, inputWith(ordinary.input, { reviewBytes: sameIdentityReview.bytes }));
  });

  it('enforces hidden secondary N10-V1 cross-vendor linkage rather than an unknown requirement ID', async () => {
    const hiddenCrossVendor = await buildFixture();
    const bindings = hiddenCrossVendor.candidate.record.payload.bindings;
    expect(hiddenCrossVendor.candidate.record.payload.evidence_requirement_ids).toEqual(['N0-D1']);
    expect(bindings.failure_tell_observations).toMatchObject([
      { failure_tell_id: 'FT-N10-MOCK-AS-PRODUCTION', requirement_ids: ['N10-V1'] },
    ]);
    const sameVendorReview = await buildReview(hiddenCrossVendor.candidate.candidate, {
      reviewer_vendor_family: 'OPENAI', reviewer_identity: 'reviewer-distinct', separation: 'VERIFIED',
    });
    await expectInputInvalid(api, hiddenCrossVendor.baseline.root, inputWith(hiddenCrossVendor.input, {
      reviewBytes: sameVendorReview.bytes,
    }));
    const proposal = await api.prepareReviewedManifestAppend!(hiddenCrossVendor.baseline.root, hiddenCrossVendor.input);
    expect(proposal.status).toBe('PROPOSED_NOT_ADMITTED');
  });

  it('does not trust parsed inputs and rejects root-bound negative-control control/slice/gate drift', async () => {
    const fixture = await buildFixture();
    const fakePolicyBytes = fixture.policy.policy as unknown as Uint8Array;
    const fakePrefixBytes = fixture.prefix.genesisPrefix as unknown as Uint8Array;
    await expect(api.verifyIntegrationAdmissionPolicy!(fixture.baseline.root, fakePolicyBytes, fixture.policy.identity))
      .resolves.toBeNull();
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, {
      independencePolicyBytes: fakePolicyBytes,
      prefixCarrierBytes: fakePrefixBytes,
    }));

    const state = fixture.baseline.root.negative_controls.find((definition) => definition.id === 'NC-STATE');
    const provenance = fixture.baseline.root.negative_controls.find((definition) => definition.id === 'NC-PROVENANCE');
    if (!state || !provenance) throw new Error('TEST_NEGATIVE_CONTROL_FIXTURE_MISSING');
    const inputForNegativeControl = async (candidate: Awaited<ReturnType<typeof buildNegativeControlCandidate>>) => {
      const review = await buildReview(candidate.candidate);
      const receipt = await canonicalCarrier({
        schemaVersion: 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1',
        rootIdentity: fixture.baseline.rootIdentity,
        candidateIdentity: candidate.identity,
        resolutions: [],
      });
      return inputWith(fixture.input, {
        candidateBytes: candidate.bytes,
        reviewBytes: review.bytes,
        receiptResolutionCarrierBytes: receipt.bytes,
        receiptResolutionCarrierIdentity: receipt.identity,
      });
    };
    const exactCandidate = await buildNegativeControlCandidate(fixture.baseline, {
      controlId: state.id,
      sliceIds: state.applicable_slice_ids,
      requirementLinks: state.requirement_links as unknown as readonly JsonObject[],
      expectedOutcome: state.expected_outcome,
    });
    await expect(api.prepareReviewedManifestAppend!(fixture.baseline.root, await inputForNegativeControl(exactCandidate)))
      .resolves.toMatchObject({ status: 'PROPOSED_NOT_ADMITTED' });
    const cases = [
      {
        controlId: provenance.id,
        sliceIds: state.applicable_slice_ids,
        requirementLinks: state.requirement_links as unknown as readonly JsonObject[],
        expectedOutcome: state.expected_outcome,
      },
      {
        controlId: state.id,
        sliceIds: ['N1'],
        requirementLinks: state.requirement_links as unknown as readonly JsonObject[],
        expectedOutcome: state.expected_outcome,
      },
      {
        controlId: state.id,
        sliceIds: state.applicable_slice_ids,
        requirementLinks: [{ slice_id: 'N0', gate: 'S', evidence_requirement_ids: ['N0-S1'] }],
        expectedOutcome: state.expected_outcome,
      },
    ] as const;
    for (const testCase of cases) {
      const candidate = await buildNegativeControlCandidate(fixture.baseline, testCase);
      await expectInputInvalid(api, fixture.baseline.root, await inputForNegativeControl(candidate));
    }

    const throwingIdentity = new Proxy({}, {
      ownKeys(): never { throw new Error('TEST_POLICY_PROXY_TRAP'); },
    }) as ContentIdentity;
    await expect(api.verifyIntegrationAdmissionPolicy!(fixture.baseline.root, fixture.policy.bytes, throwingIdentity))
      .resolves.toBeNull();
  });
});

describe.skipIf(!apiReady)('Task 4 byte-authoritative receipt-resolution oracle', () => {
  it('accepts two exact, sorted resolution entries through both closed proof/privacy paths', async () => {
    const fixture = await buildFixture();
    const result = await api.verifyIntegrationReceiptResolutionCarrier!(
      fixture.baseline.root,
      fixture.candidate.candidate,
      fixture.receipt.bytes,
      fixture.receipt.identity,
    );
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(fixture.candidate.record.source_receipts.length);
    expect(result!.map((resolution) => resolution.status === 'RESOLVED'
      ? `${resolution.ref.receipt_kind}\u0000${resolution.ref.receipt_id}` : resolution.status)).toEqual(
      fixture.candidate.sourceRefs.map((ref) => `${ref.receipt_kind}\u0000${ref.receipt_id}`),
    );
    expect(result![0]).toMatchObject({
      status: 'RESOLVED', privacy: 'PUBLIC_METADATA',
      integrityProof: { proofKind: 'D1_IMMUTABLE_CORE', supportingReceiptRefs: [] },
    });
    expect(result![1]).toMatchObject({
      status: 'RESOLVED', privacy: 'ENCRYPTED_PRIVATE_CONTAINER',
      integrityProof: { proofKind: 'COMMITTED_EXTERNAL_CONTAINER' },
    });
  });

  it.each([
    ['absent carrier bytes', 'absent'],
    ['wrong carrier identity', 'identity'],
    ['missing candidate ref resolution', 'missing'],
    ['extra resolution', 'extra'],
    ['duplicate resolution', 'duplicate'],
    ['reordered resolution', 'reordered'],
    ['wrong carrier root', 'root'],
    ['wrong carrier candidate', 'candidate'],
    ['substituted ref', 'ref'],
    ['altered canonical bytes', 'bytes'],
    ['structural resolution carrier substitution', 'structural'],
  ] as const)('rejects receipt carrier case: %s', async (_label, kind) => {
    const fixture = await buildFixture();
    if (kind === 'absent' || kind === 'structural') {
      const value = kind === 'absent' ? new Uint8Array() : fixture.receipt.carrier as unknown as Uint8Array;
      await expect(api.verifyIntegrationReceiptResolutionCarrier!(fixture.baseline.root, fixture.candidate.candidate, value, fixture.receipt.identity))
        .resolves.toBeNull();
      return;
    }
    const carrier = clone(fixture.receipt.carrier);
    if (kind === 'identity') {
      const rebuilt = await canonicalCarrier(carrier);
      await expect(api.verifyIntegrationReceiptResolutionCarrier!(fixture.baseline.root, fixture.candidate.candidate, rebuilt.bytes, identity('f')))
        .resolves.toBeNull();
      return;
    }
    if (kind === 'missing') carrier.resolutions = [carrier.resolutions[0]!];
    if (kind === 'extra' || kind === 'duplicate') carrier.resolutions = [carrier.resolutions[0], carrier.resolutions[0]];
    if (kind === 'reordered') carrier.resolutions.reverse();
    if (kind === 'root') carrier.rootIdentity = identity('f');
    if (kind === 'candidate') carrier.candidateIdentity = identity('f');
    if (kind === 'ref') {
      const resolution = carrier.resolutions[0] as JsonObject;
      resolution.ref = { ...(resolution.ref as JsonObject), receipt_id: 'other-ref' };
    }
    if (kind === 'bytes') {
      const resolution = carrier.resolutions[0] as JsonObject;
      resolution.canonicalBytesBase64 = Buffer.from('{"altered":true}\n').toString('base64');
    }
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(fixture.baseline.root, fixture.candidate.candidate, rebuilt.bytes, rebuilt.identity))
      .resolves.toBeNull();
  });

  it.each([
    ['whitespace', (value: string) => ` ${value}`],
    ['URL-safe alphabet', urlSafeAlias],
    ['missing required padding', missingPaddingAlias],
    ['interior padding', (value: string) => `${value.slice(0, 1)}=${value.slice(1)}`],
    ['excess trailing padding', (value: string) => `${value}=`],
    ['non-zero pad bits', nonCanonicalPadBits],
  ] as const)('rejects changed strict-base64 aliases on every applicable receipt payload blob: %s', async (_label, alias) => {
    const fixture = await buildFixture();
    const originalResolutions = fixture.receipt.carrier.resolutions as readonly JsonObject[];
    const allResolutionIndexes = originalResolutions.map((_resolution, index) => index);
    const urlSafeAliasAvailability = originalResolutions.map((resolution) => hasUrlSafeAlias(String(resolution.canonicalBytesBase64)));
    const applicableIndexes = originalResolutions.flatMap((resolution, index) => {
      const original = String(resolution.canonicalBytesBase64);
      const padded = /=$/u.test(original);
      if (_label === 'URL-safe alphabet') return hasUrlSafeAlias(original) ? [index] : [];
      return (!['missing required padding', 'non-zero pad bits'].includes(_label) || padded) ? [index] : [];
    });
    if (_label === 'URL-safe alphabet') expect(urlSafeAliasAvailability).toEqual([false, true]);
    else expect(applicableIndexes.length).toBeGreaterThan(0);
    const mutationIndexes = _label === 'URL-safe alphabet' ? allResolutionIndexes : applicableIndexes;
    for (const index of mutationIndexes) {
      const carrier = clone(fixture.receipt.carrier);
      const resolution = carrier.resolutions[index] as JsonObject;
      const original = String(resolution.canonicalBytesBase64);
      const sameByteAlias = _label === 'URL-safe alphabet' && hasUrlSafeAlias(original);
      const changed = _label === 'URL-safe alphabet' && !sameByteAlias ? `-${original.slice(1)}` : alias(original);
      expect(changed).not.toBe(original);
      if (sameByteAlias) {
        expect(byteEqual(new Uint8Array(Buffer.from(changed, 'base64')), new Uint8Array(Buffer.from(original, 'base64')))).toBe(true);
      }
      resolution.canonicalBytesBase64 = changed;
      const rebuilt = await canonicalCarrier(carrier);
      await expect(api.verifyIntegrationReceiptResolutionCarrier!(
        fixture.baseline.root, fixture.candidate.candidate, rebuilt.bytes, rebuilt.identity,
      )).resolves.toBeNull();
    }
  });

  it.each([
    ['D1 proof paired with encrypted privacy', 0, (resolution: JsonObject) => { resolution.privacy = 'ENCRYPTED_PRIVATE_CONTAINER'; }],
    ['external proof paired with public privacy', 1, (resolution: JsonObject) => { resolution.privacy = 'PUBLIC_METADATA'; }],
    ['malformed canonical time', 0, (resolution: JsonObject) => { resolution.committedAt = '2026-09-02T00:00:00Z'; }],
    ['proof subject mismatch', 0, (resolution: JsonObject) => { (resolution.integrityProof as JsonObject).protectedSubjectIdentity = identity('f'); }],
    ['equal external proof identities', 1, (resolution: JsonObject) => {
      const proof = resolution.integrityProof as JsonObject;
      proof.containerIdentity = identity('e', 5);
      proof.policyIdentity = identity('e', 5);
    }],
    ['receipt payload subject mismatch', 0, (resolution: JsonObject) => { (resolution.payload as JsonObject).subjectIdentity = identity('f'); }],
    ['D1 wrong guard set', 0, (resolution: JsonObject) => {
      (resolution.integrityProof as JsonObject).guardSetIdentity = identity('f');
    }],
    ['non-empty D1 supporting ref against the settled closed empty-proof constructor', 0, (resolution: JsonObject) => {
      const proof = resolution.integrityProof as JsonObject;
      proof.supportingReceiptRefs = [resolution.ref];
    }],
  ] as const)('rejects proof/privacy/time/payload matrix violation after carrier rehash: %s', async (_label, resolutionIndex, mutate) => {
    const fixture = await buildFixture();
    const carrier = clone(fixture.receipt.carrier);
    mutate(carrier.resolutions[resolutionIndex] as JsonObject);
    const rebuilt = await canonicalCarrier(carrier);
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(fixture.baseline.root, fixture.candidate.candidate, rebuilt.bytes, rebuilt.identity))
      .resolves.toBeNull();
  });

  it('rejects schema-valid private-data and plaintext/hash linkage canaries without an unknown key masking privacy', async () => {
    const privateFixture = await buildFixture({ browserTargetLink: { locator: 'private-account-canary' } });
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      privateFixture.baseline.root, privateFixture.candidate.candidate, privateFixture.receipt.bytes, privateFixture.receipt.identity,
    )).resolves.toBeNull();

    const raw = 'red-fixture-plaintext';
    const digest = await (await import('../../src/services/admission/identity')).sha256Hex(new TextEncoder().encode(raw));
    const linkageFixture = await buildFixture({ browserTargetLink: { locator: raw, digest } });
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      linkageFixture.baseline.root, linkageFixture.candidate.candidate, linkageFixture.receipt.bytes, linkageFixture.receipt.identity,
    ))
      .resolves.toBeNull();

    const crossResolutionRaw = 'cross-resolution-plaintext';
    const crossResolutionDigest = await (await import('../../src/services/admission/identity'))
      .sha256Hex(new TextEncoder().encode(crossResolutionRaw));
    const crossResolutionFixture = await buildFixture({
      browserTargetLink: { locator: crossResolutionRaw },
      attemptReceiptId: crossResolutionDigest,
    });
    expect(crossResolutionFixture.receipt.carrier.resolutions).toHaveLength(2);
    expect((crossResolutionFixture.receipt.carrier.resolutions[0] as JsonObject).ref)
      .toMatchObject({ receipt_id: crossResolutionDigest });
    expect(((crossResolutionFixture.receipt.carrier.resolutions[1] as JsonObject).payload as JsonObject).causal)
      .toMatchObject({ targetLink: { locator: crossResolutionRaw } });
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      crossResolutionFixture.baseline.root,
      crossResolutionFixture.candidate.candidate,
      crossResolutionFixture.receipt.bytes,
      crossResolutionFixture.receipt.identity,
    )).resolves.toBeNull();
  });

  it('rejects a grammar-valid receipt payload whose kind conflicts with its exact candidate ref', async () => {
    const fixture = await buildFixture({ attemptPayloadReceiptKind: 'BROWSER_ACTION_LOG' });
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      fixture.baseline.root, fixture.candidate.candidate, fixture.receipt.bytes, fixture.receipt.identity,
    )).resolves.toBeNull();
  });

  it('does not use an ambient receipt map, D1 reread, provider, network, or structural brand', async () => {
    const fixture = await buildFixture();
    const fakeResolution = [{
      status: 'RESOLVED',
      ref: fixture.candidate.sourceRef,
      subjectIdentity: fixture.candidate.subjectIdentity,
      committedAt: '2026-09-02T00:00:00.000Z',
      privacy: 'ENCRYPTED_PRIVATE_CONTAINER',
      integrityProof: { proofKind: 'COMMITTED_EXTERNAL_CONTAINER' },
      canonicalBytes: fixture.receipt.bytes,
      payload: {},
    }] as unknown as Uint8Array;
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(fixture.baseline.root, fixture.candidate.candidate, fakeResolution, fixture.receipt.identity))
      .resolves.toBeNull();

    const mutableCandidate: DetachedRecordCandidate = {
      record: clone(fixture.candidate.candidate.record),
      canonical_bytes: cloneBytes(fixture.candidate.candidate.canonical_bytes),
      record_identity: clone(fixture.candidate.candidate.record_identity),
    };
    const pending = api.verifyIntegrationReceiptResolutionCarrier!(
      fixture.baseline.root,
      mutableCandidate as DetachedRecordCandidate,
      fixture.receipt.bytes,
      fixture.receipt.identity,
    );
    mutableCandidate.canonical_bytes[0] ^= 0x01;
    mutableCandidate.record = {} as EvidenceRecordV1;
    mutableCandidate.record_identity.sha256 = sha('f');
    const settled = await pending;
    expect(settled).not.toBeNull();
    expect(settled).toHaveLength(2);

    let getterReads = 0;
    const accessorCandidate = {
      canonical_bytes: cloneBytes(fixture.candidate.candidate.canonical_bytes),
      record_identity: clone(fixture.candidate.candidate.record_identity),
    } as Record<string, unknown>;
    Object.defineProperty(accessorCandidate, 'record', {
      enumerable: true,
      get(): never {
        getterReads += 1;
        throw new Error('TEST_RECEIPT_CANDIDATE_GETTER_AFTER_AWAIT');
      },
    });
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      fixture.baseline.root,
      accessorCandidate as unknown as DetachedRecordCandidate,
      fixture.receipt.bytes,
      fixture.receipt.identity,
    )).resolves.toBeNull();
    expect(getterReads).toBe(0);

    const throwingIdentity = new Proxy({}, {
      ownKeys(): never { throw new Error('TEST_RECEIPT_PROXY_TRAP'); },
    }) as ContentIdentity;
    await expect(api.verifyIntegrationReceiptResolutionCarrier!(
      fixture.baseline.root,
      fixture.candidate.candidate,
      fixture.receipt.bytes,
      throwingIdentity,
    )).resolves.toBeNull();
  });
});

describe.skipIf(!apiReady)('Task 4 composition, replay, attribution, and no-write oracle', () => {
  it('returns exactly the eleven-field PROPOSED_NOT_ADMITTED proposal', async () => {
    const fixture = await buildFixture();
    const beforeRoot = bytes(outputPaths.root);
    const beforeManifest = bytes(outputPaths.manifest);
    const beforeProjection = bytes(outputPaths.projection);
    const proposal = await api.prepareReviewedManifestAppend!(fixture.baseline.root, fixture.input);
    expect(Object.keys(proposal).sort()).toEqual([
      'candidateIdentity',
      'expectedHeadIdentity',
      'independencePolicyIdentity',
      'integratorAttribution',
      'prefixCarrierIdentity',
      'proposedEntryBytes',
      'proposedHeadIdentity',
      'receiptResolutionCarrierIdentity',
      'reviewIdentity',
      'rootIdentity',
      'status',
    ]);
    expect(proposal.status).toBe('PROPOSED_NOT_ADMITTED');
    expect(proposal.rootIdentity).toEqual(fixture.baseline.rootIdentity);
    expect(proposal.expectedHeadIdentity).toEqual(fixture.prefix.headIdentity);
    expect(proposal.candidateIdentity).toEqual(fixture.candidate.identity);
    expect(proposal.reviewIdentity).toEqual(fixture.review.identity);
    expect(proposal.prefixCarrierIdentity).toEqual(fixture.prefix.identity);
    expect(proposal.independencePolicyIdentity).toEqual(fixture.policy.identity);
    expect(proposal.receiptResolutionCarrierIdentity).toEqual(fixture.receipt.identity);
    expect(byteEqual(proposal.proposedEntryBytes, canonicalDocument(parseAuthorityJson(proposal.proposedEntryBytes)))).toBe(true);
    expect(parseAuthorityJson(proposal.proposedEntryBytes)).toEqual({
      schema_version: 'MES-1', root_identity: fixture.baseline.rootIdentity,
      ordinal: fixture.prefix.carrier.packets.length, predecessor_identity: fixture.prefix.headIdentity,
      candidate_identity: fixture.candidate.identity, review_identity: fixture.review.identity,
      reviewer_identity: 'reviewer-b~~~', reviewer_vendor_family: 'ANTHROPIC',
      builder_identity: 'builder-a', builder_vendor_family: 'OPENAI',
      independence_verified: true, disposition: 'ADMITTED', reason_codes: [],
    });
    expect(proposal.proposedHeadIdentity).toEqual(await contentIdentity(proposal.proposedEntryBytes));
    expect(proposal.proposedHeadIdentity).not.toEqual(fixture.prefix.headIdentity);
    expect(Object.values(proposal)).not.toContain('ADMITTED');
    expect(byteEqual(bytes(outputPaths.root), beforeRoot)).toBe(true);
    expect(byteEqual(bytes(outputPaths.manifest), beforeManifest)).toBe(true);
    expect(byteEqual(bytes(outputPaths.projection), beforeProjection)).toBe(true);
  });

  it.each([
    ['missing candidate bytes', { candidateBytes: new Uint8Array() }],
    ['missing review bytes', { reviewBytes: new Uint8Array() }],
    ['missing policy bytes', { independencePolicyBytes: new Uint8Array() }],
    ['missing prefix bytes', { prefixCarrierBytes: new Uint8Array() }],
    ['missing receipt carrier bytes', { receiptResolutionCarrierBytes: new Uint8Array() }],
    ['wrong candidate identity', { candidateBytes: Buffer.from('{"changed":true}\n') }],
    ['wrong review identity', { reviewBytes: Buffer.from('{"changed":true}\n') }],
    ['wrong policy identity', { independencePolicyIdentity: identity('f') }],
    ['wrong prefix identity', { prefixCarrierIdentity: identity('f') }],
    ['wrong receipt identity', { receiptResolutionCarrierIdentity: identity('f') }],
  ] as const)('uses the uniform MES_INTEGRATION_INPUT_INVALID boundary for %s', async (_label, overrides) => {
    const fixture = await buildFixture();
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, overrides));
    if (_label === 'missing candidate bytes') {
      const throwingInput = new Proxy(fixture.input, {
        ownKeys(): never { throw new Error('TEST_COMPOSITION_PROXY_TRAP'); },
      });
      await expectInputInvalid(api, fixture.baseline.root, throwingInput);
    }
  });

  it.each([
    ['unknown attribution key', (attribution: JsonObject) => { attribution.unknown = 'x'; }],
    ['symbol attribution key', (attribution: JsonObject) => { Object.defineProperty(attribution, Symbol('x'), { value: 'x', enumerable: true }); }],
    ['accessor attribution value', (attribution: JsonObject) => { Object.defineProperty(attribution, 'actorIdentity', { get: () => 'getter', enumerable: true }); }],
    ['UNKNOWN attribution', (attribution: JsonObject) => { attribution.actorIdentity = 'UNKNOWN'; }],
    ['untrimmed attribution', (attribution: JsonObject) => { attribution.actorIdentity = ' actor '; }],
    ['non-ASCII attribution', (attribution: JsonObject) => { attribution.actorIdentity = '액터'; }],
    ['empty attribution', (attribution: JsonObject) => { attribution.sessionIdentity = ''; }],
  ] as const)('rejects attribution shape/value: %s', async (_label, mutate) => {
    const fixture = await buildFixture();
    const attribution = clone(fixture.input.integratorAttribution) as unknown as JsonObject;
    mutate(attribution);
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, {
      integratorAttribution: attribution as unknown as IntegratorAttribution,
    }));
  });

  it('allows a null-prototype two-key attribution and returns a deeply frozen exact data copy with either approved prototype', async () => {
    const fixture = await buildFixture();
    const attribution = Object.create(null) as IntegratorAttribution;
    attribution.actorIdentity = 'null-prototype-actor';
    attribution.sessionIdentity = 'null-prototype-session';
    const proposal = await api.prepareReviewedManifestAppend!(fixture.baseline.root, inputWith(fixture.input, { integratorAttribution: attribution }));
    expect(Object.keys(proposal.integratorAttribution).sort()).toEqual(['actorIdentity', 'sessionIdentity']);
    expect(proposal.integratorAttribution).toEqual({ actorIdentity: 'null-prototype-actor', sessionIdentity: 'null-prototype-session' });
    expect(Object.isFrozen(proposal.integratorAttribution)).toBe(true);
    expect([Object.prototype, null]).toContain(Object.getPrototypeOf(proposal.integratorAttribution));
    for (const key of ['actorIdentity', 'sessionIdentity'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(proposal.integratorAttribution, key);
      expect(descriptor && 'value' in descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set).toBe(true);
    }
  });

  it('keeps attribution metadata neutral to all evidence bytes and head identities', async () => {
    const fixture = await buildFixture();
    const first = await api.prepareReviewedManifestAppend!(fixture.baseline.root, fixture.input);
    const second = await api.prepareReviewedManifestAppend!(fixture.baseline.root, inputWith(fixture.input, {
      integratorAttribution: { actorIdentity: 'different-actor', sessionIdentity: 'different-session' },
    }));
    expect(byteEqual(first.proposedEntryBytes, second.proposedEntryBytes)).toBe(true);
    expect(first.proposedHeadIdentity).toEqual(second.proposedHeadIdentity);
    expect(first.rootIdentity).toEqual(second.rootIdentity);
    expect(first.candidateIdentity).toEqual(second.candidateIdentity);
    expect(first.reviewIdentity).toEqual(second.reviewIdentity);
    expect(first.integratorAttribution).not.toEqual(second.integratorAttribution);
  });

  it('snapshots root, every byte carrier, every identity, expected root/head, and attribution synchronously before the first await', async () => {
    const fixture = await buildFixture();
    const baselineProposal = await api.prepareReviewedManifestAppend!(fixture.baseline.root, fixture.input);
    const mutableInput = inputWith(fixture.input, {
      candidateBytes: cloneBytes(fixture.input.candidateBytes),
      reviewBytes: cloneBytes(fixture.input.reviewBytes),
      expectedRootIdentity: clone(fixture.input.expectedRootIdentity),
      expectedHeadIdentity: clone(fixture.input.expectedHeadIdentity),
      independencePolicyBytes: cloneBytes(fixture.input.independencePolicyBytes),
      independencePolicyIdentity: clone(fixture.input.independencePolicyIdentity),
      prefixCarrierBytes: cloneBytes(fixture.input.prefixCarrierBytes),
      prefixCarrierIdentity: clone(fixture.input.prefixCarrierIdentity),
      receiptResolutionCarrierBytes: cloneBytes(fixture.input.receiptResolutionCarrierBytes),
      receiptResolutionCarrierIdentity: clone(fixture.input.receiptResolutionCarrierIdentity),
      integratorAttribution: { ...fixture.input.integratorAttribution },
    });
    const mutableRoot = clone(fixture.baseline.root);
    const pending = api.prepareReviewedManifestAppend!(mutableRoot, mutableInput);
    mutableInput.candidateBytes[0] ^= 0x01;
    mutableInput.reviewBytes[0] ^= 0x01;
    mutableInput.independencePolicyBytes[0] ^= 0x01;
    mutableInput.prefixCarrierBytes[0] ^= 0x01;
    mutableInput.receiptResolutionCarrierBytes[0] ^= 0x01;
    for (const target of [
      mutableInput.expectedRootIdentity, mutableInput.expectedHeadIdentity, mutableInput.independencePolicyIdentity,
      mutableInput.prefixCarrierIdentity, mutableInput.receiptResolutionCarrierIdentity,
    ]) target.sha256 = sha('f');
    mutableRoot.requirements[0]!.id = 'N99-D1';
    mutableInput.integratorAttribution.actorIdentity = 'mutated-after-call';
    const proposal = await pending;
    expect(byteEqual(proposal.proposedEntryBytes, baselineProposal.proposedEntryBytes)).toBe(true);
    expect(proposal.proposedHeadIdentity).toEqual(baselineProposal.proposedHeadIdentity);
    expect(proposal.integratorAttribution.actorIdentity).toBe('offline-integrator');
  });

  it('successfully captures a valid top-level byte accessor once before an asynchronous mutation can occur', async () => {
    const fixture = await buildFixture();
    const candidateBytes = cloneBytes(fixture.input.candidateBytes);
    const accessorInput = inputWith(fixture.input, {});
    let reads = 0;
    Object.defineProperty(accessorInput, 'candidateBytes', {
      enumerable: true,
      get(): Uint8Array {
        reads += 1;
        if (reads > 1) throw new Error('TEST_TOP_LEVEL_GETTER_READ_AFTER_AWAIT');
        return candidateBytes;
      },
    });
    const pending = api.prepareReviewedManifestAppend!(fixture.baseline.root, accessorInput);
    candidateBytes[0] ^= 0x01;
    const proposal = await pending;
    expect(reads).toBe(1);
    expect(proposal.status).toBe('PROPOSED_NOT_ADMITTED');
  });

  it('rejects an attribution accessor without invoking it after an asynchronous boundary', async () => {
    const fixture = await buildFixture();
    let reads = 0;
    const attribution = {
      actorIdentity: 'offline-integrator',
      get sessionIdentity(): string {
        reads += 1;
        if (reads > 1) throw new Error('TEST_GETTER_READ_AFTER_AWAIT');
        return 'session-integrator-red';
      },
    } as unknown as IntegratorAttribution;
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, { integratorAttribution: attribution }));
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('rejects an existing-candidate/record-id replay without allowing the lower manifest no-op', async () => {
    const fixture = await buildFixture();
    const replayPrefix = await buildPrefixCarrier(fixture.baseline, fixture.candidate.candidate, fixture.review);
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, {
      expectedHeadIdentity: replayPrefix.headIdentity,
      prefixCarrierBytes: replayPrefix.bytes,
      prefixCarrierIdentity: replayPrefix.identity,
    }));

    expect(fixture.candidate.record.record_id).toEqual(fixture.candidate.candidate.record.record_id);
  });

  it('rejects an input that replaces the expected head and exposes no writer authority', async () => {
    const fixture = await buildFixture();
    await expectInputInvalid(api, fixture.baseline.root, inputWith(fixture.input, {
      expectedHeadIdentity: identity('f'),
    }));
  });

  it('preserves the generated baseline and never returns admitted authority', async () => {
    const fixture = await buildFixture();
    const before = {
      root: bytes(outputPaths.root),
      manifest: bytes(outputPaths.manifest),
      projection: bytes(outputPaths.projection),
    };
    const proposal = await api.prepareReviewedManifestAppend!(fixture.baseline.root, fixture.input);
    expect(proposal.status).toBe('PROPOSED_NOT_ADMITTED');
    expect(Object.keys(proposal)).not.toContain('writer');
    expect(Object.keys(proposal)).not.toContain('admitted');
    expect(byteEqual(bytes(outputPaths.root), before.root)).toBe(true);
    expect(byteEqual(bytes(outputPaths.manifest), before.manifest)).toBe(true);
    expect(byteEqual(bytes(outputPaths.projection), before.projection)).toBe(true);
  });
});

describe('Task 4 causal absent-module/export stop', () => {
  it('ends RED only on the approved evidence-integrator module/export boundary', () => {
    expect(moduleErrors.filter((message) => !message.includes('evidence-integrator'))).toEqual([]);
    expect(moduleErrors).toEqual([]);
    expect({
      verifyManifestPrefixCarrier: typeof api.verifyManifestPrefixCarrier,
      verifyIntegrationAdmissionPolicy: typeof api.verifyIntegrationAdmissionPolicy,
      verifyIntegrationReceiptResolutionCarrier: typeof api.verifyIntegrationReceiptResolutionCarrier,
      prepareReviewedManifestAppend: typeof api.prepareReviewedManifestAppend,
    }).toEqual({
      verifyManifestPrefixCarrier: 'function',
      verifyIntegrationAdmissionPolicy: 'function',
      verifyIntegrationReceiptResolutionCarrier: 'function',
      prepareReviewedManifestAppend: 'function',
    });
  });
});
