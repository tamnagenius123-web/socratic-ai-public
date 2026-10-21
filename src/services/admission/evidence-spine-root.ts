import {
  AuthorityJsonError,
  canonicalDocument,
  parseAuthorityJson,
  type CanonicalJsonValue,
} from './canonical-json';
import { contentIdentity, type ContentIdentity } from './identity';
import {
  type ConditionalClaimV1,
  type ConditionalClaimIdV1,
  type ClosureRuleDefinitionV1,
  type DeterministicReducerDefinitionV1,
  type EvidenceGate,
  type EvidenceRequirementV1,
  type EvidenceSliceId,
  type EvidenceSpineRootV1,
  type ExpectedRootIdentities,
  type FailureTellLinkV1,
  type FailureTellDefinitionV1,
  type FirstVerticalJourneyDefinitionV1,
  type NegativeControlDefinitionV1,
  type N9SuccessorPolicyV1,
  type RecordSchemasDefinitionV1,
  type RequirementIndependence,
  type RootSourceIdentitiesV1,
  type RootSourceBytes,
  type SuccessorLaneDefinitionV1,
  type Task13ExperimentDefinitionV1,
} from './evidence-spine-types';
import { assertContentIdentity, canonicalBytesEqual } from './evidence-spine-validation';
import { validateN9SuccessorAuthorization } from './n9-successor';

type DataObject = Record<string, unknown>;

const rootSourceKeys = [
  'specification', 'implementationPlan', 'matrix', 'answerKey', 'historicalTask4Capsule',
  'failureTellDefinitions', 'negativeControlDefinitions', 'successorLaneDefinition',
  'firstVerticalJourney', 'recordSchemas', 'deterministicReducer', 'task13Experiment', 'closureRule',
  'n9SuccessorPolicy',
] as const;

type RootSourceKey = typeof rootSourceKeys[number];

