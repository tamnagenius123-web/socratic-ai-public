import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectEvidenceSpine } from '../../src/services/admission/evidence-spine-projection';
import type {
  ArtifactEvidenceRecordV1,
  ArtifactKind,
  ArtifactStatus,
  CorrectionEvidenceRecordV1,
  EvidenceRecordV1,
  EvidenceSpineRootV1,
  GradeEvidenceRecordV1,
  NegativeControlEvidenceRecordV1,
  VerifiedManifestPrefix,
} from '../../src/services/admission/evidence-spine-types';
import type { ContentIdentity } from '../../src/services/admission/identity';

type JsonObject = Record<string, unknown>;

const sha = (digit: string): string => digit.repeat(64);
const id = (digit: string, byteLength = 1): ContentIdentity => ({
  byte_length: byteLength,
  sha256: sha(digit),
});
const rootIdentity = id('0');
const n9RequirementIds = ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'] as const;

const matrix = JSON.parse(readFileSync(
  'docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json',
  'utf8',
)) as JsonObject;
const matrixSlices = matrix.slices as Array<JsonObject>;
const requirements = matrixSlices.flatMap((slice) => (
  slice.evidence_requirements as Array<JsonObject>
).map((requirement) => ({
  id: requirement.id,
  slice_id: slice.id,
  gate: requirement.gate,
  independence: requirement.independence,
})));

const root = {
  schema_version: 'MES-1',
  source_identities: {},
  slice_ids: matrixSlices.map((slice) => slice.id),
  requirements,
  failure_tell_definitions: [{ id: 'FT-TEST', slice_id: 'N0', text: 'Synthetic observed failure.' }],
  failure_tell_links: [{
    failure_tell_id: 'FT-TEST',
    slice_id: 'N0',
    links: [{ gate: 'D', requirement_ids: ['N0-D1'] }],
  }],
  negative_controls: [{
    id: 'NC-TEST',
    applicable_slice_ids: ['N0'],
    requirement_links: [{ slice_id: 'N0', gate: 'S', evidence_requirement_ids: ['N0-S1'] }],
    probe: 'Synthetic control.',
    expected_outcome: 'DENIED',
  }],
  conditional_claims: [{
    claim_id: 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION',
    matrix_identity: id('1'),
    slice_id: 'N1',
    gate: 'L',
    requirement_id: 'N1-L1',
    gate_rule: 'Synthetic conditional rule.',
    condition: 'Synthetic condition.',
  }],
  successor_lane: { blocked_requirement_ids: n9RequirementIds },
  deterministic_reducer: {
    status_precedence: ['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS'],
  },
  closure_rule: { unauthorized_status: 'NOT_EVALUATED' },
} as unknown as EvidenceSpineRootV1;

function common(recordId: string, recordRoot = rootIdentity) {
  return {
    schema_version: 'MES-1' as const,
    record_id: recordId,
    root_identity: recordRoot,
    evidence_key: `key-${recordId}`,
    subject_identity: {
      subject_type: 'projection-fixture',
      subject_key: 'subject-projection',
      content_identity: id('2'),
    },
    created_at: '2026-09-02T00:00:00.000Z',
    producer_identity: {
      producer_id: 'builder-a', role: 'BUILDER', vendor_family: 'OPENAI', attestation: 'UNKNOWN',
    },
    source_receipts: [],
    limitations: ['projection fixture'],
    independent_review: {
      builder_identity: 'builder-a', reviewer_identity: 'UNKNOWN', separation: 'UNKNOWN' as const,
      review_output_identity: id('3'), verdict: 'UNKNOWN' as const, vendor_family: 'UNKNOWN',
    },
  };
}

