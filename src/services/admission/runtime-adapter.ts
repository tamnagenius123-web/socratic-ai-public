import { canonicalDocument, type CanonicalJsonValue } from './canonical-json';
import type {
  ArtifactCaptureBindingV1,
  ArtifactEvidenceRecordV1,
  DetachedRecordCandidate,
  EvidenceSpineRootV1,
  FrozenArtifactCapturePlanV1,
  ExternalArtifactObservationV1,
  SourceReceiptRefV1,
  VerifiedArtifactProvenanceV1,
} from './evidence-spine-types';
import { contentIdentity, recordSha256, type ContentIdentity } from './identity';
import {
  nonPassing,
  parseExternalCaptureCarrier,
  type DerivedRuntimeProvenanceV1,
  type NonPassingObservation,
  type VerifiedRuntimeTargetV1,
} from './product-receipts';

type JsonRecord = { [key: string]: CanonicalJsonValue };

const hashPattern = /^[0-9a-f]{64}$/;
const slices = new Set(['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10']);
const gates = new Set(['D', 'S', 'R', 'P', 'A', 'L', 'V0']);
const captureKinds = new Set(['BUILD', 'DEPLOYMENT', 'CONTROL_PLANE']);

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function validIdentity(value: unknown): value is ContentIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const objectValue = value as Record<string, unknown>;
  return (Object.getPrototypeOf(objectValue) === Object.prototype || Object.getPrototypeOf(objectValue) === null)
    && Object.keys(objectValue).sort().join('\0') === 'byte_length\0sha256'
    && Number.isSafeInteger(objectValue.byte_length)
    && !Object.is(objectValue.byte_length, -0)
    && (objectValue.byte_length as number) >= 0
    && typeof objectValue.sha256 === 'string'
    && hashPattern.test(objectValue.sha256);
}

function copyIdentity(value: ContentIdentity): ContentIdentity {
  return Object.freeze({ byte_length: value.byte_length, sha256: value.sha256 });
}

function validRef(value: unknown, expectedKind?: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const keys = Object.keys(ref).sort().join('\0');
  return keys === 'content_identity\0receipt_id\0receipt_kind'
    && typeof ref.receipt_kind === 'string'
    && (!expectedKind || ref.receipt_kind === expectedKind)
    && typeof ref.receipt_id === 'string'
    && ref.receipt_id.length > 0
    && validIdentity(ref.content_identity);
}