const expectedSliceIds = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10'];
const evidenceGates = ['D', 'S', 'R', 'P', 'A', 'L', 'V0'] as const;
const gateStatuses = ['PENDING', 'PASS', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'BLOCKED_CONTRACT'] as const;
const firstVerticalBaselineSteps = [
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
] as const;
const approvedRequirementRows = [
  ['N0-D1', 'N0', 'D', 'NON_BUILDER'], ['N0-S1', 'N0', 'S', 'NON_BUILDER'], ['N0-R1', 'N0', 'R', 'NON_BUILDER'], ['N0-P1', 'N0', 'P', 'NON_BUILDER'], ['N0-A1', 'N0', 'A', 'NON_BUILDER'],
  ['N1-D1', 'N1', 'D', 'NON_BUILDER'], ['N1-S1', 'N1', 'S', 'NON_BUILDER'], ['N1-R1', 'N1', 'R', 'NON_BUILDER'], ['N1-P1', 'N1', 'P', 'NON_BUILDER'], ['N1-A1', 'N1', 'A', 'NON_BUILDER'], ['N1-L1', 'N1', 'L', 'NON_BUILDER'],
  ['N2-D1', 'N2', 'D', 'NON_BUILDER'], ['N2-S1', 'N2', 'S', 'NON_BUILDER'], ['N2-R1', 'N2', 'R', 'NON_BUILDER'], ['N2-P1', 'N2', 'P', 'NON_BUILDER'], ['N2-A1', 'N2', 'A', 'NON_BUILDER'], ['N2-L1', 'N2', 'L', 'NON_BUILDER'],
  ['N3-D1', 'N3', 'D', 'NON_BUILDER'], ['N3-S1', 'N3', 'S', 'NON_BUILDER'], ['N3-R1', 'N3', 'R', 'NON_BUILDER'], ['N3-P1', 'N3', 'P', 'NON_BUILDER'], ['N3-A1', 'N3', 'A', 'NON_BUILDER'], ['N3-L1', 'N3', 'L', 'NON_BUILDER'],
  ['N4-D1', 'N4', 'D', 'NON_BUILDER'], ['N4-S1', 'N4', 'S', 'NON_BUILDER'], ['N4-R1', 'N4', 'R', 'NON_BUILDER'], ['N4-P1', 'N4', 'P', 'NON_BUILDER'], ['N4-A1', 'N4', 'A', 'NON_BUILDER'], ['N4-L1', 'N4', 'L', 'NON_BUILDER'],
  ['N5-D1', 'N5', 'D', 'NON_BUILDER'], ['N5-S1', 'N5', 'S', 'NON_BUILDER'], ['N5-R1', 'N5', 'R', 'NON_BUILDER'], ['N5-P1', 'N5', 'P', 'NON_BUILDER'], ['N5-A1', 'N5', 'A', 'NON_BUILDER'], ['N5-L1', 'N5', 'L', 'NON_BUILDER'],
  ['N6-D1', 'N6', 'D', 'NON_BUILDER'], ['N6-S1', 'N6', 'S', 'NON_BUILDER'], ['N6-R1', 'N6', 'R', 'NON_BUILDER'], ['N6-P1', 'N6', 'P', 'NON_BUILDER'], ['N6-A1', 'N6', 'A', 'NON_BUILDER'], ['N6-L1', 'N6', 'L', 'NON_BUILDER'],
  ['N7-D1', 'N7', 'D', 'NON_BUILDER'], ['N7-S1', 'N7', 'S', 'NON_BUILDER'], ['N7-R1', 'N7', 'R', 'NON_BUILDER'], ['N7-P1', 'N7', 'P', 'NON_BUILDER'], ['N7-A1', 'N7', 'A', 'NON_BUILDER'], ['N7-L1', 'N7', 'L', 'NON_BUILDER'],
  ['N8-D1', 'N8', 'D', 'NON_BUILDER'], ['N8-S1', 'N8', 'S', 'NON_BUILDER'], ['N8-R1', 'N8', 'R', 'NON_BUILDER'], ['N8-P1', 'N8', 'P', 'NON_BUILDER'], ['N8-A1', 'N8', 'A', 'NON_BUILDER'], ['N8-L1', 'N8', 'L', 'NON_BUILDER'],
  ['N9-D1', 'N9', 'D', 'NON_BUILDER'], ['N9-S1', 'N9', 'S', 'NON_BUILDER'], ['N9-R1', 'N9', 'R', 'NON_BUILDER'], ['N9-P1', 'N9', 'P', 'NON_BUILDER'], ['N9-A1', 'N9', 'A', 'NON_BUILDER'], ['N9-L1', 'N9', 'L', 'NON_BUILDER'],
  ['N10-R1', 'N10', 'R', 'NON_BUILDER'], ['N10-P1', 'N10', 'P', 'NON_BUILDER'], ['N10-A1', 'N10', 'A', 'NON_BUILDER'], ['N10-L1', 'N10', 'L', 'NON_BUILDER'], ['N10-V1', 'N10', 'V0', 'NON_BUILDER_CROSS_VENDOR'],
] as const;
const approvedFailureTellIds = [
  'FT-N0-MIXED-AUTHORITY', 'FT-N0-MISSING-SOURCE', 'FT-N0-GENERATED-PROVENANCE', 'FT-N0-OVERWRITTEN-CORRECTION', 'FT-N0-STALE-DEPLOYMENT',
  'FT-N1-FIXED-ARCHETYPE', 'FT-N1-CONFIDENCE-FREE-FACT', 'FT-N1-SINGLE-GROUND-TRUTH', 'FT-N1-HIDDEN-INFERENCE', 'FT-N1-RENDER-ONLY-CONTEST', 'FT-N1-GRAPH-DIAGNOSIS', 'FT-N1-OLD-WIKI-PROOF',
  'FT-N2-PERSONALITY-ROUTE', 'FT-N2-LOWERED-STANDARD', 'FT-N2-POST-HOC-RATIONALE', 'FT-N2-NO-CONTRARY-ROUTE',
  'FT-N3-ADVERSARIAL-DEBATE', 'FT-N3-UNIQUE-MIDPOINT', 'FT-N3-GRAPH-AS-FACT', 'FT-N3-NO-ABSTENTION', 'FT-N3-NO-MAPPING', 'FT-N3-AI-AS-TRANSFER', 'FT-N3-NO-ALTERED-CONTEXT',
  'FT-N4-INDEFINITE-NONINTERVENTION', 'FT-N4-NO-DIAGNOSIS', 'FT-N4-WRONG-RECALL-REWARDED', 'FT-N4-SYNTHETIC-RECHECK', 'FT-N4-OVERWRITTEN-HISTORY',
  'FT-N5-TELEMETRY-AS-FLOW', 'FT-N5-DOPAMINE-SCORE', 'FT-N5-PERSONALITY-EMPLOYABILITY', 'FT-N5-PUNISH-STOP', 'FT-N5-REWARD-AS-PURPOSE',
  'FT-N6-IMMEDIATE-MASTERY', 'FT-N6-SYNTHETIC-CLOCK', 'FT-N6-NO-WRONG-FEEDBACK', 'FT-N6-NO-LATER-ACTION',
  'FT-N7-UNCERTAIN-ITEM-POOLING', 'FT-N7-TOOL-BOUNDARY-COLLAPSE', 'FT-N7-COMPOSITE-HIDES-FAILURE', 'FT-N7-LEAKAGE', 'FT-N7-TRAINED-AS-FAR-TRANSFER', 'FT-N7-IQ-GENIUS-PROMISE', 'FT-N7-CLOSED-SCORE-AS-WISDOM',
  'FT-N8-DISRUPTIVE-CEREMONY', 'FT-N8-SINGLE-SCORE-GLOBAL', 'FT-N8-CROSS-DOMAIN-GENERALIZATION', 'FT-N8-ACCESS-SAFETY-REMOVED', 'FT-N8-NO-ONE-ACTION-RESTORE', 'FT-N8-HELP-PUNISHED', 'FT-N8-SELF-RETIREMENT-PROVEN',
  'FT-N9-SECRET-SCAN-AS-ROTATION', 'FT-N9-SILENT-FALLBACK', 'FT-N9-CONSENT-ASSUMED', 'FT-N9-DELETION-RESIDUE', 'FT-N9-INACCESSIBLE-PATH', 'FT-N9-SUBGROUP-OMITTED', 'FT-N9-MENTAL-IQ-DIAGNOSIS',
  'FT-N10-LOCALIZATION-AS-E2E', 'FT-N10-MOCK-AS-PRODUCTION', 'FT-N10-PREVIEW-AS-DEPLOYED', 'FT-N10-TURN-COUNT-AS-EFFICACY', 'FT-N10-CLASSCHAT-AS-MASTERY', 'FT-N10-NAVIGATION-AS-JOURNEY', 'FT-N10-MISSING-AUTH-ISOLATION', 'FT-N10-UI-DATA-UNBOUND', 'FT-N10-VISUAL-AS-FUNCTION',
] as const;
const approvedNegativeControlIds = [
  'NC-PROVENANCE', 'NC-SCOPE', 'NC-STATE', 'NC-ROUTE', 'NC-TRANSFER', 'NC-REVISION', 'NC-FALLBACK', 'NC-MOTIVATION', 'NC-DURABILITY', 'NC-LEAKAGE', 'NC-FADING', 'NC-DELETE', 'NC-ACCESS', 'NC-DEPLOYMENT', 'NC-SURVEILLANCE',
] as const;
const gateStatusKeysBySlice: Readonly<Record<EvidenceSliceId, readonly EvidenceGate[]>> = {
  N0: ['D', 'S', 'R', 'P', 'A'], N1: ['D', 'S', 'R', 'P', 'A', 'L'], N2: ['D', 'S', 'R', 'P', 'A', 'L'],
  N3: ['D', 'S', 'R', 'P', 'A', 'L'], N4: ['D', 'S', 'R', 'P', 'A', 'L'], N5: ['D', 'S', 'R', 'P', 'A', 'L'],
  N6: ['D', 'S', 'R', 'P', 'A', 'L'], N7: ['D', 'S', 'R', 'P', 'A', 'L'], N8: ['D', 'S', 'R', 'P', 'A', 'L'],
  N9: ['D', 'S', 'R', 'P', 'A', 'L'], N10: ['R', 'P', 'A', 'L', 'V0'],
};
const approvedConditionalClaims = [
  ['CLAIM-N1-LEARNER-MODEL-VALIDITY-CALIBRATION', 'N1', 'N1-L1', 'required for learner-model validity or calibration claims', 'learner-model validity or calibration is claimed'],
  ['CLAIM-N2-ROUTE-EFFICACY-FAIRNESS', 'N2', 'N2-L1', 'required for route efficacy or fairness claims', 'route efficacy or fairness is claimed'],
  ['CLAIM-N10-DURABILITY-SCAFFOLD-FADE', 'N10', 'N10-L1', 'required when N6 durability or N8 scaffold-fade effects are asserted', 'N6 durability or N8 scaffold-fade effects are asserted'],
] as const;

function fail(code: string): never {
  throw new AuthorityJsonError(code);
}

function ownDataField(objectValue: object, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
  if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  return descriptor.value;
}

function dataObject(value: unknown, code: string): DataObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(code);
  const objectValue = value as object;
  if (Object.getPrototypeOf(objectValue) !== Object.prototype && Object.getPrototypeOf(objectValue) !== null) fail(code);
  if (Object.getOwnPropertySymbols(objectValue).length !== 0) fail(code);
  for (const key of Object.getOwnPropertyNames(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  return value as DataObject;
}

function exactOwnDataObject(value: unknown, keys: readonly string[], code: string): DataObject {
  const objectValue = dataObject(value, code);
  const names = Object.getOwnPropertyNames(objectValue);
  if (names.length !== keys.length) fail(code);
  const required = new Set(keys);
  for (const name of names) {
    if (!required.has(name)) fail(code);
  }
  for (const key of keys) requiredObjectField(objectValue, key, code);
  return objectValue;
}

function requiredObjectField(objectValue: object, key: string, code: string): unknown {
  return ownDataField(objectValue, key, code);
}

function dataArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9]\d*)$/.test(key)) fail(code);
    const numericIndex = Number(key);
    if (!Number.isSafeInteger(numericIndex) || numericIndex < 0 || numericIndex >= 0xffffffff || String(numericIndex) !== key) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) fail(code);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail(code);
  }
  return value;
}

