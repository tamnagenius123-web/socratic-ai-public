import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as n9SuccessorModule from '../../src/services/admission/n9-successor';
import {
  buildN9EvidenceCapturePlan,
  buildN9ExecutionChecklist,
  validateN9SuccessorAuthorization,
} from '../../src/services/admission/n9-successor';
import { canonicalDocument, parseAuthorityJson, type CanonicalJsonValue } from '../../src/services/admission/canonical-json';
import { deriveEvidenceSpineBaseline } from '../../src/services/admission/evidence-spine-records';
import { loadEvidenceSpineRoot } from '../../src/services/admission/evidence-spine-root';
import { contentIdentity, type ContentIdentity } from '../../src/services/admission/identity';
import type {
  N9ControlObservationCarrierV1,
  N9SuccessorPolicyV1,
  SourceReceiptKind,
  SourceReceiptRefV1,
} from '../../src/services/admission/evidence-spine-types';

const repositorySources = () => {
  const bytes = (path: string) => new Uint8Array(readFileSync(path));
  return {
    specification: bytes('docs/superpowers/specs/2026-09-01-socratic-ai-minimal-evidence-spine-design.md'),
    implementationPlan: bytes('docs/superpowers/plans/2026-09-01-socratic-ai-critical-path-b.md'),
    matrix: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json'),
    answerKey: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/COMPOSITE_ANSWER_KEY_CANDIDATE.md'),
    historicalTask4Capsule: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/admission/inputs/task-4-cutoff-state-capsule.md'),
  };
};

async function identity(value: CanonicalJsonValue): Promise<ContentIdentity> {
  return contentIdentity(canonicalDocument(value));
}

function changed(identityValue: ContentIdentity): ContentIdentity {
  return {
    byte_length: identityValue.byte_length,
    sha256: identityValue.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
  };
}

function assertN9Baseline(value: Awaited<ReturnType<typeof deriveEvidenceSpineBaseline>>): void {
  const n9 = value.projection.requirements
    .filter((requirement) => ['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1'].includes(requirement.requirement_id));
  expect(n9.map((requirement) => [requirement.requirement_id, requirement.status])).toEqual([
    ['N9-S1', 'BLOCKED_CONTRACT'],
    ['N9-R1', 'BLOCKED_CONTRACT'],
    ['N9-P1', 'BLOCKED_CONTRACT'],
    ['N9-A1', 'BLOCKED_CONTRACT'],
    ['N9-L1', 'BLOCKED_CONTRACT'],
  ]);
  expect(value.root.slice_ids).toHaveLength(11);
  expect(value.root.requirements).toHaveLength(64);
  expect(value.projection.requirements.filter((row) => row.status === 'PENDING')).toHaveLength(59);
  expect(value.projection.active_artifact_count).toBe(0);
  expect(value.projection.active_grade_count).toBe(0);
  expect(value.projection.same_grade_count).toBe(0);
  expect(value.projection.closure_status).toBe('NOT_EVALUATED');
}