function sameRef(left: unknown, right: unknown): boolean {
  if (!validRef(left) || !validRef(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return a.receipt_kind === b.receipt_kind
    && a.receipt_id === b.receipt_id
    && sameIdentity(a.content_identity as ContentIdentity, b.content_identity as ContentIdentity);
}

function containsRef(refs: readonly unknown[], expected: unknown): boolean {
  return refs.some((ref) => sameRef(ref, expected));
}

function copyRef(value: SourceReceiptRefV1): SourceReceiptRefV1 {
  return Object.freeze({
    receipt_kind: value.receipt_kind,
    receipt_id: value.receipt_id,
    content_identity: copyIdentity(value.content_identity),
  });
}

function snapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value;
  const objectValue = value as unknown as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && 'value' in descriptor) snapshot(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function refsFromRuntime(runtime: DerivedRuntimeProvenanceV1): readonly SourceReceiptRefV1[] {
  if (!Array.isArray(runtime.receiptRefs)) return [];
  return runtime.receiptRefs.filter((ref): ref is SourceReceiptRefV1 => validRef(ref));
}

function isFrozenArtifactCapturePlan(
  value: FrozenArtifactCapturePlanV1 | NonPassingObservation,
): value is FrozenArtifactCapturePlanV1 {
  return typeof value === 'object' && value !== null && 'plan' in value && 'carrier' in value
    && 'carrierBytes' in value && 'carrierIdentity' in value;
}

function isVerifiedArtifactProvenance(
  value: VerifiedArtifactProvenanceV1 | NonPassingObservation,
): value is VerifiedArtifactProvenanceV1 {
  return typeof value === 'object' && value !== null && 'binding' in value && 'observation' in value
    && 'target' in value;
}

function failure(
  outcome: NonPassingObservation['outcome'],
  reason: NonPassingObservation['reason'],
  runtime?: DerivedRuntimeProvenanceV1,
): NonPassingObservation {
  try {
    return nonPassing(outcome, reason, runtime ? refsFromRuntime(runtime) : []);
  } catch {
    return nonPassing(outcome, reason);
  }
}

async function rootIdentity(root: EvidenceSpineRootV1): Promise<ContentIdentity | null> {
  try {
    if (!root || root.schema_version !== 'MES-1') return null;
    return await contentIdentity(canonicalDocument(root as unknown as CanonicalJsonValue));
  } catch {
    return null;
  }
}

function targetRefForCaptureKind(
  target: VerifiedRuntimeTargetV1,
  kind: 'BUILD' | 'DEPLOYMENT' | 'CONTROL_PLANE',
): SourceReceiptRefV1 {
  switch (kind) {
    case 'BUILD': return target.buildRef;
    case 'DEPLOYMENT': return target.deploymentRef;
    case 'CONTROL_PLANE': return target.controlPlaneRef;
  }
}

function requiredCaptureRefsMatch(
  binding: ArtifactCaptureBindingV1,
  observation: ExternalArtifactObservationV1,
  target: VerifiedRuntimeTargetV1,
): boolean {
  return binding.requiredCaptureKinds.every((kind) => (
    captureKinds.has(kind) && containsRef(observation.artifactBindings.source_receipts, targetRefForCaptureKind(target, kind))
  ));
}

function bindingFieldsMatch(
  _binding: ArtifactCaptureBindingV1,
  observation: ExternalArtifactObservationV1,
  runtime: DerivedRuntimeProvenanceV1,
  carrier: Awaited<ReturnType<typeof parseExternalCaptureCarrier>>,
): boolean {
  if (!carrier) return false;
  const fields = observation.artifactBindings;
  if (fields.build_identity !== null && !sameIdentity(fields.build_identity, runtime.target.buildIdentity)) return false;
  if (fields.deployment_identity !== null && !sameIdentity(fields.deployment_identity, runtime.target.deploymentIdentity)) return false;
  if (fields.account_scope_identity !== null && !sameIdentity(fields.account_scope_identity, runtime.accountScopeIdentity)) return false;
  if (fields.capture_environment_identity !== null && !sameIdentity(fields.capture_environment_identity, observation.scope.environment_identity)) return false;
  const policiesPresent = fields.retention_policy_identity !== null || fields.access_policy_identity !== null;
  if (policiesPresent
    && (!fields.retention_policy_identity || !fields.access_policy_identity
      || !sameIdentity(fields.retention_policy_identity, carrier.integrityProof.policyIdentity)
      || !sameIdentity(fields.access_policy_identity, carrier.integrityProof.policyIdentity))) return false;
  if (!policiesPresent && observation.privacySafeLocator.startsWith('encrypted://')) return false;
  return true;
}

function validRuntimeShape(root: EvidenceSpineRootV1, runtime: DerivedRuntimeProvenanceV1): boolean {
  if (!runtime || typeof runtime !== 'object' || !validIdentity(runtime.rootIdentity)
    || !validIdentity(runtime.subjectIdentity) || !validIdentity(runtime.accountScopeIdentity)
    || !runtime.target || typeof runtime.target !== 'object') return false;
  const target = runtime.target;
  if (!validRef(runtime.sourceManifestRef, 'SOURCE_MANIFEST')
    || !validRef(runtime.trainingContextRef, 'LEARNING_SESSION_CONTEXT')
    || !validIdentity(runtime.trainingSessionIdentity)
    || !validRef(runtime.growthCycleRef, 'GROWTH_CYCLE')
    || !validIdentity(runtime.growthOriginIdentity)
    || !validIdentity(runtime.privateSpaceIdentity)
    || !Number.isSafeInteger(runtime.aggregateRevision)
    || runtime.aggregateRevision < 0
    || !Array.isArray(runtime.turnAttemptRefs)
    || !runtime.turnAttemptRefs.every((ref) => validRef(ref, 'AI_INVOCATION_ATTEMPT'))
    || !Array.isArray(runtime.receiptRefs)
    || !runtime.receiptRefs.every((ref) => validRef(ref))
    || new Set(runtime.receiptRefs.map((ref) => `${ref.receipt_kind}\u0000${ref.receipt_id}`)).size !== runtime.receiptRefs.length) {
    return false;
  }
  const requiredRefs = [
    runtime.sourceManifestRef,
    runtime.trainingContextRef,
    ...runtime.turnAttemptRefs,
    runtime.growthCycleRef,
    target.buildRef,
    target.deploymentRef,
    target.controlPlaneRef,
  ];
  if (!requiredRefs.every((ref) => containsRef(runtime.receiptRefs, ref))) return false;
  return validIdentity(target.rootIdentity)
    && validIdentity(target.implementationPlanIdentity)
    && validIdentity(target.buildIdentity)
    && validIdentity(target.deploymentIdentity)
    && validIdentity(target.routeManifestIdentity)
    && validIdentity(target.controlPlaneIdentity)
    && validRef(target.buildRef, 'BUILD')
    && validRef(target.deploymentRef, 'DEPLOYMENT')
    && validRef(target.controlPlaneRef, 'CONTROL_PLANE')
    && Array.isArray(runtime.turnAttemptRefs)
    && runtime.turnAttemptRefs.every((ref) => validRef(ref))
    && Array.isArray(runtime.receiptRefs)
    && runtime.receiptRefs.every((ref) => validRef(ref))
    && Array.isArray(root.slice_ids);
}

function rootRequirementMatches(
  root: EvidenceSpineRootV1,
  binding: ArtifactCaptureBindingV1,
): boolean {
  if (!slices.has(binding.sliceId) || !gates.has(binding.gateId)) return false;
  const linked = root.requirements.filter((requirement) => binding.requirementIds.includes(requirement.id));
  return linked.length === binding.requirementIds.length
    && linked.length > 0
    && linked.every((requirement) => requirement.slice_id === binding.sliceId && requirement.gate === binding.gateId);
}

function targetMatches(
  root: EvidenceSpineRootV1,
  runtime: DerivedRuntimeProvenanceV1,
  carrier: Awaited<ReturnType<typeof parseExternalCaptureCarrier>>,
): NonPassingObservation | null {
  if (!carrier) return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  const target = runtime.target;
  const value = carrier.carrier;
  const plan = carrier.plan;
  const rootId = carrier.carrier.rootIdentity;
  if (!sameIdentity(target.rootIdentity, rootId)
    || !sameIdentity(target.implementationPlanIdentity, root.source_identities.implementation_plan)
    || !sameIdentity(plan.rootIdentity, rootId)
    || !sameIdentity(plan.implementationPlanIdentity, root.source_identities.implementation_plan)
    || !sameIdentity(value.implementationPlanIdentity, root.source_identities.implementation_plan)
    || !sameIdentity(value.rootIdentity, rootId)) {
    return failure('UNKNOWN', 'TARGET_MISMATCH', runtime);
  }
  if (!sameRef(value.buildRef, target.buildRef)
    || !sameRef(value.deploymentRef, target.deploymentRef)
    || !sameRef(value.controlPlaneRef, target.controlPlaneRef)
    || !sameIdentity(plan.buildIdentity, target.buildIdentity)
    || !sameIdentity(plan.deploymentIdentity, target.deploymentIdentity)
    || !sameIdentity(plan.routeManifestIdentity, target.routeManifestIdentity)
    || !sameIdentity(plan.controlPlaneIdentity, target.controlPlaneIdentity)) {
    return failure('UNKNOWN', 'TARGET_MISMATCH', runtime);
  }
  return null;
}

function graphMatches(
  root: EvidenceSpineRootV1,
  runtime: DerivedRuntimeProvenanceV1,
  carrier: Awaited<ReturnType<typeof parseExternalCaptureCarrier>>,
): NonPassingObservation | null {
  if (!carrier) return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  const value = carrier.carrier;
  const plan = carrier.plan;
  const proof = carrier.integrityProof;
  if (!sameIdentity(runtime.rootIdentity, value.rootIdentity)
    || !sameIdentity(runtime.subjectIdentity, plan.subject.content_identity)
    || !sameIdentity(runtime.accountScopeIdentity, plan.accountScopeIdentity)
    || plan.subject.subject_type !== value.subject.subject_type
    || plan.subject.subject_key !== value.subject.subject_key
    || !sameIdentity(plan.subject.content_identity, value.subject.content_identity)
    || !sameIdentity(proof.protectedSubjectIdentity, value.subject.content_identity)
    || !sameIdentity(proof.protectedSubjectIdentity, plan.subject.content_identity)
    || !sameIdentity(proof.protectedSubjectIdentity, runtime.subjectIdentity)
    || !sameIdentity(plan.accountScopeIdentity, value.accountScopeIdentity)) {
    return failure('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED', runtime);
  }
  const targetFailure = targetMatches(root, runtime, carrier);
  if (targetFailure) return targetFailure;
  const target = runtime.target;
  const artifactIds = new Set<string>();
  if (plan.bindings.length !== value.observations.length) return failure('UNKNOWN', 'CONTROL_MISMATCH', runtime);
  for (let index = 0; index < plan.bindings.length; index += 1) {
    const binding = plan.bindings[index];
    const observation = value.observations[index];
    if (observation.bindingIndex !== index || observation.artifactId !== binding.artifactId || artifactIds.has(binding.artifactId)) {
      return failure('UNKNOWN', 'CONTROL_MISMATCH', runtime);
    }
    artifactIds.add(binding.artifactId);
    if (!rootRequirementMatches(root, binding)
      || !requiredCaptureRefsMatch(binding, observation, target)
      || !bindingFieldsMatch(binding, observation, runtime, carrier)) {
      return failure('UNKNOWN', 'CONTROL_MISMATCH', runtime);
    }
    if (!sameIdentity(observation.scope.subject_identity, runtime.subjectIdentity)
      || !sameIdentity(observation.scope.subject_identity, proof.protectedSubjectIdentity)) {
      return failure('UNKNOWN', 'TARGET_MISMATCH', runtime);
    }
    for (const requiredKind of binding.requiredReceiptKinds) {
      if (observation.artifactBindings.source_receipts.filter((ref) => ref.receipt_kind === requiredKind).length !== 1) {
        return failure('UNKNOWN', 'CONTROL_MISMATCH', runtime);
      }
    }
    if (!observation.artifactBindings.source_receipts.every((ref) => containsRef(runtime.receiptRefs, ref))) {
      return failure('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED', runtime);
    }
    const invocationIds = observation.artifactBindings.kind_details.kind === 'RUNTIME'
      ? observation.artifactBindings.kind_details.invocation_receipt_ids
      : [];
    if (!invocationIds.every((id) => {
      const runtimeRef = runtime.turnAttemptRefs.find((ref) => (
        ref.receipt_kind === 'AI_INVOCATION_ATTEMPT' && ref.receipt_id === id
      ));
      return runtimeRef !== undefined
        && containsRef(observation.artifactBindings.source_receipts, runtimeRef);
    })) {
      return failure('UNKNOWN', 'SUBJECT_GRAPH_DISCONNECTED', runtime);
    }
  }
  return null;
}

export async function verifyFrozenArtifactCapturePlan(
  root: EvidenceSpineRootV1,
  runtime: DerivedRuntimeProvenanceV1,
  carrierBytes: Uint8Array,
  carrierIdentity: ContentIdentity,
): Promise<FrozenArtifactCapturePlanV1 | NonPassingObservation> {
  if (!root || !runtime || !(carrierBytes instanceof Uint8Array) || carrierBytes.byteLength === 0) {
    return failure('UNGRADABLE', 'AUTHORITY_MISSING');
  }
  try {
    const actualRootIdentity = await rootIdentity(root);
    if (!actualRootIdentity || !validRuntimeShape(root, runtime)
      || !sameIdentity(runtime.rootIdentity, actualRootIdentity)) {
      return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
    }
    const parsed = await parseExternalCaptureCarrier(carrierBytes, carrierIdentity);
    if (!parsed) return failure('UNKNOWN', 'CONTENT_MISMATCH', runtime);
    const graphFailure = graphMatches(root, runtime, parsed);
    if (graphFailure) return graphFailure;
    return Object.freeze({
      plan: parsed.plan,
      planIdentity: parsed.planIdentity,
      carrier: parsed.carrier,
      carrierBytes: new Uint8Array(parsed.carrierBytes),
      carrierIdentity: copyIdentity(parsed.carrierIdentity),
    });
  } catch {
    return failure('UNGRADABLE', 'AUTHORITY_MISSING');
  }
}

function targetSnapshot(target: VerifiedRuntimeTargetV1): VerifiedRuntimeTargetV1 {
  return Object.freeze({
    rootIdentity: copyIdentity(target.rootIdentity),
    implementationPlanIdentity: copyIdentity(target.implementationPlanIdentity),
    buildIdentity: copyIdentity(target.buildIdentity),
    deploymentIdentity: copyIdentity(target.deploymentIdentity),
    routeManifestIdentity: copyIdentity(target.routeManifestIdentity),
    controlPlaneIdentity: copyIdentity(target.controlPlaneIdentity),
    buildRef: copyRef(target.buildRef),
    deploymentRef: copyRef(target.deploymentRef),
    controlPlaneRef: copyRef(target.controlPlaneRef),
  });
}

export async function deriveVerifiedArtifactProvenance(
  root: EvidenceSpineRootV1,
  runtime: DerivedRuntimeProvenanceV1,
  frozen: FrozenArtifactCapturePlanV1,
  bindingIndex: number,
): Promise<VerifiedArtifactProvenanceV1 | NonPassingObservation> {
  if (!frozen || typeof frozen !== 'object' || !Number.isSafeInteger(bindingIndex) || bindingIndex < 0) {
    return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  }
  let carrierBytes: Uint8Array;
  let carrierIdentity: ContentIdentity;
  try {
    carrierBytes = frozen.carrierBytes;
    carrierIdentity = frozen.carrierIdentity;
  } catch {
    return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  }
  const reverified = await verifyFrozenArtifactCapturePlan(root, runtime, carrierBytes, carrierIdentity);
  if (!isFrozenArtifactCapturePlan(reverified)) return reverified;
  const binding = reverified.plan.bindings[bindingIndex];
  const observation = reverified.carrier.observations[bindingIndex];
  if (!binding || !observation || observation.bindingIndex !== bindingIndex) {
    return failure('UNKNOWN', 'CONTROL_MISMATCH', runtime);
  }
  return snapshot({
    rootIdentity: copyIdentity(reverified.carrier.rootIdentity),
    artifactCapturePlanIdentity: copyIdentity(reverified.planIdentity),
    carrierIdentity: copyIdentity(reverified.carrierIdentity),
    bindingIndex,
    binding,
    observation,
    target: targetSnapshot(runtime.target),
  });
}

async function pendingReview(producerId: string) {
  const reviewOutputIdentity = await contentIdentity(canonicalDocument({
    schema_version: 'MES-REVIEW-PENDING-1',
  }));
  return Object.freeze({
    builder_identity: producerId,
    reviewer_identity: 'UNKNOWN',
    separation: 'UNKNOWN' as const,
    review_output_identity: Object.freeze({ ...reviewOutputIdentity }),
    verdict: 'UNKNOWN' as const,
    vendor_family: 'UNKNOWN',
  });
}

async function artifactEvidenceKey(record: {
  root_identity: ContentIdentity;
  subject_identity: ArtifactEvidenceRecordV1['subject_identity'];
  payload: Pick<ArtifactEvidenceRecordV1['payload'], 'kind' | 'evidence_requirement_ids'>;
}): Promise<string> {
  return recordSha256({
    schema_version: 'MES-EVIDENCE-KEY-1',
    record_family: 'ARTIFACT',
    root_identity: record.root_identity,
    artifact_kind: record.payload.kind,
    subject_identity: record.subject_identity,
    requirement_ids: record.payload.evidence_requirement_ids,
  } as unknown as CanonicalJsonValue);
}

export async function buildArtifactCandidate(
  root: EvidenceSpineRootV1,
  runtime: DerivedRuntimeProvenanceV1,
  frozen: FrozenArtifactCapturePlanV1,
  bindingIndex: number,
): Promise<DetachedRecordCandidate | NonPassingObservation> {
  if (!frozen || typeof frozen !== 'object') return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  let reverified: FrozenArtifactCapturePlanV1 | NonPassingObservation;
  try {
    reverified = await verifyFrozenArtifactCapturePlan(
      root,
      runtime,
      frozen.carrierBytes,
      frozen.carrierIdentity,
    );
  } catch {
    return failure('UNGRADABLE', 'AUTHORITY_MISSING', runtime);
  }
  if (!isFrozenArtifactCapturePlan(reverified)) return reverified;
  const provenance = await deriveVerifiedArtifactProvenance(root, runtime, reverified, bindingIndex);
  if (!isVerifiedArtifactProvenance(provenance)) return provenance;
  const binding = provenance.binding;
  const observation = provenance.observation;
  const producer = Object.freeze({
    producer_id: observation.producer.producer_id,
    role: observation.producer.role,
    vendor_family: observation.producer.vendor_family,
    attestation: observation.producer.attestation,
  });
  const subject = Object.freeze({
    subject_type: reverified.plan.subject.subject_type,
    subject_key: reverified.plan.subject.subject_key,
    content_identity: copyIdentity(reverified.plan.subject.content_identity),
  });
  const payload = {
    id: binding.artifactId,
    slice_id: binding.sliceId,
    evidence_requirement_ids: Object.freeze([...binding.requirementIds]),
    gate: binding.gateId,
    path_or_url: observation.privacySafeLocator,
    sha256: observation.artifactBytesIdentity.sha256,
    captured_at: observation.capturedAt,
    evidence_label: observation.evidenceLabel,
    outcome: observation.outcome,
    status: observation.status,
    scope: observation.scope,
    limitations: Object.freeze([...observation.limitations]),
    kind: binding.artifactKind,
    bindings: observation.artifactBindings,
  };
  const evidenceKey = await artifactEvidenceKey({
    root_identity: copyIdentity(provenance.rootIdentity),
    subject_identity: subject,
    payload,
  });
  const independentReview = await pendingReview(producer.producer_id);
  const recordBody = {
    schema_version: 'MES-1' as const,
    record_family: 'ARTIFACT' as const,
    root_identity: copyIdentity(provenance.rootIdentity),
    evidence_key: evidenceKey,
    subject_identity: subject,
    created_at: observation.capturedAt,
    producer_identity: producer,
    source_receipts: observation.artifactBindings.source_receipts,
    limitations: Object.freeze([...observation.limitations]),
    independent_review: independentReview,
    payload,
  };
  const recordId = await recordSha256(recordBody as unknown as CanonicalJsonValue);
  const record = snapshot({
    ...recordBody,
    record_id: recordId,
  }) as unknown as ArtifactEvidenceRecordV1;
  const canonicalBytes = canonicalDocument(record as unknown as CanonicalJsonValue);
  const recordIdentity = await contentIdentity(canonicalBytes);
  return Object.freeze({
    record,
    canonical_bytes: new Uint8Array(canonicalBytes),
    record_identity: Object.freeze({ ...recordIdentity }),
  });
}