function text(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(code);
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      fail(code);
    }
    if (current <= 0x1f || (current >= 0x7f && current <= 0x9f)) fail(code);
  }
  if (value.normalize('NFC') !== value) fail(code);
  return value;
}

function stringArray(value: unknown, code: string): readonly string[] {
  return dataArray(value, code).map((item) => text(item, code));
}

function assertCanonicalValueText(value: unknown, code: string): void {
  if (typeof value === 'string') {
    text(value, code);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    for (const item of dataArray(value, code)) assertCanonicalValueText(item, code);
    return;
  }
  const objectValue = dataObject(value, code);
  for (const key of Object.getOwnPropertyNames(objectValue)) {
    assertCanonicalValueText(requiredObjectField(objectValue, key, code), code);
  }
}

function identityEqual(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function snapshotRootSources(sources: unknown): Record<RootSourceKey, Uint8Array> {
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) fail('MES_ROOT_SOURCE_SHAPE_INVALID');
  // Capture each required descriptor before examining aggregate shape.  The
  // legacy source-member error is more useful (and deliberately precedes
  // shape rejection) when a required authority input is absent.
  const sourceMap = sources as object;
  const snapshot = {} as Record<RootSourceKey, Uint8Array>;
  for (const key of rootSourceKeys) {
    const value = requiredObjectField(sourceMap, key, 'MES_ROOT_SOURCE_MISSING:' + key);
    if (!(value instanceof Uint8Array)) fail(`MES_ROOT_SOURCE_MISSING:${key}`);
    snapshot[key] = new Uint8Array(value);
  }
  exactOwnDataObject(sourceMap as DataObject, rootSourceKeys, 'MES_ROOT_SOURCE_SHAPE_INVALID');
  return snapshot;
}

function snapshotExpectedIdentities(expected: unknown): Record<RootSourceKey, ContentIdentity> {
  if (typeof expected !== 'object' || expected === null || Array.isArray(expected)) fail('MES_ROOT_EXPECTED_SHAPE_INVALID');
  const expectedMap = expected as object;
  const snapshot = {} as Record<RootSourceKey, ContentIdentity>;
  for (const key of rootSourceKeys) {
    try {
      const identity = assertContentIdentity(
        requiredObjectField(expectedMap, key, `MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`),
        `MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`,
      );
      snapshot[key] = { byte_length: identity.byte_length, sha256: identity.sha256 };
    } catch {
      fail(`MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`);
    }
  }
  exactOwnDataObject(expectedMap as DataObject, rootSourceKeys, 'MES_ROOT_EXPECTED_SHAPE_INVALID');
  return snapshot;
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

function rootSourceBytes(sources: RootSourceBytes, key: RootSourceKey): Uint8Array {
  const candidate = ownDataField(sources as unknown as object, key, `MES_ROOT_SOURCE_MISSING:${key}`);
  if (!(candidate instanceof Uint8Array)) fail(`MES_ROOT_SOURCE_MISSING:${key}`);
  return new Uint8Array(candidate);
}

function expectedIdentity(expected: ExpectedRootIdentities, key: RootSourceKey): ContentIdentity {
  try {
    return assertContentIdentity(
      ownDataField(expected as unknown as object, key, `MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`),
      `MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`,
    );
  } catch {
    fail(`MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`);
  }
}

function canonicalSource(bytes: Uint8Array, key: RootSourceKey): CanonicalJsonValue {
  let parsed: CanonicalJsonValue;
  try {
    parsed = parseAuthorityJson(bytes);
  } catch {
    fail(`MES_ROOT_SOURCE_PARSE_INVALID:${key}`);
  }
  if (!canonicalBytesEqual(canonicalDocument(parsed), bytes)) fail(`MES_ROOT_SOURCE_CANONICAL_REQUIRED:${key}`);
  assertCanonicalValueText(parsed, `MES_ROOT_SOURCE_TEXT_INVALID:${key}`);
  return parsed;
}

/**
 * Keep source-fourteen policy validation private to this root boundary.  The
 * N9 module's public surface is intentionally limited to the three approved
 * preparation functions; this offline validation-only call creates no route,
 * runner, candidate, admission, grade, or closure effect.
 */
async function validateN9SuccessorPolicyAtRoot(
  policySource: CanonicalJsonValue,
  policyIdentity: ContentIdentity,
  implementationPlanIdentity: ContentIdentity,
  historicalCapsuleIdentity: ContentIdentity,
): Promise<N9SuccessorPolicyV1> {
  const policy = dataObject(policySource, 'MES_N9_POLICY_INVALID');
  const policyField = (key: string): unknown => requiredObjectField(policy, key, 'MES_N9_POLICY_INVALID');
  const validationRoot = {
    schema_version: 'MES-1' as const,
    source_identities: {
      implementation_plan: { ...implementationPlanIdentity },
      historical_task4_capsule: { ...historicalCapsuleIdentity },
      n9_successor_policy: { ...policyIdentity },
    },
    n9_successor_policy: policySource,
  };
  const validationRootIdentity = await contentIdentity(
    canonicalDocument(validationRoot as unknown as CanonicalJsonValue),
  );
  const expected = {
    rootIdentity: validationRootIdentity,
    planIdentity: { ...implementationPlanIdentity },
    historicalTask4CapsuleIdentity: { ...historicalCapsuleIdentity },
    successorLaneId: 'N9_SUCCESSOR_V1' as const,
    buildIdentity: { ...policyIdentity },
    deploymentIdentity: { ...policyIdentity },
    routeManifestIdentity: { ...policyIdentity },
    controlPlaneIdentity: { ...policyIdentity },
  };
  await validateN9SuccessorAuthorization(
    {
      rootIdentity: { ...validationRootIdentity },
      implementationPlanIdentity: policyField('implementationPlanIdentity'),
      historicalCapsuleIdentity: policyField('historicalCapsuleIdentity'),
      successorLaneId: 'N9_SUCCESSOR_V1',
      accountAliasIdentities: policyField('accountAliasIdentities'),
      allowedActionIds: policyField('allowedActionIds'),
      allowedFileIds: policyField('allowedFileIds'),
      prohibitedActionIds: policyField('prohibitedActionIds'),
      stopConditionIds: policyField('stopConditionIds'),
      maximumClaim: policyField('maximumClaim'),
      buildIdentity: { ...policyIdentity },
      deploymentIdentity: { ...policyIdentity },
      routeManifestIdentity: { ...policyIdentity },
      controlPlaneIdentity: { ...policyIdentity },
      approvalIdentity: { ...policyIdentity },
      authorizedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2100-01-01T00:00:00.000Z',
    },
    expected,
    validationRoot as unknown as EvidenceSpineRootV1,
    policySource as unknown as N9SuccessorPolicyV1,
    { evaluatedAt: '2026-09-02T12:00:00.000Z' },
  );
  return policySource as unknown as N9SuccessorPolicyV1;
}

function parseMatrix(bytes: Uint8Array): DataObject {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('MES_ROOT_MATRIX_UTF8_INVALID');
  }
  try {
    const matrix = JSON.parse(decoded) as unknown;
    assertCanonicalValueText(matrix, 'MES_ROOT_MATRIX_INVALID');
    return dataObject(matrix, 'MES_ROOT_MATRIX_INVALID');
  } catch (error: unknown) {
    if (error instanceof AuthorityJsonError) throw error;
    fail('MES_ROOT_MATRIX_INVALID');
  }
}