async function fixture() {
  const baseline = await deriveEvidenceSpineBaseline(repositorySources());
  const policy = baseline.root.n9_successor_policy;
  const expected = Object.freeze({
    rootIdentity: baseline.rootIdentity,
    planIdentity: baseline.root.source_identities.implementation_plan,
    historicalTask4CapsuleIdentity: baseline.root.source_identities.historical_task4_capsule,
    successorLaneId: 'N9_SUCCESSOR_V1' as const,
    buildIdentity: await identity({ build: 'n9-fixture' }),
    deploymentIdentity: await identity({ deployment: 'n9-fixture' }),
    routeManifestIdentity: await identity({ routes: 'n9-fixture' }),
    controlPlaneIdentity: await identity({ control_plane: 'n9-fixture' }),
  });
  const authorization = Object.freeze({
    rootIdentity: expected.rootIdentity,
    implementationPlanIdentity: expected.planIdentity,
    historicalCapsuleIdentity: expected.historicalTask4CapsuleIdentity,
    successorLaneId: expected.successorLaneId,
    accountAliasIdentities: [...policy.accountAliasIdentities],
    allowedActionIds: [...policy.allowedActionIds],
    allowedFileIds: [...policy.allowedFileIds],
    prohibitedActionIds: [...policy.prohibitedActionIds],
    stopConditionIds: [...policy.stopConditionIds],
    maximumClaim: policy.maximumClaim,
    buildIdentity: expected.buildIdentity,
    deploymentIdentity: expected.deploymentIdentity,
    routeManifestIdentity: expected.routeManifestIdentity,
    controlPlaneIdentity: expected.controlPlaneIdentity,
    approvalIdentity: await identity({ approval: 'synthetic-n9-unit-fixture-only' }),
    authorizedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return { authorization, baseline, expected, policy };
}

function receiptKindFor(index: number): SourceReceiptKind {
  return (['BROWSER_ACTION_LOG', 'CONTROL_PLANE', 'RECHECK', 'SOURCE_MANIFEST'] as const)[index % 4];
}

async function observationsFor(
  policy: N9SuccessorPolicyV1,
): Promise<readonly N9ControlObservationCarrierV1[]> {
  return Promise.all(policy.controls.map(async (control, controlIndex) => {
    const identities = await Promise.all([
      identity({ control: control.controlId, capture: control.beforeCaptureId }),
      identity({ control: control.controlId, capture: control.afterCaptureId }),
      identity({ control: control.controlId, capture: control.actionLogCaptureId }),
      identity({ control: control.controlId, capture: control.networkEvidenceCaptureId }),
    ]);
    const captureIds = [
      control.beforeCaptureId,
      control.afterCaptureId,
      control.actionLogCaptureId,
      control.networkEvidenceCaptureId,
    ];
    const receiptRefs: SourceReceiptRefV1[] = captureIds.map((receiptId, index) => ({
      receipt_kind: receiptKindFor(controlIndex + index),
      receipt_id: receiptId,
      content_identity: identities[index],
    })).sort((left, right) => `${left.receipt_kind}\u0000${left.receipt_id}`.localeCompare(`${right.receipt_kind}\u0000${right.receipt_id}`));
    return {
      controlId: control.controlId,
      beforeIdentity: identities[0],
      afterIdentity: identities[1],
      actionLogIdentity: identities[2],
      networkEvidenceIdentity: identities[3],
      receiptRefs,
    };
  }));
}

type MutablePolicyDocument = Record<string, any>;

async function policySourceVariant(
  baseline: Awaited<ReturnType<typeof deriveEvidenceSpineBaseline>>,
  mutate: (policy: MutablePolicyDocument) => void,
): Promise<{ sourceBytes: Uint8Array; expected: typeof baseline.sourceIdentities }> {
  const policy = JSON.parse(new TextDecoder().decode(baseline.rootSourceBytes.n9SuccessorPolicy)) as MutablePolicyDocument;
  mutate(policy);
  const sourceBytes = canonicalDocument(policy as unknown as CanonicalJsonValue);
  return {
    sourceBytes,
    expected: {
      ...baseline.sourceIdentities,
      n9SuccessorPolicy: await contentIdentity(sourceBytes),
    },
  };
}

async function expectSemanticPolicyRejection(
  baseline: Awaited<ReturnType<typeof deriveEvidenceSpineBaseline>>,
  mutate: (policy: MutablePolicyDocument) => void,
): Promise<void> {
  const variant = await policySourceVariant(baseline, mutate);
  await expect(loadEvidenceSpineRoot(
    { ...baseline.rootSourceBytes, n9SuccessorPolicy: variant.sourceBytes },
    variant.expected,
  )).rejects.toThrow(/MES_N9_/);
}

async function expectSemanticPolicyRejectionCode(
  baseline: Awaited<ReturnType<typeof deriveEvidenceSpineBaseline>>,
  mutate: (policy: MutablePolicyDocument) => void,
  expectedCode: string,
): Promise<void> {
  const variant = await policySourceVariant(baseline, mutate);
  await expect(loadEvidenceSpineRoot(
    { ...baseline.rootSourceBytes, n9SuccessorPolicy: variant.sourceBytes },
    variant.expected,
  )).rejects.toThrow(expectedCode);
}

function sortReceiptRefs(refs: readonly SourceReceiptRefV1[]): SourceReceiptRefV1[] {
  return [...refs].sort((left, right) => `${left.receipt_kind}\u0000${left.receipt_id}`.localeCompare(`${right.receipt_kind}\u0000${right.receipt_id}`));
}

function proxyWithQueuedMutation<T extends object>(target: T, mutate: () => void): T {
  let queued = false;
  return new Proxy(target, {
    ownKeys(inner) {
      if (!queued) {
        queued = true;
        queueMicrotask(mutate);
      }
      return Reflect.ownKeys(inner);
    },
  });
}

function proxyWithAccessorQueuedMutation<T extends object>(
  target: T,
  mutate: () => void,
  onAccessor: () => void,
): T {
  let queued = false;
  const handler = {} as ProxyHandler<T>;
  Object.defineProperty(handler, 'getOwnPropertyDescriptor', {
    configurable: true,
    get() {
      onAccessor();
      if (!queued) {
        queued = true;
        queueMicrotask(mutate);
      }
      return (inner: T, key: PropertyKey) => Reflect.getOwnPropertyDescriptor(inner, key);
    },
  });
  return new Proxy(target, handler);
}

describe('N9 successor authorization boundary', () => {
  it('exposes only the three approved public N9 functions', () => {
    expect(Object.keys(n9SuccessorModule).sort()).toEqual([
      'buildN9EvidenceCapturePlan',
      'buildN9ExecutionChecklist',
      'validateN9SuccessorAuthorization',
    ]);
  });

  it('binds exactly one fourteenth policy source while preserving the zero-promotion baseline', async () => {
    const { baseline, policy } = await fixture();
    const policySource = baseline.documents.sources.n9SuccessorPolicy;
    expect(await contentIdentity(policySource)).toEqual(baseline.root.source_identities.n9_successor_policy);
    expect(new TextDecoder().decode(policySource)).not.toContain('rootIdentity');
    expect(policy.controls).toHaveLength(26);
    expect(new Set(policy.controls.map((control) => control.controlId)).size).toBe(26);
    expect(policy.controls.every((control) => control.sliceId === 'N9')).toBe(true);
    expect(new Set(policy.controls.flatMap((control) => control.requirementIds))).toEqual(new Set(['N9-S1', 'N9-R1', 'N9-P1', 'N9-A1', 'N9-L1']));
    assertN9Baseline(baseline);
  });

  it('rejects missing, stale, divergent, or broadened authorization without changing N9 baseline cells', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const cases: readonly [string, unknown][] = [
      ['absent', null],
      ['partial', { rootIdentity: authorization.rootIdentity }],
      ['stale', { ...authorization, expiresAt: '2000-01-01T00:00:00.000Z' }],
      ['future', { ...authorization, authorizedAt: '2100-01-01T00:00:00.000Z' }],
      ['cross-root', { ...authorization, rootIdentity: changed(authorization.rootIdentity) }],
      ['wrong-plan', { ...authorization, implementationPlanIdentity: changed(authorization.implementationPlanIdentity) }],
      ['wrong-capsule', { ...authorization, historicalCapsuleIdentity: changed(authorization.historicalCapsuleIdentity) }],
      ['wrong-successor-lane', { ...authorization, successorLaneId: 'N9_SUCCESSOR_V2' }],
      ['duplicate-account', { ...authorization, accountAliasIdentities: [policy.accountAliasIdentities[0], policy.accountAliasIdentities[0]] }],
      ['overbroad-action', { ...authorization, allowedActionIds: [...authorization.allowedActionIds, 'N9-ACTION-FORBIDDEN'] }],
      ['overbroad-file', { ...authorization, allowedFileIds: [...authorization.allowedFileIds, 'N9-FILE-FORBIDDEN'] }],
      ['missing-stop', { ...authorization, stopConditionIds: authorization.stopConditionIds.slice(1) }],
      ['overclaim', { ...authorization, maximumClaim: `${authorization.maximumClaim}:BROADER` }],
      ['wrong-policy', { ...authorization, allowedActionIds: [...policy.allowedActionIds].reverse() }],
    ];

    for (const [name, value] of cases) {
      await expect(validateN9SuccessorAuthorization(
        value,
        expected,
        baseline.root,
        policy,
        { evaluatedAt: '2026-09-02T12:00:00.000Z' },
      ), name).rejects.toThrow();
      assertN9Baseline(baseline);
    }
  });

  it('revalidates changed policy source bytes before parsing', async () => {
    const { baseline } = await fixture();
    const changedPolicy = new Uint8Array(baseline.rootSourceBytes.n9SuccessorPolicy);
    changedPolicy[changedPolicy.length - 2] ^= 1;
    const sourceBytes = { ...baseline.rootSourceBytes, n9SuccessorPolicy: changedPolicy };
    const expected = { ...baseline.sourceIdentities, n9SuccessorPolicy: baseline.sourceIdentities.n9SuccessorPolicy };
    const { loadEvidenceSpineRoot } = await import('../../src/services/admission/evidence-spine-root');
    await expect(loadEvidenceSpineRoot(sourceBytes, expected)).rejects.toThrow('MES_ROOT_SOURCE_IDENTITY_MISMATCH:n9SuccessorPolicy');
  });

  it('rejects semantically invalid policy bytes after recomputing their expected source identities', async () => {
    const { baseline } = await fixture();
    const cases: readonly [string, (policy: MutablePolicyDocument) => void][] = [
      ['unknown-key', (policy) => { policy.unknownKey = 'reject'; }],
      ['forbidden-root-identity', (policy) => { policy.rootIdentity = baseline.rootIdentity; }],
      ['plan-mismatch', (policy) => { policy.implementationPlanIdentity = changed(policy.implementationPlanIdentity); }],
      ['capsule-mismatch', (policy) => { policy.historicalCapsuleIdentity = changed(policy.historicalCapsuleIdentity); }],
      ['malformed-controls', (policy) => { policy.controls = null; }],
      ['non-n9-control', (policy) => { policy.controls[0].controlId = 'N8-CTRL-CONSENT'; }],
      ['duplicate-control', (policy) => { policy.controls[1].controlId = policy.controls[0].controlId; }],
      ['unsorted-controls', (policy) => {
        const first = policy.controls[0];
        policy.controls[0] = policy.controls[1];
        policy.controls[1] = first;
      }],
      ['wrong-route', (policy) => { policy.controls[7].routeId = 'N9-ROUTE-WRONG'; }],
      ['wrong-action', (policy) => { policy.controls[7].actionId = 'N9-ACTION-WRONG'; }],
      ['wrong-account', (policy) => { policy.controls[8].accountAliasIdentity = policy.controls[0].accountAliasIdentity; }],
      ['wrong-requirement', (policy) => { policy.controls[7].requirementIds = ['N9-S1']; }],
    ];
    for (const [name, mutate] of cases) {
      await expectSemanticPolicyRejection(baseline, mutate).catch((error) => {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const exactCases: readonly [string, (policy: MutablePolicyDocument) => void, string][] = [
      ['missing-required-control', (policy) => { policy.controls.splice(15, 1); }, 'MES_N9_POLICY_INVALID'],
      ['matrix-negative-conflation', (policy) => { policy.controls[0].controlId = 'NC-ACCESS'; }, 'MES_N9_POLICY_INVALID'],
      ['wrong-gate', (policy) => { policy.controls[7].gateId = 'S'; }, 'MES_N9_POLICY_INVALID'],
    ];
    for (const [name, mutate, expectedCode] of exactCases) {
      await expectSemanticPolicyRejectionCode(baseline, mutate, expectedCode).catch((error) => {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  it('rejects malformed explicit validation clocks and authorization target-tuple mismatches', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    await expect(validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00Z' },
    )).rejects.toThrow('MES_N9_CLOCK_INVALID');

    await expect(validateN9SuccessorAuthorization(
      { ...authorization, buildIdentity: changed(authorization.buildIdentity) },
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    )).rejects.toThrow('MES_N9_AUTHORIZATION_TARGET_MISMATCH');
    assertN9Baseline(baseline);
  });

  it('copies a frozen complete checklist and capture plan only from the branded authorization and matching observations', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const validated = await validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    const checklist = await buildN9ExecutionChecklist(baseline.root, policy, validated);
    const observations = await observationsFor(policy);
    const frozen = await buildN9EvidenceCapturePlan(baseline.root, policy, validated, observations);

    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(checklist)).toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(checklist).toHaveLength(26);
    expect(checklist.map((step) => step.controlId)).toEqual(policy.controls.map((control) => control.controlId));
    expect(frozen.plan.controls).toHaveLength(26);
    expect(frozen.plan.rootIdentity).toEqual(baseline.rootIdentity);
    expect(frozen.plan.declaredStoreManifestIdentity).not.toEqual(policy.declaredStorePolicyIdentity);
    const residue = frozen.plan.controls.find((control) => control.controlId === 'N9-CTRL-DECLARED-STORE-DELETION-RESIDUE');
    expect(residue).toBeDefined();
    expect(frozen.plan.declaredStoreManifestIdentity).toEqual(residue?.beforeIdentity);
    expect(frozen.planIdentity).toEqual(await identity(frozen.plan as unknown as CanonicalJsonValue));
    expect(frozen.authorizationIdentity).toEqual(await identity(validated as unknown as CanonicalJsonValue));
  });

  it('rejects unbranded clones and missing, duplicate, detached, or unreceipted observations', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const validated = await validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    const observations = [...await observationsFor(policy)];
    await expect(buildN9ExecutionChecklist(baseline.root, policy, { ...validated })).rejects.toThrow();
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, observations.slice(1))).rejects.toThrow();
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, [
      ...observations.slice(0, 1), observations[0], ...observations.slice(2),
    ])).rejects.toThrow();
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, observations.map((observation, index) => index === 0
      ? { ...observation, controlId: observations[1].controlId }
      : observation))).rejects.toThrow();
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, observations.map((observation, index) => index === 0
      ? { ...observation, receiptRefs: observation.receiptRefs.slice(1) }
      : observation))).rejects.toThrow();
    await expect(buildN9ExecutionChecklist(baseline.root, policy, JSON.parse(JSON.stringify(validated)))).rejects.toThrow();
  });

  it('rejects wrong receipt kinds/content identities and store-policy/manifest substitution', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const validated = await validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    const observations = [...await observationsFor(policy)];
    const wrongKind = observations.map((observation, index) => index === 0
      ? {
        ...observation,
        receiptRefs: sortReceiptRefs(observation.receiptRefs.map((ref, refIndex) => refIndex === 0
          ? { ...ref, receipt_kind: 'CONTROL_PLANE' as SourceReceiptKind }
          : ref)),
      }
      : observation);
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, wrongKind)).rejects.toThrow();
    const wrongContentIdentity = observations.map((observation, index) => index === 0
      ? {
        ...observation,
        receiptRefs: sortReceiptRefs(observation.receiptRefs.map((ref, refIndex) => refIndex === 0
          ? { ...ref, content_identity: changed(ref.content_identity) }
          : ref)),
      }
      : observation);
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, wrongContentIdentity)).rejects.toThrow();
    const residueIndex = observations.findIndex((observation) => observation.controlId === 'N9-CTRL-DECLARED-STORE-DELETION-RESIDUE');
    const residueControl = policy.controls[residueIndex];
    const substitutedManifest = observations.map((observation, index) => index === residueIndex
      ? {
        ...observation,
        beforeIdentity: policy.declaredStorePolicyIdentity,
        receiptRefs: sortReceiptRefs(observation.receiptRefs.map((ref) => ref.receipt_id === residueControl.beforeCaptureId
          ? { ...ref, content_identity: policy.declaredStorePolicyIdentity }
          : ref)),
      }
      : observation);
    await expect(buildN9EvidenceCapturePlan(baseline.root, policy, validated, substitutedManifest)).rejects.toThrow();
    await expect(buildN9ExecutionChecklist(
      baseline.root,
      { ...policy, declaredStorePolicyIdentity: changed(policy.declaredStorePolicyIdentity) },
      validated,
    )).rejects.toThrow();
  });

  it('rejects foreign root/policy brands and snapshots proxy mutations before asynchronous hashing', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const validated = await validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    const foreignVariant = await policySourceVariant(baseline, (foreignPolicy) => {
      foreignPolicy.controls[0].expectedOutcome = 'A foreign-root policy remains an offline candidate only.';
    });
    const foreign = await loadEvidenceSpineRoot(
      { ...baseline.rootSourceBytes, n9SuccessorPolicy: foreignVariant.sourceBytes },
      foreignVariant.expected,
    );
    const foreignPolicy = foreign.root.n9_successor_policy;
    const foreignAuthorization = await validateN9SuccessorAuthorization(
      { ...authorization, rootIdentity: foreign.identity },
      { ...expected, rootIdentity: foreign.identity },
      foreign.root,
      foreignPolicy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    await expect(buildN9ExecutionChecklist(baseline.root, policy, foreignAuthorization)).rejects.toThrow();
    await expect(buildN9ExecutionChecklist(foreign.root, policy, foreignAuthorization)).rejects.toThrow();
    await expect(buildN9ExecutionChecklist(baseline.root, foreignPolicy, foreignAuthorization)).rejects.toThrow();

    const mutableAuthorization = { ...authorization, allowedActionIds: [...authorization.allowedActionIds] };
    const proxiedAuthorization = proxyWithQueuedMutation(mutableAuthorization, () => {
      mutableAuthorization.allowedActionIds.push('N9-LATE-PROXY-MUTATION');
    });
    await expect(validateN9SuccessorAuthorization(
      proxiedAuthorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    )).resolves.toBeDefined();

    const observations = [...await observationsFor(policy)];
    const observationTarget = { ...observations[0], receiptRefs: [...observations[0].receiptRefs] };
    const proxiedObservation = proxyWithQueuedMutation(observationTarget, () => {
      observationTarget.beforeIdentity = changed(observationTarget.beforeIdentity);
    });
    const proxiedObservations = [proxiedObservation, ...observations.slice(1)];
    const planPending = buildN9EvidenceCapturePlan(baseline.root, policy, validated, proxiedObservations);
    await expect(planPending).resolves.toBeDefined();
  });

  it('snapshots through a genuine accessor trap before asynchronous hashing', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const mutableAuthorization = { ...authorization, allowedActionIds: [...authorization.allowedActionIds] };
    let accessorReads = 0;
    let lateMutationApplied = false;
    const accessorAuthorization = proxyWithAccessorQueuedMutation(
      mutableAuthorization,
      () => {
        mutableAuthorization.allowedActionIds.push('N9-LATE-ACCESSOR-MUTATION');
        lateMutationApplied = true;
      },
      () => { accessorReads += 1; },
    );

    const result = await validateN9SuccessorAuthorization(
      accessorAuthorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );

    expect(accessorReads).toBeGreaterThan(0);
    expect(lateMutationApplied).toBe(true);
    expect(result.allowedActionIds).toEqual(authorization.allowedActionIds);
    expect(result.allowedActionIds).not.toContain('N9-LATE-ACCESSOR-MUTATION');
  });

  it('snapshots async inputs before the first Web Crypto await', async () => {
    const { authorization, baseline, expected, policy } = await fixture();
    const mutable = { ...authorization, allowedActionIds: [...authorization.allowedActionIds] };
    const pending = validateN9SuccessorAuthorization(
      mutable,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    mutable.allowedActionIds.push('N9-LATE-MUTATION');
    await expect(pending).resolves.toBeDefined();

    const validated = await validateN9SuccessorAuthorization(
      authorization,
      expected,
      baseline.root,
      policy,
      { evaluatedAt: '2026-09-02T12:00:00.000Z' },
    );
    const observations = [...await observationsFor(policy)];
    const planPending = buildN9EvidenceCapturePlan(baseline.root, policy, validated, observations);
    observations[0] = { ...observations[0], beforeIdentity: changed(observations[0].beforeIdentity) };
    await expect(planPending).resolves.toBeDefined();
  });

  it('keeps the pure successor boundary outside live, mutation, admission, grade, and closure authority', () => {
    const source = readFileSync('src/services/admission/n9-successor.ts', 'utf8');
    expect(source).not.toMatch(/(?:from|import).*?(?:provider|playwright|browser|D1Database|evidence-spine-manifest|grade|closure)/i);
    expect(source).not.toMatch(/D1Database|\.prepare\(|fetch\(|appendCandidate|admit|evaluateClosure/i);
  });
});
