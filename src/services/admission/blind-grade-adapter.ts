import { Buffer } from 'node:buffer';
import { canonicalDocument, parseAuthorityJson, type CanonicalJsonValue } from './canonical-json';
import { type DetachedRecordCandidate, verifyManifestPrefixCarrier } from './evidence-spine-manifest';
import { validateEvidenceRecord } from './evidence-spine-validation';
import {
  type EvidenceSpineRootV1,
  type ExternalBlindMappingCommitmentCarrierV1,
  type ExternalBrandingAssessmentCarrierV1,
  type FrozenBlindGradePacketV1,
  type PreparedBlindGradeCandidateV1,
  type VerifiedActiveGradeInputCarrierV1,
  type VerifiedGradeOutputCarrierV1,
  type VerifiedGradeRubricCarrierV1,
  type VerifiedManifestPrefixCarrierV1,
} from './evidence-spine-types';
import { contentIdentity, recordSha256, type ContentIdentity } from './identity';
import {
  nonPassing,
  type NonPassingObservation,
  type ReceiptResolution,
  verifyIntegrationReceiptResolutionCarrier,
} from './product-receipts';

type Obj = Record<string, unknown>;
type MaterialFact = Readonly<{
  carrier: Obj;
  candidate: DetachedRecordCandidate;
  target: Obj;
  targetIdentity: ContentIdentity;
  subject: ContentIdentity;
  account: ContentIdentity;
  descriptor: Obj;
  descriptorIdentity: ContentIdentity;
  preimage: Obj;
  preimageIdentity: ContentIdentity;
  graderMaterial: Obj;
  redacted: Obj;
}>;
type BaseFacts = Readonly<{
  root: Obj;
  rootIdentity: ContentIdentity;
  prefix: Awaited<ReturnType<typeof verifyManifestPrefixCarrier>> & {};
  one: MaterialFact;
  two: MaterialFact;
  materialSetIdentity: ContentIdentity;
}>;
type PacketFacts = Readonly<{
  packet: Obj;
  packetBytes: Uint8Array;
  packetIdentity: ContentIdentity;
  rubric: Obj;
}>;

const canonical = (value: CanonicalJsonValue): Uint8Array => canonicalDocument(value);
const encoder = new TextEncoder();
const LINK_FIELD = 'routeManifestIdentity';
const ID_KEYS = ['byte_length', 'sha256'] as const;
const GRADE_REASONS = [
  'EVIDENCE_PARITY', 'INTERACTION_PARITY', 'ACCESSIBILITY_PARITY', 'PRIVACY_PARITY',
  'DELETION_PARITY', 'PROVENANCE_PARITY', 'ISOLATION_PARITY',
  'KOREAN_COMPREHENSION_PARITY', 'TRUTHFUL_DEGRADATION_PARITY', 'DIMENSION_UNASSESSABLE',
] as const;
const VERDICTS = ['SAME GRADE', 'A CLEARLY BETTER', 'B CLEARLY BETTER', 'UNGRADABLE'] as const;
const FORBIDDEN = [
  'builder_identity', 'builder_vendor_family', 'builder_report', 'reviewer_identity',
  'reviewer_vendor_family', 'account_identity', 'raw_learner_content', 'plaintext_hash',
  'nonce', 'candidate', 'slot_1', 'slot_2', 'a clearly better', 'b clearly better',
];
const FORBIDDEN_MARKDOWN = [
  ...FORBIDDEN,
  'builder identity', 'builder vendor family', 'builder report', 'builder narrative',
  'reviewer identity', 'reviewer vendor family', 'account identity',
  'raw learner content', 'plaintext hash', 'private canary', 'private_canary',
  'unlicensed branding', 'unlicensed-branding',
];

class Fault extends Error {
  constructor(readonly reason: NonPassingObservation['reason']) {
    super(reason);
  }
}

function fault(reason: NonPassingObservation['reason']): never {
  throw new Fault(reason);
}

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return left.byte_length === right.byte_length && left.sha256 === right.sha256;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function utf8Order(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(utf8Order);
}

function sortedRefs(values: readonly Obj[]): Obj[] {
  const unique: Obj[] = [];
  for (const value of values) {
    if (!unique.some((known) => refKey(known) === refKey(value))) unique.push(value);
  }
  return unique.sort((left, right) => utf8Order(refKey(left), refKey(right)));
}

function refKey(value: Obj): string {
  return `${value.receipt_kind as string}\0${value.receipt_id as string}`;
}

function exactKeys(value: unknown, keys: readonly string[], reason: NonPassingObservation['reason']): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault(reason);
  const object = value as Obj;
  if (Object.keys(object).length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(object, key))) fault(reason);
  return object;
}

function requireIdentity(value: unknown, reason: NonPassingObservation['reason']): ContentIdentity {
  const object = exactKeys(value, ID_KEYS, reason);
  if (!Number.isSafeInteger(object.byte_length) || (object.byte_length as number) < 0
    || typeof object.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(object.sha256)) fault(reason);
  return Object.freeze({ byte_length: object.byte_length as number, sha256: object.sha256 as string });
}

function approvedAccessor(path: readonly string[]): boolean {
  return (path.length === 2 && path[0] === 'root' && path[1] === 'source_identities')
    || (path.length === 2 && path[0] === 'packet' && path[1] === 'packet')
    || (path.length === 3 && path[0] === 'packet' && path[1] === 'packet' && path[2] === 'rubricCarrier');
}

function approvedOwnKeys(path: readonly string[]): readonly string[] | undefined {
  if (path.length === 1 && path[0] === 'root') return [
    'schema_version', 'source_identities', 'slice_ids', 'requirements', 'failure_tell_definitions', 'failure_tell_links',
    'negative_controls', 'conditional_claims', 'successor_lane', 'first_vertical_journey', 'record_schemas',
    'deterministic_reducer', 'task13_experiment', 'closure_rule', 'n9_successor_policy',
  ];
  if (path.length === 2 && path[0] === 'root' && path[1] === 'source_identities') return [
    'specification', 'implementation_plan', 'matrix', 'answer_key', 'historical_task4_capsule',
    'failure_tell_definitions', 'negative_control_definitions', 'successor_lane_definition', 'first_vertical_journey',
    'record_schemas', 'deterministic_reducer', 'task13_experiment', 'closure_rule', 'n9_successor_policy',
  ];
  if (path.length === 1 && path[0] === 'prefix') return ['carrierBytes', 'carrierIdentity', 'prefix'];
  if (path.length === 1 && path[0] === 'rubric') return [
    'schemaVersion', 'rootIdentity', 'matrixBytesBase64', 'matrixIdentity', 'answerKeyBytesBase64', 'answerKeyIdentity',
    'rubricBytesBase64', 'rubricIdentity', 'viewportProfileBytesBase64', 'viewportProfileIdentity',
    'contextProfileBytesBase64', 'contextProfileIdentity',
  ];
  if (path.length === 1 && path[0] === 'policyIdentity') return ['byte_length', 'sha256'];
  if (path.length === 1 && (path[0] === 'materialOne' || path[0] === 'materialTwo')) return [
    'schemaVersion', 'rootIdentity', 'prefixCarrierIdentity', 'manifestHeadIdentity',
    'gradeInputArtifactBytesBase64', 'gradeInputArtifactIdentity', 'targetReceiptCarrierBytesBase64',
    'targetReceiptCarrierIdentity', 'statePreimageBytesBase64', 'statePreimageIdentity',
    'stateDescriptorBytesBase64', 'stateDescriptorIdentity', 'graderMaterialBytesBase64', 'graderMaterialIdentity',
  ];
  if (path.length === 1 && path[0] === 'mapping') return ['schemaVersion', 'rootIdentity', 'commitmentBytesBase64', 'commitmentIdentity'];
  if (path.length === 1 && path[0] === 'branding') return [
    'schemaVersion', 'rootIdentity', 'assessmentBytesBase64', 'assessmentIdentity', 'disclosureReceiptBytesBase64', 'disclosureReceiptIdentity',
  ];
  if (path.length === 1 && path[0] === 'packet') return ['packet', 'packetBytes', 'packetIdentity'];
  if (path.length === 2 && path[0] === 'packet' && path[1] === 'packet') return [
    'schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'stateDescriptorIdentity', 'gradeMaterialSetIdentity',
    'matrixIdentity', 'answerKeyIdentity', 'rubricIdentity', 'rubricCarrier', 'sanitizationPolicyIdentity',
    'brandingAssessmentIdentity', 'mappingCommitmentIdentity', 'items',
  ];
  if (path.length === 3 && path[0] === 'packet' && path[1] === 'packet' && path[2] === 'rubricCarrier') return [
    'schemaVersion', 'rootIdentity', 'matrixBytesBase64', 'matrixIdentity', 'answerKeyBytesBase64', 'answerKeyIdentity',
    'rubricBytesBase64', 'rubricIdentity', 'viewportProfileBytesBase64', 'viewportProfileIdentity',
    'contextProfileBytesBase64', 'contextProfileIdentity',
  ];
  if (path.length === 1 && path[0] === 'output') return ['carrierBytes', 'carrierIdentity'];
  return undefined;
}