function artifact(input: {
  digit: string;
  requirementId?: string;
  status?: ArtifactStatus;
  root?: ContentIdentity;
  controlIds?: readonly string[];
  tellObserved?: boolean;
  claimState?: 'ASSERTED' | 'NOT_ASSERTED' | 'UNKNOWN';
  runtimeWithoutReceipts?: boolean;
}): ArtifactEvidenceRecordV1 {
  const requirementId = input.requirementId ?? 'N0-D1';
  const [sliceId, encodedGate] = requirementId.split('-');
  const gate = requirementId === 'N10-V1' ? 'V0' : encodedGate.slice(0, 1);
  const status = input.status ?? 'PASS';
  const recordId = sha(input.digit);
  const kind = input.runtimeWithoutReceipts ? 'RUNTIME' : 'STATIC';
  const kindDetails = input.runtimeWithoutReceipts
    ? {
      kind: 'RUNTIME' as const,
      invocation_receipt_ids: [],
      action_log_artifact_id: 'missing-action-log',
      started_at: '2026-09-02T00:00:00.000Z',
      completed_at: '2026-09-02T00:00:01.000Z',
    }
    : {
      kind: 'STATIC' as const,
      source_subject_ids: ['fixture-source'],
      source_snapshot_identity: id('4'),
      code_bound: true,
    };
  return {
    ...common(recordId, input.root),
    record_family: 'ARTIFACT',
    payload: {
      id: `artifact-${input.digit}`,
      slice_id: sliceId,
      evidence_requirement_ids: [requirementId],
      gate,
      kind,
      path_or_url: `repo://tests/fixtures/${input.digit}`,
      sha256: sha('5'),
      captured_at: '2026-09-02T00:00:00.000Z',
      evidence_label: status === 'PASS' ? 'CODE_VERIFIED' : 'UNKNOWN',
      outcome: status === 'PASS'
        ? 'CLAIM_SUPPORTED'
        : status === 'FAIL'
          ? 'CLAIM_CONTRADICTED'
          : status === 'PENDING'
            ? 'NO_RESULT'
            : status,
      status,
      scope: {
        purpose_identity: id('6'), subject_identity: id('7'), time_identity: id('8'),
        environment_identity: id('9'), exclusion_identities: [],
      },
      limitations: status === 'PASS' ? [] : ['not passing'],
      bindings: {
        source_receipts: [],
        build_identity: input.runtimeWithoutReceipts ? null : id('a'),
        deployment_identity: null,
        account_scope_identity: null,
        capture_environment_identity: null,
        retention_policy_identity: null,
        access_policy_identity: null,
        negative_control_result_ids: [...(input.controlIds ?? [])],
        failure_tell_observations: input.tellObserved ? [{
          failure_tell_id: 'FT-TEST',
          slice_ids: ['N0'], gate_ids: ['D'], requirement_ids: ['N0-D1'],
          subject_identity: {
            subject_type: 'projection-fixture', subject_key: 'subject-projection', content_identity: id('2'),
          },
          observed: true,
          artifact_ids: [`artifact-${input.digit}`],
          scope: {
            purpose_identity: id('6'), subject_identity: id('7'), time_identity: id('8'),
            environment_identity: id('9'), exclusion_identities: [],
          },
          review_output_identities: [id('c')],
        }] : [],
        claim_assertions: input.claimState ? [{
          claim_id: 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION',
          conditional_requirement_ids: ['N1-L1'],
          subject_identity: {
            subject_type: 'projection-fixture', subject_key: 'subject-projection', content_identity: id('2'),
          },
          assertion_state: input.claimState,
          artifact_ids: input.claimState === 'ASSERTED' ? [`artifact-${input.digit}`] : [],
          review_output_identities: [id('e')],
        }] : [],
        kind_details: kindDetails,
      },
    },
  } as ArtifactEvidenceRecordV1;
}

type MutableArtifactFixture = {
  source_receipts: unknown[];
  payload: {
    id: string;
    slice_id: string;
    evidence_requirement_ids: string[];
    gate: string;
    kind: ArtifactKind;
    path_or_url: string;
    bindings: {
      source_receipts: unknown[];
      build_identity: ContentIdentity | null;
      deployment_identity: ContentIdentity | null;
      account_scope_identity: ContentIdentity | null;
      capture_environment_identity: ContentIdentity | null;
      retention_policy_identity: ContentIdentity | null;
      access_policy_identity: ContentIdentity | null;
      failure_tell_observations: Array<JsonObject>;
      claim_assertions: Array<JsonObject>;
      kind_details: JsonObject;
    };
  };
};

