import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RECORD_FAMILIES,
  loadEvidenceSpineRoot,
  type ExpectedRootIdentities,
  type RootSourceBytes,
  validateEvidenceRecord,
} from '../../src/services/admission/evidence-spine';
import {
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from '../../src/services/admission/canonical-json';
import {
  contentIdentity,
  type ContentIdentity,
} from '../../src/services/admission/identity';

type MutableRecord = Record<string, unknown>;
type ArtifactKind =
  | 'STATIC'
  | 'RUNTIME'
  | 'DEPLOYMENT'
  | 'AUTHENTICATED_E2E'
  | 'LONGITUDINAL'
  | 'ACCESSIBILITY'
  | 'DELETION'
  | 'GRADE_INPUT';

const textEncoder = new TextEncoder();
const bytes = (value: string): Uint8Array => textEncoder.encode(value);
const sha = (digit: string): string => digit.repeat(64);
const identity = (digit = '0', byteLength = 1) => ({
  byte_length: byteLength,
  sha256: sha(digit),
});

const clone = <T>(value: T): T => structuredClone(value);

const asMutableRecord = (value: unknown): MutableRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('TEST_FIXTURE_OBJECT_REQUIRED');
  }
  return value as MutableRecord;
};

const readPath = (root: unknown, path: readonly (string | number)[]): unknown => {
  let cursor = root;
  for (const part of path) {
    if (typeof part === 'number') {
      if (!Array.isArray(cursor) || part < 0 || part >= cursor.length) {
        throw new Error(`TEST_FIXTURE_ARRAY_PATH_REQUIRED:${path.join('.')}`);
      }
      cursor = cursor[part];
    } else {
      const record = asMutableRecord(cursor);
      if (!Object.prototype.hasOwnProperty.call(record, part)) {
        throw new Error(`TEST_FIXTURE_PATH_MISSING:${path.join('.')}`);
      }
      cursor = record[part];
    }
  }
  return cursor;
};