function exactApprovedOwnKeys(keys: readonly PropertyKey[], path: readonly string[]): void {
  const expected = approvedOwnKeys(path);
  if (expected && (keys.length !== expected.length || !expected.every((key) => keys.includes(key)))) {
    fault(path[0] === 'rubric' || path[0] === 'packet' ? 'CONTENT_MISMATCH' : 'AUTHORITY_MISSING');
  }
}

function sameOwnKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function cloneMember(value: object, key: string, descriptor: PropertyDescriptor, path: readonly string[], keys: readonly PropertyKey[]): unknown {
  if (!descriptor.enumerable) fault('AUTHORITY_MISSING');
  const memberPath = [...path, key];
  if ('value' in descriptor) {
    if (!Object.is(Reflect.get(value, key), descriptor.value)) fault('AUTHORITY_MISSING');
    return cloneValue(descriptor.value, memberPath);
  }
  if (!approvedAccessor(memberPath) || typeof descriptor.get !== 'function' || descriptor.set !== undefined) fault('AUTHORITY_MISSING');
  const detached = cloneValue(descriptor.get.call(value), memberPath);
  if (!sameOwnKeys(keys, Reflect.ownKeys(value))) fault('AUTHORITY_MISSING');
  return detached;
}

function cloneValue(value: unknown, path: readonly string[] = []): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fault('AUTHORITY_MISSING');
    return value;
  }
  if (value instanceof Uint8Array) {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype) fault('AUTHORITY_MISSING');
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fault('AUTHORITY_MISSING');
    const keys = Reflect.ownKeys(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || keys.length !== length.value + 1 || !keys.includes('length')) fault('AUTHORITY_MISSING');
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) fault('AUTHORITY_MISSING');
      copy.push(cloneMember(value, String(index), descriptor, path, keys));
    }
    return copy;
  }
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fault('AUTHORITY_MISSING');
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fault('AUTHORITY_MISSING');
  exactApprovedOwnKeys(keys, path);
  const copy: Obj = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) fault('AUTHORITY_MISSING');
    copy[key] = cloneMember(value, key, descriptor, path, keys);
  }
  return copy;
}

function frozen<T>(value: T): T {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value as Obj)) frozen(item);
  return Object.freeze(value);
}

function b64(value: unknown, reason: NonPassingObservation['reason']): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) fault(reason);
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.byteLength === 0 || Buffer.from(bytes).toString('base64') !== value) fault(reason);
  return bytes;
}

function base64Reason(key: string): NonPassingObservation['reason'] {
  if (key === 'gradeInputArtifactBytesBase64') return 'MISSING_SOURCE';
  if (key === 'targetReceiptCarrierBytesBase64') return 'TARGET_MISMATCH';
  if (key === 'redactedMaterialBytesBase64') return 'PRIVACY_BOUNDARY';
  return 'CONTENT_MISMATCH';
}

function strictDecodeBase64Graph(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) strictDecodeBase64Graph(item, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Obj)) {
    if (key.endsWith('BytesBase64')) {
      const bytes = b64(item, base64Reason(key));
      try {
        strictDecodeBase64Graph(parseAuthorityJson(bytes), seen);
      } catch (error) {
        if (error instanceof Fault) throw error;
        // A base64 field may carry raw matrix or Markdown bytes; decoding is the required boundary.
      }
    } else {
      strictDecodeBase64Graph(item, seen);
    }
  }
}

async function paired(bytes: Uint8Array, identity: unknown, reason: NonPassingObservation['reason']): Promise<ContentIdentity> {
  const expected = requireIdentity(identity, reason);
  const actual = await contentIdentity(bytes);
  if (!sameIdentity(actual, expected)) fault(reason);
  return expected;
}

function parse(bytes: Uint8Array, reason: NonPassingObservation['reason']): Obj {
  try {
    const value = parseAuthorityJson(bytes);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !sameBytes(canonical(value), bytes)) fault(reason);
    return value as Obj;
  } catch (error) {
    if (error instanceof Fault) throw error;
    fault(reason);
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return sameBytes(canonical(left as CanonicalJsonValue), canonical(right as CanonicalJsonValue));
  } catch {
    return false;
  }
}

function text(value: unknown, reason: NonPassingObservation['reason'], markdown = false): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)) fault(reason);
  if (markdown && (!value.endsWith('\n') || value.includes('\r') || value.charCodeAt(0) === 0xFEFF)) fault(reason);
  return value;
}

function privateMarkdown(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const lower = value.toLocaleLowerCase('en-US');
  return FORBIDDEN_MARKDOWN.some((marker) => lower.includes(marker));
}

function printable(value: unknown, reason: NonPassingObservation['reason']): string {
  const result = text(value, reason);
  if (!/^[\x20-\x7E]+$/u.test(result) || result === 'UNKNOWN') fault(reason);
  return result;
}

function identityArray(value: unknown, reason: NonPassingObservation['reason']): ContentIdentity[] {
  if (!Array.isArray(value)) fault(reason);
  return value.map((item) => requireIdentity(item, reason));
}

function stringSet(value: unknown, reason: NonPassingObservation['reason'], nonempty = false): string[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fault(reason);
  const items = value.map((item) => text(item, reason));
  if (!equalJson(items, sortedUnique(items))) fault(reason);
  return items;
}

function ref(value: unknown, reason: NonPassingObservation['reason']): Obj {
  const item = exactKeys(value, ['receipt_kind', 'receipt_id', 'content_identity'], reason);
  if (typeof item.receipt_kind !== 'string' || typeof item.receipt_id !== 'string' || item.receipt_kind.length === 0 || item.receipt_id.length === 0) fault(reason);
  requireIdentity(item.content_identity, reason);
  return item;
}

function contentAt(root: Obj, key: string, reason: NonPassingObservation['reason']): ContentIdentity {
  const sources = root.source_identities;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) fault(reason);
  return requireIdentity((sources as Obj)[key], reason);
}

function snapshotBuild(
  root: EvidenceSpineRootV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  rubric: VerifiedGradeRubricCarrierV1,
  policyBytes: Uint8Array,
  policyIdentity: ContentIdentity,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
  mapping: ExternalBlindMappingCommitmentCarrierV1,
  branding: ExternalBrandingAssessmentCarrierV1,
): readonly [Obj, Obj, Obj, Uint8Array, Obj, Obj, Obj, Obj, Obj] {
  return frozen([
    cloneValue(root, ['root']) as Obj, cloneValue(prefix, ['prefix']) as Obj, cloneValue(rubric, ['rubric']) as Obj,
    cloneValue(policyBytes, ['policyBytes']) as Uint8Array, cloneValue(policyIdentity, ['policyIdentity']) as Obj,
    cloneValue(materialOne, ['materialOne']) as Obj, cloneValue(materialTwo, ['materialTwo']) as Obj,
    cloneValue(mapping, ['mapping']) as Obj, cloneValue(branding, ['branding']) as Obj,
  ]);
}

function snapshotCandidate(
  root: EvidenceSpineRootV1,
  packet: FrozenBlindGradePacketV1,
  output: VerifiedGradeOutputCarrierV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
): readonly [Obj, Obj, Obj, Obj, Obj, Obj] {
  return frozen([
    cloneValue(root, ['root']) as Obj, cloneValue(packet, ['packet']) as Obj, cloneValue(output, ['output']) as Obj,
    cloneValue(prefix, ['prefix']) as Obj, cloneValue(materialOne, ['materialOne']) as Obj, cloneValue(materialTwo, ['materialTwo']) as Obj,
  ]);
}

async function prefixFacts(root: Obj, prefix: Obj, one: Obj, two: Obj): Promise<Readonly<{ rootIdentity: ContentIdentity; prefix: NonNullable<Awaited<ReturnType<typeof verifyManifestPrefixCarrier>>> }>> {
  exactKeys(prefix, ['carrierBytes', 'carrierIdentity', 'prefix'], 'CONTENT_MISMATCH');
  const rootIdentity = await contentIdentity(canonical(root as CanonicalJsonValue));
  const oneHead = requireIdentity(one.manifestHeadIdentity, 'MISSING_SOURCE');
  const twoHead = requireIdentity(two.manifestHeadIdentity, 'MISSING_SOURCE');
  if (!sameIdentity(oneHead, twoHead)) fault('MISSING_SOURCE');
  const bytes = prefix.carrierBytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) fault('CONTENT_MISMATCH');
  const verified = await verifyManifestPrefixCarrier(rootIdentity, oneHead, new Uint8Array(bytes), requireIdentity(prefix.carrierIdentity, 'CONTENT_MISMATCH'));
  if (!verified) fault('CONTENT_MISMATCH');
  return frozen({ rootIdentity, prefix: verified });
}