function artifactForKind(digit: string, kind: ArtifactKind): ArtifactEvidenceRecordV1 {
  const record = structuredClone(artifact({ digit })) as unknown as MutableArtifactFixture;
  const receipt = {
    receipt_kind: 'BUILD',
    receipt_id: `receipt-${digit}`,
    content_identity: id('b'),
  };
  record.payload.kind = kind;
  record.source_receipts = kind === 'STATIC' ? [] : [receipt];
  record.payload.bindings.source_receipts = kind === 'STATIC' ? [] : [receipt];
  record.payload.bindings.build_identity = null;
  record.payload.bindings.deployment_identity = null;
  record.payload.bindings.account_scope_identity = null;
  record.payload.bindings.capture_environment_identity = null;
  record.payload.bindings.retention_policy_identity = null;
  record.payload.bindings.access_policy_identity = null;
  record.payload.bindings.kind_details = { kind };
  if (kind === 'STATIC') {
    record.payload.bindings.kind_details = { kind, code_bound: true };
    record.payload.bindings.build_identity = id('a');
  }
  if (['RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'GRADE_INPUT'].includes(kind)) {
    record.payload.bindings.build_identity = id('a');
  }
  if (['DEPLOYMENT', 'AUTHENTICATED_E2E', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT'].includes(kind)) {
    record.payload.bindings.deployment_identity = id('b');
  }
  if (['AUTHENTICATED_E2E', 'LONGITUDINAL', 'DELETION'].includes(kind)) {
    record.payload.bindings.account_scope_identity = id('c');
  }
  if (['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'GRADE_INPUT'].includes(kind)) {
    record.payload.bindings.capture_environment_identity = id('d');
  }
  if (['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION'].includes(kind)) {
    record.payload.bindings.retention_policy_identity = id('e');
    record.payload.bindings.access_policy_identity = id('f');
  }
  return record as unknown as ArtifactEvidenceRecordV1;
}

function setArtifactBinding(
  record: ArtifactEvidenceRecordV1,
  key: keyof MutableArtifactFixture['payload']['bindings'],
  value: unknown,
): void {
  const mutable = record as unknown as MutableArtifactFixture;
  (mutable.payload.bindings as unknown as JsonObject)[key] = value;
}

function control(
  digit: string,
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'UNGRADABLE',
): NegativeControlEvidenceRecordV1 {
  const recordId = sha(digit);
  return {
    ...common(recordId),
    record_family: 'NEGATIVE_CONTROL_RESULT',
    payload: {
      control_id: 'NC-TEST',
      slice_ids: ['N0'],
      requirement_links: [{ slice_id: 'N0', gate: 'S', evidence_requirement_ids: ['N0-S1'] }],
      subject_identity: {
        subject_type: 'projection-fixture', subject_key: 'subject-projection', content_identity: id('2'),
      },
      expected_outcome: 'DENIED',
      observed_outcome: status === 'PASS' ? 'DENIED' : status === 'FAIL' ? 'ALLOWED' : null,
      before_state_identity: id('4'), after_state_identity: id('5'), action_log_identity: id('6'),
      network_evidence: { kind: 'NOT_APPLICABLE', content_identity: null, reason: 'NO_NETWORK_SURFACE' },
      artifact_ids: ['artifact-1'],
      scope: {
        purpose_identity: id('6'), subject_identity: id('7'), time_identity: id('8'),
        environment_identity: id('9'), exclusion_identities: [],
      },
      status,
    },
  } as NegativeControlEvidenceRecordV1;
}

function grade(digit: string, recordRoot = rootIdentity, verdict = 'SAME GRADE'): GradeEvidenceRecordV1 {
  const recordId = sha(digit);
  return {
    ...common(recordId, recordRoot),
    record_family: 'GRADE',
    payload: {
      id: `grade-${digit}`, slice_ids: ['N0'], frozen_rubric_sha256: sha('4'), matrix_sha256: sha('5'),
      artifact_ids: ['artifact-a'], builder_vendor_family: 'OPENAI', grader_vendor_family: 'ANTHROPIC',
      grader_is_non_builder: true, builder_report_used: false, branding_treatment: 'STRIPPED',
      same_state_material: true, mapping_commitment: sha('6'), prompt_sha256: sha('7'),
      verdict, reasons: ['fixture'], unassessable_dimensions: [],
      timestamp: '2026-09-02T00:00:00.000Z', output_sha256: sha('8'),
    },
  } as GradeEvidenceRecordV1;
}

function correction(digit: string, target: EvidenceRecordV1, replacementIds: readonly string[]): CorrectionEvidenceRecordV1 {
  const recordId = sha(digit);
  return {
    ...common(recordId),
    record_family: 'CORRECTION',
    payload: {
      target_record_id: target.record_id,
      target_record_identity: id('f'),
      defect_code: 'FIXTURE_DEFECT',
      reason: 'Synthetic malformed correction.',
      replacement_record_ids: replacementIds,
      approval_identity: id('a'),
      review_output_identities: [id('b')],
      effective_manifest_head_identity: id('c'),
    },
  };
}

function fixture(records: readonly EvidenceRecordV1[], options: {
  prefixStatus?: 'VERIFIED' | 'UNKNOWN';
  admittedCount?: number;
  mapOverride?: ReadonlyMap<string, EvidenceRecordV1>;
} = {}) {
  const admittedCount = options.admittedCount ?? records.length;
  const identities = records.map((_, index) => id(((index + 1) % 15).toString(16)));
  const entries = [{
    schema_version: 'MES-1', root_identity: rootIdentity, ordinal: 0,
    predecessor_identity: null, candidate_identity: null, review_identity: null,
    reviewer_identity: null, reviewer_vendor_family: null, builder_identity: null,
    builder_vendor_family: null, independence_verified: false, disposition: 'ADMITTED', reason_codes: [],
  }, ...records.slice(0, admittedCount).map((record, index) => ({
    schema_version: 'MES-1', root_identity: rootIdentity, ordinal: index + 1,
    predecessor_identity: index === 0 ? id('e') : identities[index - 1],
    candidate_identity: identities[index], review_identity: id('d'),
    reviewer_identity: 'reviewer-b', reviewer_vendor_family: 'ANTHROPIC', builder_identity: 'builder-a',
    builder_vendor_family: 'OPENAI', independence_verified: true, disposition: 'ADMITTED', reason_codes: [],
  }))] as VerifiedManifestPrefix['entries'];
  const registry = Object.fromEntries(records.slice(0, admittedCount).map(
    (record, index) => [identities[index].sha256, record],
  ));
  const prefix = {
    schema_version: 'MES-MANIFEST-PREFIX-1',
    status: options.prefixStatus ?? 'VERIFIED',
    root_identity: rootIdentity,
    entries,
    entry_identities: [id('e'), ...identities.slice(0, admittedCount)],
    head_identity: admittedCount === 0 ? id('e') : identities[admittedCount - 1],
    records_by_identity: registry,
    reviews_by_identity: {},
    correction_authorities_by_identity: {},
    correction_reviews_by_identity: {},
    conflict_codes: options.prefixStatus === 'UNKNOWN' ? ['FIXTURE_CONFLICT'] : [],
  } as VerifiedManifestPrefix;
  const recordsByIdentity = options.mapOverride ?? new Map(
    records.map((record, index) => [identities[index].sha256, record]),
  );
  return { prefix, recordsByIdentity, identities };
}

function requirementStatus(projection: ReturnType<typeof projectEvidenceSpine>, requirementId: string) {
  return projection.requirements.find((row) => row.requirement_id === requirementId)!;
}

describe('Critical Path B deterministic projection', () => {
  it('projects the exact zero-promotion genesis baseline', () => {
    const { prefix, recordsByIdentity } = fixture([]);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(projection).toMatchObject({
      schema_version: 'MES-PROJECTION-1',
      root_identity: rootIdentity,
      manifest_status: 'VERIFIED',
      active_artifact_count: 0,
      active_grade_count: 0,
      same_grade_count: 0,
      closure_status: 'NOT_EVALUATED',
    });
    expect(projection.slices).toHaveLength(11);
    expect(projection.requirements).toHaveLength(64);
    expect(projection.requirements.filter((row) => row.status === 'PENDING')).toHaveLength(59);
    expect(projection.requirements.filter((row) => row.status === 'BLOCKED_CONTRACT').map(
      (row) => row.requirement_id,
    )).toEqual(n9RequirementIds);
    expect(Object.hasOwn(projection.slices[0], 'status')).toBe(false);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.slices)).toBe(true);
    expect(Object.isFrozen(projection.slices[0])).toBe(true);
    expect(Object.isFrozen(projection.requirements)).toBe(true);
    expect(Object.isFrozen(projection.requirements[0])).toBe(true);
    expect(Object.isFrozen(projection.requirements[0].lineage_record_identities)).toBe(true);
  });

  it.each([
    [['PASS'], 'PASS'],
    [['PASS', 'PENDING'], 'PENDING'],
    [['PASS', 'UNGRADABLE'], 'UNGRADABLE'],
    [['PASS', 'UNKNOWN'], 'UNKNOWN'],
    [['PASS', 'FAIL'], 'FAIL'],
  ] as const)('applies least-favorable precedence to %j', (statuses, expected) => {
    const records = statuses.map((status, index) => artifact({
      digit: (index + 1).toString(16), status,
    }));
    const { prefix, recordsByIdentity } = fixture(records);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe(expected);
  });

  it.each([
    ['missing', undefined, 'UNKNOWN'],
    ['failed', 'FAIL', 'FAIL'],
    ['unknown', 'UNKNOWN', 'UNKNOWN'],
    ['ungradable', 'UNGRADABLE', 'UNGRADABLE'],
    ['passed', 'PASS', 'PASS'],
  ] as const)('resolves linked negative control: %s', (_label, controlStatus, expected) => {
    const evidence = artifact({ digit: '1', requirementId: 'N0-S1', controlIds: [sha('2')] });
    const records = controlStatus ? [evidence, control('2', controlStatus)] : [evidence];
    const { prefix, recordsByIdentity } = fixture(records);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-S1').status).toBe(expected);
  });

  it('forces FAIL when an admitted passing control contradicts the root definition', () => {
    const evidence = artifact({ digit: '1', requirementId: 'N0-S1', controlIds: [sha('2')] });
    const mismatched = control('2', 'PASS');
    mismatched.payload.expected_outcome = 'ALLOWED';
    mismatched.payload.observed_outcome = 'ALLOWED';
    const { prefix, recordsByIdentity } = fixture([evidence, mismatched]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-S1').status).toBe('FAIL');
  });

  it('forces FAIL for an exact observed linked failure tell', () => {
    const evidence = artifact({ digit: '1', tellObserved: true });
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('FAIL');
  });

  it('does not treat a partially linked or differently scoped failure tell as exact', () => {
    const evidence = artifact({ digit: '1', tellObserved: true });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.bindings.failure_tell_observations[0].subject_identity = {
      subject_type: 'projection-fixture', subject_key: 'other-subject', content_identity: id('2'),
    };
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('uses the schema sorted-set order for an exact multi-gate failure tell', () => {
    const evidence = artifact({ digit: '1', tellObserved: true });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.bindings.failure_tell_observations[0].gate_ids = ['D', 'R', 'S'];
    mutable.payload.bindings.failure_tell_observations[0].requirement_ids = ['N0-D1', 'N0-R1', 'N0-S1'];
    const multiGateRoot = structuredClone(root) as unknown as EvidenceSpineRootV1;
    (multiGateRoot.failure_tell_links as unknown as Array<JsonObject>)[0].links = [
      { gate: 'D', requirement_ids: ['N0-D1'] },
      { gate: 'S', requirement_ids: ['N0-S1'] },
      { gate: 'R', requirement_ids: ['N0-R1'] },
    ];
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(
      projectEvidenceSpine(multiGateRoot, prefix, recordsByIdentity),
      'N0-D1',
    ).status).toBe('FAIL');
  });

  it.each([
    ['NOT_ASSERTED', 'PENDING'],
    ['UNKNOWN', 'UNKNOWN'],
    ['ASSERTED', 'PASS'],
  ] as const)('preserves conditional claim state %s', (claimState, expected) => {
    const evidence = artifact({ digit: '1', requirementId: 'N1-L1', claimState });
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N1-L1').status).toBe(expected);
  });

  it('rejects an asserted conditional claim whose subject is not the artifact subject', () => {
    const evidence = artifact({ digit: '1', requirementId: 'N1-L1', claimState: 'ASSERTED' });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.bindings.claim_assertions[0].subject_identity = {
      subject_type: 'projection-fixture', subject_key: 'other-subject', content_identity: id('2'),
    };
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N1-L1').status).toBe('UNKNOWN');
  });

  it('fails closed for a passing runtime artifact with missing receipt and binding facts', () => {
    const evidence = artifact({ digit: '1', runtimeWithoutReceipts: true });
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('requires the artifact slice and gate to match the linked root requirement', () => {
    const evidence = artifact({ digit: '1' });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.slice_id = 'N1';
    mutable.payload.gate = 'S';
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('rejects the whole artifact when its requirement list crosses a gate', () => {
    const evidence = artifact({ digit: '1' });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.evidence_requirement_ids = ['N0-D1', 'N0-S1'];
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('requires distinct builder and reviewer vendors for a cross-vendor requirement', () => {
    const evidence = artifact({ digit: '1', requirementId: 'N10-V1' });
    const mutable = evidence as unknown as MutableArtifactFixture;
    mutable.payload.gate = 'V0';
    const valid = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, valid.prefix, valid.recordsByIdentity), 'N10-V1').status).toBe('PASS');
    const sameVendor = structuredClone(valid.prefix) as unknown as VerifiedManifestPrefix;
    (sameVendor.entries[1] as unknown as { reviewer_vendor_family: string }).reviewer_vendor_family = 'OPENAI';
    expect(requirementStatus(
      projectEvidenceSpine(root, sameVendor, valid.recordsByIdentity),
      'N10-V1',
    ).status).toBe('UNKNOWN');
  });

  it.each([
    ['STATIC', 'build_identity'],
    ['RUNTIME', 'build_identity'],
    ['DEPLOYMENT', 'build_identity'],
    ['DEPLOYMENT', 'deployment_identity'],
    ['AUTHENTICATED_E2E', 'build_identity'],
    ['AUTHENTICATED_E2E', 'deployment_identity'],
    ['AUTHENTICATED_E2E', 'account_scope_identity'],
    ['AUTHENTICATED_E2E', 'capture_environment_identity'],
    ['LONGITUDINAL', 'account_scope_identity'],
    ['LONGITUDINAL', 'capture_environment_identity'],
    ['ACCESSIBILITY', 'deployment_identity'],
    ['ACCESSIBILITY', 'capture_environment_identity'],
    ['DELETION', 'deployment_identity'],
    ['DELETION', 'account_scope_identity'],
    ['DELETION', 'retention_policy_identity'],
    ['DELETION', 'access_policy_identity'],
    ['GRADE_INPUT', 'build_identity'],
    ['GRADE_INPUT', 'deployment_identity'],
    ['GRADE_INPUT', 'capture_environment_identity'],
  ] as const)('requires the approved %s %s binding before PASS', (kind, missingBinding) => {
    const evidence = artifactForKind('1', kind);
    setArtifactBinding(evidence, missingBinding, null);
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it.each([
    'STATIC', 'RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E',
    'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT',
  ] as const)('accepts the complete approved %s binding matrix', (kind) => {
    const evidence = artifactForKind('1', kind);
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('PASS');
  });

  it('requires byte-equal envelope and binding receipts for non-static evidence', () => {
    const evidence = artifactForKind('1', 'RUNTIME');
    setArtifactBinding(evidence, 'source_receipts', [{
      receipt_kind: 'BUILD', receipt_id: 'different-receipt', content_identity: id('b'),
    }]);
    const { prefix, recordsByIdentity } = fixture([evidence]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('keeps a malformed correction target active and marks the affected key UNKNOWN', () => {
    const target = artifact({ digit: '1' });
    const malformed = correction('2', target, [sha('f')]);
    const { prefix, recordsByIdentity } = fixture([target, malformed]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('marks a linked control UNKNOWN when its evidence key has a malformed correction', () => {
    const evidence = artifact({ digit: '1', requirementId: 'N0-S1', controlIds: [sha('2')] });
    const passingControl = control('2', 'PASS');
    const malformed = correction('3', passingControl, [sha('f')]);
    const { prefix, recordsByIdentity } = fixture([evidence, passingControl, malformed]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-S1').status).toBe('UNKNOWN');
  });

  it('does not count SAME GRADE while its evidence key has a malformed correction', () => {
    const acceptedGrade = grade('1');
    const malformed = correction('2', acceptedGrade, [sha('f')]);
    const { prefix, recordsByIdentity } = fixture([acceptedGrade, malformed]);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(projection.active_grade_count).toBe(1);
    expect(projection.same_grade_count).toBe(0);
  });

  it('deactivates only the exact target of a valid correction after its replacement is admitted', () => {
    const target = artifact({ digit: '1', status: 'FAIL' });
    const replacement = artifact({ digit: '2', status: 'PASS' });
    const valid = correction('3', target, [replacement.record_id]);
    valid.payload.target_record_identity = id('1');
    valid.payload.effective_manifest_head_identity = id('2');
    const { prefix, recordsByIdentity } = fixture([target, replacement, valid]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('PASS');
  });

  it('does not let a correction name a replacement admitted later in the manifest', () => {
    const target = artifact({ digit: '1', status: 'FAIL' });
    const replacement = artifact({ digit: '3', status: 'PASS' });
    const premature = correction('2', target, [replacement.record_id]);
    premature.payload.target_record_identity = id('1');
    premature.payload.effective_manifest_head_identity = id('1');
    const { prefix, recordsByIdentity } = fixture([target, premature, replacement]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('FAIL');
  });

  it('lets a valid later correction deactivate an earlier correction record', () => {
    const target = artifact({ digit: '1', status: 'FAIL' });
    const replacement = artifact({ digit: '2', status: 'PASS' });
    const first = correction('3', target, [replacement.record_id]);
    first.payload.target_record_identity = id('1');
    first.payload.effective_manifest_head_identity = id('2');
    const second = correction('4', first, [target.record_id]);
    second.payload.target_record_identity = id('3');
    second.payload.effective_manifest_head_identity = id('3');
    const { prefix, recordsByIdentity } = fixture([target, replacement, first, second]);
    expect(requirementStatus(projectEvidenceSpine(root, prefix, recordsByIdentity), 'N0-D1').status).toBe('FAIL');
  });

  it('ignores unreviewed map-only candidates and extra unadmitted records', () => {
    const candidate = artifact({ digit: '1' });
    const { prefix, recordsByIdentity } = fixture([candidate], { admittedCount: 0 });
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(requirementStatus(projection, 'N0-D1').status).toBe('PENDING');
    expect(projection.active_artifact_count).toBe(0);
  });

  it('does not count a cross-root grade or relabel generic artifact PASS as SAME GRADE', () => {
    const evidence = artifact({ digit: '1' });
    const foreignGrade = grade('2', id('f'));
    const { prefix, recordsByIdentity } = fixture([evidence, foreignGrade]);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(projection.active_artifact_count).toBe(1);
    expect(projection.active_grade_count).toBe(0);
    expect(projection.same_grade_count).toBe(0);
  });

  it('counts only an active same-root GRADE record as SAME GRADE', () => {
    const acceptedGrade = grade('1');
    const { prefix, recordsByIdentity } = fixture([acceptedGrade]);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(projection.active_grade_count).toBe(1);
    expect(projection.same_grade_count).toBe(1);
  });

  it('keeps all five historical N9 cells BLOCKED_CONTRACT despite generic PASS artifacts', () => {
    const records = n9RequirementIds.map((requirementId, index) => artifact({
      digit: (index + 1).toString(16), requirementId,
    }));
    const { prefix, recordsByIdentity } = fixture(records);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(n9RequirementIds.map((requirementId) => requirementStatus(projection, requirementId).status)).toEqual(
      n9RequirementIds.map(() => 'BLOCKED_CONTRACT'),
    );
  });

  it('poisons a missing or changed admitted registry record without accepting map extras', () => {
    const evidence = artifact({ digit: '1' });
    const base = fixture([evidence]);
    const missing = projectEvidenceSpine(root, base.prefix, new Map());
    expect(requirementStatus(missing, 'N0-D1').status).toBe('UNKNOWN');
    const missingRegistry = structuredClone(base.prefix) as unknown as VerifiedManifestPrefix;
    delete (missingRegistry.records_by_identity as Record<string, EvidenceRecordV1>)[base.identities[0].sha256];
    expect(requirementStatus(
      projectEvidenceSpine(root, missingRegistry, base.recordsByIdentity),
      'N0-D1',
    ).status).toBe('UNKNOWN');
    const changed = structuredClone(evidence);
    changed.payload.status = 'FAIL';
    const changedMap = new Map([[base.identities[0].sha256, changed as EvidenceRecordV1]]);
    expect(requirementStatus(projectEvidenceSpine(root, base.prefix, changedMap), 'N0-D1').status).toBe('UNKNOWN');
  });

  it('invalidates the prefix when an admitted record is absent from both exact record carriers', () => {
    const evidence = artifact({ digit: '1' });
    const base = fixture([evidence]);
    const missing = structuredClone(base.prefix) as unknown as VerifiedManifestPrefix;
    delete (missing.records_by_identity as Record<string, EvidenceRecordV1>)[base.identities[0].sha256];
    const projection = projectEvidenceSpine(root, missing, new Map());
    expect(projection.manifest_status).toBe('UNKNOWN');
    expect(requirementStatus(projection, 'N0-D1').status).toBe('UNKNOWN');
    expect(requirementStatus(projection, 'N9-S1').status).toBe('BLOCKED_CONTRACT');
  });

  it('does not let a different-family map record mask a missing verified registry record', () => {
    const evidence = artifact({ digit: '1' });
    const base = fixture([evidence]);
    const missing = structuredClone(base.prefix) as unknown as VerifiedManifestPrefix;
    delete (missing.records_by_identity as Record<string, EvidenceRecordV1>)[base.identities[0].sha256];
    const disguised = new Map<string, EvidenceRecordV1>([[base.identities[0].sha256, grade('2')]]);
    const projection = projectEvidenceSpine(root, missing, disguised);
    expect(projection.manifest_status).toBe('UNKNOWN');
    expect(requirementStatus(projection, 'N0-D1').status).toBe('UNKNOWN');
  });

  it('invalidates a prefix whose entry root is not the verified prefix root', () => {
    const evidence = artifact({ digit: '1' });
    const base = fixture([evidence]);
    const mismatched = structuredClone(base.prefix) as unknown as VerifiedManifestPrefix;
    (mismatched.entries[1] as unknown as { root_identity: ContentIdentity }).root_identity = id('f');
    const projection = projectEvidenceSpine(root, mismatched, base.recordsByIdentity);
    expect(projection.manifest_status).toBe('UNKNOWN');
    expect(requirementStatus(projection, 'N0-D1').status).toBe('UNKNOWN');
  });

  it('projects an UNKNOWN prefix fail-closed and never mutates caller inputs', () => {
    const evidence = artifact({ digit: '1' });
    const { prefix, recordsByIdentity } = fixture([evidence], { prefixStatus: 'UNKNOWN' });
    const beforePrefix = structuredClone(prefix);
    const beforeRecord = structuredClone(evidence);
    const projection = projectEvidenceSpine(root, prefix, recordsByIdentity);
    expect(requirementStatus(projection, 'N0-D1').status).toBe('UNKNOWN');
    expect(requirementStatus(projection, 'N9-S1').status).toBe('BLOCKED_CONTRACT');
    expect(projection.active_artifact_count).toBe(0);
    expect(prefix).toEqual(beforePrefix);
    expect(evidence).toEqual(beforeRecord);
  });
});
