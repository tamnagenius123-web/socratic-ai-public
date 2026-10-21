import { AuthorityJsonError, canonicalDocument, type CanonicalJsonValue } from './canonical-json';
import { createGenesisEntry, verifyManifestPrefix } from './evidence-spine-manifest';
import { projectEvidenceSpine } from './evidence-spine-projection';
import { loadEvidenceSpineRoot } from './evidence-spine-root';
import type {
  ArtifactKind,
  EvidenceManifestEntryV1,
  EvidenceSpineRootV1,
  ExpectedRootIdentities,
  RootSourceBytes,
  SpineProjectionV1,
  VerifiedManifestPrefix,
} from './evidence-spine-types';
import { contentIdentity, type ContentIdentity } from './identity';

type MatrixRequirement = Readonly<{ id: string; gate: string }>;
type MatrixSlice = Readonly<{
  id: string;
  gate_status: Readonly<Record<string, string>>;
  evidence_requirements: readonly MatrixRequirement[];
}>;
type MatrixFailureTell = Readonly<{ id: string; slice_id: string; text: string }>;
type MatrixRequirementLink = Readonly<{
  slice_id: string;
  gate: string;
  evidence_requirement_ids: readonly string[];
}>;
type MatrixNegativeControl = Readonly<{
  id: string;
  applicable_slice_ids: readonly string[];
  requirement_links: readonly MatrixRequirementLink[];
  probe: string;
  expected: string;
}>;
type MatrixDocument = Readonly<{
  slices: readonly MatrixSlice[];
  failure_tells: readonly MatrixFailureTell[];
  negative_controls: readonly MatrixNegativeControl[];
}>;

const textEncoder = new TextEncoder();

export interface EvidenceSpineRepositorySources {
  specification: Uint8Array;
  implementationPlan: Uint8Array;
  matrix: Uint8Array;
  answerKey: Uint8Array;
  historicalTask4Capsule: Uint8Array;
}

export interface RootOwnedDefinitionDocuments {
  failureTellDefinitions: Uint8Array;
  negativeControlDefinitions: Uint8Array;
  successorLaneDefinition: Uint8Array;
  firstVerticalJourney: Uint8Array;
  recordSchemas: Uint8Array;
  deterministicReducer: Uint8Array;
  task13Experiment: Uint8Array;
  closureRule: Uint8Array;
  n9SuccessorPolicy: Uint8Array;
}

export interface EvidenceSpineBaselineDocuments {
  sources: RootOwnedDefinitionDocuments;
  root: Uint8Array;
  manifest: Uint8Array;
  projection: Uint8Array;
}

export interface DerivedEvidenceSpineBaseline {
  rootSourceBytes: RootSourceBytes;
  sourceIdentities: ExpectedRootIdentities;
  root: EvidenceSpineRootV1;
  rootIdentity: ContentIdentity;
  genesisEntry: EvidenceManifestEntryV1;
  verifiedPrefix: VerifiedManifestPrefix;
  projection: SpineProjectionV1;
  documents: EvidenceSpineBaselineDocuments;
}

const approvedRepositorySourceIdentities = Object.freeze({
  specification: {
    byte_length: 37_324,
    sha256: '132454449036677bbc39678bbf5a31f7f2fd0990860e59a9bcd7b2aef237c59f',
  },
  implementationPlan: {
    byte_length: 80_405,
    sha256: 'e4aca90670bebe7adcee106d4df2d63ef6ec01ca476faab4029fd9ba59869756',
  },
  matrix: {
    byte_length: 66_605,
    sha256: '6e0184e7c771bad7e95604c8cfc37b0e006064ec9dc9d5a06129b482842f4d60',
  },
  answerKey: {
    byte_length: 26_213,
    sha256: '4f16ccdbb7c2d1dceda1994dca49d7e867d3404bf66c4494a3fcccb8fa239137',
  },
  historicalTask4Capsule: {
    byte_length: 8_942,
    sha256: '8e04132ffdbd97aea93f49ffedc411d39bccf4a8fe4c6519483ff8aa8f783654',
  },
} satisfies Readonly<Record<keyof EvidenceSpineRepositorySources, ContentIdentity>>);

const artifactKinds = Object.freeze([
  'STATIC',
  'RUNTIME',
  'DEPLOYMENT',
  'AUTHENTICATED_E2E',
  'LONGITUDINAL',
  'ACCESSIBILITY',
  'DELETION',
  'GRADE_INPUT',
] as const satisfies readonly ArtifactKind[]);

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function canonical(value: unknown): Uint8Array {
  return canonicalDocument(value as CanonicalJsonValue);
}