function active(prefix: BaseFacts['prefix'], identity: ContentIdentity): boolean {
  const entry = prefix.prefix.entries.find((item) => item.candidate_identity !== null && sameIdentity(item.candidate_identity, identity));
  if (!entry || entry.disposition !== 'ADMITTED') return false;
  return !Object.values(prefix.prefix.records_by_identity).some((record) => {
    if (record.record_family !== 'CORRECTION') return false;
    const payload = record.payload as unknown as Obj;
    return payload.target_record_identity !== undefined && sameIdentity(requireIdentity(payload.target_record_identity, 'MISSING_SOURCE'), identity);
  });
}

function artifactCandidate(bytes: Uint8Array, identity: ContentIdentity, rootIdentity: ContentIdentity): DetachedRecordCandidate {
  const parsed = parse(bytes, 'MISSING_SOURCE');
  let record;
  try {
    record = validateEvidenceRecord(parsed);
  } catch {
    fault('MISSING_SOURCE');
  }
  if (record.record_family !== 'ARTIFACT' || !sameIdentity(record.root_identity, rootIdentity)
    || (record.payload as unknown as Obj).kind !== 'GRADE_INPUT') fault('MISSING_SOURCE');
  return frozen({ record, canonical_bytes: new Uint8Array(bytes), record_identity: identity });
}

function member(record: Obj, key: string, reason: NonPassingObservation['reason']): Obj {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault(reason);
  return value as Obj;
}

function targetFrom(resolutions: readonly ReceiptResolution[], record: Obj, root: Obj, rootIdentity: ContentIdentity): Readonly<{ target: Obj; subject: ContentIdentity; account: ContentIdentity }> {
  const settled = resolutions.filter((value): value is Extract<ReceiptResolution, { status: 'RESOLVED' }> => value.status === 'RESOLVED');
  if (settled.length !== 3) fault('TARGET_MISMATCH');
  const get = (kind: string): Extract<ReceiptResolution, { status: 'RESOLVED' }> => {
    const items = settled.filter((item) => item.ref.receipt_kind === kind);
    if (items.length !== 1) fault('TARGET_MISMATCH');
    return items[0]!;
  };
  const build = get('BUILD');
  const deployment = get('DEPLOYMENT');
  const control = get('CONTROL_PLANE');
  const buildCausal = member(build.payload as Obj, 'causal', 'TARGET_MISMATCH');
  const deployCausal = member(deployment.payload as Obj, 'causal', 'TARGET_MISMATCH');
  const controlCausal = member(control.payload as Obj, 'causal', 'TARGET_MISMATCH');
  const buildIdentity = requireIdentity(buildCausal.buildIdentity, 'TARGET_MISMATCH');
  if (!sameIdentity(buildIdentity, requireIdentity(deployCausal.buildIdentity, 'TARGET_MISMATCH'))) fault('TARGET_MISMATCH');
  const deploymentIdentity = requireIdentity(deployCausal.deploymentIdentity, 'TARGET_MISMATCH');
  if (!sameIdentity(deploymentIdentity, requireIdentity(controlCausal.deploymentIdentity, 'TARGET_MISMATCH'))) fault('TARGET_MISMATCH');
  const controlIdentity = requireIdentity(controlCausal.controlPlaneIdentity, 'TARGET_MISMATCH');
  const payload = member(record, 'payload', 'TARGET_MISMATCH');
  const bindings = member(payload, 'bindings', 'TARGET_MISMATCH');
  const scope = member(payload, 'scope', 'TARGET_MISMATCH');
  if (!sameIdentity(buildIdentity, requireIdentity(bindings.build_identity, 'TARGET_MISMATCH'))
    || !sameIdentity(deploymentIdentity, requireIdentity(bindings.deployment_identity, 'TARGET_MISMATCH'))
    || !sameIdentity(controlIdentity, requireIdentity(bindings.capture_environment_identity, 'TARGET_MISMATCH'))
    || !sameIdentity(controlIdentity, requireIdentity(scope.environment_identity, 'TARGET_MISMATCH'))
    || !sameIdentity(build.subjectIdentity, deployment.subjectIdentity)
    || !sameIdentity(build.subjectIdentity, control.subjectIdentity)
    || !sameIdentity(requireIdentity((build.payload as Obj).accountScopeIdentity, 'TARGET_MISMATCH'), requireIdentity((deployment.payload as Obj).accountScopeIdentity, 'TARGET_MISMATCH'))
    || !sameIdentity(requireIdentity((build.payload as Obj).accountScopeIdentity, 'TARGET_MISMATCH'), requireIdentity((control.payload as Obj).accountScopeIdentity, 'TARGET_MISMATCH'))) fault('TARGET_MISMATCH');
  const target: Obj = {
    rootIdentity,
    implementationPlanIdentity: contentAt(root, 'implementation_plan', 'TARGET_MISMATCH'),
    buildIdentity,
    deploymentIdentity,
    [LINK_FIELD]: requireIdentity(controlCausal[LINK_FIELD], 'TARGET_MISMATCH'),
    controlPlaneIdentity: controlIdentity,
    supportingReceiptRefs: sortedRefs([build.ref as unknown as Obj, control.ref as unknown as Obj, deployment.ref as unknown as Obj]),
  };
  return frozen({ target, subject: build.subjectIdentity, account: requireIdentity((build.payload as Obj).accountScopeIdentity, 'TARGET_MISMATCH') });
}