const writePath = (
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void => {
  if (path.length === 0) throw new Error('TEST_FIXTURE_NONEMPTY_PATH_REQUIRED');
  const parent = readPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (typeof key === 'number') {
    if (!Array.isArray(parent) || key < 0 || key >= parent.length) {
      throw new Error(`TEST_FIXTURE_ARRAY_PATH_REQUIRED:${path.join('.')}`);
    }
    parent[key] = value;
  } else {
    asMutableRecord(parent)[key] = value;
  }
};

const removePath = (root: unknown, path: readonly (string | number)[]): void => {
  if (path.length === 0) throw new Error('TEST_FIXTURE_NONEMPTY_PATH_REQUIRED');
  const parent = readPath(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (typeof key === 'number') {
    if (!Array.isArray(parent) || key < 0 || key >= parent.length) {
      throw new Error(`TEST_FIXTURE_ARRAY_PATH_REQUIRED:${path.join('.')}`);
    }
    parent.splice(key, 1);
  } else {
    delete asMutableRecord(parent)[key];
  }
};

const addUnknownKeyAt = (root: unknown, path: readonly (string | number)[]): void => {
  asMutableRecord(readPath(root, path)).unexpected_mes_key = true;
};

const sourceReceipt = (receiptKind: string, receiptId: string, digit = '1') => ({
  receipt_kind: receiptKind,
  receipt_id: receiptId,
  content_identity: identity(digit),
});

const sortedReceipts = (...values: ReturnType<typeof sourceReceipt>[]) => values.sort((left, right) => {
  const leftKey = `${left.receipt_kind}\u0000${left.receipt_id}`;
  const rightKey = `${right.receipt_kind}\u0000${right.receipt_id}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
});

const scope = () => ({
  purpose_identity: identity('1'),
  subject_identity: identity('2'),
  time_identity: identity('3'),
  environment_identity: identity('4'),
  exclusion_identities: [identity('5')],
});

const subjectIdentity = () => ({
  subject_type: 'FIXTURE_SUBJECT',
  subject_key: 'fixture-subject-1',
  content_identity: identity('6'),
});

const producerIdentity = () => ({
  producer_id: 'fixture-builder-1',
  role: 'BUILDER',
  vendor_family: 'OPENAI',
  attestation: 'UNKNOWN',
});

const independentReview = () => ({
  builder_identity: 'fixture-builder-1',
  reviewer_identity: 'fixture-reviewer-1',
  separation: 'VERIFIED',
  review_output_identity: identity('7'),
  verdict: 'ADMIT',
  vendor_family: 'ANTHROPIC',
});

const commonEnvelope = (recordFamily: string, receipts: ReturnType<typeof sourceReceipt>[] = []) => ({
  schema_version: 'MES-1',
  record_family: recordFamily,
  record_id: sha('8'),
  root_identity: identity('9'),
  evidence_key: `MES:${recordFamily}:fixture-subject-1`,
  subject_identity: subjectIdentity(),
  created_at: '2026-09-02T00:00:00.000Z',
  producer_identity: producerIdentity(),
  source_receipts: receipts,
  limitations: [],
  independent_review: independentReview(),
});

const kindReceipts = (kind: ArtifactKind) => {
  switch (kind) {
    case 'STATIC':
      return [];
    case 'RUNTIME':
      return sortedReceipts(sourceReceipt('AI_INVOCATION_ATTEMPT', 'attempt-1'));
    case 'DEPLOYMENT':
      return sortedReceipts(
        sourceReceipt('BUILD', 'build-1'),
        sourceReceipt('CONTROL_PLANE', 'control-plane-1'),
        sourceReceipt('DEPLOYMENT', 'deployment-1'),
      );
    case 'AUTHENTICATED_E2E':
      return sortedReceipts(
        sourceReceipt('BROWSER_ACTION_LOG', 'action-log-1'),
        sourceReceipt('BUILD', 'build-1'),
        sourceReceipt('CONTROL_PLANE', 'control-plane-1'),
        sourceReceipt('DEPLOYMENT', 'deployment-1'),
      );
    case 'LONGITUDINAL':
      return sortedReceipts(
        sourceReceipt('AI_INVOCATION_ATTEMPT', 'attempt-1'),
        sourceReceipt('BROWSER_ACTION_LOG', 'follow-up-log-1'),
        sourceReceipt('RECHECK', 'recheck-1'),
      );
    case 'ACCESSIBILITY':
      return sortedReceipts(
        sourceReceipt('ACCESSIBILITY', 'accessibility-1'),
        sourceReceipt('DEPLOYMENT', 'deployment-1'),
      );
    case 'DELETION':
      return sortedReceipts(
        sourceReceipt('DELETION', 'deletion-1'),
        sourceReceipt('DEPLOYMENT', 'deployment-1'),
      );
    case 'GRADE_INPUT':
      return sortedReceipts(
        sourceReceipt('BUILD', 'build-1'),
        sourceReceipt('DEPLOYMENT', 'deployment-1'),
      );
  }
};

const kindDetails = (kind: ArtifactKind): MutableRecord => {
  switch (kind) {
    case 'STATIC':
      return {
        kind: 'STATIC',
        source_subject_ids: ['source-subject-1'],
        source_snapshot_identity: identity('a'),
        code_bound: false,
      };
    case 'RUNTIME':
      return {
        kind: 'RUNTIME',
        invocation_receipt_ids: ['attempt-1'],
        action_log_artifact_id: 'artifact-action-log-1',
        started_at: '2026-09-02T00:00:00.000Z',
        completed_at: '2026-09-02T00:01:00.000Z',
      };
    case 'DEPLOYMENT':
      return {
        kind: 'DEPLOYMENT',
        control_plane_artifact_id: 'artifact-control-plane-1',
        production_probe_artifact_ids: ['artifact-probe-1'],
        route_ids: ['route-1'],
      };
    case 'AUTHENTICATED_E2E':
      return {
        kind: 'AUTHENTICATED_E2E',
        journey_id: 'journey-korean-training-growth-v1',
        step_ids: ['step-b', 'step-a'],
        action_log_artifact_id: 'artifact-action-log-1',
        capture_artifact_ids: ['artifact-capture-1'],
        korean_comprehension_artifact_id: 'artifact-korean-1',
        isolation_result_ids: ['control-isolation-1'],
      };
    case 'LONGITUDINAL':
      return {
        kind: 'LONGITUDINAL',
        protocol_id: 'protocol-longitudinal-1',
        baseline_artifact_id: 'artifact-baseline-1',
        followup_artifact_ids: ['artifact-follow-up-1'],
        scheduled_at: '2026-09-09T00:00:00.000Z',
        observed_at: '2026-09-09T01:00:00.000Z',
        horizon_seconds: 604800,
        changed_context: true,
        outcome_status: 'UNKNOWN',
      };
    case 'ACCESSIBILITY':
      return {
        kind: 'ACCESSIBILITY',
        evaluation_id: 'accessibility-evaluation-1',
        route_ids: ['route-1'],
        viewport_artifact_ids: ['artifact-viewport-1'],
        input_mode_artifact_ids: ['artifact-keyboard-1'],
        assistive_technology_artifact_ids: ['artifact-screen-reader-1'],
        korean_comprehension_artifact_ids: ['artifact-korean-1'],
        issue_ids: [],
      };
    case 'DELETION':
      return {
        kind: 'DELETION',
        deletion_receipt_id: 'deletion-1',
        declared_store_ids: ['store-context', 'store-text'],
        before_manifest_artifact_id: 'artifact-before-1',
        after_manifest_artifact_id: 'artifact-after-1',
        residue_probe_ids: ['artifact-residue-1'],
        authorized_actor: 'fixture-owner-a',
        completed_at: '2026-09-02T00:02:00.000Z',
      };
    case 'GRADE_INPUT':
      return {
        kind: 'GRADE_INPUT',
        presentation_packet_id: 'packet-1',
        randomized_mapping_commitment: sha('b'),
        presented_artifact_ids: ['artifact-b', 'artifact-a'],
        same_state_material: true,
      };
  }
};

const bindingIdentities = (kind: ArtifactKind) => {
  const build = ['RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'GRADE_INPUT'].includes(kind)
    ? identity('b')
    : null;
  const deployment = ['DEPLOYMENT', 'AUTHENTICATED_E2E', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT'].includes(kind)
    ? identity('c')
    : null;
  const accountScope = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'DELETION'].includes(kind)
    ? identity('d')
    : null;
  const captureEnvironment = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'GRADE_INPUT'].includes(kind)
    ? identity('e')
    : null;
  const requiresPolicies = kind !== 'STATIC';
  return {
    build_identity: build,
    deployment_identity: deployment,
    account_scope_identity: accountScope,
    capture_environment_identity: captureEnvironment,
    retention_policy_identity: requiresPolicies ? identity('f') : null,
    access_policy_identity: requiresPolicies ? identity('1') : null,
  };
};

const artifactRecord = (kind: ArtifactKind = 'STATIC'): MutableRecord => {
  const receipts = kindReceipts(kind);
  return {
    ...commonEnvelope('ARTIFACT', receipts),
    payload: {
      id: `artifact-${kind.toLowerCase()}-1`,
      slice_id: 'N0',
      evidence_requirement_ids: ['N0-S1'],
      gate: 'S',
      kind,
      path_or_url: kind === 'STATIC' ? 'repo://fixture/README.md' : `encrypted://fixture/${kind.toLowerCase()}`,
      sha256: sha('2'),
      captured_at: '2026-09-02T00:00:00.000Z',
      evidence_label: 'CODE_VERIFIED',
      outcome: 'CLAIM_SUPPORTED',
      status: 'PASS',
      scope: scope(),
      limitations: [],
      bindings: {
        source_receipts: clone(receipts),
        ...bindingIdentities(kind),
        negative_control_result_ids: [],
        failure_tell_observations: [],
        claim_assertions: [],
        kind_details: kindDetails(kind),
      },
    },
  };
};

const negativeControlRecord = (): MutableRecord => ({
  ...commonEnvelope('NEGATIVE_CONTROL_RESULT', [sourceReceipt('BROWSER_ACTION_LOG', 'action-log-1')]),
  payload: {
    control_id: 'N9-FOREIGN-READ-REFUSAL',
    slice_ids: ['N9'],
    requirement_links: [{
      slice_id: 'N9',
      gate: 'S',
      evidence_requirement_ids: ['N9-S1'],
    }],
    subject_identity: subjectIdentity(),
    expected_outcome: 'HTTP_403',
    observed_outcome: 'HTTP_403',
    before_state_identity: identity('2'),
    after_state_identity: identity('2'),
    action_log_identity: identity('3'),
    network_evidence: {
      kind: 'LOG',
      content_identity: identity('4'),
      reason: null,
    },
    artifact_ids: ['artifact-action-log-1'],
    scope: scope(),
    status: 'PASS',
  },
});

const gradeRecord = (): MutableRecord => ({
  ...commonEnvelope('GRADE', [sourceReceipt('GRADE_OUTPUT', 'grade-output-1')]),
  payload: {
    id: 'grade-1',
    slice_ids: ['N0'],
    frozen_rubric_sha256: sha('1'),
    matrix_sha256: sha('2'),
    artifact_ids: ['artifact-a', 'artifact-b'],
    builder_vendor_family: 'OPENAI',
    grader_vendor_family: 'ANTHROPIC',
    grader_is_non_builder: true,
    builder_report_used: false,
    branding_treatment: 'STRIPPED',
    same_state_material: true,
    mapping_commitment: sha('3'),
    prompt_sha256: sha('4'),
    verdict: 'SAME GRADE',
    reasons: ['reason-a', 'reason-b'],
    unassessable_dimensions: [],
    timestamp: '2026-09-02T00:00:00.000Z',
    output_sha256: sha('5'),
  },
});

const correctionRecord = (): MutableRecord => ({
  ...commonEnvelope('CORRECTION', [sourceReceipt('REVIEW', 'correction-review-1')]),
  payload: {
    target_record_id: sha('1'),
    target_record_identity: identity('2'),
    defect_code: 'STALE_DEPLOYMENT',
    reason: 'The target was captured against a stale deployment.',
    replacement_record_ids: [sha('3')],
    approval_identity: identity('4'),
    review_output_identities: [identity('5')],
    effective_manifest_head_identity: identity('6'),
  },
});

const artifactKinds: ArtifactKind[] = [
  'STATIC',
  'RUNTIME',
  'DEPLOYMENT',
  'AUTHENTICATED_E2E',
  'LONGITUDINAL',
  'ACCESSIBILITY',
  'DELETION',
  'GRADE_INPUT',
];

describe('Minimal Evidence Spine closed schema vocabulary', () => {
  it('exports exactly four semantic record families', () => {
    const acceptedFamilies = [
      'ARTIFACT',
      'NEGATIVE_CONTROL_RESULT',
      'GRADE',
      'CORRECTION',
    ] as const;
    expect(RECORD_FAMILIES).toEqual(acceptedFamilies);
    expect(() => validateEvidenceRecord({ record_family: 'AUTHORITY_CONTEXT' }))
      .toThrowError('MES_RECORD_FAMILY_REJECTED');
  });

  it.each([
    'APPROVAL_RECEIPT',
    'WRITER_AUTHORIZATION',
    'KERNEL_FREEZE',
    'PACKET_FREEZE',
    'FAILURE_TELL_OBSERVATION',
    'CLAIM_ASSERTION',
    'REVOCATION',
    'BLOCKED_CONTRACT',
    'TERMINAL_LANE_LOCK',
    'SUCCESSOR_WAVE_AUTHORIZATION',
    'CLOSURE_EVALUATION_REQUEST',
    'KERNEL_COMPATIBILITY',
    'EXPERIMENT_MEASUREMENT',
    'AUTHORITY_CONTEXT',
  ])('rejects legacy family %s', (recordFamily) => {
    expect(() => validateEvidenceRecord({ record_family: recordFamily }))
      .toThrowError('MES_RECORD_FAMILY_REJECTED');
  });

  it.each([
    ['ARTIFACT', artifactRecord()],
    ['NEGATIVE_CONTROL_RESULT', negativeControlRecord()],
    ['GRADE', gradeRecord()],
    ['CORRECTION', correctionRecord()],
  ])('accepts the exact %s envelope and payload shape', (_family, record) => {
    expect(() => validateEvidenceRecord(record)).not.toThrow();
  });

  it.each(artifactKinds)('accepts the closed %s kind_details shape', (kind) => {
    expect(() => validateEvidenceRecord(artifactRecord(kind))).not.toThrow();
  });

  it.each([
    'SAME GRADE',
    'A CLEARLY BETTER',
    'B CLEARLY BETTER',
    'UNGRADABLE',
  ])('accepts exact grade verdict %s', (verdict) => {
    const record = gradeRecord();
    writePath(record, ['payload', 'verdict'], verdict);
    expect(() => validateEvidenceRecord(record)).not.toThrow();
  });

  it('rejects the non-spec grade verdict DIFFERENT GRADE', () => {
    const record = gradeRecord();
    writePath(record, ['payload', 'verdict'], 'DIFFERENT GRADE');
    expect(() => validateEvidenceRecord(record)).toThrow();
  });
});

const validStatusOutcomePairs = new Set([
  'PASS:CLAIM_SUPPORTED',
  'PASS:EXPECTED_RESULT_OBSERVED',
  'FAIL:CLAIM_CONTRADICTED',
  'FAIL:EXPECTED_RESULT_NOT_OBSERVED',
  'PENDING:NO_RESULT',
  'UNKNOWN:UNKNOWN',
  'UNGRADABLE:UNGRADABLE',
]);

const artifactStatuses = ['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE'];
const artifactOutcomes = [
  'CLAIM_SUPPORTED',
  'CLAIM_CONTRADICTED',
  'EXPECTED_RESULT_OBSERVED',
  'EXPECTED_RESULT_NOT_OBSERVED',
  'NO_RESULT',
  'UNKNOWN',
  'UNGRADABLE',
];

describe('ARTIFACT status and outcome matrix', () => {
  it.each(artifactStatuses.flatMap((status) => artifactOutcomes.map((outcome) => ({ status, outcome }))))(
    'enforces $status / $outcome',
    ({ status, outcome }) => {
      const record = artifactRecord();
      writePath(record, ['payload', 'status'], status);
      writePath(record, ['payload', 'outcome'], outcome);
      writePath(record, ['payload', 'limitations'], status === 'PASS' ? [] : ['fixture limitation']);
      const shouldPass = validStatusOutcomePairs.has(`${status}:${outcome}`);
      if (shouldPass) {
        expect(() => validateEvidenceRecord(record)).not.toThrow();
      } else {
        expect(() => validateEvidenceRecord(record)).toThrow();
      }
    },
  );

  it.each(['PASS', 'FAIL'])('does not let UNKNOWN evidence become %s', (status) => {
    const record = artifactRecord();
    writePath(record, ['payload', 'evidence_label'], 'UNKNOWN');
    writePath(record, ['payload', 'status'], status);
    writePath(
      record,
      ['payload', 'outcome'],
      status === 'PASS' ? 'CLAIM_SUPPORTED' : 'CLAIM_CONTRADICTED',
    );
    expect(() => validateEvidenceRecord(record)).toThrow();
  });
});

const unknownKeyPaths: Array<Array<string | number>> = [
  [],
  ['root_identity'],
  ['subject_identity'],
  ['producer_identity'],
  ['source_receipts', 0],
  ['independent_review'],
  ['payload'],
  ['payload', 'scope'],
  ['payload', 'bindings'],
  ['payload', 'bindings', 'source_receipts', 0],
  ['payload', 'bindings', 'build_identity'],
  ['payload', 'bindings', 'kind_details'],
];

const addUnknownKey = (path: Array<string | number>): MutableRecord => {
  const record = artifactRecord('RUNTIME');
  addUnknownKeyAt(record, path);
  return record;
};

type ClosedShapeCase = Readonly<{
  name: string;
  build: () => MutableRecord;
  path: readonly (string | number)[];
  requiredKey: string;
}>;

const recordFamilyClosedShapeCases: readonly ClosedShapeCase[] = [
  { name: 'ARTIFACT payload', build: artifactRecord, path: ['payload'], requiredKey: 'id' },
  {
    name: 'NEGATIVE_CONTROL_RESULT payload',
    build: negativeControlRecord,
    path: ['payload'],
    requiredKey: 'control_id',
  },
  { name: 'GRADE payload', build: gradeRecord, path: ['payload'], requiredKey: 'id' },
  {
    name: 'CORRECTION payload',
    build: correctionRecord,
    path: ['payload'],
    requiredKey: 'target_record_id',
  },
];

const kindRequiredKeys: Readonly<Record<ArtifactKind, string>> = {
  STATIC: 'source_snapshot_identity',
  RUNTIME: 'invocation_receipt_ids',
  DEPLOYMENT: 'control_plane_artifact_id',
  AUTHENTICATED_E2E: 'journey_id',
  LONGITUDINAL: 'protocol_id',
  ACCESSIBILITY: 'evaluation_id',
  DELETION: 'deletion_receipt_id',
  GRADE_INPUT: 'presentation_packet_id',
};

const artifactKindClosedShapeCases: readonly ClosedShapeCase[] = artifactKinds.map((kind) => ({
  name: `${kind} kind_details`,
  build: () => artifactRecord(kind),
  path: ['payload', 'bindings', 'kind_details'],
  requiredKey: kindRequiredKeys[kind],
}));

const artifactWithFailureTellObservation = (): MutableRecord => {
  const record = artifactRecord();
  writePath(record, ['payload', 'status'], 'FAIL');
  writePath(record, ['payload', 'outcome'], 'CLAIM_CONTRADICTED');
  writePath(record, ['payload', 'limitations'], ['observed failure tell']);
  writePath(record, ['payload', 'bindings', 'failure_tell_observations'], [{
    failure_tell_id: 'FT-N0-MISSING-SOURCE',
    slice_ids: ['N0'],
    gate_ids: ['S'],
    requirement_ids: ['N0-S1'],
    subject_identity: subjectIdentity(),
    observed: true,
    artifact_ids: ['artifact-static-1'],
    scope: scope(),
    review_output_identities: [identity('7')],
  }]);
  return record;
};

const artifactWithClaimAssertion = (): MutableRecord => {
  const record = artifactRecord();
  writePath(record, ['payload', 'bindings', 'claim_assertions'], [{
    claim_id: 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION',
    conditional_requirement_ids: ['N1-L1'],
    subject_identity: subjectIdentity(),
    assertion_state: 'ASSERTED',
    artifact_ids: ['artifact-static-1'],
    review_output_identities: [identity('7')],
  }]);
  return record;
};

const nestedClosedShapeCases: readonly ClosedShapeCase[] = [
  {
    name: 'NEGATIVE_CONTROL_RESULT requirement link',
    build: negativeControlRecord,
    path: ['payload', 'requirement_links', 0],
    requiredKey: 'evidence_requirement_ids',
  },
  {
    name: 'NEGATIVE_CONTROL_RESULT network evidence',
    build: negativeControlRecord,
    path: ['payload', 'network_evidence'],
    requiredKey: 'content_identity',
  },
  {
    name: 'failure-tell observation carrier',
    build: artifactWithFailureTellObservation,
    path: ['payload', 'bindings', 'failure_tell_observations', 0],
    requiredKey: 'failure_tell_id',
  },
  {
    name: 'conditional-claim assertion carrier',
    build: artifactWithClaimAssertion,
    path: ['payload', 'bindings', 'claim_assertions', 0],
    requiredKey: 'claim_id',
  },
];

describe('exact-key and collection rules', () => {
  it.each(unknownKeyPaths.map((path) => ({ path })))('rejects an unknown key at path $path', ({ path }) => {
    expect(() => validateEvidenceRecord(addUnknownKey(path))).toThrow();
  });

  it.each([
    ...recordFamilyClosedShapeCases,
    ...artifactKindClosedShapeCases,
    ...nestedClosedShapeCases,
  ])('accepts then closes injected and required keys for $name', ({ build, path, requiredKey }) => {
    const positive = build();
    expect(() => validateEvidenceRecord(positive)).not.toThrow();

    const injected = build();
    addUnknownKeyAt(injected, path);
    expect(() => validateEvidenceRecord(injected)).toThrow();

    const missing = build();
    removePath(missing, [...path, requiredKey]);
    expect(() => validateEvidenceRecord(missing)).toThrow();
  });

  it('accepts a null-prototype data envelope', () => {
    const record = artifactRecord();
    Object.setPrototypeOf(record, null);
    expect(() => validateEvidenceRecord(record)).not.toThrow();
  });

  it('rejects inherited required and inherited unknown properties', () => {
    const inheritedRequired = artifactRecord();
    const schemaVersion = readPath(inheritedRequired, ['schema_version']);
    removePath(inheritedRequired, ['schema_version']);
    Object.setPrototypeOf(inheritedRequired, { schema_version: schemaVersion });
    expect(() => validateEvidenceRecord(inheritedRequired)).toThrow();

    const inheritedUnknown = artifactRecord();
    Object.setPrototypeOf(inheritedUnknown, { unexpected_mes_key: true });
    expect(() => validateEvidenceRecord(inheritedUnknown)).toThrow();
  });

  it('rejects accessors without invoking them', () => {
    const record = artifactRecord();
    let getterCalls = 0;
    Object.defineProperty(record, 'created_at', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return '2026-09-02T00:00:00.000Z';
      },
    });
    expect(() => validateEvidenceRecord(record)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it('rejects non-enumerable and symbol keys', () => {
    const nonEnumerable = artifactRecord();
    Object.defineProperty(nonEnumerable, 'unexpected_mes_key', {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });
    expect(() => validateEvidenceRecord(nonEnumerable)).toThrow();

    const symbolic = artifactRecord();
    Object.defineProperty(symbolic, Symbol('unexpected_mes_key'), {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
    expect(() => validateEvidenceRecord(symbolic)).toThrow();
  });

  it('requires envelope and binding receipt lists to be byte-equal', () => {
    const record = artifactRecord('RUNTIME');
    writePath(
      record,
      ['payload', 'bindings', 'source_receipts', 0, 'receipt_id'],
      'different-attempt',
    );
    expect(() => validateEvidenceRecord(record)).toThrow();
  });

  it('requires receipt semantic sets to be UTF-8-byte sorted and unique', () => {
    const record = artifactRecord('DEPLOYMENT');
    const receipts = readPath(record, ['source_receipts']);
    if (!Array.isArray(receipts)) throw new Error('TEST_FIXTURE_RECEIPTS_REQUIRED');
    const reversed = clone(receipts).reverse();
    writePath(record, ['source_receipts'], reversed);
    writePath(record, ['payload', 'bindings', 'source_receipts'], clone(reversed));
    expect(() => validateEvidenceRecord(record)).toThrow();
  });

  it.each([
    ['duplicate requirement set member', (record: MutableRecord) => {
      writePath(record, ['payload', 'evidence_requirement_ids'], ['N0-S1', 'N0-S1']);
    }],
    ['unsorted requirement set', (record: MutableRecord) => {
      writePath(record, ['payload', 'evidence_requirement_ids'], ['N0-S2', 'N0-S1']);
    }],
    ['duplicate grade ordered member', (record: MutableRecord) => {
      writePath(record, ['payload', 'artifact_ids'], ['artifact-a', 'artifact-a']);
    }],
  ])('rejects %s', (name, mutate) => {
    const record = name.includes('grade') ? gradeRecord() : artifactRecord();
    mutate(record);
    expect(() => validateEvidenceRecord(record)).toThrow();
  });

  it('preserves non-lexical order for ordered arrays while rejecting duplicates', () => {
    const record = artifactRecord('AUTHENTICATED_E2E');
    expect(readPath(record, ['payload', 'bindings', 'kind_details', 'step_ids']))
      .toEqual(['step-b', 'step-a']);
    expect(() => validateEvidenceRecord(record)).not.toThrow();
    writePath(record, ['payload', 'bindings', 'kind_details', 'step_ids'], ['step-a', 'step-a']);
    expect(() => validateEvidenceRecord(record)).toThrow();
  });
});

describe('timestamp, safe-integer, and identity grammar', () => {
  it.each([
    ['created_at', (record: MutableRecord) => {
      writePath(record, ['created_at'], '2026-09-02T00:00:00Z');
    }],
    ['captured_at', (record: MutableRecord) => {
      writePath(record, ['payload', 'captured_at'], '2026-09-02 00:00:00.000Z');
    }],
    ['unsafe horizon', (record: MutableRecord) => {
      writePath(
        record,
        ['payload', 'bindings', 'kind_details', 'horizon_seconds'],
        Number.MAX_SAFE_INTEGER + 1,
      );
    }],
    ['negative byte length', (record: MutableRecord) => {
      writePath(record, ['root_identity', 'byte_length'], -1);
    }],
    ['uppercase hash', (record: MutableRecord) => {
      writePath(record, ['root_identity', 'sha256'], 'A'.repeat(64));
    }],
    ['short artifact hash', (record: MutableRecord) => {
      writePath(record, ['payload', 'sha256'], '0'.repeat(63));
    }],
  ])('rejects malformed %s', (name, mutate) => {
    const record = name === 'unsafe horizon' ? artifactRecord('LONGITUDINAL') : artifactRecord();
    mutate(record);
    expect(() => validateEvidenceRecord(record)).toThrow();
  });
});

const ROOT_SOURCE_KEYS = [
  'specification',
  'implementationPlan',
  'matrix',
  'answerKey',
  'historicalTask4Capsule',
  'failureTellDefinitions',
  'negativeControlDefinitions',
  'successorLaneDefinition',
  'firstVerticalJourney',
  'recordSchemas',
  'deterministicReducer',
  'task13Experiment',
  'closureRule',
  'n9SuccessorPolicy',
] as const;

type RootSourceKey = typeof ROOT_SOURCE_KEYS[number];

type MatrixRequirement = Readonly<{
  id: string;
  gate: string;
  independence: string;
  condition?: string;
}>;

type MatrixSlice = Readonly<{
  id: string;
  required_gates: string[];
  gate_status: Readonly<Record<string, string>>;
  evidence_requirements: MatrixRequirement[];
  conditional_gates?: Readonly<Record<string, string>>;
}>;

type MatrixFailureTell = Readonly<{
  id: string;
  slice_id: string;
  text: string;
}>;

type MatrixRequirementLink = Readonly<{
  slice_id: string;
  gate: string;
  evidence_requirement_ids: string[];
}>;

type MatrixNegativeControl = Readonly<{
  id: string;
  applicable_slice_ids: string[];
  requirement_links: MatrixRequirementLink[];
  probe: string;
  expected: string;
}>;

type MatrixFixture = Readonly<{
  slices: MatrixSlice[];
  failure_tells: MatrixFailureTell[];
  negative_controls: MatrixNegativeControl[];
}>;

const ROOT_REPOSITORY_PATHS: Readonly<Record<
  'specification' | 'implementationPlan' | 'matrix' | 'answerKey' | 'historicalTask4Capsule',
  string
>> = {
  specification: 'docs/superpowers/specs/2026-09-01-socratic-ai-minimal-evidence-spine-design.md',
  implementationPlan: 'docs/superpowers/plans/2026-09-01-socratic-ai-critical-path-b.md',
  matrix: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json',
  answerKey: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/COMPOSITE_ANSWER_KEY_CANDIDATE.md',
  historicalTask4Capsule: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/admission/inputs/task-4-cutoff-state-capsule.md',
};

const ROOT_IDENTITY_KEYS: Readonly<Record<RootSourceKey, string>> = {
  specification: 'specification',
  implementationPlan: 'implementation_plan',
  matrix: 'matrix',
  answerKey: 'answer_key',
  historicalTask4Capsule: 'historical_task4_capsule',
  failureTellDefinitions: 'failure_tell_definitions',
  negativeControlDefinitions: 'negative_control_definitions',
  successorLaneDefinition: 'successor_lane_definition',
  firstVerticalJourney: 'first_vertical_journey',
  recordSchemas: 'record_schemas',
  deterministicReducer: 'deterministic_reducer',
  task13Experiment: 'task13_experiment',
  closureRule: 'closure_rule',
  n9SuccessorPolicy: 'n9_successor_policy',
};

const APPROVED_REPOSITORY_SOURCE_IDENTITIES: Readonly<Partial<Record<
  RootSourceKey,
  ContentIdentity
>>> = {
  specification: {
    byte_length: 37324,
    sha256: '132454449036677bbc39678bbf5a31f7f2fd0990860e59a9bcd7b2aef237c59f',
  },
  implementationPlan: {
    byte_length: 80405,
    sha256: 'e4aca90670bebe7adcee106d4df2d63ef6ec01ca476faab4029fd9ba59869756',
  },
  matrix: {
    byte_length: 66605,
    sha256: '6e0184e7c771bad7e95604c8cfc37b0e006064ec9dc9d5a06129b482842f4d60',
  },
  answerKey: {
    byte_length: 26213,
    sha256: '4f16ccdbb7c2d1dceda1994dca49d7e867d3404bf66c4494a3fcccb8fa239137',
  },
  historicalTask4Capsule: {
    byte_length: 8942,
    sha256: '8e04132ffdbd97aea93f49ffedc411d39bccf4a8fe4c6519483ff8aa8f783654',
  },
};

const repositorySourceBytes = (relativePath: string): Uint8Array => (
  new Uint8Array(readFileSync(resolve(process.cwd(), relativePath)))
);

const parseMatrixFixture = (matrixBytes: Uint8Array): MatrixFixture => (
  JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(matrixBytes)) as MatrixFixture
);

const canonicalSource = (value: unknown): Uint8Array => (
  canonicalDocument(value as CanonicalJsonValue)
);

const buildDefinitionValues = async (matrixBytes: Uint8Array): Promise<Readonly<{
  failureTellDefinitions: MutableRecord;
  negativeControlDefinitions: MutableRecord;
  successorLaneDefinition: MutableRecord;
  firstVerticalJourney: MutableRecord;
  recordSchemas: MutableRecord;
  deterministicReducer: MutableRecord;
  task13Experiment: MutableRecord;
  closureRule: MutableRecord;
}>> => {
  const matrix = parseMatrixFixture(matrixBytes);
  const matrixIdentity = await contentIdentity(matrixBytes);
  const n9 = matrix.slices.find((slice) => slice.id === 'N9');
  if (!n9) throw new Error('TEST_FIXTURE_N9_REQUIRED');

  return {
    failureTellDefinitions: {
      schema_version: 'MES-1',
      matrix_identity: matrixIdentity,
      failure_tells: matrix.failure_tells.map(({ id, slice_id, text }) => ({ id, slice_id, text })),
    },
    negativeControlDefinitions: {
      schema_version: 'MES-1',
      matrix_identity: matrixIdentity,
      negative_controls: matrix.negative_controls.map((control) => ({
        id: control.id,
        applicable_slice_ids: control.applicable_slice_ids,
        requirement_links: control.requirement_links,
        probe: control.probe,
        expected_outcome: control.expected,
      })),
    },
    successorLaneDefinition: {
      schema_version: 'MES-1',
      lane_id: 'N9_SUCCESSOR_V1',
      blocked_requirement_ids: n9.evidence_requirements
        .filter((requirement) => n9.gate_status[requirement.gate] === 'BLOCKED_CONTRACT')
        .map((requirement) => requirement.id),
      required_negative_control_ids: ['NC-ACCESS', 'NC-DELETE', 'NC-SCOPE', 'NC-SURVEILLANCE'],
      required_authorization_bindings: [
        'account_alias_identities',
        'allowed_action_ids',
        'allowed_file_ids',
        'approval_identity',
        'deployment_identity',
        'historical_capsule_identity',
        'implementation_plan_identity',
        'maximum_claim',
        'prohibited_action_ids',
        'root_identity',
        'stop_condition_ids',
      ],
      safeguard_dimensions: [
        'accessibility',
        'consent',
        'contestability',
        'deletion',
        'fairness',
        'human_review',
        'privacy',
      ],
      stop_condition_ids: [
        'CROSS_ACCOUNT_ACCESS',
        'DELETION_RESIDUE',
        'SCOPE_BROADENING',
        'SURVEILLANCE_REQUIREMENT',
      ],
      maximum_claim: 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY',
    },
    firstVerticalJourney: {
      schema_version: 'MES-1',
      journey_id: 'KOREAN_TRAINING_TO_GROWTH_V1',
      learner_locale: 'ko',
      distinct_account_roles: ['LEARNER_A', 'LEARNER_B'],
      required_target_identity_kinds: [
        'AI_INVOCATION_ATTEMPT',
        'TRAINING_SCENARIO_EVIDENCE',
        'TRAINING_SCENARIO_PACK',
      ],
      ordered_step_ids: [
        'bind-runtime-identities',
        'authenticate-distinct-accounts',
        'select-books-and-query-in-korean',
        'complete-two-attributable-training-turns',
        'inspect-evidence-and-provenance',
        'create-growth-consent-and-private-space',
        'open-growth-cycle-from-training-origin',
        'contest-gap-and-choose-practice',
        'schedule-real-recheck',
        'attempt-foreign-account-operations',
        'exercise-korean-accessibility',
        'delete-cycle-and-inspect-residue',
        'emit-detached-evidence-candidates',
      ],
      immediate_evidence_scopes: ['account-isolation', 'context-binding', 'korean-comprehension'],
      longitudinal_follow_up: 'SEPARATELY_GATED_AFTER_CONTEXT_CHANGE',
    },
    recordSchemas: {
      schema_version: 'MES-1',
      common_envelope: 'MinimalEvidenceEnvelopeV1',
      families: [
        'ARTIFACT',
        'CORRECTION',
        'GRADE',
        'NEGATIVE_CONTROL_RESULT',
      ],
      artifact_kind_details: artifactKinds,
      vocabulary: {
        artifact_statuses: ['FAIL', 'PASS', 'PENDING', 'UNGRADABLE', 'UNKNOWN'],
        grade_verdicts: [
          'A CLEARLY BETTER',
          'B CLEARLY BETTER',
          'SAME GRADE',
          'UNGRADABLE',
        ],
      },
    },
    deterministicReducer: {
      schema_version: 'MES-1',
      reducer_id: 'MINIMAL_EVIDENCE_REDUCER_V1',
      admitted_record_rule: 'ADMITTED_ACTIVE_RECORDS_ONLY',
      active_record_rule: 'ALL_UNSUPERSEDED_RECORDS_PER_EVIDENCE_KEY',
      status_precedence: [
        'BLOCKED_CONTRACT',
        'FAIL',
        'UNKNOWN',
        'UNGRADABLE',
        'PENDING',
        'PASS',
      ],
      pass_prerequisites: [
        'ALL_REQUIRED_LINKS_PASS',
        'NO_ACTIVE_FAILURE_TELL',
        'ALL_LINKED_NEGATIVE_CONTROLS_PASS',
        'CONDITIONAL_CLAIM_ASSERTED_WHEN_APPLICABLE',
      ],
      correction_rule: 'EXACT_TARGET_AND_ADMITTED_SAME_ROOT_REPLACEMENTS',
      missing_evidence_rule: 'PENDING_OR_UNKNOWN_NEVER_PASS',
    },
    task13Experiment: {
      schema_version: 'MES-1',
      experiment_id: 'TASK_13_TIME_TO_EVIDENCE_V1',
      separately_authorized: true,
      pre_e2e_prerequisite: false,
      pre_authorization_output: 'CONFIGURATION_ONLY',
      prohibited_claims: ['EXPERIMENT_PASSED', 'FIFTY_PERCENT_REDUCTION_PROVED'],
      later_execution_contract: 'EXACT_ROOT_AND_SEPARATE_DIRECT_AUTHORIZATION_REQUIRED',
    },
    closureRule: {
      schema_version: 'MES-1',
      unauthorized_status: 'NOT_EVALUATED',
      incomplete_status: 'NOT_CLEARED',
      cleared_status: 'CLEARED',
      required_conditions: [
        'ALL_11_SLICES_PASS',
        'ALL_64_REQUIREMENTS_PASS',
        'N9_NONCOMPENSATORY_PASS',
        'TWO_INDEPENDENT_CROSS_VENDOR_SAME_GRADE',
        'MATERIALLY_DIFFERENT_SUPPORTING_REASONS',
        'SEPARATELY_AUTHORIZED_CLOSURE_EVALUATION',
      ],
    },
  };
};

const validRootInputs = async (): Promise<Readonly<{
  sources: RootSourceBytes;
  expected: ExpectedRootIdentities;
  definitions: Awaited<ReturnType<typeof buildDefinitionValues>>;
}>> => {
  const sourceValues: MutableRecord = Object.create(null) as MutableRecord;
  for (const [key, relativePath] of Object.entries(ROOT_REPOSITORY_PATHS)) {
    sourceValues[key] = repositorySourceBytes(relativePath);
  }

  const matrixBytes = readPath(sourceValues, ['matrix']);
  if (!(matrixBytes instanceof Uint8Array)) throw new Error('TEST_FIXTURE_MATRIX_BYTES_REQUIRED');
  const definitions = await buildDefinitionValues(matrixBytes);
  for (const key of [
    'failureTellDefinitions',
    'negativeControlDefinitions',
    'successorLaneDefinition',
    'firstVerticalJourney',
    'recordSchemas',
    'deterministicReducer',
    'task13Experiment',
    'closureRule',
  ] as const) {
    sourceValues[key] = canonicalSource(definitions[key]);
  }
  sourceValues.n9SuccessorPolicy = repositorySourceBytes(
    'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b/sources/n9-successor-policy.json',
  );

  const expectedValues: MutableRecord = Object.create(null) as MutableRecord;
  for (const key of ROOT_SOURCE_KEYS) {
    const source = readPath(sourceValues, [key]);
    if (!(source instanceof Uint8Array)) throw new Error(`TEST_FIXTURE_SOURCE_BYTES_REQUIRED:${key}`);
    expectedValues[key] = APPROVED_REPOSITORY_SOURCE_IDENTITIES[key]
      ?? await contentIdentity(source);
  }

  return {
    sources: sourceValues as unknown as RootSourceBytes,
    expected: expectedValues as unknown as ExpectedRootIdentities,
    definitions,
  };
};

type RevisableDefinitionSourceKey =
  | 'successorLaneDefinition'
  | 'firstVerticalJourney'
  | 'recordSchemas'
  | 'deterministicReducer'
  | 'task13Experiment'
  | 'closureRule';

type DefinitionRevisionCase = Readonly<{
  name: string;
  sourceKey: RevisableDefinitionSourceKey;
  rootKey: string;
  path: readonly (string | number)[];
  revise: (current: unknown) => unknown;
}>;

const definitionRevisionCases: readonly DefinitionRevisionCase[] = [
  {
    name: 'successor lane',
    sourceKey: 'successorLaneDefinition',
    rootKey: 'successor_lane',
    path: ['maximum_claim'],
    revise: () => 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY_REVISION_PROOF',
  },
  {
    name: 'first vertical journey',
    sourceKey: 'firstVerticalJourney',
    rootKey: 'first_vertical_journey',
    path: ['ordered_step_ids'],
    revise: (current) => {
      if (!Array.isArray(current)) throw new Error('TEST_FIXTURE_ORDERED_STEPS_REQUIRED');
      return [...current, 'source-revision-proof'];
    },
  },
  {
    name: 'record schemas',
    sourceKey: 'recordSchemas',
    rootKey: 'record_schemas',
    path: ['common_envelope'],
    revise: () => 'MinimalEvidenceEnvelopeRevisionProofV1',
  },
  {
    name: 'deterministic reducer',
    sourceKey: 'deterministicReducer',
    rootKey: 'deterministic_reducer',
    path: ['reducer_id'],
    revise: () => 'MINIMAL_EVIDENCE_REDUCER_REVISION_PROOF_V1',
  },
  {
    name: 'Task 13 experiment',
    sourceKey: 'task13Experiment',
    rootKey: 'task13_experiment',
    path: ['experiment_id'],
    revise: () => 'TASK_13_TIME_TO_EVIDENCE_REVISION_PROOF_V1',
  },
  {
    name: 'closure rule',
    sourceKey: 'closureRule',
    rootKey: 'closure_rule',
    path: ['required_conditions'],
    revise: (current) => {
      if (!Array.isArray(current)) throw new Error('TEST_FIXTURE_CLOSURE_CONDITIONS_REQUIRED');
      return [...current, 'ROOT_SOURCE_REVISION_PROOF'];
    },
  },
];

type MatrixDerivedRevisionCase = Readonly<{
  name: string;
  matrixPath: readonly (string | number)[];
  revisedValue: string;
  rootKey: 'failure_tell_definitions' | 'negative_controls';
  definitionKey: 'failureTellDefinitions' | 'negativeControlDefinitions';
  definitionListKey: 'failure_tells' | 'negative_controls';
}>;

const matrixDerivedRevisionCases: readonly MatrixDerivedRevisionCase[] = [
  {
    name: 'failure-tell definitions',
    matrixPath: ['failure_tells', 0, 'text'],
    revisedValue: 'Source revision proof: the failure tell text changed under a new matrix identity.',
    rootKey: 'failure_tell_definitions',
    definitionKey: 'failureTellDefinitions',
    definitionListKey: 'failure_tells',
  },
  {
    name: 'negative-control definitions',
    matrixPath: ['negative_controls', 0, 'probe'],
    revisedValue: 'Source revision proof: execute the same bounded negative control with revised instructions.',
    rootKey: 'negative_controls',
    definitionKey: 'negativeControlDefinitions',
    definitionListKey: 'negative_controls',
  },
];

describe('root source byte and identity gates precede semantic parsing', () => {
  it.each(ROOT_SOURCE_KEYS)('rejects missing %s bytes', async (key) => {
    const { sources, expected } = await validRootInputs();
    const missing = { ...sources } as MutableRecord;
    removePath(missing, [key]);
    await expect(loadEvidenceSpineRoot(missing as unknown as RootSourceBytes, expected))
      .rejects.toThrow(`MES_ROOT_SOURCE_MISSING:${key}`);
  });

  it.each(ROOT_SOURCE_KEYS)('rejects changed %s bytes', async (key) => {
    const { sources, expected } = await validRootInputs();
    const changed = { ...sources, [key]: new Uint8Array([...sources[key], 0x20]) };
    await expect(loadEvidenceSpineRoot(changed, expected))
      .rejects.toThrow(`MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`);
  });

  it.each(ROOT_SOURCE_KEYS)('rejects wrong expected identity for %s', async (key) => {
    const { sources, expected } = await validRootInputs();
    const wrongExpected = {
      ...expected,
      [key]: identity('0', expected[key].byte_length),
    };
    await expect(loadEvidenceSpineRoot(sources, wrongExpected))
      .rejects.toThrow(`MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`);
  });

  it('rejects a parsed-equivalent source with different bytes', async () => {
    const { sources, expected } = await validRootInputs();
    const changed = {
      ...sources,
      failureTellDefinitions: bytes(new TextDecoder().decode(sources.failureTellDefinitions).replace(
        '"schema_version":"MES-1"',
        '"schema_version":"\\u004dES-1"',
      )),
    };
    await expect(loadEvidenceSpineRoot(changed, expected))
      .rejects.toThrow('MES_ROOT_SOURCE_IDENTITY_MISMATCH:failureTellDefinitions');
  });

  it('derives the complete immutable root from all fourteen verified source byte strings', async () => {
    const { sources, expected, definitions } = await validRootInputs();
    const loaded = await loadEvidenceSpineRoot(sources, expected);
    const matrix = parseMatrixFixture(sources.matrix);
    const expectedRequirements = matrix.slices.flatMap((slice) => (
      slice.evidence_requirements.map((requirement) => ({
        id: requirement.id,
        slice_id: slice.id,
        gate: requirement.gate,
        independence: requirement.independence,
      }))
    ));
    const expectedTellLinks = matrix.failure_tells.map((tell) => {
      const slice = matrix.slices.find((candidate) => candidate.id === tell.slice_id);
      if (!slice) throw new Error(`TEST_FIXTURE_TELL_SLICE_REQUIRED:${tell.id}`);
      return {
        failure_tell_id: tell.id,
        slice_id: tell.slice_id,
        links: slice.required_gates.map((gate) => ({
          gate,
          requirement_ids: slice.evidence_requirements
            .filter((requirement) => requirement.gate === gate)
            .map((requirement) => requirement.id),
        })),
      };
    });
    const expectedConditionalClaims = [
      {
        claim_id: 'CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION',
        matrix_identity: expected.matrix,
        slice_id: 'N1',
        gate: 'L',
        requirement_id: 'N1-L1',
        gate_rule: 'required for learner-model validity or calibration claims',
        condition: 'learner-model validity or calibration is claimed',
      },
      {
        claim_id: 'CLAIM-N2-ROUTE-EFFICACY-FAIRNESS',
        matrix_identity: expected.matrix,
        slice_id: 'N2',
        gate: 'L',
        requirement_id: 'N2-L1',
        gate_rule: 'required for route efficacy or fairness claims',
        condition: 'route efficacy or fairness is claimed',
      },
      {
        claim_id: 'CLAIM-N10-DURABILITY-SCAFFOLD-FADE',
        matrix_identity: expected.matrix,
        slice_id: 'N10',
        gate: 'L',
        requirement_id: 'N10-L1',
        gate_rule: 'required when N6 durability or N8 scaffold-fade effects are asserted',
        condition: 'N6 durability or N8 scaffold-fade effects are asserted',
      },
    ];

    expect(readPath(loaded.root, ['slice_ids'])).toEqual([
      'N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10',
    ]);
    expect(readPath(loaded.root, ['requirements'])).toEqual(expectedRequirements);
    expect(new Set(expectedRequirements.map(({ id }) => id)).size).toBe(64);
    expect(readPath(loaded.root, ['failure_tell_definitions']))
      .toEqual(readPath(definitions.failureTellDefinitions, ['failure_tells']));
    expect(readPath(loaded.root, ['failure_tell_links'])).toEqual(expectedTellLinks);
    expect(readPath(loaded.root, ['negative_controls']))
      .toEqual(readPath(definitions.negativeControlDefinitions, ['negative_controls']));
    expect(readPath(loaded.root, ['conditional_claims'])).toEqual(expectedConditionalClaims);
    expect(readPath(loaded.root, ['successor_lane'])).toEqual(definitions.successorLaneDefinition);
    expect(readPath(loaded.root, ['first_vertical_journey'])).toEqual(definitions.firstVerticalJourney);
    expect(readPath(loaded.root, ['record_schemas'])).toEqual(definitions.recordSchemas);
    expect(readPath(loaded.root, ['deterministic_reducer'])).toEqual(definitions.deterministicReducer);
    expect(readPath(loaded.root, ['task13_experiment'])).toEqual(definitions.task13Experiment);
    expect(readPath(loaded.root, ['closure_rule'])).toEqual(definitions.closureRule);
    expect(readPath(loaded.root, ['n9_successor_policy']))
      .toEqual(parseAuthorityJson(readPath(sources, ['n9SuccessorPolicy']) as Uint8Array));
    expect(readPath(loaded.root, ['successor_lane', 'blocked_requirement_ids']))
      .toEqual(['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1']);
    expect(readPath(loaded.root, ['deterministic_reducer', 'status_precedence']))
      .toEqual(['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS']);
    expect(readPath(loaded.root, ['record_schemas', 'vocabulary', 'grade_verdicts']))
      .toEqual(['A CLEARLY BETTER', 'B CLEARLY BETTER', 'SAME GRADE', 'UNGRADABLE']);

    const sourceIdentities = asMutableRecord(readPath(loaded.root, ['source_identities']));
    expect(Object.keys(sourceIdentities).sort()).toEqual(Object.values(ROOT_IDENTITY_KEYS).sort());
    for (const key of ROOT_SOURCE_KEYS) {
      expect(sourceIdentities[ROOT_IDENTITY_KEYS[key]]).toEqual(expected[key]);
    }

    for (const forbiddenKey of [
      'admitted_artifacts',
      'artifacts',
      'closure_result',
      'closure_status',
      'current_requirement_statuses',
      'current_status',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(loaded.root, forbiddenKey)).toBe(false);
    }
    expect(await contentIdentity(canonicalSource(loaded.root))).toEqual(loaded.identity);
  });

  it.each(definitionRevisionCases)(
    'uses the valid changed $name source instead of substituting code constants',
    async ({ sourceKey, rootKey, path, revise }) => {
      const initial = await validRootInputs();
      const first = await loadEvidenceSpineRoot(initial.sources, initial.expected);
      const revisedDefinitions = clone(initial.definitions) as unknown as MutableRecord;
      const definition = readPath(revisedDefinitions, [sourceKey]);
      const current = readPath(definition, path);
      const revisedValue = revise(current);
      writePath(definition, path, revisedValue);
      const revisedBytes = canonicalSource(definition);
      const revisedSources = { ...initial.sources, [sourceKey]: revisedBytes };
      const revisedExpected = {
        ...initial.expected,
        [sourceKey]: await contentIdentity(revisedBytes),
      };
      const revised = await loadEvidenceSpineRoot(revisedSources, revisedExpected);

      expect(readPath(first.root, [rootKey, ...path])).not.toEqual(revisedValue);
      expect(readPath(revised.root, [rootKey, ...path])).toEqual(revisedValue);
      expect(revised.identity).not.toEqual(first.identity);
      expect(readPath(revised.root, ['source_identities', ROOT_IDENTITY_KEYS[sourceKey]]))
        .toEqual(revisedExpected[sourceKey]);
    },
  );

  it.each(matrixDerivedRevisionCases)(
    'rederives and uses a valid changed $name source instead of code constants',
    async ({ matrixPath, revisedValue, rootKey, definitionKey, definitionListKey }) => {
      const initial = await validRootInputs();
      const first = await loadEvidenceSpineRoot(initial.sources, initial.expected);
      const revisedMatrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
      writePath(revisedMatrix, matrixPath, revisedValue);
      const revisedMatrixBytes = canonicalSource(revisedMatrix);
      const revisedDefinitions = await buildDefinitionValues(revisedMatrixBytes);
      const revisedFailureTellBytes = canonicalSource(revisedDefinitions.failureTellDefinitions);
      const revisedNegativeControlBytes = canonicalSource(revisedDefinitions.negativeControlDefinitions);
      const revisedSources = {
        ...initial.sources,
        matrix: revisedMatrixBytes,
        failureTellDefinitions: revisedFailureTellBytes,
        negativeControlDefinitions: revisedNegativeControlBytes,
      };
      const revisedExpected = {
        ...initial.expected,
        matrix: await contentIdentity(revisedMatrixBytes),
        failureTellDefinitions: await contentIdentity(revisedFailureTellBytes),
        negativeControlDefinitions: await contentIdentity(revisedNegativeControlBytes),
      };
      const revised = await loadEvidenceSpineRoot(revisedSources, revisedExpected);
      const expectedDefinition = readPath(revisedDefinitions[definitionKey], [definitionListKey]);

      expect(readPath(revised.root, [rootKey])).toEqual(expectedDefinition);
      expect(readPath(revised.root, [rootKey])).not.toEqual(readPath(first.root, [rootKey]));
      expect(revised.identity).not.toEqual(first.identity);
      expect(readPath(revised.root, ['source_identities', 'matrix']))
        .toEqual(revisedExpected.matrix);
      expect(readPath(revised.root, ['source_identities', ROOT_IDENTITY_KEYS[definitionKey]]))
        .toEqual(revisedExpected[definitionKey]);
    },
  );
});

describe('reviewer regression: immutable closed evidence spine boundary', () => {
  it('freezes the accepted family vocabulary and rejects every non-family at the public boundary', () => {
    expect(Object.isFrozen(RECORD_FAMILIES)).toBe(true);
    expect(() => validateEvidenceRecord({ record_family: 'C1_CONTROL' }))
      .toThrowError('MES_RECORD_FAMILY_REJECTED');
  });

  it('deep-freezes every returned root descendant before exposing its content identity', async () => {
    const { sources, expected } = await validRootInputs();
    const loaded = await loadEvidenceSpineRoot(sources, expected);
    const before = await contentIdentity(canonicalSource(loaded.root));

    expect(Object.isFrozen(loaded.root)).toBe(true);
    expect(Object.isFrozen(readPath(loaded.root, ['slice_ids']))).toBe(true);
    expect(Object.isFrozen(readPath(loaded.root, ['source_identities']))).toBe(true);
    expect(Object.isFrozen(readPath(loaded.root, ['failure_tell_links', 0, 'links']))).toBe(true);
    expect(() => (readPath(loaded.root, ['slice_ids']) as string[]).push('N11')).toThrow();
    expect(await contentIdentity(canonicalSource(loaded.root))).toEqual(before);
    expect(before).toEqual(loaded.identity);
  });

  it('rejects a refreshed successor definition that weakens root-owned control requirements', async () => {
    const initial = await validRootInputs();
    const revised = clone(initial.definitions.successorLaneDefinition);
    writePath(revised, ['required_negative_control_ids'], ['NC-ACCESS']);
    const revisedBytes = canonicalSource(revised);
    const sources = { ...initial.sources, successorLaneDefinition: revisedBytes };
    const expected = {
      ...initial.expected,
      successorLaneDefinition: await contentIdentity(revisedBytes),
    };

    await expect(loadEvidenceSpineRoot(sources, expected)).rejects.toThrow('MES_ROOT_SUCCESSOR_LANE_INVALID');
  });

  it('rejects a refreshed matrix whose slice omits a declared failure-tell membership', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', 0, 'failure_tell_ids'], []);
    const matrixBytes = canonicalSource(matrix);
    const definitions = await buildDefinitionValues(matrixBytes);
    const failureTellDefinitions = canonicalSource(definitions.failureTellDefinitions);
    const negativeControlDefinitions = canonicalSource(definitions.negativeControlDefinitions);
    const sources = {
      ...initial.sources,
      matrix: matrixBytes,
      failureTellDefinitions,
      negativeControlDefinitions,
    };
    const expected = {
      ...initial.expected,
      matrix: await contentIdentity(matrixBytes),
      failureTellDefinitions: await contentIdentity(failureTellDefinitions),
      negativeControlDefinitions: await contentIdentity(negativeControlDefinitions),
    };

    await expect(loadEvidenceSpineRoot(sources, expected)).rejects.toThrow('MES_ROOT_MATRIX_INTEGRITY_INVALID');
  });

  it('rejects a later-entry mutation triggered during expected-identity descriptor access', async () => {
    const initial = await validRootInputs();
    const revisedSuccessor = clone(initial.definitions.successorLaneDefinition);
    writePath(revisedSuccessor, ['maximum_claim'], 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY_REVISED');
    const revisedSuccessorBytes = canonicalSource(revisedSuccessor);
    const revisedSuccessorIdentity = await contentIdentity(revisedSuccessorBytes);
    const sourceTarget = { ...initial.sources };
    const expectedTarget = { ...initial.expected };
    let mutated = false;
    const expected = new Proxy(expectedTarget, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'specification' && !mutated) {
          mutated = true;
          sourceTarget.successorLaneDefinition = revisedSuccessorBytes;
          target.successorLaneDefinition = revisedSuccessorIdentity;
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(loadEvidenceSpineRoot(sourceTarget, expected)).rejects
      .toThrow('MES_ROOT_SOURCE_IDENTITY_MISMATCH:successorLaneDefinition');
  });

  it('rejects a non-STATIC record without receipts and a self-reviewed record', () => {
    const missingReceipts = artifactRecord('RUNTIME');
    writePath(missingReceipts, ['source_receipts'], []);
    writePath(missingReceipts, ['payload', 'bindings', 'source_receipts'], []);
    expect(() => validateEvidenceRecord(missingReceipts)).toThrow();

    const selfReviewed = artifactRecord();
    writePath(selfReviewed, ['independent_review', 'reviewer_identity'], 'fixture-builder-1');
    expect(() => validateEvidenceRecord(selfReviewed)).toThrow();
  });

  it('returns a frozen descriptor-derived record snapshot, not caller-owned mutable input', () => {
    const record = artifactRecord();
    const validated = validateEvidenceRecord(record);
    const before = canonicalSource(validated);

    writePath(record, ['payload', 'id'], 'artifact-caller-mutated');
    expect(Object.isFrozen(validated)).toBe(true);
    expect(readPath(validated, ['payload', 'id'])).toBe('artifact-static-1');
    expect(canonicalSource(validated)).toEqual(before);
  });

  it('snapshots proxy descriptor data before validation can revisit the caller graph', () => {
    const record = artifactRecord();
    let payloadDescriptorReads = 0;
    const proxied = new Proxy(record, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'payload') {
          payloadDescriptorReads += 1;
          if (payloadDescriptorReads === 4) {
            writePath(target, ['payload', 'id'], 'artifact-proxy-drifted');
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const validated = validateEvidenceRecord(proxied);
    expect(readPath(validated, ['payload', 'id'])).toBe('artifact-static-1');
    expect(readPath(record, ['payload', 'id'])).toBe('artifact-static-1');
    expect(payloadDescriptorReads).toBe(1);
  });

  it('rejects duplicate and out-of-order negative-control requirement links', () => {
    const duplicate = negativeControlRecord();
    const duplicateLink = clone(readPath(duplicate, ['payload', 'requirement_links', 0]));
    writePath(duplicate, ['payload', 'requirement_links'], [duplicateLink, duplicateLink]);
    expect(() => validateEvidenceRecord(duplicate)).toThrow();

    const unordered = negativeControlRecord();
    const original = clone(readPath(unordered, ['payload', 'requirement_links', 0])) as MutableRecord;
    writePath(original, ['gate'], 'R');
    writePath(original, ['evidence_requirement_ids'], ['N9-R1']);
    writePath(unordered, ['payload', 'requirement_links'], [clone(readPath(unordered, ['payload', 'requirement_links', 0])), original]);
    expect(() => validateEvidenceRecord(unordered)).toThrow();
  });
});

const rootInputsForRevisedMatrix = async (
  initial: Awaited<ReturnType<typeof validRootInputs>>,
  revisedMatrix: MutableRecord,
): Promise<Readonly<{ sources: RootSourceBytes; expected: ExpectedRootIdentities }>> => {
  const matrix = canonicalSource(revisedMatrix);
  const definitions = await buildDefinitionValues(matrix);
  const failureTellDefinitions = canonicalSource(definitions.failureTellDefinitions);
  const negativeControlDefinitions = canonicalSource(definitions.negativeControlDefinitions);
  return {
    sources: {
      ...initial.sources,
      matrix,
      failureTellDefinitions,
      negativeControlDefinitions,
    },
    expected: {
      ...initial.expected,
      matrix: await contentIdentity(matrix),
      failureTellDefinitions: await contentIdentity(failureTellDefinitions),
      negativeControlDefinitions: await contentIdentity(negativeControlDefinitions),
    },
  };
};

describe('Critical Path B Task 2 repair round 2 causal boundaries', () => {
  it.each(['RUNTIME', 'DEPLOYMENT', 'GRADE_INPUT'] as const)(
    'requires retention and access policy identities for encrypted %s artifacts',
    (kind) => {
      const record = artifactRecord(kind);
      writePath(record, ['payload', 'bindings', 'retention_policy_identity'], null);
      writePath(record, ['payload', 'bindings', 'access_policy_identity'], null);
      expect(() => validateEvidenceRecord(record)).toThrow('MES_ARTIFACT_INVALID');
    },
  );

  it('rejects C1 controls in canonical record text', () => {
    const record = correctionRecord();
    writePath(record, ['payload', 'reason'], 'A stale capture was found\u007f.');
    expect(() => validateEvidenceRecord(record)).toThrow('MES_CORRECTION_INVALID');
  });

  it('rejects array exotic pseudo-index 4294967295', () => {
    const record = artifactRecord();
    const receipts = readPath(record, ['source_receipts']);
    if (!Array.isArray(receipts)) throw new Error('TEST_FIXTURE_RECEIPT_ARRAY_REQUIRED');
    Object.defineProperty(receipts, '4294967295', {
      enumerable: true,
      configurable: true,
      value: sourceReceipt('BUILD', 'array-exotic'),
    });
    expect(() => validateEvidenceRecord(record)).toThrow('MES_RECORD_SHAPE_INVALID');
  });

  it('rejects an out-of-order first-vertical baseline prefix', async () => {
    const initial = await validRootInputs();
    const journey = clone(initial.definitions.firstVerticalJourney);
    const originalSteps = readPath(journey, ['ordered_step_ids']);
    if (!Array.isArray(originalSteps)) throw new Error('TEST_FIXTURE_ORDERED_STEPS_REQUIRED');
    writePath(journey, ['ordered_step_ids'], [
      'authenticate-distinct-accounts',
      'bind-runtime-identities',
      ...originalSteps.slice(2),
    ]);
    const journeyBytes = canonicalSource(journey);
    await expect(loadEvidenceSpineRoot(
      { ...initial.sources, firstVerticalJourney: journeyBytes },
      { ...initial.expected, firstVerticalJourney: await contentIdentity(journeyBytes) },
    )).rejects.toThrow('MES_ROOT_FIRST_VERTICAL_INVALID');
  });

  it.each([
    ['admitted_record_rule', 'ADMITTED_RECORDS_MAY_BE_ACTIVE'],
    ['active_record_rule', 'ONE_FAVORABLE_RECORD_PER_EVIDENCE_KEY'],
    ['correction_rule', 'SAME_ROOT_REPLACEMENTS_ONLY'],
    ['missing_evidence_rule', 'PENDING_CAN_PASS'],
  ] as const)('rejects mutated deterministic reducer %s', async (fieldName, replacement) => {
    const initial = await validRootInputs();
    const reducer = clone(initial.definitions.deterministicReducer);
    writePath(reducer, [fieldName], replacement);
    const reducerBytes = canonicalSource(reducer);
    await expect(loadEvidenceSpineRoot(
      { ...initial.sources, deterministicReducer: reducerBytes },
      { ...initial.expected, deterministicReducer: await contentIdentity(reducerBytes) },
    )).rejects.toThrow('MES_ROOT_REDUCER_INVALID');
  });

  it.each([
    ['N1', 1, 5, 'condition', 'a different learner-model condition'],
    ['N2', 2, 5, 'condition', 'a different route-efficacy condition'],
    ['N10', 10, 3, 'condition', 'a different durability condition'],
  ] as const)('rejects mutated conditional claim source for %s', async (_slice, sliceIndex, requirementIndex, key, replacement) => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', sliceIndex, 'evidence_requirements', requirementIndex, key], replacement);
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_CONDITIONAL_CLAIMS_INVALID');
  });

  it('rejects a renamed approved requirement even when the matrix remains 64 rows', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', 0, 'evidence_requirements', 0, 'id'], 'N0-D9');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_REQUIREMENTS_INVALID');
  });

  it('rejects a required matrix gate with no owned requirement or tell-link target', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', 0, 'evidence_requirements', 0, 'gate'], 'S');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_REQUIREMENTS_INVALID');
  });

  it('rejects renamed failure-tell vocabulary despite preserved count and linkage', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['failure_tells', 0, 'id'], 'FT-N0-REPLACED');
    writePath(matrix, ['slices', 0, 'failure_tell_ids', 0], 'FT-N0-REPLACED');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_FAILURE_TELLS_INVALID');
  });

  it('rejects a dangling required N9 control when the matrix substitutes a fake control id', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    const controlIndex = (readPath(matrix, ['negative_controls']) as MutableRecord[])
      .findIndex((control) => control.id === 'NC-DELETE');
    if (controlIndex < 0) throw new Error('TEST_FIXTURE_N9_DELETE_CONTROL_REQUIRED');
    writePath(matrix, ['negative_controls', controlIndex, 'id'], 'NC-N9-FAKE');
    const n9ControlIndex = (readPath(matrix, ['slices', 9, 'negative_control_ids']) as string[])
      .indexOf('NC-DELETE');
    if (n9ControlIndex < 0) throw new Error('TEST_FIXTURE_N9_DELETE_REFERENCE_REQUIRED');
    writePath(matrix, ['slices', 9, 'negative_control_ids', n9ControlIndex], 'NC-N9-FAKE');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_NEGATIVE_CONTROLS_INVALID');
  });

  it('rejects a gate-status literal outside the closed vocabulary', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', 0, 'gate_status', 'D'], 'PROMOTED');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_MATRIX_INTEGRITY_INVALID');
  });

  it('preserves the N9 pending and blocked-contract baseline independently of successor definitions', async () => {
    const initial = await validRootInputs();
    const matrix = clone(parseMatrixFixture(initial.sources.matrix)) as unknown as MutableRecord;
    writePath(matrix, ['slices', 9, 'gate_status', 'D'], 'PASS');
    const revised = await rootInputsForRevisedMatrix(initial, matrix);
    await expect(loadEvidenceSpineRoot(revised.sources, revised.expected))
      .rejects.toThrow('MES_ROOT_MATRIX_INTEGRITY_INVALID');
  });

  it('rejects C1 controls in root configuration text', async () => {
    const initial = await validRootInputs();
    const journey = clone(initial.definitions.firstVerticalJourney);
    writePath(journey, ['journey_id'], 'KOREAN_TRAINING_TO_GROWTH_V1\u0080');
    const journeyBytes = canonicalSource(journey);
    await expect(loadEvidenceSpineRoot(
      { ...initial.sources, firstVerticalJourney: journeyBytes },
      { ...initial.expected, firstVerticalJourney: await contentIdentity(journeyBytes) },
    )).rejects.toThrow();
  });
});
