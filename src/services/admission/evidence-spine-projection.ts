import { canonicalDocument, type CanonicalJsonValue } from './canonical-json';
import type { ContentIdentity } from './identity';
import type {
  ArtifactEvidenceRecordV1,
  CorrectionEvidenceRecordV1,
  EvidenceManifestEntryV1,
  EvidenceRecordV1,
  EvidenceSpineRootV1,
  NegativeControlEvidenceRecordV1,
  ProjectedRequirementV1,
  ProjectionRequirementStatusV1,
  SpineProjectionV1,
  VerifiedManifestPrefix,
} from './evidence-spine-types';

const STATUS_PRECEDENCE = Object.freeze([
  'BLOCKED_CONTRACT',
  'FAIL',
  'UNKNOWN',
  'UNGRADABLE',
  'PENDING',
  'PASS',
] as const satisfies readonly ProjectionRequirementStatusV1[]);

const HASH = /^[0-9a-f]{64}$/;

type Admission = Readonly<{
  entry: EvidenceManifestEntryV1;
  identity: ContentIdentity;
  record: EvidenceRecordV1;
  exact: boolean;
  sameRoot: boolean;
}>;

function asCanonical(value: unknown): CanonicalJsonValue {
  return value as CanonicalJsonValue;
}

function identityEqual(left: ContentIdentity | null, right: ContentIdentity | null): boolean {
  return left === null || right === null
    ? left === right
    : left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function cloneIdentity(identity: ContentIdentity): ContentIdentity {
  return { byte_length: identity.byte_length, sha256: identity.sha256 };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function canonicalRecordEqual(left: EvidenceRecordV1, right: EvidenceRecordV1): boolean {
  try {
    return bytesEqual(canonicalDocument(asCanonical(left)), canonicalDocument(asCanonical(right)));
  } catch {
    return false;
  }
}

function canonicalValueEqual(left: unknown, right: unknown): boolean {
  try {
    return bytesEqual(canonicalDocument(asCanonical(left)), canonicalDocument(asCanonical(right)));
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function combine(statuses: readonly ProjectionRequirementStatusV1[]): ProjectionRequirementStatusV1 {
  if (statuses.length === 0) return 'PENDING';
  return STATUS_PRECEDENCE.find((status) => statuses.includes(status)) ?? 'UNKNOWN';
}

function sortedUniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function sortedLineage(identities: readonly ContentIdentity[]): readonly ContentIdentity[] {
  const unique = new Map<string, ContentIdentity>();
  for (const identity of identities) {
    unique.set(`${identity.sha256}\u0000${identity.byte_length}`, cloneIdentity(identity));
  }
  return [...unique.values()].sort((left, right) => (
    (left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)
      || left.byte_length - right.byte_length
  ));
}

function admittedRecords(
  prefix: VerifiedManifestPrefix,
  recordsByIdentity: ReadonlyMap<string, EvidenceRecordV1>,
): Admission[] {
  const admissions: Admission[] = [];
  for (const entry of prefix.entries) {
    if (entry.ordinal === 0 || entry.disposition !== 'ADMITTED' || entry.candidate_identity === null) continue;
    const identity = entry.candidate_identity;
    if (!HASH.test(identity.sha256)) continue;
    const suppliedRecord = recordsByIdentity.get(identity.sha256);
    const registryRecord = prefix.records_by_identity[identity.sha256];
    if (!registryRecord) continue;
    admissions.push({
      entry,
      identity,
      record: registryRecord,
      exact: suppliedRecord !== undefined && canonicalRecordEqual(registryRecord, suppliedRecord),
      sameRoot: identityEqual(registryRecord.root_identity, prefix.root_identity),
    });
  }
  return admissions;
}

function correctionGraph(admissions: readonly Admission[]) {
  const admittedById = new Map<string, Admission>();
  for (const admission of admissions) {
    if (admission.exact && admission.sameRoot) {
      admittedById.set(admission.record.record_id, admission);
    }
  }
  const corrections = admissions.filter(
    (admission): admission is Admission & Readonly<{ record: CorrectionEvidenceRecordV1 }> => (
      admission.record.record_family === 'CORRECTION'
    ),
  ).sort((left, right) => left.entry.ordinal - right.entry.ordinal);
  const targetCounts = new Map<string, number>();
  for (const correction of corrections) {
    const targetId = correction.record.payload.target_record_id;
    targetCounts.set(targetId, (targetCounts.get(targetId) ?? 0) + 1);
  }
  const edges = new Map<string, readonly string[]>();
  for (const correction of corrections) {
    edges.set(correction.record.payload.target_record_id, correction.record.payload.replacement_record_ids);
  }
  const inCycle = (start: string, current: string, seen: Set<string>): boolean => {
    if (seen.has(current)) return current === start;
    seen.add(current);
    return (edges.get(current) ?? []).some(
      (next) => next === start || inCycle(start, next, new Set(seen)),
    );
  };
  const deactivatingCorrectionByTarget = new Map<string, string>();
  const evaluations: Array<Readonly<{
    correction: Admission & Readonly<{ record: CorrectionEvidenceRecordV1 }>;
    target: Admission | undefined;
    valid: boolean;
  }>> = [];
  const isActive = (recordId: string, seen = new Set<string>()): boolean => {
    const correctionId = deactivatingCorrectionByTarget.get(recordId);
    if (!correctionId) return true;
    if (seen.has(correctionId)) return false;
    seen.add(correctionId);
    return !isActive(correctionId, seen);
  };
  for (const correction of corrections) {
    const payload = correction.record.payload;
    const target = admittedById.get(payload.target_record_id);
    const replacements = payload.replacement_record_ids.map((recordId) => admittedById.get(recordId));
    const replacementsComplete = replacements.every((replacement): replacement is Admission => replacement !== undefined);
    const valid = correction.exact
      && correction.sameRoot
      && target !== undefined
      && target.entry.ordinal < correction.entry.ordinal
      && isActive(target.record.record_id)
      && identityEqual(target.identity, payload.target_record_identity)
      && identityEqual(correction.entry.predecessor_identity, payload.effective_manifest_head_identity)
      && targetCounts.get(payload.target_record_id) === 1
      && replacements.length > 0
      && replacementsComplete
      && replacements.every((replacement) => replacement.entry.ordinal < correction.entry.ordinal)
      && !inCycle(payload.target_record_id, payload.target_record_id, new Set());
    if (valid) {
      deactivatingCorrectionByTarget.set(payload.target_record_id, correction.record.record_id);
    }
    evaluations.push({ correction, target, valid });
  }
  const inactiveRecordIds = new Set<string>();
  for (const admission of admittedById.values()) {
    if (!isActive(admission.record.record_id)) inactiveRecordIds.add(admission.record.record_id);
  }
  const poisonedEvidenceKeys = new Set<string>();
  for (const evaluation of evaluations) {
    if (!evaluation.valid
      && evaluation.target
      && isActive(evaluation.correction.record.record_id)) {
      poisonedEvidenceKeys.add(evaluation.target.record.evidence_key);
    }
  }
  return { inactiveRecordIds, poisonedEvidenceKeys };
}

function requiredBindingFactsPresent(record: ArtifactEvidenceRecordV1): boolean {
  if (record.payload.status !== 'PASS') return true;
  const { bindings, kind, path_or_url: locator } = record.payload;
  if (bindings.kind_details.kind !== kind) return false;
  if (!canonicalValueEqual(record.source_receipts, bindings.source_receipts)) return false;
  if (kind !== 'STATIC' && record.source_receipts.length === 0) return false;

  const required = new Set<string>();
  if ((kind === 'STATIC' && bindings.kind_details.code_bound)
    || ['RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'GRADE_INPUT'].includes(kind)) {
    required.add('build_identity');
  }
  if (['DEPLOYMENT', 'AUTHENTICATED_E2E', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT'].includes(kind)) {
    required.add('deployment_identity');
  }
  if (['AUTHENTICATED_E2E', 'LONGITUDINAL', 'DELETION'].includes(kind)) {
    required.add('account_scope_identity');
  }
  if (['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'GRADE_INPUT'].includes(kind)) {
    required.add('capture_environment_identity');
  }
  const privateArtifact = ['AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION'].includes(kind);
  if (privateArtifact || !locator.startsWith('repo://')) {
    required.add('retention_policy_identity');
    required.add('access_policy_identity');
  }
  const identityKeys = [
    'build_identity',
    'deployment_identity',
    'account_scope_identity',
    'capture_environment_identity',
    'retention_policy_identity',
    'access_policy_identity',
  ] as const;
  return identityKeys.every((key) => required.has(key) ? bindings[key] !== null : bindings[key] === null);
}

function controlStatus(
  recordId: string,
  requirementId: string,
  artifact: ArtifactEvidenceRecordV1,
  root: EvidenceSpineRootV1,
  activeControlsById: ReadonlyMap<string, Admission & Readonly<{ record: NegativeControlEvidenceRecordV1 }>>,
  poisonedEvidenceKeys: ReadonlySet<string>,
): Readonly<{ status: ProjectionRequirementStatusV1; identity: ContentIdentity | null }> {
  const admission = activeControlsById.get(recordId);
  if (!admission) return { status: 'UNKNOWN', identity: null };
  if (poisonedEvidenceKeys.has(admission.record.evidence_key)) {
    return { status: 'UNKNOWN', identity: admission.identity };
  }
  const definition = root.negative_controls.find((candidate) => candidate.id === admission.record.payload.control_id);
  if (!definition) return { status: 'UNKNOWN', identity: admission.identity };
  const linked = admission.record.payload.requirement_links.some(
    (link) => link.evidence_requirement_ids.includes(requirementId),
  );
  const defined = definition.requirement_links.some(
    (link) => link.evidence_requirement_ids.includes(requirementId),
  );
  if (!linked || !defined) return { status: 'UNKNOWN', identity: admission.identity };
  if (admission.record.payload.expected_outcome !== definition.expected_outcome) {
    return { status: 'FAIL', identity: admission.identity };
  }
  if (admission.record.payload.status === 'PASS'
    && admission.record.payload.observed_outcome !== definition.expected_outcome) {
    return { status: 'FAIL', identity: admission.identity };
  }
  const exactDefinition = canonicalValueEqual(admission.record.payload.slice_ids, definition.applicable_slice_ids)
    && canonicalValueEqual(admission.record.payload.requirement_links, definition.requirement_links);
  const exactArtifactBinding = canonicalValueEqual(admission.record.payload.subject_identity, artifact.subject_identity)
    && canonicalValueEqual(admission.record.payload.scope, artifact.payload.scope)
    && admission.record.payload.artifact_ids.includes(artifact.payload.id);
  if (!exactDefinition || !exactArtifactBinding) {
    return { status: 'UNKNOWN', identity: admission.identity };
  }
  return { status: admission.record.payload.status, identity: admission.identity };
}

function artifactStatus(
  admission: Admission & Readonly<{ record: ArtifactEvidenceRecordV1 }>,
  requirementId: string,
  root: EvidenceSpineRootV1,
  activeControlsById: ReadonlyMap<string, Admission & Readonly<{ record: NegativeControlEvidenceRecordV1 }>>,
  poisonedEvidenceKeys: ReadonlySet<string>,
): Readonly<{ status: ProjectionRequirementStatusV1; lineage: readonly ContentIdentity[] }> {
  const lineage: ContentIdentity[] = [admission.identity];
  let status: ProjectionRequirementStatusV1 = admission.record.payload.status;
  const requirement = root.requirements.find((candidate) => candidate.id === requirementId);
  const linkedRequirements = admission.record.payload.evidence_requirement_ids.map(
    (linkedId) => root.requirements.find((candidate) => candidate.id === linkedId),
  );
  const exactArtifactRelation = linkedRequirements.length > 0 && linkedRequirements.every((linked) => (
    linked !== undefined
    && linked.slice_id === admission.record.payload.slice_id
    && linked.gate === admission.record.payload.gate
  ));
  const entryIndependent = admission.entry.independence_verified
    && admission.entry.builder_identity !== null
    && admission.entry.reviewer_identity !== null
    && admission.entry.builder_identity !== admission.entry.reviewer_identity;
  const crossVendorIndependent = requirement?.independence !== 'NON_BUILDER_CROSS_VENDOR'
    || (admission.entry.builder_vendor_family !== null
      && admission.entry.reviewer_vendor_family !== null
      && admission.entry.builder_vendor_family !== admission.entry.reviewer_vendor_family);
  if (!requirement
    || admission.record.payload.slice_id !== requirement.slice_id
    || admission.record.payload.gate !== requirement.gate
    || !exactArtifactRelation
    || !entryIndependent
    || !crossVendorIndependent) {
    status = combine([status, 'UNKNOWN']);
  }
  if (!requiredBindingFactsPresent(admission.record)) status = combine([status, 'UNKNOWN']);

  for (const recordId of admission.record.payload.bindings.negative_control_result_ids) {
    const control = controlStatus(
      recordId,
      requirementId,
      admission.record,
      root,
      activeControlsById,
      poisonedEvidenceKeys,
    );
    status = combine([status, control.status]);
    if (control.identity) lineage.push(control.identity);
  }

  const requiredControls = root.negative_controls.filter((definition) => (
    definition.requirement_links.some((link) => link.evidence_requirement_ids.includes(requirementId))
  ));
  for (const definition of requiredControls) {
    const matched = admission.record.payload.bindings.negative_control_result_ids.some((recordId) => (
      activeControlsById.get(recordId)?.record.payload.control_id === definition.id
    ));
    if (!matched) status = combine([status, 'UNKNOWN']);
  }

  for (const observation of admission.record.payload.bindings.failure_tell_observations) {
    const definition = root.failure_tell_definitions.find((candidate) => candidate.id === observation.failure_tell_id);
    const link = root.failure_tell_links.find((candidate) => candidate.failure_tell_id === observation.failure_tell_id);
    if (!definition || !link || definition.slice_id !== link.slice_id) {
      status = combine([status, 'UNKNOWN']);
      continue;
    }
    const expectedRequirementIds = link.links.flatMap((candidate) => candidate.requirement_ids);
    if (!expectedRequirementIds.includes(requirementId)) continue;
    const exactObservation = canonicalValueEqual(observation.slice_ids, [link.slice_id])
      && canonicalValueEqual(observation.gate_ids, sortedUniqueStrings(
        link.links.map((candidate) => candidate.gate),
      ))
      && canonicalValueEqual(observation.requirement_ids, sortedUniqueStrings(expectedRequirementIds))
      && canonicalValueEqual(observation.subject_identity, admission.record.subject_identity)
      && canonicalValueEqual(observation.scope, admission.record.payload.scope)
      && observation.artifact_ids.includes(admission.record.payload.id)
      && observation.review_output_identities.length > 0;
    status = combine([status, exactObservation ? 'FAIL' : 'UNKNOWN']);
  }

  const conditional = root.conditional_claims.find((claim) => claim.requirement_id === requirementId);
  if (conditional) {
    const assertion = admission.record.payload.bindings.claim_assertions.find(
      (candidate) => candidate.claim_id === conditional.claim_id
        && candidate.conditional_requirement_ids.includes(requirementId),
    );
    if (!assertion || assertion.assertion_state === 'NOT_ASSERTED') {
      status = combine([status, 'PENDING']);
    } else if (!canonicalValueEqual(assertion.conditional_requirement_ids, [conditional.requirement_id])
      || !canonicalValueEqual(assertion.subject_identity, admission.record.subject_identity)
      || assertion.review_output_identities.length === 0) {
      status = combine([status, 'UNKNOWN']);
    } else if (assertion.assertion_state === 'UNKNOWN') {
      status = combine([status, 'UNKNOWN']);
    } else if (!assertion.artifact_ids.includes(admission.record.payload.id)) {
      status = combine([status, 'UNKNOWN']);
    }
  }
  return { status, lineage };
}

export function projectEvidenceSpine(
  root: EvidenceSpineRootV1,
  prefix: VerifiedManifestPrefix,
  recordsByIdentity: ReadonlyMap<string, EvidenceRecordV1>,
): SpineProjectionV1 {
  const blocked = new Set<string>(root.successor_lane.blocked_requirement_ids);
  const hasMissingRegistryAdmission = prefix.entries.some((entry) => (
    entry.ordinal !== 0
    && entry.disposition === 'ADMITTED'
    && entry.candidate_identity !== null
    && prefix.records_by_identity[entry.candidate_identity.sha256] === undefined
  ));
  const entriesBoundToPrefixRoot = prefix.entries.every((entry) => (
    identityEqual(entry.root_identity, prefix.root_identity)
  ));
  const manifestVerified = prefix.status === 'VERIFIED'
    && prefix.conflict_codes.length === 0
    && !hasMissingRegistryAdmission
    && entriesBoundToPrefixRoot;
  const admissions = manifestVerified ? admittedRecords(prefix, recordsByIdentity) : [];
  const { inactiveRecordIds, poisonedEvidenceKeys } = correctionGraph(admissions);
  const active = admissions.filter((admission) => (
    admission.exact
    && admission.sameRoot
    && admission.record.record_family !== 'CORRECTION'
    && !inactiveRecordIds.has(admission.record.record_id)
  ));
  const activeArtifacts = active.filter(
    (admission): admission is Admission & Readonly<{ record: ArtifactEvidenceRecordV1 }> => (
      admission.record.record_family === 'ARTIFACT'
    ),
  );
  const activeControlsById = new Map(active.flatMap((admission) => (
    admission.record.record_family === 'NEGATIVE_CONTROL_RESULT'
      ? [[admission.record.record_id, admission as Admission & Readonly<{ record: NegativeControlEvidenceRecordV1 }>]]
      : []
  )));
  const activeGrades = active.filter((admission) => admission.record.record_family === 'GRADE');
  const invalidArtifactAdmissions = admissions.filter((admission) => (
    admission.record.record_family === 'ARTIFACT' && (!admission.exact || !admission.sameRoot)
  ));

  const requirementRows: ProjectedRequirementV1[] = root.requirements.map((requirement) => {
    const artifacts = activeArtifacts.filter((admission) => (
      admission.record.payload.evidence_requirement_ids.includes(requirement.id)
    ));
    const invalidArtifacts = invalidArtifactAdmissions.filter((admission) => (
      (admission.record as ArtifactEvidenceRecordV1).payload.evidence_requirement_ids.includes(requirement.id)
    ));
    const statuses: ProjectionRequirementStatusV1[] = [];
    const lineage: ContentIdentity[] = [];
    for (const admission of artifacts) {
      const evaluated = artifactStatus(
        admission,
        requirement.id,
        root,
        activeControlsById,
        poisonedEvidenceKeys,
      );
      statuses.push(evaluated.status);
      lineage.push(...evaluated.lineage);
      if (poisonedEvidenceKeys.has(admission.record.evidence_key)) statuses.push('UNKNOWN');
    }
    for (const admission of invalidArtifacts) {
      statuses.push('UNKNOWN');
      lineage.push(admission.identity);
    }
    const status = blocked.has(requirement.id)
      ? 'BLOCKED_CONTRACT'
      : !manifestVerified
        ? 'UNKNOWN'
        : combine(statuses);
    return {
      requirement_id: requirement.id,
      slice_id: requirement.slice_id,
      gate: requirement.gate,
      status,
      lineage_record_identities: sortedLineage(lineage),
    };
  });

  const sliceRows = root.slice_ids.map((sliceId) => {
    const rows = requirementRows.filter((requirement) => requirement.slice_id === sliceId);
    return {
      slice_id: sliceId,
      requirement_ids: rows.map((requirement) => requirement.requirement_id),
    };
  });

  return deepFreeze({
    schema_version: 'MES-PROJECTION-1' as const,
    root_identity: cloneIdentity(prefix.root_identity),
    manifest_head_identity: prefix.head_identity === null ? null : cloneIdentity(prefix.head_identity),
    manifest_status: manifestVerified ? 'VERIFIED' as const : 'UNKNOWN' as const,
    slices: sliceRows,
    requirements: requirementRows,
    active_artifact_count: activeArtifacts.length,
    active_grade_count: activeGrades.length,
    same_grade_count: activeGrades.filter(
      (admission) => admission.record.record_family === 'GRADE'
        && admission.record.payload.verdict === 'SAME GRADE'
        && !poisonedEvidenceKeys.has(admission.record.evidence_key),
    ).length,
    closure_status: 'NOT_EVALUATED' as const,
  });
}