async function materialFact(root: Obj, rootIdentity: ContentIdentity, prefix: BaseFacts['prefix'], value: Obj): Promise<MaterialFact> {
  exactKeys(value, [
    'schemaVersion', 'rootIdentity', 'prefixCarrierIdentity', 'manifestHeadIdentity',
    'gradeInputArtifactBytesBase64', 'gradeInputArtifactIdentity', 'targetReceiptCarrierBytesBase64',
    'targetReceiptCarrierIdentity', 'statePreimageBytesBase64', 'statePreimageIdentity',
    'stateDescriptorBytesBase64', 'stateDescriptorIdentity', 'graderMaterialBytesBase64', 'graderMaterialIdentity',
  ], 'CONTENT_MISMATCH');
  if (value.schemaVersion !== 'MES-VERIFIED-GRADE-INPUT-1' || !sameIdentity(requireIdentity(value.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(value.prefixCarrierIdentity, 'CONTENT_MISMATCH'), prefix.carrierIdentity)) fault('CONTENT_MISMATCH');
  const artifactBytes = b64(value.gradeInputArtifactBytesBase64, 'MISSING_SOURCE');
  const artifactIdentity = await paired(artifactBytes, value.gradeInputArtifactIdentity, 'MISSING_SOURCE');
  const candidate = artifactCandidate(artifactBytes, artifactIdentity, rootIdentity);
  if (!active(prefix, artifactIdentity)) fault('MISSING_SOURCE');
  const targetBytes = b64(value.targetReceiptCarrierBytesBase64, 'TARGET_MISMATCH');
  const targetIdentity = await paired(targetBytes, value.targetReceiptCarrierIdentity, 'TARGET_MISMATCH');
  const resolutions = await verifyIntegrationReceiptResolutionCarrier(root as unknown as EvidenceSpineRootV1, candidate, targetBytes, targetIdentity);
  if (!resolutions) fault('TARGET_MISMATCH');
  const rawTarget = targetFrom(resolutions, candidate.record as unknown as Obj, root, rootIdentity);
  const target = rawTarget.target;
  const targetIdentityValue = await contentIdentity(canonical(target as CanonicalJsonValue));
  const preimageBytes = b64(value.statePreimageBytesBase64, 'CONTENT_MISMATCH');
  const preimageIdentity = await paired(preimageBytes, value.statePreimageIdentity, 'CONTENT_MISMATCH');
  const preimage = parse(preimageBytes, 'CONTENT_MISMATCH');
  exactKeys(preimage, ['schemaVersion', 'rootIdentity', 'targetLink', 'evidenceCategoryIds'], 'CONTENT_MISMATCH');
  if (preimage.schemaVersion !== 'MES-GRADE-STATE-PREIMAGE-1' || !sameIdentity(requireIdentity(preimage.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !equalJson(preimage.targetLink, target)) fault('TARGET_MISMATCH');
  const payload = member(candidate.record as unknown as Obj, 'payload', 'CONTENT_MISMATCH');
  const categories = stringSet(preimage.evidenceCategoryIds, 'CONTENT_MISMATCH', true);
  if (!equalJson(categories, stringSet(payload.evidence_requirement_ids, 'CONTENT_MISMATCH', true))) fault('CONTENT_MISMATCH');
  const descriptorBytes = b64(value.stateDescriptorBytesBase64, 'CONTENT_MISMATCH');
  const descriptorIdentity = await paired(descriptorBytes, value.stateDescriptorIdentity, 'CONTENT_MISMATCH');
  const descriptor = parse(descriptorBytes, 'CONTENT_MISMATCH');
  exactKeys(descriptor, ['schemaVersion', 'rootIdentity', 'statePreimageIdentity', 'viewportProfileIdentity', 'contextProfileIdentity', 'targetLinkIdentity'], 'CONTENT_MISMATCH');
  if (descriptor.schemaVersion !== 'MES-GRADE-STATE-DESCRIPTOR-1' || !sameIdentity(requireIdentity(descriptor.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(descriptor.statePreimageIdentity, 'CONTENT_MISMATCH'), preimageIdentity)
    || !sameIdentity(requireIdentity(descriptor.targetLinkIdentity, 'TARGET_MISMATCH'), targetIdentityValue)) fault('CONTENT_MISMATCH');
  const graderBytes = b64(value.graderMaterialBytesBase64, 'CONTENT_MISMATCH');
  await paired(graderBytes, value.graderMaterialIdentity, 'CONTENT_MISMATCH');
  const graderMaterial = parse(graderBytes, 'CONTENT_MISMATCH');
  if (Object.keys(graderMaterial).some((key) => FORBIDDEN.includes(key))) fault('PRIVACY_BOUNDARY');
  exactKeys(graderMaterial, ['schemaVersion', 'slotId', 'rootIdentity', 'gradeMaterialSetIdentity', 'stateDescriptorIdentity', 'redactedMaterialBytesBase64', 'redactedMaterialIdentity', 'unavoidableDisclosureTokens'], 'CONTENT_MISMATCH');
  if (graderMaterial.schemaVersion !== 'MES-BLIND-GRADER-MATERIAL-1' || !['SLOT_1', 'SLOT_2'].includes(graderMaterial.slotId as string)
    || !sameIdentity(requireIdentity(graderMaterial.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(graderMaterial.stateDescriptorIdentity, 'CONTENT_MISMATCH'), descriptorIdentity)) fault('CONTENT_MISMATCH');
  const redactedBytes = b64(graderMaterial.redactedMaterialBytesBase64, 'PRIVACY_BOUNDARY');
  const redacted = parse(redactedBytes, 'PRIVACY_BOUNDARY');
  exactKeys(redacted, ['schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'stateDescriptorIdentity', 'evidenceCategoryIds', 'contentMarkdown'], 'PRIVACY_BOUNDARY');
  if (privateMarkdown(redacted.contentMarkdown)) fault('PRIVACY_BOUNDARY');
  const redactedIdentity = await paired(redactedBytes, graderMaterial.redactedMaterialIdentity, 'CONTENT_MISMATCH');
  if (redacted.schemaVersion !== 'MES-REDACTED-GRADE-MATERIAL-1' || !sameIdentity(requireIdentity(redacted.rootIdentity, 'PRIVACY_BOUNDARY'), rootIdentity)
    || !sameIdentity(requireIdentity(redacted.targetLinkIdentity, 'PRIVACY_BOUNDARY'), targetIdentityValue)
    || !sameIdentity(requireIdentity(redacted.stateDescriptorIdentity, 'PRIVACY_BOUNDARY'), descriptorIdentity)
    || !equalJson(stringSet(redacted.evidenceCategoryIds, 'PRIVACY_BOUNDARY', true), categories)) fault('PRIVACY_BOUNDARY');
  if (redactedIdentity.sha256 !== payload.sha256 || text(redacted.contentMarkdown, 'PRIVACY_BOUNDARY', true).length === 0) fault('PRIVACY_BOUNDARY');
  return frozen({
    carrier: value, candidate, target, targetIdentity: targetIdentityValue, subject: rawTarget.subject, account: rawTarget.account,
    descriptor, descriptorIdentity, preimage, preimageIdentity, graderMaterial, redacted,
  });
}

async function base(root: Obj, prefixCarrier: Obj, materialOne: Obj, materialTwo: Obj): Promise<BaseFacts> {
  const start = await prefixFacts(root, prefixCarrier, materialOne, materialTwo);
  const one = await materialFact(root, start.rootIdentity, start.prefix, materialOne);
  const two = await materialFact(root, start.rootIdentity, start.prefix, materialTwo);
  if (sameIdentity(one.candidate.record_identity, two.candidate.record_identity)
    || !equalJson(one.target, two.target)
    || !sameIdentity(one.descriptorIdentity, two.descriptorIdentity)
    || !sameIdentity(one.preimageIdentity, two.preimageIdentity)
    || !sameIdentity(one.subject, two.subject)
    || !sameIdentity(one.account, two.account)) fault('CONTROL_MISMATCH');
  const identities = [one.candidate.record_identity, two.candidate.record_identity]
    .sort((left, right) => utf8Order(left.sha256, right.sha256) || left.byte_length - right.byte_length);
  const materialSet = {
    schemaVersion: 'MES-GRADE-MATERIAL-SET-1', rootIdentity: start.rootIdentity,
    targetLinkIdentity: one.targetIdentity, stateDescriptorIdentity: one.descriptorIdentity,
    gradeInputArtifactIdentities: identities,
  };
  return frozen({ root, rootIdentity: start.rootIdentity, prefix: start.prefix, one, two, materialSetIdentity: await contentIdentity(canonical(materialSet as unknown as CanonicalJsonValue)) });
}

async function policyFact(bytes: Uint8Array, identity: Obj, rootIdentity: ContentIdentity): Promise<Obj> {
  await paired(bytes, identity, 'CONTENT_MISMATCH');
  const policy = parse(bytes, 'CONTENT_MISMATCH');
  exactKeys(policy, ['schemaVersion', 'rootIdentity', 'policyId', 'forbiddenSemanticFields', 'unavoidableDisclosureRule'], 'CONTENT_MISMATCH');
  const expected = [
    'builder_identity', 'builder_vendor_family', 'builder_report', 'reviewer_identity',
    'reviewer_vendor_family', 'account_identity', 'raw_learner_content', 'plaintext_hash',
  ];
  if (policy.schemaVersion !== 'MES-BLIND-GRADE-SANITIZATION-POLICY-1' || policy.policyId !== 'STRIP_BRANDING_EXCLUDE_BUILDER_NARRATIVE_V1'
    || policy.unavoidableDisclosureRule !== 'SORTED_EXACT_DISCLOSURES_OR_REJECT'
    || !sameIdentity(requireIdentity(policy.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !equalJson(policy.forbiddenSemanticFields, expected)) fault('CONTENT_MISMATCH');
  return frozen(policy);
}

async function rubricFact(value: Obj, root: Obj, rootIdentity: ContentIdentity, targetIdentity: ContentIdentity): Promise<Obj> {
  exactKeys(value, [
    'schemaVersion', 'rootIdentity', 'matrixBytesBase64', 'matrixIdentity', 'answerKeyBytesBase64', 'answerKeyIdentity',
    'rubricBytesBase64', 'rubricIdentity', 'viewportProfileBytesBase64', 'viewportProfileIdentity',
    'contextProfileBytesBase64', 'contextProfileIdentity',
  ], 'CONTENT_MISMATCH');
  if (value.schemaVersion !== 'MES-GRADE-RUBRIC-CARRIER-1' || !sameIdentity(requireIdentity(value.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)) fault('CONTENT_MISMATCH');
  const matrixBytes = b64(value.matrixBytesBase64, 'CONTENT_MISMATCH');
  const answerBytes = b64(value.answerKeyBytesBase64, 'CONTENT_MISMATCH');
  const matrixIdentity = await paired(matrixBytes, value.matrixIdentity, 'CONTENT_MISMATCH');
  const answerIdentity = await paired(answerBytes, value.answerKeyIdentity, 'CONTENT_MISMATCH');
  if (!sameIdentity(matrixIdentity, contentAt(root, 'matrix', 'CONTENT_MISMATCH'))
    || !sameIdentity(answerIdentity, contentAt(root, 'answer_key', 'CONTENT_MISMATCH'))) fault('CONTENT_MISMATCH');
  const rubricBytes = b64(value.rubricBytesBase64, 'CONTENT_MISMATCH');
  const rubricIdentity = await paired(rubricBytes, value.rubricIdentity, 'CONTENT_MISMATCH');
  const rubric = parse(rubricBytes, 'CONTENT_MISMATCH');
  exactKeys(rubric, ['schemaVersion', 'rootIdentity', 'matrixIdentity', 'answerKeyIdentity', 'viewportProfileIdentity', 'contextProfileIdentity', 'allowedVerdicts', 'allowedReasonCodes', 'instructionsMarkdown'], 'CONTENT_MISMATCH');
  const viewportBytes = b64(value.viewportProfileBytesBase64, 'CONTENT_MISMATCH');
  const viewportIdentity = await paired(viewportBytes, value.viewportProfileIdentity, 'CONTENT_MISMATCH');
  const viewport = parse(viewportBytes, 'CONTENT_MISMATCH');
  exactKeys(viewport, ['schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'widthCssPixels', 'heightCssPixels', 'deviceScaleFactor'], 'CONTENT_MISMATCH');
  const contextBytes = b64(value.contextProfileBytesBase64, 'CONTENT_MISMATCH');
  const contextIdentity = await paired(contextBytes, value.contextProfileIdentity, 'CONTENT_MISMATCH');
  const context = parse(contextBytes, 'CONTENT_MISMATCH');
  exactKeys(context, ['schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'locale', 'timeZone'], 'CONTENT_MISMATCH');
  if (rubric.schemaVersion !== 'MES-GRADE-RUBRIC-1' || !sameIdentity(requireIdentity(rubric.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(rubric.matrixIdentity, 'CONTENT_MISMATCH'), matrixIdentity)
    || !sameIdentity(requireIdentity(rubric.answerKeyIdentity, 'CONTENT_MISMATCH'), answerIdentity)
    || !sameIdentity(requireIdentity(rubric.viewportProfileIdentity, 'CONTENT_MISMATCH'), viewportIdentity)
    || !sameIdentity(requireIdentity(rubric.contextProfileIdentity, 'CONTENT_MISMATCH'), contextIdentity)
    || !equalJson(rubric.allowedVerdicts, VERDICTS) || !equalJson(rubric.allowedReasonCodes, GRADE_REASONS)
    || text(rubric.instructionsMarkdown, 'CONTENT_MISMATCH', true).length === 0
    || viewport.schemaVersion !== 'MES-GRADE-VIEWPORT-PROFILE-1' || !sameIdentity(requireIdentity(viewport.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(viewport.targetLinkIdentity, 'CONTENT_MISMATCH'), targetIdentity)
    || !Number.isSafeInteger(viewport.widthCssPixels) || (viewport.widthCssPixels as number) <= 0
    || !Number.isSafeInteger(viewport.heightCssPixels) || (viewport.heightCssPixels as number) <= 0
    || typeof viewport.deviceScaleFactor !== 'number' || !Number.isFinite(viewport.deviceScaleFactor) || viewport.deviceScaleFactor <= 0
    || context.schemaVersion !== 'MES-GRADE-CONTEXT-PROFILE-1' || !sameIdentity(requireIdentity(context.rootIdentity, 'CONTENT_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(context.targetLinkIdentity, 'CONTENT_MISMATCH'), targetIdentity)
    || !/^[\x20-\x7E]+$/u.test(text(context.locale, 'CONTENT_MISMATCH')) || context.locale === 'UNKNOWN'
    || !/^[\x20-\x7E]+$/u.test(text(context.timeZone, 'CONTENT_MISMATCH')) || context.timeZone === 'UNKNOWN') fault('CONTENT_MISMATCH');
  return frozen({ ...value, matrixIdentity, answerKeyIdentity: answerIdentity, rubricIdentity, viewportProfileIdentity: viewportIdentity, contextProfileIdentity: contextIdentity });
}

async function brandingFact(value: Obj, rootIdentity: ContentIdentity, materialSetIdentity: ContentIdentity, policyIdentity: ContentIdentity): Promise<Obj> {
  exactKeys(value, ['schemaVersion', 'rootIdentity', 'assessmentBytesBase64', 'assessmentIdentity', 'disclosureReceiptBytesBase64', 'disclosureReceiptIdentity'], 'CONTROL_MISMATCH');
  if (value.schemaVersion !== 'MES-BRANDING-ASSESSMENT-CARRIER-1' || !sameIdentity(requireIdentity(value.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)) fault('CONTROL_MISMATCH');
  const assessmentBytes = b64(value.assessmentBytesBase64, 'CONTROL_MISMATCH');
  const assessmentIdentity = await paired(assessmentBytes, value.assessmentIdentity, 'CONTROL_MISMATCH');
  const disclosureBytes = b64(value.disclosureReceiptBytesBase64, 'CONTROL_MISMATCH');
  const disclosureIdentity = await paired(disclosureBytes, value.disclosureReceiptIdentity, 'CONTROL_MISMATCH');
  const assessment = parse(assessmentBytes, 'CONTROL_MISMATCH');
  const disclosure = parse(disclosureBytes, 'CONTROL_MISMATCH');
  exactKeys(assessment, ['schemaVersion', 'rootIdentity', 'gradeMaterialSetIdentity', 'sanitizationPolicyIdentity', 'semanticBrandingTokens', 'visualBrandingTokens', 'treatment', 'externalAssessmentReceiptIdentity'], 'CONTROL_MISMATCH');
  exactKeys(disclosure, ['schemaVersion', 'rootIdentity', 'gradeMaterialSetIdentity', 'sanitizationPolicyIdentity', 'semanticBrandingTokens', 'visualBrandingTokens', 'treatment'], 'CONTROL_MISMATCH');
  const semantic = stringSet(assessment.semanticBrandingTokens, 'CONTROL_MISMATCH');
  const visual = stringSet(assessment.visualBrandingTokens, 'CONTROL_MISMATCH');
  if (assessment.schemaVersion !== 'MES-BRANDING-ASSESSMENT-1' || disclosure.schemaVersion !== 'MES-BRANDING-DISCLOSURE-RECEIPT-1'
    || !sameIdentity(requireIdentity(assessment.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(disclosure.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(assessment.gradeMaterialSetIdentity, 'CONTROL_MISMATCH'), materialSetIdentity)
    || !sameIdentity(requireIdentity(disclosure.gradeMaterialSetIdentity, 'CONTROL_MISMATCH'), materialSetIdentity)
    || !sameIdentity(requireIdentity(assessment.sanitizationPolicyIdentity, 'CONTROL_MISMATCH'), policyIdentity)
    || !sameIdentity(requireIdentity(disclosure.sanitizationPolicyIdentity, 'CONTROL_MISMATCH'), policyIdentity)
    || !sameIdentity(requireIdentity(assessment.externalAssessmentReceiptIdentity, 'CONTROL_MISMATCH'), disclosureIdentity)
    || !equalJson(semantic, disclosure.semanticBrandingTokens) || !equalJson(visual, disclosure.visualBrandingTokens)
    || assessment.treatment !== disclosure.treatment || !['STRIPPED', 'UNAVOIDABLE_DISCLOSED'].includes(assessment.treatment as string)) fault('CONTROL_MISMATCH');
  return frozen({ ...value, assessmentIdentity, disclosureReceiptIdentity: disclosureIdentity, assessment, disclosure });
}

async function mappingFact(value: Obj, rootIdentity: ContentIdentity, materialSetIdentity: ContentIdentity, one: MaterialFact, two: MaterialFact): Promise<Obj> {
  exactKeys(value, ['schemaVersion', 'rootIdentity', 'commitmentBytesBase64', 'commitmentIdentity'], 'CONTROL_MISMATCH');
  if (value.schemaVersion !== 'MES-BLIND-MAPPING-COMMITMENT-1' || !sameIdentity(requireIdentity(value.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)) fault('CONTROL_MISMATCH');
  const bytes = b64(value.commitmentBytesBase64, 'CONTROL_MISMATCH');
  const identity = await paired(bytes, value.commitmentIdentity, 'CONTROL_MISMATCH');
  const body = parse(bytes, 'CONTROL_MISMATCH');
  exactKeys(body, ['schemaVersion', 'rootIdentity', 'gradeMaterialSetIdentity', 'candidateArtifactIdentity', 'slotMapping', 'nonceCommitmentIdentity', 'externalRandomizationReceiptIdentity'], 'CONTROL_MISMATCH');
  if (body.schemaVersion !== 'MES-BLIND-MAPPING-COMMITMENT-BODY-1' || !sameIdentity(requireIdentity(body.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(body.gradeMaterialSetIdentity, 'CONTROL_MISMATCH'), materialSetIdentity)) fault('CONTROL_MISMATCH');
  const candidate = requireIdentity(body.candidateArtifactIdentity, 'CONTROL_MISMATCH');
  const ids = [one.candidate.record_identity, two.candidate.record_identity];
  if (!ids.some((item) => sameIdentity(item, candidate))) fault('CONTROL_MISMATCH');
  if (!Array.isArray(body.slotMapping) || body.slotMapping.length !== 2) fault('CONTROL_MISMATCH');
  const slots = body.slotMapping.map((item) => {
    const row = exactKeys(item, ['slotId', 'gradeInputArtifactIdentity'], 'CONTROL_MISMATCH');
    return { slotId: row.slotId, identity: requireIdentity(row.gradeInputArtifactIdentity, 'CONTROL_MISMATCH') };
  });
  if (!equalJson(slots.map((item) => item.slotId), ['SLOT_1', 'SLOT_2'])
    || !ids.every((id) => slots.some((slot) => sameIdentity(slot.identity, id)))
    || !ids.every((id) => slots.filter((slot) => sameIdentity(slot.identity, id)).length === 1)) fault('CONTROL_MISMATCH');
  requireIdentity(body.nonceCommitmentIdentity, 'CONTROL_MISMATCH');
  requireIdentity(body.externalRandomizationReceiptIdentity, 'CONTROL_MISMATCH');
  return frozen({ ...value, commitmentIdentity: identity, body, candidate, slots });
}

function materialItem(material: MaterialFact, materialSetIdentity: ContentIdentity, branding: Obj): Obj {
  const item = material.graderMaterial;
  if (!sameIdentity(requireIdentity(item.gradeMaterialSetIdentity, 'CONTROL_MISMATCH'), materialSetIdentity)) fault('CONTROL_MISMATCH');
  const tokens = stringSet(item.unavoidableDisclosureTokens, 'PRIVACY_BOUNDARY');
  const assessment = member(branding, 'assessment', 'CONTROL_MISMATCH');
  const allowed = sortedUnique([
    ...stringSet(assessment.semanticBrandingTokens, 'CONTROL_MISMATCH'),
    ...stringSet(assessment.visualBrandingTokens, 'CONTROL_MISMATCH'),
  ]);
  if (assessment.treatment === 'STRIPPED' && tokens.length !== 0) fault('PRIVACY_BOUNDARY');
  const content = text(material.redacted.contentMarkdown, 'PRIVACY_BOUNDARY', true);
  if (!tokens.every((token) => allowed.includes(token) && content.includes(token))) fault('PRIVACY_BOUNDARY');
  if (!equalJson(tokens, allowed.filter((token) => content.includes(token)))) fault('PRIVACY_BOUNDARY');
  return frozen({ ...item, unavoidableDisclosureTokens: tokens });
}

function gradeMaterialItems(facts: BaseFacts, branding: Obj): Obj[] {
  const items = [facts.one, facts.two].map((material) => materialItem(material, facts.materialSetIdentity, branding));
  const assessment = member(branding, 'assessment', 'CONTROL_MISMATCH');
  const allowed = sortedUnique([
    ...stringSet(assessment.semanticBrandingTokens, 'CONTROL_MISMATCH'),
    ...stringSet(assessment.visualBrandingTokens, 'CONTROL_MISMATCH'),
  ]);
  const disclosed = sortedUnique(items.flatMap((item) => stringSet(item.unavoidableDisclosureTokens, 'PRIVACY_BOUNDARY')));
  if (assessment.treatment === 'STRIPPED' ? disclosed.length !== 0 : !equalJson(disclosed, allowed)) fault('PRIVACY_BOUNDARY');
  return frozen(items);
}

function outputGrader(value: unknown): Obj {
  const grader = exactKeys(value, ['reviewerIdentity', 'vendorFamily', 'modelIdentity', 'independenceReceiptIdentity'], 'CONTROL_MISMATCH');
  printable(grader.reviewerIdentity, 'CONTROL_MISMATCH');
  printable(grader.vendorFamily, 'CONTROL_MISMATCH');
  requireIdentity(grader.modelIdentity, 'CONTROL_MISMATCH');
  requireIdentity(grader.independenceReceiptIdentity, 'CONTROL_MISMATCH');
  return frozen(grader);
}

function validateOutput(value: Obj, rootIdentity: ContentIdentity, packetIdentity: ContentIdentity): Obj {
  exactKeys(value, ['schemaVersion', 'rootIdentity', 'packetIdentity', 'grader', 'verdict', 'reasonCodes', 'unassessableDimensions'], 'CONTROL_MISMATCH');
  const reasons = stringSet(value.reasonCodes, 'CONTROL_MISMATCH', true);
  const dimensions = stringSet(value.unassessableDimensions, 'CONTROL_MISMATCH');
  if (value.schemaVersion !== 'MES-BLIND-GRADE-OUTPUT-1' || !sameIdentity(requireIdentity(value.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)
    || !sameIdentity(requireIdentity(value.packetIdentity, 'CONTROL_MISMATCH'), packetIdentity)
    || !VERDICTS.includes(value.verdict as (typeof VERDICTS)[number]) || !reasons.every((reason) => (GRADE_REASONS as readonly string[]).includes(reason))
    || (value.verdict === 'UNGRADABLE' ? dimensions.length === 0 : dimensions.length !== 0)) fault('CONTROL_MISMATCH');
  return frozen({ ...value, grader: outputGrader(value.grader), reasonCodes: reasons, unassessableDimensions: dimensions });
}

async function buildPacket(root: Obj, prefixCarrier: Obj, rubricCarrier: Obj, policyBytes: Uint8Array, policyIdentity: Obj, first: Obj, second: Obj, mappingCarrier: Obj, brandingCarrier: Obj): Promise<FrozenBlindGradePacketV1> {
  const facts = await base(root, prefixCarrier, first, second);
  const policy = await policyFact(policyBytes, policyIdentity, facts.rootIdentity);
  const policyIdentityValue = await contentIdentity(policyBytes);
  const rubric = await rubricFact(rubricCarrier, facts.root, facts.rootIdentity, facts.one.targetIdentity);
  if (!sameIdentity(requireIdentity(facts.one.descriptor.viewportProfileIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.viewportProfileIdentity, 'CONTENT_MISMATCH'))
    || !sameIdentity(requireIdentity(facts.one.descriptor.contextProfileIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.contextProfileIdentity, 'CONTENT_MISMATCH'))) fault('CONTENT_MISMATCH');
  const branding = await brandingFact(brandingCarrier, facts.rootIdentity, facts.materialSetIdentity, policyIdentityValue);
  const mapping = await mappingFact(mappingCarrier, facts.rootIdentity, facts.materialSetIdentity, facts.one, facts.two);
  const items = gradeMaterialItems(facts, branding);
  const ordered = ['SLOT_1', 'SLOT_2'].map((slot) => {
    const item = items.find((candidate) => candidate.slotId === slot);
    if (!item) fault('CONTROL_MISMATCH');
    const mapped = (mapping.slots as readonly Obj[]).find((row) => row.slotId === item.slotId);
    const source = item === items[0] ? facts.one : facts.two;
    if (!mapped || !sameIdentity(mapped.identity as ContentIdentity, source.candidate.record_identity)) fault('CONTROL_MISMATCH');
    return item;
  });
  const packet: Obj = {
    schemaVersion: 'MES-BLIND-GRADE-PACKET-1', rootIdentity: facts.rootIdentity,
    targetLinkIdentity: facts.one.targetIdentity, stateDescriptorIdentity: facts.one.descriptorIdentity,
    gradeMaterialSetIdentity: facts.materialSetIdentity, matrixIdentity: rubric.matrixIdentity,
    answerKeyIdentity: rubric.answerKeyIdentity, rubricIdentity: rubric.rubricIdentity, rubricCarrier: rubric,
    sanitizationPolicyIdentity: policyIdentityValue, brandingAssessmentIdentity: branding.assessmentIdentity,
    mappingCommitmentIdentity: mapping.commitmentIdentity, items: ordered,
  };
  const bytes = canonical(packet as CanonicalJsonValue);
  return frozen({ packet: frozen(packet) as unknown as FrozenBlindGradePacketV1['packet'], packetBytes: new Uint8Array(bytes), packetIdentity: await contentIdentity(bytes) });
}

function packetFacts(value: Obj): PacketFacts {
  exactKeys(value, ['packet', 'packetBytes', 'packetIdentity'], 'CONTENT_MISMATCH');
  if (!(value.packetBytes instanceof Uint8Array) || value.packetBytes.byteLength === 0) fault('CONTENT_MISMATCH');
  const packetBytes = new Uint8Array(value.packetBytes);
  const packet = parse(packetBytes, 'CONTENT_MISMATCH');
  if (!equalJson(value.packet, packet)) fault('CONTENT_MISMATCH');
  exactKeys(packet, ['schemaVersion', 'rootIdentity', 'targetLinkIdentity', 'stateDescriptorIdentity', 'gradeMaterialSetIdentity', 'matrixIdentity', 'answerKeyIdentity', 'rubricIdentity', 'rubricCarrier', 'sanitizationPolicyIdentity', 'brandingAssessmentIdentity', 'mappingCommitmentIdentity', 'items'], 'CONTENT_MISMATCH');
  return frozen({ packet, packetBytes, packetIdentity: requireIdentity(value.packetIdentity, 'CONTENT_MISMATCH'), rubric: member(packet, 'rubricCarrier', 'CONTENT_MISMATCH') });
}

function sourceUnion(one: MaterialFact, two: MaterialFact, outputRef: Obj): Obj[] {
  const records = [one, two].map((item) => item.candidate.record as unknown as Obj);
  const refs = records.flatMap((record) => {
    const values = record.source_receipts;
    if (!Array.isArray(values)) fault('CONTROL_MISMATCH');
    return values.map((value) => ref(value, 'CONTROL_MISMATCH'));
  });
  return sortedRefs([...refs, outputRef]);
}

async function pendingReview(builder: string): Promise<Obj> {
  return frozen({
    builder_identity: builder, reviewer_identity: 'UNKNOWN', separation: 'UNKNOWN',
    review_output_identity: await contentIdentity(canonical({ schema_version: 'MES-REVIEW-PENDING-1' })),
    verdict: 'UNKNOWN', vendor_family: 'UNKNOWN',
  });
}

async function candidateFrom(
  facts: BaseFacts,
  packet: PacketFacts,
  output: Obj,
  mapping: Obj,
  branding: Obj,
  outputRef: Obj,
  producedAt: string,
): Promise<Readonly<{ candidate: DetachedRecordCandidate; pending: Obj }>> {
  const candidateIdentity = mapping.candidate as ContentIdentity;
  const chosen = [facts.one, facts.two].find((item) => sameIdentity(item.candidate.record_identity, candidateIdentity));
  if (!chosen) fault('CONTROL_MISMATCH');
  const grader = output.grader as Obj;
  const builder = member(chosen.candidate.record as unknown as Obj, 'producer_identity', 'CONTROL_MISMATCH');
  if (builder.vendor_family === grader.vendorFamily) fault('CONTROL_MISMATCH');
  const oneRecord = facts.one.candidate.record as unknown as Obj;
  const twoRecord = facts.two.candidate.record as unknown as Obj;
  if (!equalJson(oneRecord.subject_identity, twoRecord.subject_identity)
    || !equalJson(member(oneRecord, 'payload', 'CONTROL_MISMATCH').scope, member(twoRecord, 'payload', 'CONTROL_MISMATCH').scope)) fault('CONTROL_MISMATCH');
  const outputIdentity = await contentIdentity(canonical(output as CanonicalJsonValue));
  const gradeRunId = `GRADE:${packet.packetIdentity.sha256}:${outputIdentity.sha256}`;
  const payload: Obj = {
    id: gradeRunId,
    slice_ids: sortedUnique([String(member(oneRecord, 'payload', 'CONTROL_MISMATCH').slice_id), String(member(twoRecord, 'payload', 'CONTROL_MISMATCH').slice_id)]),
    frozen_rubric_sha256: requireIdentity(packet.packet.rubricIdentity, 'CONTROL_MISMATCH').sha256,
    matrix_sha256: requireIdentity(packet.packet.matrixIdentity, 'CONTROL_MISMATCH').sha256,
    artifact_ids: sortedUnique([String(member(oneRecord, 'payload', 'CONTROL_MISMATCH').id), String(member(twoRecord, 'payload', 'CONTROL_MISMATCH').id)]),
    builder_vendor_family: builder.vendor_family,
    grader_vendor_family: grader.vendorFamily,
    grader_is_non_builder: true,
    builder_report_used: false,
    branding_treatment: member(branding, 'assessment', 'CONTROL_MISMATCH').treatment,
    same_state_material: true,
    mapping_commitment: (mapping.commitmentIdentity as ContentIdentity).sha256,
    prompt_sha256: packet.packetIdentity.sha256,
    verdict: output.verdict,
    reasons: output.reasonCodes,
    unassessable_dimensions: output.unassessableDimensions,
    timestamp: producedAt,
    output_sha256: outputIdentity.sha256,
  };
  const review = await pendingReview(String((grader.modelIdentity as ContentIdentity).sha256));
  const body: Obj = {
    schema_version: 'MES-1', record_family: 'GRADE', record_id: '0'.repeat(64), root_identity: facts.rootIdentity,
    evidence_key: await recordSha256({ schema_version: 'MES-EVIDENCE-KEY-1', record_family: 'GRADE', root_identity: facts.rootIdentity, grade_run_id: gradeRunId } as unknown as CanonicalJsonValue),
    subject_identity: oneRecord.subject_identity,
    created_at: producedAt,
    producer_identity: {
      producer_id: (grader.modelIdentity as ContentIdentity).sha256, role: 'INDEPENDENT_GRADER',
      vendor_family: grader.vendorFamily, attestation: (grader.independenceReceiptIdentity as ContentIdentity).sha256,
    },
    source_receipts: sourceUnion(facts.one, facts.two, outputRef),
    limitations: sortedUnique([...(oneRecord.limitations as string[]), ...(twoRecord.limitations as string[])]),
    independent_review: review,
    payload,
  };
  const without = { ...body };
  delete without.record_id;
  body.record_id = await recordSha256(without as CanonicalJsonValue);
  let record;
  try {
    record = validateEvidenceRecord(body);
  } catch {
    fault('CONTROL_MISMATCH');
  }
  const bytes = canonical(record as unknown as CanonicalJsonValue);
  return frozen({ candidate: frozen({ record, canonical_bytes: new Uint8Array(bytes), record_identity: await contentIdentity(bytes) }), pending: review });
}

function bootstrapRef(bytes: Uint8Array, rootIdentity: ContentIdentity, grader: Obj, one: MaterialFact, two: MaterialFact): Obj {
  const carrier = parse(bytes, 'CONTROL_MISMATCH');
  exactKeys(carrier, ['schemaVersion', 'rootIdentity', 'candidateIdentity', 'resolutions'], 'CONTROL_MISMATCH');
  if (carrier.schemaVersion !== 'MES-INTEGRATION-RECEIPT-RESOLUTION-CARRIER-1'
    || !sameIdentity(requireIdentity(carrier.rootIdentity, 'CONTROL_MISMATCH'), rootIdentity)
    || !Array.isArray(carrier.resolutions)) fault('CONTROL_MISMATCH');
  const expected = sourceUnion(one, two, { receipt_kind: 'GRADE_OUTPUT', receipt_id: '', content_identity: grader.independenceReceiptIdentity });
  const refs = carrier.resolutions.map((row) => {
    const item = member(row as Obj, 'ref', 'CONTROL_MISMATCH');
    return ref(item, 'CONTROL_MISMATCH');
  });
  const grades = refs.filter((item) => item.receipt_kind === 'GRADE_OUTPUT');
  if (grades.length !== 1 || !sameIdentity(requireIdentity(grades[0]!.content_identity, 'CONTROL_MISMATCH'), requireIdentity(grader.independenceReceiptIdentity, 'CONTROL_MISMATCH'))) {
    fault('CONTROL_MISMATCH');
  }
  const union = sourceUnion(one, two, grades[0]!);
  if (!equalJson(refs, union) || expected.length !== union.length) {
    fault('CONTROL_MISMATCH');
  }
  return grades[0]!;
}

async function prepare(root: Obj, packetWrapper: Obj, outputWrapper: Obj, prefixCarrier: Obj, first: Obj, second: Obj): Promise<PreparedBlindGradeCandidateV1> {
  const packet = packetFacts(packetWrapper);
  const facts = await base(root, prefixCarrier, first, second);
  if (!sameIdentity(packet.packetIdentity, await contentIdentity(packet.packetBytes))
    || packet.packet.schemaVersion !== 'MES-BLIND-GRADE-PACKET-1'
    || !sameIdentity(requireIdentity(packet.packet.rootIdentity, 'CONTENT_MISMATCH'), facts.rootIdentity)
    || !sameIdentity(requireIdentity(packet.packet.targetLinkIdentity, 'CONTENT_MISMATCH'), facts.one.targetIdentity)
    || !sameIdentity(requireIdentity(packet.packet.stateDescriptorIdentity, 'CONTENT_MISMATCH'), facts.one.descriptorIdentity)
    || !sameIdentity(requireIdentity(packet.packet.gradeMaterialSetIdentity, 'CONTENT_MISMATCH'), facts.materialSetIdentity)) fault('CONTENT_MISMATCH');
  const rubric = await rubricFact(packet.rubric, facts.root, facts.rootIdentity, facts.one.targetIdentity);
  if (!sameIdentity(requireIdentity(packet.packet.matrixIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.matrixIdentity, 'CONTENT_MISMATCH'))
    || !sameIdentity(requireIdentity(packet.packet.answerKeyIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.answerKeyIdentity, 'CONTENT_MISMATCH'))
    || !sameIdentity(requireIdentity(packet.packet.rubricIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.rubricIdentity, 'CONTENT_MISMATCH'))
    || !sameIdentity(requireIdentity(facts.one.descriptor.viewportProfileIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.viewportProfileIdentity, 'CONTENT_MISMATCH'))
    || !sameIdentity(requireIdentity(facts.one.descriptor.contextProfileIdentity, 'CONTENT_MISMATCH'), requireIdentity(rubric.contextProfileIdentity, 'CONTENT_MISMATCH'))) fault('CONTENT_MISMATCH');
  exactKeys(outputWrapper, ['carrierBytes', 'carrierIdentity'], 'CONTENT_MISMATCH');
  if (!(outputWrapper.carrierBytes instanceof Uint8Array)) fault('CONTENT_MISMATCH');
  const outerBytes = new Uint8Array(outputWrapper.carrierBytes);
  const outerIdentity = await paired(outerBytes, outputWrapper.carrierIdentity, 'CONTENT_MISMATCH');
  const outer = parse(outerBytes, 'CONTROL_MISMATCH');
  exactKeys(outer, ['schemaVersion', 'rootIdentity', 'packetBytesBase64', 'packetIdentity', 'outputBytesBase64', 'outputIdentity', 'outputReceiptCarrierBytesBase64', 'outputReceiptCarrierIdentity', 'mappingCommitmentBytesBase64', 'mappingCommitmentIdentity', 'brandingAssessmentCarrierBytesBase64', 'brandingAssessmentCarrierIdentity', 'candidateArtifactIdentity', 'grader', 'producedAt'], 'CONTROL_MISMATCH');
  if (outer.schemaVersion !== 'MES-GRADE-OUTPUT-CARRIER-1' || !sameIdentity(requireIdentity(outer.rootIdentity, 'CONTROL_MISMATCH'), facts.rootIdentity)) fault('CONTROL_MISMATCH');
  const embeddedPacket = b64(outer.packetBytesBase64, 'CONTENT_MISMATCH');
  if (!sameBytes(embeddedPacket, packet.packetBytes) || !sameIdentity(await paired(embeddedPacket, outer.packetIdentity, 'CONTENT_MISMATCH'), packet.packetIdentity)) fault('CONTENT_MISMATCH');
  const mapping = await mappingFact({ schemaVersion: 'MES-BLIND-MAPPING-COMMITMENT-1', rootIdentity: outer.rootIdentity, commitmentBytesBase64: outer.mappingCommitmentBytesBase64, commitmentIdentity: outer.mappingCommitmentIdentity }, facts.rootIdentity, facts.materialSetIdentity, facts.one, facts.two);
  const brandingBytes = b64(outer.brandingAssessmentCarrierBytesBase64, 'CONTROL_MISMATCH');
  await paired(brandingBytes, outer.brandingAssessmentCarrierIdentity, 'CONTROL_MISMATCH');
  const branding = await brandingFact(parse(brandingBytes, 'CONTROL_MISMATCH'), facts.rootIdentity, facts.materialSetIdentity, requireIdentity(packet.packet.sanitizationPolicyIdentity, 'CONTROL_MISMATCH'));
  if (!sameIdentity(requireIdentity(outer.mappingCommitmentIdentity, 'CONTROL_MISMATCH'), requireIdentity(packet.packet.mappingCommitmentIdentity, 'CONTROL_MISMATCH'))
    || !sameIdentity(branding.assessmentIdentity as ContentIdentity, requireIdentity(packet.packet.brandingAssessmentIdentity, 'CONTROL_MISMATCH'))
    || !sameIdentity(requireIdentity(outer.candidateArtifactIdentity, 'CONTROL_MISMATCH'), mapping.candidate as ContentIdentity)) {
    fault('CONTROL_MISMATCH');
  }
  const items = packet.packet.items;
  if (!Array.isArray(items) || items.length !== 2) fault('CONTROL_MISMATCH');
  const materialItems = gradeMaterialItems(facts, branding);
  for (const slot of ['SLOT_1', 'SLOT_2']) {
    const actual = items.find((item) => (item as Obj).slotId === slot);
    const expected = materialItems.find((item) => item.slotId === slot);
    if (!actual || !expected || !equalJson(actual, expected)) fault('CONTROL_MISMATCH');
  }
  const outputBytes = b64(outer.outputBytesBase64, 'CONTROL_MISMATCH');
  const outputIdentity = await paired(outputBytes, outer.outputIdentity, 'CONTROL_MISMATCH');
  const output = validateOutput(parse(outputBytes, 'CONTROL_MISMATCH'), facts.rootIdentity, packet.packetIdentity);
  const grader = output.grader as Obj;
  if (!equalJson(grader, outputGrader(outer.grader))) fault('CONTROL_MISMATCH');
  const receiptBytes = b64(outer.outputReceiptCarrierBytesBase64, 'CONTROL_MISMATCH');
  const receiptIdentity = await paired(receiptBytes, outer.outputReceiptCarrierIdentity, 'CONTROL_MISMATCH');
  const outputRef = bootstrapRef(receiptBytes, facts.rootIdentity, grader, facts.one, facts.two);
  const producedAt = text(outer.producedAt, 'CONTROL_MISMATCH');
  const provisional = await candidateFrom(facts, packet, output, mapping, branding, outputRef, producedAt);
  const resolutions = await verifyIntegrationReceiptResolutionCarrier(facts.root as unknown as EvidenceSpineRootV1, provisional.candidate, receiptBytes, receiptIdentity);
  if (!resolutions) fault('CONTROL_MISMATCH');
  const result = resolutions.filter((item): item is Extract<ReceiptResolution, { status: 'RESOLVED' }> => item.status === 'RESOLVED' && item.ref.receipt_kind === 'GRADE_OUTPUT');
  if (result.length !== 1) fault('CONTROL_MISMATCH');
  const receipt = result[0]!;
  if (!sameIdentity(receipt.ref.content_identity, requireIdentity(grader.independenceReceiptIdentity, 'CONTROL_MISMATCH'))
    || !sameIdentity(receipt.subjectIdentity, facts.one.subject)
    || !sameIdentity((receipt.payload as Obj).accountScopeIdentity as ContentIdentity, facts.one.account)) fault('CONTROL_MISMATCH');
  const causal = member(receipt.payload as Obj, 'causal', 'CONTROL_MISMATCH');
  const graderIdentity = await contentIdentity(canonical({ reviewerIdentity: grader.reviewerIdentity, modelIdentity: grader.modelIdentity } as unknown as CanonicalJsonValue));
  if (!sameIdentity(requireIdentity(causal.packetIdentity, 'CONTROL_MISMATCH'), packet.packetIdentity)
    || !sameIdentity(requireIdentity(causal.graderIdentity, 'CONTROL_MISMATCH'), graderIdentity)
    || causal.graderFamily !== grader.vendorFamily || causal.verdict !== output.verdict || !equalJson(causal.reasonCodes, output.reasonCodes)) fault('CONTROL_MISMATCH');
  const final = await candidateFrom(facts, packet, output, mapping, branding, outputRef, producedAt);
  if (!sameBytes(provisional.candidate.canonical_bytes, final.candidate.canonical_bytes)
    || !sameIdentity(provisional.candidate.record_identity, final.candidate.record_identity)) fault('CONTROL_MISMATCH');
  return frozen({ status: 'PENDING_INDEPENDENT_REVIEW', candidate: final.candidate, outputBytes: new Uint8Array(outputBytes), outputIdentity, pendingIndependentReview: final.pending }) as unknown as PreparedBlindGradeCandidateV1;
}

export async function buildBlindGradePacket(
  root: EvidenceSpineRootV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  rubric: VerifiedGradeRubricCarrierV1,
  policyBytes: Uint8Array,
  policyIdentity: ContentIdentity,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
  mapping: ExternalBlindMappingCommitmentCarrierV1,
  branding: ExternalBrandingAssessmentCarrierV1,
): Promise<FrozenBlindGradePacketV1 | NonPassingObservation> {
  try {
    const [rootCopy, prefixCopy, rubricCopy, policyCopy, policyIdentityCopy, oneCopy, twoCopy, mappingCopy, brandingCopy] = snapshotBuild(root, prefix, rubric, policyBytes, policyIdentity, materialOne, materialTwo, mapping, branding);
    strictDecodeBase64Graph([rootCopy, prefixCopy, rubricCopy, policyCopy, policyIdentityCopy, oneCopy, twoCopy, mappingCopy, brandingCopy]);
    return await buildPacket(rootCopy, prefixCopy, rubricCopy, policyCopy, policyIdentityCopy, oneCopy, twoCopy, mappingCopy, brandingCopy);
  } catch (error) {
    return nonPassing('UNGRADABLE', error instanceof Fault ? error.reason : 'AUTHORITY_MISSING');
  }
}

export async function prepareBlindGradeCandidate(
  root: EvidenceSpineRootV1,
  packet: FrozenBlindGradePacketV1,
  output: VerifiedGradeOutputCarrierV1,
  prefix: VerifiedManifestPrefixCarrierV1,
  materialOne: VerifiedActiveGradeInputCarrierV1,
  materialTwo: VerifiedActiveGradeInputCarrierV1,
): Promise<PreparedBlindGradeCandidateV1 | NonPassingObservation> {
  try {
    const [rootCopy, packetCopy, outputCopy, prefixCopy, oneCopy, twoCopy] = snapshotCandidate(root, packet, output, prefix, materialOne, materialTwo);
    strictDecodeBase64Graph([rootCopy, packetCopy, outputCopy, prefixCopy, oneCopy, twoCopy]);
    return await prepare(rootCopy, packetCopy, outputCopy, prefixCopy, oneCopy, twoCopy);
  } catch (error) {
    return nonPassing('UNGRADABLE', error instanceof Fault ? error.reason : 'AUTHORITY_MISSING');
  }
}
