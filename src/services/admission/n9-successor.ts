import {
  AuthorityJsonError,
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from './canonical-json';
import { contentIdentity, type ContentIdentity } from './identity';
import {
  assertContentIdentity,
  canonicalBytesEqual,
} from './evidence-spine-validation';
import type {
  ControlCaptureBindingV1,
  EvidenceGate,
  EvidenceSpineRootV1,
  FrozenN9EvidenceCapturePlanV1,
  N9AuthorizedStep,
  N9ControlObservationCarrierV1,
  N9EvidenceCapturePlanV1,
  N9SuccessorAuthorizationV1,
  N9SuccessorPolicyV1,
  N9ValidationClockV1,
  SourceReceiptKind,
} from './evidence-spine-types';

type DataObject = Record<string, unknown>;
type IdentityFields = Readonly<{
  rootIdentity: ContentIdentity;
  planIdentity: ContentIdentity;
  historicalTask4CapsuleIdentity: ContentIdentity;
  successorLaneId: 'N9_SUCCESSOR_V1';
  buildIdentity: ContentIdentity;
  deploymentIdentity: ContentIdentity;
  routeManifestIdentity: ContentIdentity;
  controlPlaneIdentity: ContentIdentity;
}>;

type PolicySourceContext = Readonly<{
  sourceIdentity: ContentIdentity;
  implementationPlanIdentity: ContentIdentity;
  historicalCapsuleIdentity: ContentIdentity;
}>;

type AuthorizationBrand = Readonly<{
  rootIdentity: ContentIdentity;
  policyIdentity: ContentIdentity;
  authorizationIdentity: ContentIdentity;
  evaluatedAt: string;
}>;

const authorizationBrands = new WeakMap<object, AuthorizationBrand>();
const textEncoder = new TextEncoder();

const CONTROL_IDS = Object.freeze([
  'N9-CTRL-CONSENT',
  'N9-CTRL-PURPOSE',
  'N9-CTRL-RETENTION',
  'N9-CTRL-PRECONSENT-OPTOUT',
  'N9-CTRL-POSTCONSENT-REVOCATION',
  'N9-CTRL-CONTEST',
  'N9-CTRL-CORRECTION',
  'N9-CTRL-HUMAN-REVIEW-PENDING',
  'N9-CTRL-ACCOUNT-B-FOREIGN-READ',
  'N9-CTRL-ACCOUNT-B-FOREIGN-ENUMERATE',
  'N9-CTRL-ACCOUNT-B-FOREIGN-MUTATE',
  'N9-CTRL-ACCOUNT-B-FOREIGN-SCHEDULE',
  'N9-CTRL-ACCOUNT-B-FOREIGN-CORRECT',
  'N9-CTRL-ACCOUNT-B-FOREIGN-RESTORE',
  'N9-CTRL-ACCOUNT-B-FOREIGN-DELETE',
  'N9-CTRL-DECLARED-STORE-DELETION-RESIDUE',
  'N9-CTRL-KOREAN-COMPREHENSION',
  'N9-CTRL-KEYBOARD',
  'N9-CTRL-FOCUS',
  'N9-CTRL-SCREEN-READER',
  'N9-CTRL-ZOOM-400',
  'N9-CTRL-REFLOW-320',
  'N9-CTRL-MOBILE-KEYBOARD',
  'N9-CTRL-REDUCED-MOTION',
  'N9-CTRL-PROHIBITED-INFERENCE-REVIEW',
  'N9-CTRL-TRUTHFUL-DEGRADATION',
] as const);

const REQUIRED_RECEIPT_KINDS = Object.freeze([
  'BROWSER_ACTION_LOG',
  'CONTROL_PLANE',
  'RECHECK',
  'SOURCE_MANIFEST',
] as const satisfies readonly SourceReceiptKind[]);

const STOP_CONDITION_IDS = Object.freeze([
  'CROSS_ACCOUNT_ACCESS',
  'DELETION_RESIDUE',
  'SCOPE_BROADENING',
  'SURVEILLANCE_REQUIREMENT',
] as const);

const BLOCKED_REQUIREMENT_IDS = Object.freeze([
  'N9-S1',
  'N9-R1',
  'N9-P1',
  'N9-A1',
  'N9-L1',
] as const);

const DECLARED_STORE_POLICY_DESCRIPTOR = {
  schemaVersion: 'MES-1',
  policyId: 'N9_DECLARED_STORE_POLICY_V1',
  storeKinds: ['GROWTH_CYCLE', 'HUMAN_REVIEW_REQUEST'],
  accessRule: 'NAMED_OWNER_OR_GOVERNED_REVIEW_ONLY',
  retentionRule: 'PRIVATE_CONTAINER_RETENTION_ONLY',
} as const;

const PRIVATE_CONTAINER_POLICY_DESCRIPTORS = Object.freeze([
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
] as const);

const N9_SUBJECT_DESCRIPTOR = {
  subject: 'N9_SUCCESSOR_SYNTHETIC_SUBJECT_V1',
  scope: 'KOREAN_TRAINING_TO_GROWTH',
} as const;

function fail(code: string): never {
  throw new AuthorityJsonError(code);
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

function identityEqual(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function identityCopy(value: unknown, code: string): ContentIdentity {
  try {
    const identity = assertContentIdentity(value, code);
    return { byte_length: identity.byte_length, sha256: identity.sha256 };
  } catch {
    fail(code);
  }
}

function dataObject(value: unknown, code: string): DataObject {
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

function exactObject(value: unknown, keys: readonly string[], code: string): DataObject {
  const objectValue = dataObject(value, code);
  const actual = Object.getOwnPropertyNames(objectValue);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) fail(code);
  return objectValue;
}

function required(objectValue: DataObject, key: string, code: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(objectValue, key)) fail(code);
  const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  return descriptor.value;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function array(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(code);
  const objectValue = value as unknown as object;
  if (Object.getOwnPropertySymbols(objectValue).length !== 0) fail(code);
  for (const key of Object.getOwnPropertyNames(objectValue)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail(code);
  }
  return value;
}

function stringArray(value: unknown, code: string): readonly string[] {
  return array(value, code).map((item) => text(item, code));
}

function sortedUnique(values: readonly string[], code: string): readonly string[] {
  if (values.length === 0 || values.length !== new Set(values).size) fail(code);
  for (let index = 1; index < values.length; index += 1) {
    if (compareTextBytes(values[index - 1], values[index]) >= 0) fail(code);
  }
  return values;
}

function sortedIdentityArray(value: unknown, code: string): readonly ContentIdentity[] {
  const values = array(value, code).map((item) => identityCopy(item, code));
  if (values.length === 0) fail(code);
  for (let index = 1; index < values.length; index += 1) {
    const order = compareTextBytes(values[index - 1].sha256, values[index].sha256)
      || values[index - 1].byte_length - values[index].byte_length;
    if (order >= 0) fail(code);
  }
  return values;
}

function exactTextArray(value: unknown, expected: readonly string[], code: string): readonly string[] {
  const actual = stringArray(value, code);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) fail(code);
  return actual;
}

function exactIdentityArray(value: unknown, expected: readonly ContentIdentity[], code: string): readonly ContentIdentity[] {
  const actual = sortedIdentityArray(value, code);
  if (actual.length !== expected.length || actual.some((item, index) => !identityEqual(item, expected[index]))) fail(code);
  return actual;
}

function canonicalSnapshot(value: unknown, code: string): { bytes: Uint8Array; value: unknown } {
  let bytes: Uint8Array;
  try {
    bytes = canonicalDocument(value as CanonicalJsonValue);
  } catch {
    fail(code);
  }
  let parsed: CanonicalJsonValue;
  try {
    parsed = parseAuthorityJson(bytes);
  } catch {
    fail(code);
  }
  return { bytes: new Uint8Array(bytes), value: parsed };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function canonicalIdentity(value: unknown, code: string): Promise<ContentIdentity> {
  try {
    return contentIdentity(canonicalDocument(value as CanonicalJsonValue));
  } catch {
    fail(code);
  }
}

function validateUtcMilliseconds(value: unknown, code: string): number {
  const timestamp = text(value, code);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(timestamp);
  if (!match) fail(code);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) fail(code);
  return parsed;
}

function aliasDescriptors(): readonly CanonicalJsonValue[] {
  return [
    { alias: 'N9_ACCOUNT_A_PSEUDONYM_V1', role: 'LEARNER_A' },
    { alias: 'N9_ACCOUNT_B_PSEUDONYM_V1', role: 'LEARNER_B' },
  ];
}

function n9ControlExpectation(index: number): Readonly<{
  controlId: string;
  gateId: EvidenceGate;
  accountAliasIndex: 0 | 1;
}> {
  const controlId = CONTROL_IDS[index];
  const accountAliasIndex = controlId.includes('ACCOUNT-B-FOREIGN') ? 1 : 0;
  const gateId: EvidenceGate = index < 2 ? 'S' : index < 7 ? 'R' : index < 11 ? 'P' : index < 16 ? 'A' : 'L';
  return { controlId, gateId, accountAliasIndex };
}

function policyIdentityBindings(
  value: N9SuccessorPolicyV1,
  code: string,
): readonly ContentIdentity[] {
  return value.privateContainerPolicyIdentities.map((identityValue) => identityCopy(identityValue, code));
}

function validatePolicyShape(value: unknown, code = 'MES_N9_POLICY_INVALID'): N9SuccessorPolicyV1 {
  const policy = exactObject(value, [
    'schemaVersion', 'policyId', 'implementationPlanIdentity', 'historicalCapsuleIdentity', 'successorLaneId',
    'blockedRequirementIds', 'accountAliasIdentities', 'allowedActionIds', 'allowedFileIds',
    'prohibitedActionIds', 'stopConditionIds', 'maximumClaim', 'controls', 'declaredStorePolicyIdentity',
    'privateContainerPolicyIdentities',
  ], code);
  if (required(policy, 'schemaVersion', code) !== 'MES-1' || required(policy, 'policyId', code) !== 'N9_SUCCESSOR_POLICY_V1') fail(code);
  const implementationPlanIdentity = identityCopy(required(policy, 'implementationPlanIdentity', code), code);
  const historicalCapsuleIdentity = identityCopy(required(policy, 'historicalCapsuleIdentity', code), code);
  if (required(policy, 'successorLaneId', code) !== 'N9_SUCCESSOR_V1') fail(code);
  const blockedRequirementIds = exactTextArray(required(policy, 'blockedRequirementIds', code), BLOCKED_REQUIREMENT_IDS, code) as N9SuccessorPolicyV1['blockedRequirementIds'];
  const accountAliasIdentities = sortedIdentityArray(required(policy, 'accountAliasIdentities', code), code);
  if (accountAliasIdentities.length !== 2 || identityEqual(accountAliasIdentities[0], accountAliasIdentities[1])) fail(code);
  const allowedActionIds = sortedUnique(stringArray(required(policy, 'allowedActionIds', code), code), code);
  const allowedFileIds = sortedUnique(stringArray(required(policy, 'allowedFileIds', code), code), code);
  const prohibitedActionIds = sortedUnique(stringArray(required(policy, 'prohibitedActionIds', code), code), code);
  const stopConditionIds = exactTextArray(required(policy, 'stopConditionIds', code), STOP_CONDITION_IDS, code);
  const maximumClaim = text(required(policy, 'maximumClaim', code), code);
  if (maximumClaim !== 'N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY') fail(code);
  const declaredStorePolicyIdentity = identityCopy(required(policy, 'declaredStorePolicyIdentity', code), code);
  const privateContainerPolicyIdentities = sortedIdentityArray(required(policy, 'privateContainerPolicyIdentities', code), code);
  if (privateContainerPolicyIdentities.length !== PRIVATE_CONTAINER_POLICY_DESCRIPTORS.length) fail(code);
  const controlsInput = array(required(policy, 'controls', code), code);
  if (controlsInput.length !== CONTROL_IDS.length) fail(code);
  const controls: N9SuccessorPolicyV1['controls'][number][] = [];
  const routeIds = new Set<string>();
  const actionIds = new Set<string>();
  const captureIds = new Set<string>();
  const artifactIds = new Set<string>();
  const requirements = new Set<string>();
  const expectedOutcomes = new Set<string>();
  for (let index = 0; index < controlsInput.length; index += 1) {
    const control = exactObject(controlsInput[index], [
      'stepIndex', 'controlId', 'accountAliasIdentity', 'routeId', 'actionId', 'allowedFileIds',
      'prohibitedActionIds', 'stopConditionIds', 'maximumClaim', 'expectedOutcome', 'beforeCaptureId',
      'afterCaptureId', 'actionLogCaptureId', 'networkEvidenceCaptureId', 'artifactIds', 'sliceId',
      'gateId', 'requirementIds', 'requiredReceiptKinds', 'privateContainerPolicyIdentities',
    ], code);
    const expected = n9ControlExpectation(index);
    if (integer(required(control, 'stepIndex', code), code) !== index) fail(code);
    if (required(control, 'controlId', code) !== expected.controlId) fail(code);
    const accountAliasIdentity = identityCopy(required(control, 'accountAliasIdentity', code), code);
    if (!identityEqual(accountAliasIdentity, accountAliasIdentities[expected.accountAliasIndex])) fail(code);
    const routeId = text(required(control, 'routeId', code), code);
    const actionId = text(required(control, 'actionId', code), code);
    const expectedRouteId = expected.controlId === 'N9-CTRL-HUMAN-REVIEW-PENDING'
      ? '/api/growth/spaces/:spaceId/cycles/:cycleId/human-review-requests'
      : `N9-ROUTE-${expected.controlId}`;
    const expectedActionId = expected.controlId === 'N9-CTRL-HUMAN-REVIEW-PENDING'
      ? 'N9-ACTION-POST-HUMAN-REVIEW-REQUEST'
      : `N9-ACTION-${expected.controlId}`;
    if (routeId !== expectedRouteId || actionId !== expectedActionId) fail(code);
    if (routeIds.has(routeId) || actionIds.has(actionId)) fail(code);
    routeIds.add(routeId);
    actionIds.add(actionId);
    const allowedFiles = sortedUnique(stringArray(required(control, 'allowedFileIds', code), code), code);
    if (allowedFiles.length !== 1 || allowedFiles[0] !== `N9-FILE-${expected.controlId}` || !allowedFileIds.includes(allowedFiles[0])) fail(code);
    const prohibited = exactTextArray(required(control, 'prohibitedActionIds', code), prohibitedActionIds, code);
    const stops = exactTextArray(required(control, 'stopConditionIds', code), STOP_CONDITION_IDS, code);
    const controlMaximumClaim = text(required(control, 'maximumClaim', code), code);
    if (controlMaximumClaim !== maximumClaim) fail(code);
    const expectedOutcome = text(required(control, 'expectedOutcome', code), code);
    if (expectedOutcomes.has(expectedOutcome)) fail(code);
    expectedOutcomes.add(expectedOutcome);
    if (expected.controlId === 'N9-CTRL-HUMAN-REVIEW-PENDING'
      && expectedOutcome !== 'POST creates only an owner-scoped PENDING request; review is not complete.') fail(code);
    const controlCaptureIds = [
      text(required(control, 'beforeCaptureId', code), code),
      text(required(control, 'afterCaptureId', code), code),
      text(required(control, 'actionLogCaptureId', code), code),
      text(required(control, 'networkEvidenceCaptureId', code), code),
    ];
    if (controlCaptureIds[0] !== `${expected.controlId}-BEFORE`
      || controlCaptureIds[1] !== `${expected.controlId}-AFTER`
      || controlCaptureIds[2] !== `${expected.controlId}-ACTION-LOG`
      || controlCaptureIds[3] !== `${expected.controlId}-NETWORK-EVIDENCE`) fail(code);
    for (const captureId of controlCaptureIds) {
      if (captureIds.has(captureId)) fail(code);
      captureIds.add(captureId);
    }
    const artifacts = sortedUnique(stringArray(required(control, 'artifactIds', code), code), code);
    const artifactPrefix = `N9-ARTIFACT-${String(index).padStart(2, '0')}`;
    const expectedArtifacts = [
      `${artifactPrefix}-ACTION-LOG`,
      `${artifactPrefix}-AFTER`,
      `${artifactPrefix}-BEFORE`,
      `${artifactPrefix}-NETWORK`,
    ];
    if (artifacts.length !== 4 || artifacts.some((artifactId, artifactIndex) => artifactId !== expectedArtifacts[artifactIndex])) fail(code);
    for (const artifactId of artifacts) {
      if (artifactIds.has(artifactId)) fail(code);
      artifactIds.add(artifactId);
    }
    if (required(control, 'sliceId', code) !== 'N9' || required(control, 'gateId', code) !== expected.gateId) fail(code);
    const requirementIds = exactTextArray(required(control, 'requirementIds', code), [`N9-${expected.gateId}1`], code);
    requirements.add(requirementIds[0]);
    const requiredReceiptKinds = exactTextArray(required(control, 'requiredReceiptKinds', code), REQUIRED_RECEIPT_KINDS, code) as readonly SourceReceiptKind[];
    const privateIdentities = exactIdentityArray(required(control, 'privateContainerPolicyIdentities', code), privateContainerPolicyIdentities, code);
    controls.push({
      stepIndex: index,
      controlId: expected.controlId,
      accountAliasIdentity,
      routeId,
      actionId,
      allowedFileIds: allowedFiles,
      prohibitedActionIds: prohibited,
      stopConditionIds: stops,
      maximumClaim: controlMaximumClaim,
      expectedOutcome,
      beforeCaptureId: controlCaptureIds[0],
      afterCaptureId: controlCaptureIds[1],
      actionLogCaptureId: controlCaptureIds[2],
      networkEvidenceCaptureId: controlCaptureIds[3],
      artifactIds: artifacts,
      sliceId: 'N9',
      gateId: expected.gateId,
      requirementIds,
      requiredReceiptKinds,
      privateContainerPolicyIdentities: privateIdentities,
    });
  }
  if (!BLOCKED_REQUIREMENT_IDS.every((id) => requirements.has(id))) fail(code);
  if (allowedActionIds.length !== actionIds.size || [...actionIds].some((id) => !allowedActionIds.includes(id))) fail(code);
  if (allowedFileIds.length !== controls.length || controls.some((control) => !allowedFileIds.includes(control.allowedFileIds[0]))) fail(code);
  return {
    schemaVersion: 'MES-1',
    policyId: 'N9_SUCCESSOR_POLICY_V1',
    implementationPlanIdentity,
    historicalCapsuleIdentity,
    successorLaneId: 'N9_SUCCESSOR_V1',
    blockedRequirementIds,
    accountAliasIdentities,
    allowedActionIds,
    allowedFileIds,
    prohibitedActionIds,
    stopConditionIds,
    maximumClaim,
    controls,
    declaredStorePolicyIdentity,
    privateContainerPolicyIdentities,
  };
}

async function expectedStaticIdentity(value: CanonicalJsonValue, code: string): Promise<ContentIdentity> {
  return canonicalIdentity(value, code);
}

async function assertStaticPolicyIdentities(policy: N9SuccessorPolicyV1, code: string): Promise<void> {
  const aliases = await Promise.all(aliasDescriptors().map((descriptor) => expectedStaticIdentity(descriptor, code)));
  aliases.sort((left, right) => compareTextBytes(left.sha256, right.sha256) || left.byte_length - right.byte_length);
  if (policy.accountAliasIdentities.some((identityValue, index) => !identityEqual(identityValue, aliases[index]))) fail(code);
  const privateIdentities = await Promise.all(PRIVATE_CONTAINER_POLICY_DESCRIPTORS.map((descriptor) => expectedStaticIdentity(descriptor as unknown as CanonicalJsonValue, code)));
  privateIdentities.sort((left, right) => compareTextBytes(left.sha256, right.sha256) || left.byte_length - right.byte_length);
  if (policy.privateContainerPolicyIdentities.some((identityValue, index) => !identityEqual(identityValue, privateIdentities[index]))) fail(code);
  const declared = await expectedStaticIdentity(DECLARED_STORE_POLICY_DESCRIPTOR as unknown as CanonicalJsonValue, code);
  if (!identityEqual(policy.declaredStorePolicyIdentity, declared)) fail(code);
}

function assertPolicyContext(
  policy: N9SuccessorPolicyV1,
  context: PolicySourceContext,
  code: string,
): void {
  if (!identityEqual(policy.implementationPlanIdentity, context.implementationPlanIdentity)) fail(code);
  if (!identityEqual(policy.historicalCapsuleIdentity, context.historicalCapsuleIdentity)) fail(code);
  if (policy.successorLaneId !== 'N9_SUCCESSOR_V1') fail(code);
}

function expectedIdentityObject(value: unknown, code: string): ContentIdentity {
  return identityCopy(value, code);
}

function snapshotExpected(value: unknown): IdentityFields {
  const expected = exactObject(value, [
    'rootIdentity', 'planIdentity', 'historicalTask4CapsuleIdentity', 'successorLaneId',
    'buildIdentity', 'deploymentIdentity', 'routeManifestIdentity', 'controlPlaneIdentity',
  ], 'MES_N9_EXPECTED_INVALID');
  if (required(expected, 'successorLaneId', 'MES_N9_EXPECTED_INVALID') !== 'N9_SUCCESSOR_V1') fail('MES_N9_EXPECTED_INVALID');
  return {
    rootIdentity: expectedIdentityObject(required(expected, 'rootIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    planIdentity: expectedIdentityObject(required(expected, 'planIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    historicalTask4CapsuleIdentity: expectedIdentityObject(required(expected, 'historicalTask4CapsuleIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    successorLaneId: 'N9_SUCCESSOR_V1',
    buildIdentity: expectedIdentityObject(required(expected, 'buildIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    deploymentIdentity: expectedIdentityObject(required(expected, 'deploymentIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    routeManifestIdentity: expectedIdentityObject(required(expected, 'routeManifestIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
    controlPlaneIdentity: expectedIdentityObject(required(expected, 'controlPlaneIdentity', 'MES_N9_EXPECTED_INVALID'), 'MES_N9_EXPECTED_INVALID'),
  };
}

function snapshotClock(value: unknown): N9ValidationClockV1 {
  const clock = exactObject(value, ['evaluatedAt'], 'MES_N9_CLOCK_INVALID');
  const evaluatedAt = text(required(clock, 'evaluatedAt', 'MES_N9_CLOCK_INVALID'), 'MES_N9_CLOCK_INVALID');
  return { evaluatedAt };
}

function snapshotAuthorization(value: unknown): N9SuccessorAuthorizationV1 {
  const authorization = exactObject(value, [
    'rootIdentity', 'implementationPlanIdentity', 'historicalCapsuleIdentity', 'successorLaneId',
    'accountAliasIdentities', 'allowedActionIds', 'allowedFileIds', 'prohibitedActionIds',
    'stopConditionIds', 'maximumClaim', 'buildIdentity', 'deploymentIdentity', 'routeManifestIdentity',
    'controlPlaneIdentity', 'approvalIdentity', 'authorizedAt', 'expiresAt',
  ], 'MES_N9_AUTHORIZATION_INVALID');
  if (required(authorization, 'successorLaneId', 'MES_N9_AUTHORIZATION_INVALID') !== 'N9_SUCCESSOR_V1') fail('MES_N9_AUTHORIZATION_INVALID');
  return {
    rootIdentity: identityCopy(required(authorization, 'rootIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    implementationPlanIdentity: identityCopy(required(authorization, 'implementationPlanIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    historicalCapsuleIdentity: identityCopy(required(authorization, 'historicalCapsuleIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    successorLaneId: 'N9_SUCCESSOR_V1',
    accountAliasIdentities: sortedIdentityArray(required(authorization, 'accountAliasIdentities', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    allowedActionIds: sortedUnique(stringArray(required(authorization, 'allowedActionIds', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    allowedFileIds: sortedUnique(stringArray(required(authorization, 'allowedFileIds', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    prohibitedActionIds: sortedUnique(stringArray(required(authorization, 'prohibitedActionIds', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    stopConditionIds: exactTextArray(required(authorization, 'stopConditionIds', 'MES_N9_AUTHORIZATION_INVALID'), STOP_CONDITION_IDS, 'MES_N9_AUTHORIZATION_INVALID'),
    maximumClaim: text(required(authorization, 'maximumClaim', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    buildIdentity: identityCopy(required(authorization, 'buildIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    deploymentIdentity: identityCopy(required(authorization, 'deploymentIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    routeManifestIdentity: identityCopy(required(authorization, 'routeManifestIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    controlPlaneIdentity: identityCopy(required(authorization, 'controlPlaneIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    approvalIdentity: identityCopy(required(authorization, 'approvalIdentity', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    authorizedAt: text(required(authorization, 'authorizedAt', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
    expiresAt: text(required(authorization, 'expiresAt', 'MES_N9_AUTHORIZATION_INVALID'), 'MES_N9_AUTHORIZATION_INVALID'),
  };
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    if (typeof value === 'string' && typeof candidate === 'string') return value === candidate;
    if (typeof value === 'object' && value !== null && typeof candidate === 'object' && candidate !== null) {
      return identityEqual(value as ContentIdentity, candidate as ContentIdentity);
    }
    return value === candidate;
  });
}

function assertAuthorizationMatchesPolicy(
  authorization: N9SuccessorAuthorizationV1,
  policy: N9SuccessorPolicyV1,
  expected: IdentityFields,
): void {
  if (!identityEqual(authorization.rootIdentity, expected.rootIdentity)) fail('MES_N9_AUTHORIZATION_ROOT_MISMATCH');
  if (!identityEqual(authorization.implementationPlanIdentity, expected.planIdentity)
    || !identityEqual(authorization.implementationPlanIdentity, policy.implementationPlanIdentity)) fail('MES_N9_AUTHORIZATION_PLAN_MISMATCH');
  if (!identityEqual(authorization.historicalCapsuleIdentity, expected.historicalTask4CapsuleIdentity)
    || !identityEqual(authorization.historicalCapsuleIdentity, policy.historicalCapsuleIdentity)) fail('MES_N9_AUTHORIZATION_CAPSULE_MISMATCH');
  if (authorization.successorLaneId !== expected.successorLaneId || authorization.successorLaneId !== policy.successorLaneId) fail('MES_N9_AUTHORIZATION_LANE_MISMATCH');
  if (!sameArray(authorization.accountAliasIdentities, policy.accountAliasIdentities)
    || !sameArray(authorization.allowedActionIds, policy.allowedActionIds)
    || !sameArray(authorization.allowedFileIds, policy.allowedFileIds)
    || !sameArray(authorization.prohibitedActionIds, policy.prohibitedActionIds)
    || !sameArray(authorization.stopConditionIds, policy.stopConditionIds)
    || authorization.maximumClaim !== policy.maximumClaim) fail('MES_N9_AUTHORIZATION_POLICY_MISMATCH');
  if (!identityEqual(authorization.buildIdentity, expected.buildIdentity)
    || !identityEqual(authorization.deploymentIdentity, expected.deploymentIdentity)
    || !identityEqual(authorization.routeManifestIdentity, expected.routeManifestIdentity)
    || !identityEqual(authorization.controlPlaneIdentity, expected.controlPlaneIdentity)) fail('MES_N9_AUTHORIZATION_TARGET_MISMATCH');
  const authorizedAt = validateUtcMilliseconds(authorization.authorizedAt, 'MES_N9_AUTHORIZATION_TIME_INVALID');
  const expiresAt = validateUtcMilliseconds(authorization.expiresAt, 'MES_N9_AUTHORIZATION_TIME_INVALID');
  if (authorizedAt >= expiresAt) fail('MES_N9_AUTHORIZATION_TIME_INVALID');
}

function rootPolicySnapshots(
  rootValue: unknown,
  policyValue: unknown,
): Readonly<{ root: EvidenceSpineRootV1; policy: N9SuccessorPolicyV1; rootBytes: Uint8Array; policyBytes: Uint8Array }> {
  const rootSnapshot = canonicalSnapshot(rootValue, 'MES_N9_ROOT_INVALID');
  const policySnapshot = canonicalSnapshot(policyValue, 'MES_N9_POLICY_INVALID');
  const root = rootSnapshot.value as EvidenceSpineRootV1;
  const policy = validatePolicyShape(policySnapshot.value);
  const rootObject = dataObject(root, 'MES_N9_ROOT_INVALID');
  const rootPolicy = validatePolicyShape(required(rootObject, 'n9_successor_policy', 'MES_N9_ROOT_POLICY_MISSING'));
  if (!canonicalBytesEqual(canonicalDocument(rootPolicy as unknown as CanonicalJsonValue), policySnapshot.bytes)) fail('MES_N9_ROOT_POLICY_MISMATCH');
  const sourceIdentities = dataObject(required(rootObject, 'source_identities', 'MES_N9_ROOT_SOURCES_MISSING'), 'MES_N9_ROOT_SOURCES_INVALID');
  const rootPlanIdentity = identityCopy(required(sourceIdentities, 'implementation_plan', 'MES_N9_ROOT_PLAN_IDENTITY_MISSING'), 'MES_N9_ROOT_PLAN_IDENTITY_INVALID');
  const rootCapsuleIdentity = identityCopy(required(sourceIdentities, 'historical_task4_capsule', 'MES_N9_ROOT_CAPSULE_IDENTITY_MISSING'), 'MES_N9_ROOT_CAPSULE_IDENTITY_INVALID');
  if (!identityEqual(policy.implementationPlanIdentity, rootPlanIdentity)
    || !identityEqual(policy.historicalCapsuleIdentity, rootCapsuleIdentity)) fail('MES_N9_ROOT_POLICY_BINDING_INVALID');
  return { root, policy, rootBytes: rootSnapshot.bytes, policyBytes: policySnapshot.bytes };
}

function getBrand(authorization: unknown): AuthorizationBrand {
  if (typeof authorization !== 'object' || authorization === null) fail('MES_N9_AUTHORIZATION_UNBRANDED');
  const brand = authorizationBrands.get(authorization);
  if (!brand) fail('MES_N9_AUTHORIZATION_UNBRANDED');
  return brand;
}

export async function validateN9SuccessorAuthorization(
  value: unknown,
  expectedValue: Readonly<{
    rootIdentity: ContentIdentity;
    planIdentity: ContentIdentity;
    historicalTask4CapsuleIdentity: ContentIdentity;
    successorLaneId: 'N9_SUCCESSOR_V1';
    buildIdentity: ContentIdentity;
    deploymentIdentity: ContentIdentity;
    routeManifestIdentity: ContentIdentity;
    controlPlaneIdentity: ContentIdentity;
  }>,
  rootValue: EvidenceSpineRootV1,
  policyValue: N9SuccessorPolicyV1,
  clockValue: N9ValidationClockV1,
): Promise<N9SuccessorAuthorizationV1> {
  // All mutable/accessor-bearing caller inputs are converted into canonical
  // snapshots before the first Web Crypto await.
  const rootSnapshot = canonicalSnapshot(rootValue, 'MES_N9_ROOT_INVALID');
  const policySnapshot = canonicalSnapshot(policyValue, 'MES_N9_POLICY_INVALID');
  const expectedSnapshot = canonicalSnapshot(expectedValue, 'MES_N9_EXPECTED_INVALID');
  const authorizationSnapshot = canonicalSnapshot(value, 'MES_N9_AUTHORIZATION_INVALID');
  const clockSnapshot = canonicalSnapshot(clockValue, 'MES_N9_CLOCK_INVALID');
  const rootAndPolicy = rootPolicySnapshots(rootSnapshot.value, policySnapshot.value);
  const expected = snapshotExpected(expectedSnapshot.value);
  const authorization = snapshotAuthorization(authorizationSnapshot.value);
  const clock = snapshotClock(clockSnapshot.value);
  const [actualRootIdentity, actualPolicyIdentity, actualAuthorizationIdentity] = await Promise.all([
    contentIdentity(rootAndPolicy.rootBytes),
    contentIdentity(rootAndPolicy.policyBytes),
    contentIdentity(authorizationSnapshot.bytes),
  ]);

  if (!identityEqual(actualRootIdentity, expected.rootIdentity)) fail('MES_N9_ROOT_IDENTITY_MISMATCH');
  const sourceIdentities = dataObject(required(dataObject(rootAndPolicy.root, 'MES_N9_ROOT_INVALID'), 'source_identities', 'MES_N9_ROOT_SOURCES_MISSING'), 'MES_N9_ROOT_SOURCES_INVALID');
  const sourcePolicyIdentity = identityCopy(required(sourceIdentities, 'n9_successor_policy', 'MES_N9_ROOT_POLICY_IDENTITY_MISSING'), 'MES_N9_ROOT_POLICY_IDENTITY_INVALID');
  if (!identityEqual(actualPolicyIdentity, sourcePolicyIdentity)) fail('MES_N9_POLICY_IDENTITY_MISMATCH');
  await assertStaticPolicyIdentities(rootAndPolicy.policy, 'MES_N9_POLICY_STATIC_IDENTITY_INVALID');
  assertPolicyContext(rootAndPolicy.policy, {
    sourceIdentity: actualPolicyIdentity,
    implementationPlanIdentity: expected.planIdentity,
    historicalCapsuleIdentity: expected.historicalTask4CapsuleIdentity,
  }, 'MES_N9_POLICY_ROOT_BINDING_INVALID');
  assertAuthorizationMatchesPolicy(authorization, rootAndPolicy.policy, expected);
  if (validateUtcMilliseconds(clock.evaluatedAt, 'MES_N9_CLOCK_INVALID') < validateUtcMilliseconds(authorization.authorizedAt, 'MES_N9_AUTHORIZATION_TIME_INVALID')
    || validateUtcMilliseconds(clock.evaluatedAt, 'MES_N9_CLOCK_INVALID') >= validateUtcMilliseconds(authorization.expiresAt, 'MES_N9_AUTHORIZATION_TIME_INVALID')) {
    fail('MES_N9_AUTHORIZATION_TIME_INVALID');
  }
  const frozenAuthorization = deepFreeze({
    rootIdentity: authorization.rootIdentity,
    implementationPlanIdentity: authorization.implementationPlanIdentity,
    historicalCapsuleIdentity: authorization.historicalCapsuleIdentity,
    successorLaneId: authorization.successorLaneId,
    accountAliasIdentities: [...authorization.accountAliasIdentities],
    allowedActionIds: [...authorization.allowedActionIds],
    allowedFileIds: [...authorization.allowedFileIds],
    prohibitedActionIds: [...authorization.prohibitedActionIds],
    stopConditionIds: [...authorization.stopConditionIds],
    maximumClaim: authorization.maximumClaim,
    buildIdentity: authorization.buildIdentity,
    deploymentIdentity: authorization.deploymentIdentity,
    routeManifestIdentity: authorization.routeManifestIdentity,
    controlPlaneIdentity: authorization.controlPlaneIdentity,
    approvalIdentity: authorization.approvalIdentity,
    authorizedAt: authorization.authorizedAt,
    expiresAt: authorization.expiresAt,
  }) as N9SuccessorAuthorizationV1;
  authorizationBrands.set(frozenAuthorization as object, {
    rootIdentity: actualRootIdentity,
    policyIdentity: actualPolicyIdentity,
    authorizationIdentity: actualAuthorizationIdentity,
    evaluatedAt: clock.evaluatedAt,
  });
  return frozenAuthorization;
}

async function revalidateBuilderInputs(
  rootSnapshot: ReturnType<typeof canonicalSnapshot>,
  policySnapshot: ReturnType<typeof canonicalSnapshot>,
  authorizationSnapshot: ReturnType<typeof canonicalSnapshot>,
  brand: AuthorizationBrand,
): Promise<Readonly<{
  root: EvidenceSpineRootV1;
  policy: N9SuccessorPolicyV1;
  authorization: N9SuccessorAuthorizationV1;
  rootIdentity: ContentIdentity;
  policyIdentity: ContentIdentity;
  authorizationIdentity: ContentIdentity;
}>> {
  const rootAndPolicy = rootPolicySnapshots(rootSnapshot.value, policySnapshot.value);
  const authorization = snapshotAuthorization(authorizationSnapshot.value);
  const [rootIdentity, policyIdentity, authorizationIdentity] = await Promise.all([
    contentIdentity(rootAndPolicy.rootBytes),
    contentIdentity(rootAndPolicy.policyBytes),
    contentIdentity(authorizationSnapshot.bytes),
  ]);
  if (!identityEqual(rootIdentity, brand.rootIdentity)
    || !identityEqual(policyIdentity, brand.policyIdentity)
    || !identityEqual(authorizationIdentity, brand.authorizationIdentity)) {
    fail('MES_N9_AUTHORIZATION_BRAND_MISMATCH');
  }
  const sourceIdentities = dataObject(required(dataObject(rootAndPolicy.root, 'MES_N9_ROOT_INVALID'), 'source_identities', 'MES_N9_ROOT_SOURCES_MISSING'), 'MES_N9_ROOT_SOURCES_INVALID');
  const sourcePolicyIdentity = identityCopy(required(sourceIdentities, 'n9_successor_policy', 'MES_N9_ROOT_POLICY_IDENTITY_MISSING'), 'MES_N9_ROOT_POLICY_IDENTITY_INVALID');
  if (!identityEqual(policyIdentity, sourcePolicyIdentity)) fail('MES_N9_POLICY_IDENTITY_MISMATCH');
  await assertStaticPolicyIdentities(rootAndPolicy.policy, 'MES_N9_POLICY_STATIC_IDENTITY_INVALID');
  if (!identityEqual(authorization.rootIdentity, rootIdentity)
    || !identityEqual(authorization.implementationPlanIdentity, rootAndPolicy.policy.implementationPlanIdentity)
    || !identityEqual(authorization.historicalCapsuleIdentity, rootAndPolicy.policy.historicalCapsuleIdentity)
    || authorization.successorLaneId !== rootAndPolicy.policy.successorLaneId) {
    fail('MES_N9_AUTHORIZATION_BINDING_INVALID');
  }
  return {
    root: rootAndPolicy.root,
    policy: rootAndPolicy.policy,
    authorization,
    rootIdentity,
    policyIdentity,
    authorizationIdentity,
  };
}

export async function buildN9ExecutionChecklist(
  rootValue: EvidenceSpineRootV1,
  policyValue: N9SuccessorPolicyV1,
  authorizationValue: N9SuccessorAuthorizationV1,
): Promise<readonly N9AuthorizedStep[]> {
  const rootSnapshot = canonicalSnapshot(rootValue, 'MES_N9_ROOT_INVALID');
  const policySnapshot = canonicalSnapshot(policyValue, 'MES_N9_POLICY_INVALID');
  const authorizationSnapshot = canonicalSnapshot(authorizationValue, 'MES_N9_AUTHORIZATION_INVALID');
  const existingBrand = getBrand(authorizationValue);
  const checked = await revalidateBuilderInputs(rootSnapshot, policySnapshot, authorizationSnapshot, existingBrand);
  const checklist = checked.policy.controls.map((control) => ({
    stepIndex: control.stepIndex,
    controlId: control.controlId,
    accountAliasIdentity: { ...control.accountAliasIdentity },
    routeId: control.routeId,
    actionId: control.actionId,
    allowedFileIds: [...control.allowedFileIds],
    prohibitedActionIds: [...control.prohibitedActionIds],
    stopConditionIds: [...control.stopConditionIds],
    maximumClaim: control.maximumClaim,
  }));
  return deepFreeze(checklist);
}

function snapshotObservation(value: unknown): N9ControlObservationCarrierV1 {
  const observation = exactObject(value, [
    'controlId', 'beforeIdentity', 'afterIdentity', 'actionLogIdentity', 'networkEvidenceIdentity', 'receiptRefs',
  ], 'MES_N9_OBSERVATION_INVALID');
  const refs = array(required(observation, 'receiptRefs', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID').map((refValue) => {
    const ref = exactObject(refValue, ['receipt_kind', 'receipt_id', 'content_identity'], 'MES_N9_RECEIPT_REF_INVALID');
    const receiptKind = text(required(ref, 'receipt_kind', 'MES_N9_RECEIPT_REF_INVALID'), 'MES_N9_RECEIPT_REF_INVALID');
    if (!(REQUIRED_RECEIPT_KINDS as readonly string[]).includes(receiptKind)) fail('MES_N9_RECEIPT_REF_INVALID');
    return {
      receipt_kind: receiptKind as SourceReceiptKind,
      receipt_id: text(required(ref, 'receipt_id', 'MES_N9_RECEIPT_REF_INVALID'), 'MES_N9_RECEIPT_REF_INVALID'),
      content_identity: identityCopy(required(ref, 'content_identity', 'MES_N9_RECEIPT_REF_INVALID'), 'MES_N9_RECEIPT_REF_INVALID'),
    };
  });
  for (let index = 1; index < refs.length; index += 1) {
    const previousKey = `${refs[index - 1].receipt_kind}\u0000${refs[index - 1].receipt_id}`;
    const currentKey = `${refs[index].receipt_kind}\u0000${refs[index].receipt_id}`;
    if (compareTextBytes(previousKey, currentKey) >= 0) fail('MES_N9_RECEIPT_REF_ORDER_INVALID');
  }
  return {
    controlId: text(required(observation, 'controlId', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID'),
    beforeIdentity: identityCopy(required(observation, 'beforeIdentity', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID'),
    afterIdentity: identityCopy(required(observation, 'afterIdentity', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID'),
    actionLogIdentity: identityCopy(required(observation, 'actionLogIdentity', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID'),
    networkEvidenceIdentity: identityCopy(required(observation, 'networkEvidenceIdentity', 'MES_N9_OBSERVATION_INVALID'), 'MES_N9_OBSERVATION_INVALID'),
    receiptRefs: refs,
  };
}

function assertObservationMatchesControl(
  control: N9SuccessorPolicyV1['controls'][number],
  observation: N9ControlObservationCarrierV1,
): void {
  const expectedCaptureIdentities: Readonly<Record<string, ContentIdentity>> = {
    [control.beforeCaptureId]: observation.beforeIdentity,
    [control.afterCaptureId]: observation.afterIdentity,
    [control.actionLogCaptureId]: observation.actionLogIdentity,
    [control.networkEvidenceCaptureId]: observation.networkEvidenceIdentity,
  };
  const captureIds = Object.keys(expectedCaptureIdentities);
  if (captureIds.length !== 4 || observation.receiptRefs.length !== 4) fail('MES_N9_OBSERVATION_RECEIPT_INVALID');
  if (new Set(observation.receiptRefs.map((ref) => ref.receipt_id)).size !== 4) fail('MES_N9_OBSERVATION_RECEIPT_INVALID');
  const kinds = new Set<string>();
  for (const ref of observation.receiptRefs) {
    const expectedIdentity = expectedCaptureIdentities[ref.receipt_id];
    if (!expectedIdentity || !identityEqual(expectedIdentity, ref.content_identity)) fail('MES_N9_OBSERVATION_RECEIPT_INVALID');
    kinds.add(ref.receipt_kind);
  }
  if (kinds.size !== control.requiredReceiptKinds.length || control.requiredReceiptKinds.some((kind) => !kinds.has(kind))) {
    fail('MES_N9_OBSERVATION_RECEIPT_KIND_INVALID');
  }
}

export async function buildN9EvidenceCapturePlan(
  rootValue: EvidenceSpineRootV1,
  policyValue: N9SuccessorPolicyV1,
  authorizationValue: N9SuccessorAuthorizationV1,
  observationsValue: readonly N9ControlObservationCarrierV1[],
): Promise<FrozenN9EvidenceCapturePlanV1> {
  const rootSnapshot = canonicalSnapshot(rootValue, 'MES_N9_ROOT_INVALID');
  const policySnapshot = canonicalSnapshot(policyValue, 'MES_N9_POLICY_INVALID');
  const authorizationSnapshot = canonicalSnapshot(authorizationValue, 'MES_N9_AUTHORIZATION_INVALID');
  const observationsSnapshot = canonicalSnapshot(observationsValue, 'MES_N9_OBSERVATIONS_INVALID');
  const existingBrand = getBrand(authorizationValue);
  const checked = await revalidateBuilderInputs(rootSnapshot, policySnapshot, authorizationSnapshot, existingBrand);
  const observationValues = array(observationsSnapshot.value, 'MES_N9_OBSERVATIONS_INVALID').map(snapshotObservation);
  if (observationValues.length !== checked.policy.controls.length) fail('MES_N9_OBSERVATIONS_INCOMPLETE');
  const observationByControl = new Map<string, N9ControlObservationCarrierV1>();
  for (const observation of observationValues) {
    if (observationByControl.has(observation.controlId)) fail('MES_N9_OBSERVATIONS_DUPLICATE');
    observationByControl.set(observation.controlId, observation);
  }
  const subjectIdentity = await canonicalIdentity(N9_SUBJECT_DESCRIPTOR, 'MES_N9_SUBJECT_IDENTITY_INVALID');
  const bindings: ControlCaptureBindingV1[] = [];
  let declaredStoreManifestIdentity: ContentIdentity | undefined;
  for (const control of checked.policy.controls) {
    const observation = observationByControl.get(control.controlId);
    if (!observation) fail('MES_N9_OBSERVATION_CONTROL_MISSING');
    assertObservationMatchesControl(control, observation);
    const binding: ControlCaptureBindingV1 = {
      rootIdentity: { ...checked.rootIdentity },
      implementationPlanIdentity: { ...controlIdentity(checked.policy.implementationPlanIdentity) },
      successorLaneId: 'N9_SUCCESSOR_V1',
      controlId: control.controlId,
      subjectIdentity: { ...subjectIdentity },
      accountScopeIdentity: { ...control.accountAliasIdentity },
      sliceId: control.sliceId,
      gateId: control.gateId,
      requirementIds: [...control.requirementIds],
      routeId: control.routeId,
      actionId: control.actionId,
      expectedOutcome: control.expectedOutcome,
      buildIdentity: { ...checked.authorization.buildIdentity },
      deploymentIdentity: { ...checked.authorization.deploymentIdentity },
      routeManifestIdentity: { ...checked.authorization.routeManifestIdentity },
      controlPlaneIdentity: { ...checked.authorization.controlPlaneIdentity },
      beforeIdentity: { ...observation.beforeIdentity },
      afterIdentity: { ...observation.afterIdentity },
      actionLogIdentity: { ...observation.actionLogIdentity },
      networkEvidenceIdentity: { ...observation.networkEvidenceIdentity },
      artifactIds: [...control.artifactIds],
      requiredReceiptKinds: [...control.requiredReceiptKinds],
      stopConditionIds: [...control.stopConditionIds],
      maximumClaim: control.maximumClaim,
    };
    bindings.push(binding);
    if (control.controlId === 'N9-CTRL-DECLARED-STORE-DELETION-RESIDUE') {
      declaredStoreManifestIdentity = { ...observation.beforeIdentity };
    }
  }
  if (!declaredStoreManifestIdentity || identityEqual(declaredStoreManifestIdentity, checked.policy.declaredStorePolicyIdentity)) {
    fail('MES_N9_STORE_IDENTITY_INVALID');
  }
  const plan: N9EvidenceCapturePlanV1 = {
    rootIdentity: { ...checked.rootIdentity },
    implementationPlanIdentity: { ...checked.policy.implementationPlanIdentity },
    historicalCapsuleIdentity: { ...checked.policy.historicalCapsuleIdentity },
    successorLaneId: 'N9_SUCCESSOR_V1',
    authorizationIdentity: { ...checked.authorizationIdentity },
    buildIdentity: { ...checked.authorization.buildIdentity },
    deploymentIdentity: { ...checked.authorization.deploymentIdentity },
    routeManifestIdentity: { ...checked.authorization.routeManifestIdentity },
    controlPlaneIdentity: { ...checked.authorization.controlPlaneIdentity },
    controls: bindings,
    declaredStoreManifestIdentity,
    privateContainerPolicyIdentities: policyIdentityBindings(checked.policy, 'MES_N9_POLICY_INVALID').map((identityValue) => ({ ...identityValue })),
  };
  const planIdentity = await canonicalIdentity(plan, 'MES_N9_CAPTURE_PLAN_INVALID');
  const frozenPlan = deepFreeze(plan);
  return deepFreeze({
    plan: frozenPlan,
    planIdentity,
    authorization: checked.authorization,
    authorizationIdentity: { ...checked.authorizationIdentity },
  });
}

function controlIdentity(value: ContentIdentity): ContentIdentity {
  return { byte_length: value.byte_length, sha256: value.sha256 };
}