function parseMatrix(bytes: Uint8Array): MatrixDocument {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as MatrixDocument;
  } catch {
    throw new AuthorityJsonError('MES_BASELINE_MATRIX_INVALID');
  }
}

function compareTextBytes(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function sortText(values: readonly string[]): readonly string[] {
  return [...values].sort(compareTextBytes);
}

function sortIdentities(values: readonly ContentIdentity[]): readonly ContentIdentity[] {
  return [...values].sort((left, right) => compareTextBytes(left.sha256, right.sha256) || left.byte_length - right.byte_length);
}

const N9_CONTROL_SPECS = Object.freeze([
  ['N9-CTRL-CONSENT', 'S', 'consent', 'The owner consent boundary is explicit and revocable.'],
  ['N9-CTRL-PURPOSE', 'S', 'purpose', 'The request is limited to its declared learning purpose.'],
  ['N9-CTRL-RETENTION', 'R', 'retention', 'Retention is limited to the declared private evidence policy.'],
  ['N9-CTRL-PRECONSENT-OPTOUT', 'R', 'pre-consent-optout', 'An opt-out before consent is honored without a completion claim.'],
  ['N9-CTRL-POSTCONSENT-REVOCATION', 'R', 'post-consent-revocation', 'A later revocation is honored and does not erase immutable history.'],
  ['N9-CTRL-CONTEST', 'R', 'contest', 'A contest path remains available without rewriting prior evidence.'],
  ['N9-CTRL-CORRECTION', 'R', 'correction', 'A correction appends a bounded replacement and preserves history.'],
  ['N9-CTRL-HUMAN-REVIEW-PENDING', 'P', 'human-review-pending', 'POST creates only an owner-scoped PENDING request; review is not complete.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-READ', 'P', 'account-b-foreign-read', 'Account B receives no Account A learner content.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-ENUMERATE', 'P', 'account-b-foreign-enumerate', 'Account B cannot enumerate Account A records.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-MUTATE', 'P', 'account-b-foreign-mutate', 'Account B cannot mutate Account A records.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-SCHEDULE', 'A', 'account-b-foreign-schedule', 'Account B cannot schedule an operation for Account A.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-CORRECT', 'A', 'account-b-foreign-correct', 'Account B cannot correct Account A records.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-RESTORE', 'A', 'account-b-foreign-restore', 'Account B cannot restore Account A records.'],
  ['N9-CTRL-ACCOUNT-B-FOREIGN-DELETE', 'A', 'account-b-foreign-delete', 'Account B cannot delete Account A records.'],
  ['N9-CTRL-DECLARED-STORE-DELETION-RESIDUE', 'A', 'declared-store-deletion-residue', 'The declared store residue probe is observed without claiming external deletion truth.'],
  ['N9-CTRL-KOREAN-COMPREHENSION', 'L', 'korean-comprehension', 'The Korean surface communicates literal PENDING and its non-completion meaning.'],
  ['N9-CTRL-KEYBOARD', 'L', 'keyboard', 'The journey is operable with a keyboard.'],
  ['N9-CTRL-FOCUS', 'L', 'focus', 'Focus remains visible and ordered through the journey.'],
  ['N9-CTRL-SCREEN-READER', 'L', 'screen-reader', 'The journey exposes status and errors to assistive technology.'],
  ['N9-CTRL-ZOOM-400', 'L', 'zoom-400', 'The journey remains usable at 400 percent zoom.'],
  ['N9-CTRL-REFLOW-320', 'L', 'reflow-320', 'The journey reflows at a 320 pixel viewport.'],
  ['N9-CTRL-MOBILE-KEYBOARD', 'L', 'mobile-keyboard', 'Mobile keyboard interaction does not hide the active task.'],
  ['N9-CTRL-REDUCED-MOTION', 'L', 'reduced-motion', 'Reduced-motion preferences are respected.'],
  ['N9-CTRL-PROHIBITED-INFERENCE-REVIEW', 'L', 'prohibited-inference-review', 'Prohibited subgroup or mental-IQ inferences are reviewed and not asserted.'],
  ['N9-CTRL-TRUTHFUL-DEGRADATION', 'L', 'truthful-degradation', 'Missing evidence degrades truthfully to a non-passing state.'],
] as const);

const declaredStorePolicyDescriptor = {
  schemaVersion: 'MES-1',
  policyId: 'N9_DECLARED_STORE_POLICY_V1',
  storeKinds: ['GROWTH_CYCLE', 'HUMAN_REVIEW_REQUEST'],
  accessRule: 'NAMED_OWNER_OR_GOVERNED_REVIEW_ONLY',
  retentionRule: 'PRIVATE_CONTAINER_RETENTION_ONLY',
};

const privateContainerPolicyDescriptors = [
  {
    schemaVersion: 'MES-1',
    policyId: 'N9_ACCESSIBILITY_CONTAINER_POLICY_V1',
    accessRule: 'NAMED_AUTHORIZED_OBSERVER_ONLY',
    encryptionRule: 'EXTERNAL_KEY_REQUIRED',
    retentionRule: 'TIME_BOUNDED_PRIVATE_CONTAINER',
  },
  {
    schemaVersion: 'MES-1',
    policyId: 'N9_EVIDENCE_CONTAINER_POLICY_V1',
    accessRule: 'NAMED_AUTHORIZED_OBSERVER_ONLY',
    encryptionRule: 'EXTERNAL_KEY_REQUIRED',
    retentionRule: 'TIME_BOUNDED_PRIVATE_CONTAINER',
  },
] as const;

async function buildN9SuccessorPolicy(
  implementationPlanIdentity: ContentIdentity,
  historicalCapsuleIdentity: ContentIdentity,
): Promise<CanonicalJsonValue> {
  const accountAliasIdentities = sortIdentities(await Promise.all([
    contentIdentity(canonical({ alias: 'N9_ACCOUNT_A_PSEUDONYM_V1', role: 'LEARNER_A' })),
    contentIdentity(canonical({ alias: 'N9_ACCOUNT_B_PSEUDONYM_V1', role: 'LEARNER_B' })),
  ]));
  const privateContainerPolicyIdentities = sortIdentities(await Promise.all(
    privateContainerPolicyDescriptors.map((descriptor) => contentIdentity(canonical(descriptor))),
  ));
  const declaredStorePolicyIdentity = await contentIdentity(canonical(declaredStorePolicyDescriptor));
  const blockedRequirementIds = ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'] as const;
  const prohibitedActionIds = sortText([
    'N9-ACTION-ADMIT',
    'N9-ACTION-BROWSER-EXECUTION',
    'N9-ACTION-CANDIDATE-APPEND',
    'N9-ACTION-CLOSURE',
    'N9-ACTION-D1-WRITE',
    'N9-ACTION-GRADE',
    'N9-ACTION-PROVIDER-CALL',
  ]);
  const controls = N9_CONTROL_SPECS.map(([controlId, gateId, , expectedOutcome], stepIndex) => {
    const accountAliasIdentity = controlId.includes('ACCOUNT-B-FOREIGN')
      ? accountAliasIdentities[1]
      : accountAliasIdentities[0];
    const routeId = controlId === 'N9-CTRL-HUMAN-REVIEW-PENDING'
      ? '/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests'
      : `N9-ROUTE-${controlId}`;
    const actionId = controlId === 'N9-CTRL-HUMAN-REVIEW-PENDING'
      ? 'N9-ACTION-POST-HUMAN-REVIEW-REQUEST'
      : `N9-ACTION-${controlId}`;
    const requirementId = `N9-${gateId}1`;
    const artifactPrefix = `N9-ARTIFACT-${String(stepIndex).padStart(2, '0')}`;
    return {
      stepIndex,
      controlId,
      accountAliasIdentity,
      routeId,
      actionId,
      allowedFileIds: [`N9-FILE-${controlId}`],
      prohibitedActionIds,
      stopConditionIds: ['CROSS_ACCOUNT_ACCESS', 'DELETION_RESIDUE', 'SCOPE_BROADENING', 'SURVEILLANCE_REQUIREMENT'],
      maximumClaim: 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY',
      expectedOutcome,
      beforeCaptureId: `${controlId}-BEFORE`,
      afterCaptureId: `${controlId}-AFTER`,
      actionLogCaptureId: `${controlId}-ACTION-LOG`,
      networkEvidenceCaptureId: `${controlId}-NETWORK-EVIDENCE`,
      artifactIds: sortText([
        `${artifactPrefix}-ACTION-LOG`,
        `${artifactPrefix}-AFTER`,
        `${artifactPrefix}-BEFORE`,
        `${artifactPrefix}-NETWORK`,
      ]),
      sliceId: 'N9',
      gateId,
      requirementIds: [requirementId],
      requiredReceiptKinds: ['BROWSER_ACTION_LOG', 'CONTROL_PLANE', 'RECHECK', 'SOURCE_MANIFEST'],
      privateContainerPolicyIdentities,
    };
  });
  return {
    schemaVersion: 'MES-1',
    policyId: 'N9_SUCCESSOR_POLICY_V1',
    implementationPlanIdentity,
    historicalCapsuleIdentity,
    successorLaneId: 'N9_SUCCESSOR_V1',
    blockedRequirementIds,
    accountAliasIdentities,
    allowedActionIds: sortText(controls.map((control) => control.actionId)),
    allowedFileIds: sortText(controls.map((control) => control.allowedFileIds[0])),
    prohibitedActionIds,
    stopConditionIds: ['CROSS_ACCOUNT_ACCESS', 'DELETION_RESIDUE', 'SCOPE_BROADENING', 'SURVEILLANCE_REQUIREMENT'],
    maximumClaim: 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY',
    controls,
    declaredStorePolicyIdentity,
    privateContainerPolicyIdentities,
  } as unknown as CanonicalJsonValue;
}

async function buildRootOwnedDefinitionDocuments(
  matrixBytes: Uint8Array,
  implementationPlanIdentity: ContentIdentity,
  historicalCapsuleIdentity: ContentIdentity,
): Promise<RootOwnedDefinitionDocuments> {
  const matrix = parseMatrix(copyBytes(matrixBytes));
  const matrixIdentity = await contentIdentity(matrixBytes);
  const n9 = matrix.slices.find((slice) => slice.id === 'N9');
  if (!n9) throw new AuthorityJsonError('MES_BASELINE_N9_REQUIRED');

  return {
    failureTellDefinitions: canonical({
      schema_version: 'MES-1',
      matrix_identity: matrixIdentity,
      failure_tells: matrix.failure_tells.map(({ id, slice_id, text }) => ({ id, slice_id, text })),
    }),
    negativeControlDefinitions: canonical({
      schema_version: 'MES-1',
      matrix_identity: matrixIdentity,
      negative_controls: matrix.negative_controls.map((control) => ({
        id: control.id,
        applicable_slice_ids: control.applicable_slice_ids,
        requirement_links: control.requirement_links,
        probe: control.probe,
        expected_outcome: control.expected,
      })),
    }),
    successorLaneDefinition: canonical({
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
    }),
    firstVerticalJourney: canonical({
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
    }),
    recordSchemas: canonical({
      schema_version: 'MES-1',
      common_envelope: 'MinimalEvidenceEnvelopeV1',
      families: ['ARTIFACT', 'CORRECTION', 'GRADE', 'NEGATIVE_CONTROL_RESULT'],
      artifact_kind_details: artifactKinds,
      vocabulary: {
        artifact_statuses: ['FAIL', 'PASS', 'PENDING', 'UNGRADABLE', 'UNKNOWN'],
        grade_verdicts: ['A CLEARLY BETTER', 'B CLEARLY BETTER', 'SAME GRADE', 'UNGRADABLE'],
      },
    }),
    deterministicReducer: canonical({
      schema_version: 'MES-1',
      reducer_id: 'MINIMAL_EVIDENCE_REDUCER_V1',
      admitted_record_rule: 'ADMITTED_ACTIVE_RECORDS_ONLY',
      active_record_rule: 'ALL_UNSUPERSEDED_RECORDS_PER_EVIDENCE_KEY',
      status_precedence: ['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS'],
      pass_prerequisites: [
        'ALL_REQUIRED_LINKS_PASS',
        'NO_ACTIVE_FAILURE_TELL',
        'ALL_LINKED_NEGATIVE_CONTROLS_PASS',
        'CONDITIONAL_CLAIM_ASSERTED_WHEN_APPLICABLE',
      ],
      correction_rule: 'EXACT_TARGET_AND_ADMITTED_SAME_ROOT_REPLACEMENTS',
      missing_evidence_rule: 'PENDING_OR_UNKNOWN_NEVER_PASS',
    }),
    task13Experiment: canonical({
      schema_version: 'MES-1',
      experiment_id: 'TASK_13_TIME_TO_EVIDENCE_V1',
      separately_authorized: true,
      pre_e2e_prerequisite: false,
      pre_authorization_output: 'CONFIGURATION_ONLY',
      prohibited_claims: ['EXPERIMENT_PASSED', 'FIFTY_PERCENT_REDUCTION_PROVED'],
      later_execution_contract: 'EXACT_ROOT_AND_SEPARATE_DIRECT_AUTHORIZATION_REQUIRED',
    }),
    closureRule: canonical({
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
    }),
    n9SuccessorPolicy: canonical(await buildN9SuccessorPolicy(
      implementationPlanIdentity,
      historicalCapsuleIdentity,
    )),
  };
}

export async function deriveEvidenceSpineBaseline(
  input: EvidenceSpineRepositorySources,
): Promise<DerivedEvidenceSpineBaseline> {
  const repositorySources = {
    specification: copyBytes(input.specification),
    implementationPlan: copyBytes(input.implementationPlan),
    matrix: copyBytes(input.matrix),
    answerKey: copyBytes(input.answerKey),
    historicalTask4Capsule: copyBytes(input.historicalTask4Capsule),
  };
  for (const key of Object.keys(approvedRepositorySourceIdentities) as Array<
    keyof EvidenceSpineRepositorySources
  >) {
    const actual = await contentIdentity(repositorySources[key]);
    const expected = approvedRepositorySourceIdentities[key];
    if (actual.byte_length !== expected.byte_length || actual.sha256 !== expected.sha256) {
      throw new AuthorityJsonError(`MES_BASELINE_SOURCE_IDENTITY_MISMATCH:${key}`);
    }
  }
  const definitionSources = await buildRootOwnedDefinitionDocuments(
    repositorySources.matrix,
    approvedRepositorySourceIdentities.implementationPlan,
    approvedRepositorySourceIdentities.historicalTask4Capsule,
  );
  const rootSourceBytes: RootSourceBytes = {
    ...repositorySources,
    failureTellDefinitions: copyBytes(definitionSources.failureTellDefinitions),
    negativeControlDefinitions: copyBytes(definitionSources.negativeControlDefinitions),
    successorLaneDefinition: copyBytes(definitionSources.successorLaneDefinition),
    firstVerticalJourney: copyBytes(definitionSources.firstVerticalJourney),
    recordSchemas: copyBytes(definitionSources.recordSchemas),
    deterministicReducer: copyBytes(definitionSources.deterministicReducer),
    task13Experiment: copyBytes(definitionSources.task13Experiment),
    closureRule: copyBytes(definitionSources.closureRule),
    n9SuccessorPolicy: copyBytes(definitionSources.n9SuccessorPolicy),
  };
  const sourceIdentities: ExpectedRootIdentities = {
    specification: await contentIdentity(rootSourceBytes.specification),
    implementationPlan: await contentIdentity(rootSourceBytes.implementationPlan),
    matrix: await contentIdentity(rootSourceBytes.matrix),
    answerKey: await contentIdentity(rootSourceBytes.answerKey),
    historicalTask4Capsule: await contentIdentity(rootSourceBytes.historicalTask4Capsule),
    failureTellDefinitions: await contentIdentity(rootSourceBytes.failureTellDefinitions),
    negativeControlDefinitions: await contentIdentity(rootSourceBytes.negativeControlDefinitions),
    successorLaneDefinition: await contentIdentity(rootSourceBytes.successorLaneDefinition),
    firstVerticalJourney: await contentIdentity(rootSourceBytes.firstVerticalJourney),
    recordSchemas: await contentIdentity(rootSourceBytes.recordSchemas),
    deterministicReducer: await contentIdentity(rootSourceBytes.deterministicReducer),
    task13Experiment: await contentIdentity(rootSourceBytes.task13Experiment),
    closureRule: await contentIdentity(rootSourceBytes.closureRule),
    n9SuccessorPolicy: await contentIdentity(rootSourceBytes.n9SuccessorPolicy),
  };
  const loaded = await loadEvidenceSpineRoot(rootSourceBytes, sourceIdentities);
  const genesisEntry = createGenesisEntry(loaded.identity);
  const verifiedPrefix = await verifyManifestPrefix(loaded.identity, [genesisEntry]);
  if (verifiedPrefix.status !== 'VERIFIED') {
    throw new AuthorityJsonError('MES_BASELINE_GENESIS_INVALID');
  }
  const projection = projectEvidenceSpine(loaded.root, verifiedPrefix, new Map());
  return {
    rootSourceBytes,
    sourceIdentities,
    root: loaded.root,
    rootIdentity: loaded.identity,
    genesisEntry,
    verifiedPrefix,
    projection,
    documents: {
      sources: definitionSources,
      root: canonical(loaded.root),
      manifest: canonical(genesisEntry),
      projection: canonical(projection),
    },
  };
}