function matrixSlices(matrix: DataObject): readonly DataObject[] {
  return dataArray(requiredObjectField(matrix, 'slices', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID')
    .map((slice) => dataObject(slice, 'MES_ROOT_MATRIX_INVALID'));
}

function matrixFailureTells(matrix: DataObject): readonly DataObject[] {
  return dataArray(requiredObjectField(matrix, 'failure_tells', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID')
    .map((tell) => dataObject(tell, 'MES_ROOT_MATRIX_INVALID'));
}

function matrixNegativeControls(matrix: DataObject): readonly DataObject[] {
  return dataArray(requiredObjectField(matrix, 'negative_controls', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID')
    .map((control) => dataObject(control, 'MES_ROOT_MATRIX_INVALID'));
}

function canonicalObject(value: CanonicalJsonValue, code: string): DataObject {
  return dataObject(value, code);
}

function canonicalField(objectValue: DataObject, key: string, code: string): CanonicalJsonValue {
  const value = requiredObjectField(objectValue, key, code);
  return value as CanonicalJsonValue;
}

function assertDerivedSource(
  source: CanonicalJsonValue,
  expectedValue: CanonicalJsonValue,
  key: RootSourceKey,
): DataObject {
  if (!canonicalBytesEqual(canonicalDocument(source), canonicalDocument(expectedValue))) {
    fail(`MES_ROOT_SOURCE_DERIVATION_MISMATCH:${key}`);
  }
  return canonicalObject(source, `MES_ROOT_SOURCE_INVALID:${key}`);
}

function requirementRows(slices: readonly DataObject[]): readonly EvidenceRequirementV1[] {
  const rows: EvidenceRequirementV1[] = [];
  for (const slice of slices) {
    const sliceId = text(requiredObjectField(slice, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
    const requirements = dataArray(requiredObjectField(slice, 'evidence_requirements', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
    for (const requirementValue of requirements) {
      const requirement = dataObject(requirementValue, 'MES_ROOT_MATRIX_INVALID');
      rows.push({
        id: text(requiredObjectField(requirement, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
        slice_id: sliceId as EvidenceSliceId,
        gate: text(requiredObjectField(requirement, 'gate', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID') as EvidenceGate,
        independence: text(requiredObjectField(requirement, 'independence', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID') as RequirementIndependence,
      });
    }
  }
  if (rows.length !== approvedRequirementRows.length || new Set(rows.map((row) => row.id)).size !== approvedRequirementRows.length) {
    fail('MES_ROOT_REQUIREMENTS_INVALID');
  }
  for (let index = 0; index < approvedRequirementRows.length; index += 1) {
    const row = rows[index];
    const [id, sliceId, gate, independence] = approvedRequirementRows[index];
    if (!row || row.id !== id || row.slice_id !== sliceId || row.gate !== gate || row.independence !== independence) {
      fail('MES_ROOT_REQUIREMENTS_INVALID');
    }
  }
  return rows;
}

function deriveFailureTellDefinitions(tells: readonly DataObject[], matrixIdentity: ContentIdentity): CanonicalJsonValue {
  return {
    schema_version: 'MES-1',
    matrix_identity: matrixIdentity as unknown as CanonicalJsonValue,
    failure_tells: tells.map((tell) => ({
      id: text(requiredObjectField(tell, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
      slice_id: text(requiredObjectField(tell, 'slice_id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
      text: text(requiredObjectField(tell, 'text', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
    })),
  };
}

function deriveNegativeControlDefinitions(controls: readonly DataObject[], matrixIdentity: ContentIdentity): CanonicalJsonValue {
  return {
    schema_version: 'MES-1',
    matrix_identity: matrixIdentity as unknown as CanonicalJsonValue,
    negative_controls: controls.map((control) => ({
      id: text(requiredObjectField(control, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
      applicable_slice_ids: requiredObjectField(control, 'applicable_slice_ids', 'MES_ROOT_MATRIX_INVALID') as CanonicalJsonValue,
      requirement_links: requiredObjectField(control, 'requirement_links', 'MES_ROOT_MATRIX_INVALID') as CanonicalJsonValue,
      probe: text(requiredObjectField(control, 'probe', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
      expected_outcome: text(requiredObjectField(control, 'expected', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
    })),
  };
}

function deriveFailureTellLinks(tells: readonly DataObject[], slices: readonly DataObject[]): readonly FailureTellLinkV1[] {
  return tells.map((tell) => {
    const failureTellId = text(requiredObjectField(tell, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
    const sliceId = text(requiredObjectField(tell, 'slice_id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
    const slice = slices.find((candidate) => requiredObjectField(candidate, 'id', 'MES_ROOT_MATRIX_INVALID') === sliceId);
    if (!slice) fail(`MES_ROOT_FAILURE_TELL_SLICE_MISSING:${failureTellId}`);
    const requiredGates = stringArray(requiredObjectField(slice, 'required_gates', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
    const requirements = dataArray(requiredObjectField(slice, 'evidence_requirements', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID')
      .map((requirement) => dataObject(requirement, 'MES_ROOT_MATRIX_INVALID'));
    return {
      failure_tell_id: failureTellId,
      slice_id: sliceId as EvidenceSliceId,
      links: requiredGates.map((gate) => ({
        gate: gate as EvidenceGate,
        requirement_ids: (() => {
          const ids = requirements
          .filter((requirement) => requiredObjectField(requirement, 'gate', 'MES_ROOT_MATRIX_INVALID') === gate)
          .map((requirement) => text(requiredObjectField(requirement, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'));
          if (ids.length === 0) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
          return ids;
        })(),
      })),
    };
  });
}

function conditionalClaim(
  slices: readonly DataObject[],
  matrixIdentity: ContentIdentity,
  claimId: ConditionalClaimIdV1,
  sliceId: 'N1' | 'N2' | 'N10',
  requirementId: 'N1-L1' | 'N2-L1' | 'N10-L1',
): ConditionalClaimV1 {
  const slice = slices.find((candidate) => requiredObjectField(candidate, 'id', 'MES_ROOT_MATRIX_INVALID') === sliceId);
  if (!slice) fail(`MES_ROOT_CONDITIONAL_SLICE_MISSING:${sliceId}`);
  const gateRules = dataObject(requiredObjectField(slice, 'conditional_gates', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
  const gateRule = text(requiredObjectField(gateRules, 'L', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
  const requirements = dataArray(requiredObjectField(slice, 'evidence_requirements', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID')
    .map((requirement) => dataObject(requirement, 'MES_ROOT_MATRIX_INVALID'));
  const requirement = requirements.find((candidate) => requiredObjectField(candidate, 'id', 'MES_ROOT_MATRIX_INVALID') === requirementId);
  if (!requirement) fail(`MES_ROOT_CONDITIONAL_REQUIREMENT_MISSING:${requirementId}`);
  return {
    claim_id: claimId,
    matrix_identity: matrixIdentity,
    slice_id: sliceId,
    gate: 'L',
    requirement_id: requirementId,
    gate_rule: gateRule,
    condition: text(requiredObjectField(requirement, 'condition', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'),
  };
}

function deriveConditionalClaims(
  slices: readonly DataObject[],
  matrixIdentity: ContentIdentity,
): readonly ConditionalClaimV1[] {
  return approvedConditionalClaims.map(([claimId, sliceId, requirementId, gateRule, condition]) => {
    const claim = conditionalClaim(
      slices,
      matrixIdentity,
      claimId as ConditionalClaimIdV1,
      sliceId as 'N1' | 'N2' | 'N10',
      requirementId as 'N1-L1' | 'N2-L1' | 'N10-L1',
    );
    if (claim.gate !== 'L' || claim.gate_rule !== gateRule || claim.condition !== condition) {
      fail('MES_ROOT_CONDITIONAL_CLAIMS_INVALID');
    }
    return claim;
  });
}

function exactStringSet(value: unknown, expected: readonly string[], code: string): readonly string[] {
  const values = stringArray(value, code);
  if (values.length !== new Set(values).size || values.length !== expected.length) fail(code);
  const actual = new Set(values);
  if (expected.some((item) => !actual.has(item))) fail(code);
  return values;
}

function exactConfigurationObject(value: CanonicalJsonValue, keys: readonly string[], code: string): DataObject {
  return exactOwnDataObject(value, keys, code);
}

function validateSuccessorLane(
  value: CanonicalJsonValue,
  slices: readonly DataObject[],
  controls: readonly DataObject[],
): void {
  const lane = exactConfigurationObject(value, [
    'schema_version', 'lane_id', 'blocked_requirement_ids', 'required_negative_control_ids',
    'required_authorization_bindings', 'safeguard_dimensions', 'stop_condition_ids', 'maximum_claim',
  ], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  if (requiredObjectField(lane, 'schema_version', 'MES_ROOT_SUCCESSOR_LANE_INVALID') !== 'MES-1') fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
  if (requiredObjectField(lane, 'lane_id', 'MES_ROOT_SUCCESSOR_LANE_INVALID') !== 'N9_SUCCESSOR_V1') fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
  const maximumClaim = text(requiredObjectField(lane, 'maximum_claim', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  if (!maximumClaim.startsWith('N9_SUCCESSOR_EVIDENCE_CANDIDATE_ONLY')) fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
  const n9 = slices.find((slice) => requiredObjectField(slice, 'id', 'MES_ROOT_MATRIX_INVALID') === 'N9');
  if (!n9) fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
  exactStringSet(requiredObjectField(lane, 'blocked_requirement_ids', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  const requiredControls = exactStringSet(requiredObjectField(lane, 'required_negative_control_ids', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), ['NC-ACCESS', 'NC-DELETE', 'NC-SCOPE', 'NC-SURVEILLANCE'], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  const n9Controls = stringArray(requiredObjectField(n9, 'negative_control_ids', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID');
  for (const id of requiredControls) {
    const control = controls.find((candidate) => requiredObjectField(candidate, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID') === id);
    if (!control) fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
    const applicable = stringArray(requiredObjectField(control, 'applicable_slice_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (!applicable.includes('N9') || !n9Controls.includes(id)) fail('MES_ROOT_SUCCESSOR_LANE_INVALID');
  }
  exactStringSet(requiredObjectField(lane, 'required_authorization_bindings', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), [
    'account_alias_identities', 'allowed_action_ids', 'allowed_file_ids', 'approval_identity', 'deployment_identity',
    'historical_capsule_identity', 'implementation_plan_identity', 'maximum_claim', 'prohibited_action_ids',
    'root_identity', 'stop_condition_ids',
  ], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  exactStringSet(requiredObjectField(lane, 'safeguard_dimensions', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), [
    'accessibility', 'consent', 'contestability', 'deletion', 'fairness', 'human_review', 'privacy',
  ], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
  exactStringSet(requiredObjectField(lane, 'stop_condition_ids', 'MES_ROOT_SUCCESSOR_LANE_INVALID'), [
    'CROSS_ACCOUNT_ACCESS', 'DELETION_RESIDUE', 'SCOPE_BROADENING', 'SURVEILLANCE_REQUIREMENT',
  ], 'MES_ROOT_SUCCESSOR_LANE_INVALID');
}

function validateFirstVerticalJourney(value: CanonicalJsonValue): void {
  const journey = exactConfigurationObject(value, [
    'schema_version', 'journey_id', 'learner_locale', 'distinct_account_roles', 'required_target_identity_kinds',
    'ordered_step_ids', 'immediate_evidence_scopes', 'longitudinal_follow_up',
  ], 'MES_ROOT_FIRST_VERTICAL_INVALID');
  if (requiredObjectField(journey, 'schema_version', 'MES_ROOT_FIRST_VERTICAL_INVALID') !== 'MES-1') fail('MES_ROOT_FIRST_VERTICAL_INVALID');
  text(requiredObjectField(journey, 'journey_id', 'MES_ROOT_FIRST_VERTICAL_INVALID'), 'MES_ROOT_FIRST_VERTICAL_INVALID');
  if (requiredObjectField(journey, 'learner_locale', 'MES_ROOT_FIRST_VERTICAL_INVALID') !== 'ko') fail('MES_ROOT_FIRST_VERTICAL_INVALID');
  exactStringSet(requiredObjectField(journey, 'distinct_account_roles', 'MES_ROOT_FIRST_VERTICAL_INVALID'), ['LEARNER_A', 'LEARNER_B'], 'MES_ROOT_FIRST_VERTICAL_INVALID');
  exactStringSet(requiredObjectField(journey, 'required_target_identity_kinds', 'MES_ROOT_FIRST_VERTICAL_INVALID'), [
    'AI_INVOCATION_ATTEMPT', 'TRAINING_SCENARIO_EVIDENCE', 'TRAINING_SCENARIO_PACK',
  ], 'MES_ROOT_FIRST_VERTICAL_INVALID');
  const steps = stringArray(requiredObjectField(journey, 'ordered_step_ids', 'MES_ROOT_FIRST_VERTICAL_INVALID'), 'MES_ROOT_FIRST_VERTICAL_INVALID');
  // The approved 13-step journey is a lower bound. An identity-refreshed
  // authority source may append a unique revision step, but cannot reorder,
  // collapse, or duplicate the approved first vertical.
  if (steps.length < firstVerticalBaselineSteps.length || steps.length !== new Set(steps).size) fail('MES_ROOT_FIRST_VERTICAL_INVALID');
  for (let index = 0; index < firstVerticalBaselineSteps.length; index += 1) {
    if (steps[index] !== firstVerticalBaselineSteps[index]) fail('MES_ROOT_FIRST_VERTICAL_INVALID');
  }
  exactStringSet(requiredObjectField(journey, 'immediate_evidence_scopes', 'MES_ROOT_FIRST_VERTICAL_INVALID'), [
    'account-isolation', 'context-binding', 'korean-comprehension',
  ], 'MES_ROOT_FIRST_VERTICAL_INVALID');
  if (requiredObjectField(journey, 'longitudinal_follow_up', 'MES_ROOT_FIRST_VERTICAL_INVALID') !== 'SEPARATELY_GATED_AFTER_CONTEXT_CHANGE') fail('MES_ROOT_FIRST_VERTICAL_INVALID');
}

function validateRecordSchemas(value: CanonicalJsonValue): void {
  const schemas = exactConfigurationObject(value, [
    'schema_version', 'common_envelope', 'families', 'artifact_kind_details', 'vocabulary',
  ], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  if (requiredObjectField(schemas, 'schema_version', 'MES_ROOT_RECORD_SCHEMAS_INVALID') !== 'MES-1') fail('MES_ROOT_RECORD_SCHEMAS_INVALID');
  text(requiredObjectField(schemas, 'common_envelope', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  exactStringSet(requiredObjectField(schemas, 'families', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), ['ARTIFACT', 'CORRECTION', 'GRADE', 'NEGATIVE_CONTROL_RESULT'], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  exactStringSet(requiredObjectField(schemas, 'artifact_kind_details', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), [
    'STATIC', 'RUNTIME', 'DEPLOYMENT', 'AUTHENTICATED_E2E', 'LONGITUDINAL', 'ACCESSIBILITY', 'DELETION', 'GRADE_INPUT',
  ], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  const vocabulary = exactOwnDataObject(requiredObjectField(schemas, 'vocabulary', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), ['artifact_statuses', 'grade_verdicts'], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  exactStringSet(requiredObjectField(vocabulary, 'artifact_statuses', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), ['FAIL', 'PASS', 'PENDING', 'UNGRADABLE', 'UNKNOWN'], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
  exactStringSet(requiredObjectField(vocabulary, 'grade_verdicts', 'MES_ROOT_RECORD_SCHEMAS_INVALID'), ['A CLEARLY BETTER', 'B CLEARLY BETTER', 'SAME GRADE', 'UNGRADABLE'], 'MES_ROOT_RECORD_SCHEMAS_INVALID');
}

function validateDeterministicReducer(value: CanonicalJsonValue): void {
  const reducer = exactConfigurationObject(value, [
    'schema_version', 'reducer_id', 'admitted_record_rule', 'active_record_rule', 'status_precedence',
    'pass_prerequisites', 'correction_rule', 'missing_evidence_rule',
  ], 'MES_ROOT_REDUCER_INVALID');
  if (requiredObjectField(reducer, 'schema_version', 'MES_ROOT_REDUCER_INVALID') !== 'MES-1') fail('MES_ROOT_REDUCER_INVALID');
  text(requiredObjectField(reducer, 'reducer_id', 'MES_ROOT_REDUCER_INVALID'), 'MES_ROOT_REDUCER_INVALID');
  const exactRules: Readonly<Record<string, string>> = {
    admitted_record_rule: 'ADMITTED_ACTIVE_RECORDS_ONLY',
    active_record_rule: 'ALL_UNSUPERSEDED_RECORDS_PER_EVIDENCE_KEY',
    correction_rule: 'EXACT_TARGET_AND_ADMITTED_SAME_ROOT_REPLACEMENTS',
    missing_evidence_rule: 'PENDING_OR_UNKNOWN_NEVER_PASS',
  };
  for (const [key, expected] of Object.entries(exactRules)) {
    if (requiredObjectField(reducer, key, 'MES_ROOT_REDUCER_INVALID') !== expected) fail('MES_ROOT_REDUCER_INVALID');
  }
  const precedence = stringArray(requiredObjectField(reducer, 'status_precedence', 'MES_ROOT_REDUCER_INVALID'), 'MES_ROOT_REDUCER_INVALID');
  if (precedence.length !== 6 || precedence.join('\u0000') !== ['BLOCKED_CONTRACT', 'FAIL', 'UNKNOWN', 'UNGRADABLE', 'PENDING', 'PASS'].join('\u0000')) fail('MES_ROOT_REDUCER_INVALID');
  exactStringSet(requiredObjectField(reducer, 'pass_prerequisites', 'MES_ROOT_REDUCER_INVALID'), [
    'ALL_REQUIRED_LINKS_PASS', 'NO_ACTIVE_FAILURE_TELL', 'ALL_LINKED_NEGATIVE_CONTROLS_PASS', 'CONDITIONAL_CLAIM_ASSERTED_WHEN_APPLICABLE',
  ], 'MES_ROOT_REDUCER_INVALID');
}

function validateTask13Configuration(value: CanonicalJsonValue): void {
  const config = exactConfigurationObject(value, [
    'schema_version', 'experiment_id', 'separately_authorized', 'pre_e2e_prerequisite', 'pre_authorization_output', 'prohibited_claims', 'later_execution_contract',
  ], 'MES_ROOT_TASK13_INVALID');
  if (requiredObjectField(config, 'schema_version', 'MES_ROOT_TASK13_INVALID') !== 'MES-1') fail('MES_ROOT_TASK13_INVALID');
  text(requiredObjectField(config, 'experiment_id', 'MES_ROOT_TASK13_INVALID'), 'MES_ROOT_TASK13_INVALID');
  if (requiredObjectField(config, 'separately_authorized', 'MES_ROOT_TASK13_INVALID') !== true || requiredObjectField(config, 'pre_e2e_prerequisite', 'MES_ROOT_TASK13_INVALID') !== false || requiredObjectField(config, 'pre_authorization_output', 'MES_ROOT_TASK13_INVALID') !== 'CONFIGURATION_ONLY') fail('MES_ROOT_TASK13_INVALID');
  exactStringSet(requiredObjectField(config, 'prohibited_claims', 'MES_ROOT_TASK13_INVALID'), ['EXPERIMENT_PASSED', 'FIFTY_PERCENT_REDUCTION_PROVED'], 'MES_ROOT_TASK13_INVALID');
  if (requiredObjectField(config, 'later_execution_contract', 'MES_ROOT_TASK13_INVALID') !== 'EXACT_ROOT_AND_SEPARATE_DIRECT_AUTHORIZATION_REQUIRED') fail('MES_ROOT_TASK13_INVALID');
}

function validateClosureRule(value: CanonicalJsonValue): void {
  const rule = exactConfigurationObject(value, ['schema_version', 'unauthorized_status', 'incomplete_status', 'cleared_status', 'required_conditions'], 'MES_ROOT_CLOSURE_RULE_INVALID');
  if (requiredObjectField(rule, 'schema_version', 'MES_ROOT_CLOSURE_RULE_INVALID') !== 'MES-1' || requiredObjectField(rule, 'unauthorized_status', 'MES_ROOT_CLOSURE_RULE_INVALID') !== 'NOT_EVALUATED' || requiredObjectField(rule, 'incomplete_status', 'MES_ROOT_CLOSURE_RULE_INVALID') !== 'NOT_CLEARED' || requiredObjectField(rule, 'cleared_status', 'MES_ROOT_CLOSURE_RULE_INVALID') !== 'CLEARED') fail('MES_ROOT_CLOSURE_RULE_INVALID');
  const conditions = stringArray(requiredObjectField(rule, 'required_conditions', 'MES_ROOT_CLOSURE_RULE_INVALID'), 'MES_ROOT_CLOSURE_RULE_INVALID');
  if (conditions.length !== new Set(conditions).size) fail('MES_ROOT_CLOSURE_RULE_INVALID');
  for (const required of [
    'ALL_11_SLICES_PASS', 'ALL_64_REQUIREMENTS_PASS', 'N9_NONCOMPENSATORY_PASS',
    'TWO_INDEPENDENT_CROSS_VENDOR_SAME_GRADE', 'MATERIALLY_DIFFERENT_SUPPORTING_REASONS',
    'SEPARATELY_AUTHORIZED_CLOSURE_EVALUATION',
  ]) if (!conditions.includes(required)) fail('MES_ROOT_CLOSURE_RULE_INVALID');
}

function validateMatrixIntegrity(
  slices: readonly DataObject[],
  tells: readonly DataObject[],
  controls: readonly DataObject[],
  requirements: readonly EvidenceRequirementV1[],
): void {
  const sliceById = new Map<string, DataObject>();
  for (const slice of slices) {
    const id = text(requiredObjectField(slice, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (sliceById.has(id)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    sliceById.set(id, slice);
  }
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  if (requirementById.size !== approvedRequirementRows.length) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
  const tellIds = tells.map((tell) => text(requiredObjectField(tell, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID'));
  if (tellIds.length !== approvedFailureTellIds.length || tellIds.some((id, index) => id !== approvedFailureTellIds[index])) {
    fail('MES_ROOT_FAILURE_TELLS_INVALID');
  }
  const controlIds = controls.map((control) => text(requiredObjectField(control, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID'));
  if (controlIds.length !== approvedNegativeControlIds.length || controlIds.some((id, index) => id !== approvedNegativeControlIds[index])) {
    fail('MES_ROOT_NEGATIVE_CONTROLS_INVALID');
  }
  const tellById = new Map<string, DataObject>();
  for (const tell of tells) {
    const id = text(requiredObjectField(tell, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const sliceId = text(requiredObjectField(tell, 'slice_id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (tellById.has(id) || !sliceById.has(sliceId)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    tellById.set(id, tell);
  }
  const controlById = new Map<string, DataObject>();
  for (const control of controls) {
    const id = text(requiredObjectField(control, 'id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (controlById.has(id) || id.startsWith('C1')) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const applicable = stringArray(requiredObjectField(control, 'applicable_slice_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (applicable.length === 0 || applicable.length !== new Set(applicable).size || applicable.some((sliceId) => !sliceById.has(sliceId))) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const links = dataArray(requiredObjectField(control, 'requirement_links', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (links.length === 0) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const linkKeys = new Set<string>();
    for (const linkValue of links) {
      const link = dataObject(linkValue, 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
      const sliceId = text(requiredObjectField(link, 'slice_id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
      const gate = text(requiredObjectField(link, 'gate', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
      const ids = stringArray(requiredObjectField(link, 'evidence_requirement_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
      if (!applicable.includes(sliceId) || ids.length === 0 || ids.length !== new Set(ids).size) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      for (const idValue of ids) {
        const requirement = requirementById.get(idValue);
        if (!requirement || requirement.slice_id !== sliceId || requirement.gate !== gate) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      }
      const key = `${sliceId}\u0000${gate}\u0000${ids.join('\u0000')}`;
      if (linkKeys.has(key)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      linkKeys.add(key);
    }
    controlById.set(id, control);
  }
  for (const [sliceId, slice] of sliceById) {
    const gateStatus = dataObject(requiredObjectField(slice, 'gate_status', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const requiredGates = stringArray(requiredObjectField(slice, 'required_gates', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const expectedStatusGates = gateStatusKeysBySlice[sliceId as EvidenceSliceId];
    const actualStatusGates = Object.getOwnPropertyNames(gateStatus);
    if (!expectedStatusGates || actualStatusGates.length !== expectedStatusGates.length || actualStatusGates.some((gate) => !expectedStatusGates.includes(gate as EvidenceGate))) {
      fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
    for (const gate of expectedStatusGates) {
      const status = requiredObjectField(gateStatus, gate, 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
      if (typeof status !== 'string' || !gateStatuses.includes(status as typeof gateStatuses[number])) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
    if (sliceId === 'N9') {
      if (requiredObjectField(gateStatus, 'D', 'MES_ROOT_MATRIX_INTEGRITY_INVALID') !== 'PENDING') fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      for (const gate of ['S', 'R', 'P', 'A', 'L']) {
        if (requiredObjectField(gateStatus, gate, 'MES_ROOT_MATRIX_INTEGRITY_INVALID') !== 'BLOCKED_CONTRACT') fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      }
    }
    if (requiredGates.length === 0 || requiredGates.length !== new Set(requiredGates).size || requiredGates.some((gate) => !evidenceGates.includes(gate as EvidenceGate))) {
      fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
    const failureTellIds = stringArray(requiredObjectField(slice, 'failure_tell_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const negativeControlIds = stringArray(requiredObjectField(slice, 'negative_control_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    if (failureTellIds.length !== new Set(failureTellIds).size || negativeControlIds.length !== new Set(negativeControlIds).size) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    for (const tellId of failureTellIds) {
      const tell = tellById.get(tellId);
      if (!tell || requiredObjectField(tell, 'slice_id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID') !== sliceId) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
    for (const controlId of negativeControlIds) {
      const control = controlById.get(controlId);
      if (!control || !stringArray(requiredObjectField(control, 'applicable_slice_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID').includes(sliceId)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
    for (const gate of requiredGates) {
      if (!requirements.some((candidate) => candidate.slice_id === sliceId && candidate.gate === gate)) {
        fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
      }
    }
    for (const requirement of requirements.filter((candidate) => candidate.slice_id === sliceId)) {
      if (requiredObjectField(gateStatus, requirement.gate, 'MES_ROOT_MATRIX_INTEGRITY_INVALID') === undefined) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
  }
  for (const [tellId, tell] of tellById) {
    const sliceId = text(requiredObjectField(tell, 'slice_id', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID');
    const slice = sliceById.get(sliceId);
    if (!slice || !stringArray(requiredObjectField(slice, 'failure_tell_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID').includes(tellId)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
  }
  for (const [controlId, control] of controlById) {
    for (const sliceId of stringArray(requiredObjectField(control, 'applicable_slice_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID')) {
      const slice = sliceById.get(sliceId);
      if (!slice || !stringArray(requiredObjectField(slice, 'negative_control_ids', 'MES_ROOT_MATRIX_INTEGRITY_INVALID'), 'MES_ROOT_MATRIX_INTEGRITY_INVALID').includes(controlId)) fail('MES_ROOT_MATRIX_INTEGRITY_INVALID');
    }
  }
}

export async function loadEvidenceSpineRoot(
  sources: RootSourceBytes,
  expected: ExpectedRootIdentities,
): Promise<Readonly<{ root: EvidenceSpineRootV1; identity: ContentIdentity }>> {
  // Snapshot the complete closed inputs synchronously. No source byte or expected
  // identity access is permitted after the first digest await.
  const sourceBytes = snapshotRootSources(sources);
  const expectedIdentities = snapshotExpectedIdentities(expected);
  const identities = {} as Record<RootSourceKey, ContentIdentity>;

  // The complete identity pass intentionally happens before any source is parsed.
  for (const key of rootSourceKeys) {
    const actual = await contentIdentity(sourceBytes[key]);
    if (!identityEqual(actual, expectedIdentities[key])) {
      fail(`MES_ROOT_SOURCE_IDENTITY_MISMATCH:${key}`);
    }
    identities[key] = actual;
  }

  const matrix = parseMatrix(sourceBytes.matrix);
  const slices = matrixSlices(matrix);
  const sliceIds = slices.map((slice) => text(requiredObjectField(slice, 'id', 'MES_ROOT_MATRIX_INVALID'), 'MES_ROOT_MATRIX_INVALID'));
  if (sliceIds.length !== expectedSliceIds.length || sliceIds.some((id, index) => id !== expectedSliceIds[index])) {
    fail('MES_ROOT_SLICES_INVALID');
  }
  const requirements = requirementRows(slices);
  const tells = matrixFailureTells(matrix);
  if (tells.length !== 67) fail('MES_ROOT_FAILURE_TELLS_INVALID');
  const controls = matrixNegativeControls(matrix);
  if (controls.length !== 15) fail('MES_ROOT_NEGATIVE_CONTROLS_INVALID');
  validateMatrixIntegrity(slices, tells, controls, requirements);

  const failureTellDefinitions = canonicalSource(sourceBytes.failureTellDefinitions, 'failureTellDefinitions');
  const negativeControlDefinitions = canonicalSource(sourceBytes.negativeControlDefinitions, 'negativeControlDefinitions');
  const successorLane = canonicalSource(sourceBytes.successorLaneDefinition, 'successorLaneDefinition');
  const firstVerticalJourney = canonicalSource(sourceBytes.firstVerticalJourney, 'firstVerticalJourney');
  const recordSchemas = canonicalSource(sourceBytes.recordSchemas, 'recordSchemas');
  const deterministicReducer = canonicalSource(sourceBytes.deterministicReducer, 'deterministicReducer');
  const task13Experiment = canonicalSource(sourceBytes.task13Experiment, 'task13Experiment');
  const closureRule = canonicalSource(sourceBytes.closureRule, 'closureRule');
  const n9SuccessorPolicySource = canonicalSource(sourceBytes.n9SuccessorPolicy, 'n9SuccessorPolicy');

  const derivedFailureTells = deriveFailureTellDefinitions(tells, identities.matrix);
  const derivedControls = deriveNegativeControlDefinitions(controls, identities.matrix);
  const failureTellDefinitionsObject = assertDerivedSource(failureTellDefinitions, derivedFailureTells, 'failureTellDefinitions');
  const negativeControlDefinitionsObject = assertDerivedSource(negativeControlDefinitions, derivedControls, 'negativeControlDefinitions');
  const failureTellValues = canonicalField(failureTellDefinitionsObject, 'failure_tells', 'MES_ROOT_SOURCE_INVALID:failureTellDefinitions');
  const negativeControlValues = canonicalField(negativeControlDefinitionsObject, 'negative_controls', 'MES_ROOT_SOURCE_INVALID:negativeControlDefinitions');
  validateSuccessorLane(successorLane, slices, controls);
  validateFirstVerticalJourney(firstVerticalJourney);
  validateRecordSchemas(recordSchemas);
  validateDeterministicReducer(deterministicReducer);
  validateTask13Configuration(task13Experiment);
  validateClosureRule(closureRule);
  const n9SuccessorPolicy = await validateN9SuccessorPolicyAtRoot(
    n9SuccessorPolicySource,
    identities.n9SuccessorPolicy,
    identities.implementationPlan,
    identities.historicalTask4Capsule,
  );

  const sourceIdentities: RootSourceIdentitiesV1 = {
    specification: identities.specification,
    implementation_plan: identities.implementationPlan,
    matrix: identities.matrix,
    answer_key: identities.answerKey,
    historical_task4_capsule: identities.historicalTask4Capsule,
    failure_tell_definitions: identities.failureTellDefinitions,
    negative_control_definitions: identities.negativeControlDefinitions,
    successor_lane_definition: identities.successorLaneDefinition,
    first_vertical_journey: identities.firstVerticalJourney,
    record_schemas: identities.recordSchemas,
    deterministic_reducer: identities.deterministicReducer,
    task13_experiment: identities.task13Experiment,
    closure_rule: identities.closureRule,
    n9_successor_policy: identities.n9SuccessorPolicy,
  };

  const root: EvidenceSpineRootV1 = {
    schema_version: 'MES-1',
    source_identities: sourceIdentities,
    slice_ids: sliceIds as EvidenceSliceId[],
    requirements,
    failure_tell_definitions: failureTellValues as unknown as readonly FailureTellDefinitionV1[],
    failure_tell_links: deriveFailureTellLinks(tells, slices),
    negative_controls: negativeControlValues as unknown as readonly NegativeControlDefinitionV1[],
    conditional_claims: deriveConditionalClaims(slices, identities.matrix),
    successor_lane: successorLane as unknown as SuccessorLaneDefinitionV1,
    first_vertical_journey: firstVerticalJourney as unknown as FirstVerticalJourneyDefinitionV1,
    record_schemas: recordSchemas as unknown as RecordSchemasDefinitionV1,
    deterministic_reducer: deterministicReducer as unknown as DeterministicReducerDefinitionV1,
    task13_experiment: task13Experiment as unknown as Task13ExperimentDefinitionV1,
    closure_rule: closureRule as unknown as ClosureRuleDefinitionV1,
    n9_successor_policy: n9SuccessorPolicy,
  };
  const frozenRoot = deepFreeze(root);
  const identity = deepFreeze(await contentIdentity(canonicalDocument(frozenRoot as unknown as CanonicalJsonValue)));
  return deepFreeze({ root: frozenRoot, identity });
}
