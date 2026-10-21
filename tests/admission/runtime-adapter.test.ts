import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as runtimeAdapter from '../../src/services/admission/runtime-adapter';
import {
  deriveRuntimeProvenance,
  readCommittedReceipt,
} from '../../src/services/admission/product-receipts';
import { deriveEvidenceSpineBaseline } from '../../src/services/admission/evidence-spine-records';
import { canonicalDocument, type CanonicalJsonValue } from '../../src/services/admission/canonical-json';
import { contentIdentity, recordSha256, sha256Hex, type ContentIdentity } from '../../src/services/admission/identity';
import { validateEvidenceRecord } from '../../src/services/admission/evidence-spine-validation';
import type { ReceiptResolution, VerifiedRuntimeTargetV1 } from '../../src/services/admission/product-receipts';
import type { EvidenceSpineRootV1, SourceReceiptRefV1 } from '../../src/services/admission/evidence-spine-types';
import {
  canonicalExternalCaptureFixture,
  FIXTURE_ACCOUNT_CANARY,
  FIXTURE_BROWSER_CANARY,
  FIXTURE_CLAIM_CANARY,
  FIXTURE_PASSAGE_CANARY,
  createRuntimeReceiptFixture,
  type RuntimeReceiptFixture,
} from '../fixtures/admission/runtime-receipt-fixtures';

const fixtures: RuntimeReceiptFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function fixture(options: Parameters<typeof createRuntimeReceiptFixture>[0] = {}): Promise<RuntimeReceiptFixture> {
  const created = await createRuntimeReceiptFixture(options);
  fixtures.push(created);
  return created;
}

function expectUnresolved(value: ReceiptResolution, reason: string): void {
  expect(value).toEqual({ status: 'UNRESOLVED', reason });
}

function repositorySources() {
  const bytes = (path: string) => new Uint8Array(readFileSync(path));
  return {
    specification: bytes('docs/superpowers/specs/2026-09-01-socratic-ai-minimal-evidence-spine-design.md'),
    implementationPlan: bytes('docs/superpowers/plans/2026-09-01-socratic-ai-critical-path-b.md'),
    matrix: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json'),
    answerKey: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/COMPOSITE_ANSWER_KEY_CANDIDATE.md'),
    historicalTask4Capsule: bytes('docs/verification/socratic-ai-hle-northstar-2026-08-31/admission/inputs/task-4-cutoff-state-capsule.md'),
  };
}

function mutateWithGuardRestored(
  value: RuntimeReceiptFixture,
  triggerName: string,
  mutation: () => void,
): void {
  const row = value.sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?1
  `).get(triggerName) as { sql: string } | undefined;
  if (!row?.sql) throw new Error(`missing fixture trigger: ${triggerName}`);
  value.sqlite.exec(`DROP TRIGGER ${triggerName}`);
  mutation();
  value.sqlite.exec(row.sql);
}

type JsonObject = Record<string, any>;

const encoder = new TextEncoder();

function json(value: unknown): CanonicalJsonValue {
  return value as CanonicalJsonValue;
}

function cloneIdentity(value: ContentIdentity): ContentIdentity {
  return { byte_length: value.byte_length, sha256: value.sha256 };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function sortRefs(refs: readonly SourceReceiptRefV1[]): SourceReceiptRefV1[] {
  return [...refs].sort((left, right) => compareUtf8(
    `${left.receipt_kind}\u0000${left.receipt_id}`,
    `${right.receipt_kind}\u0000${right.receipt_id}`,
  ));
}

async function fixtureIdentity(seed: string): Promise<ContentIdentity> {
  return contentIdentity(canonicalDocument({ seed }));
}

function adapterFunction(name: string): (...args: any[]) => any {
  return (runtimeAdapter as unknown as Record<string, unknown>)[name] as (...args: any[]) => any;
}

type RuntimeFixtureGraph = {
  rootIdentity: ContentIdentity;
  subjectIdentity: ContentIdentity;
  accountScopeIdentity: ContentIdentity;
  sourceManifestRef: SourceReceiptRefV1;
  trainingContextRef: SourceReceiptRefV1;
  trainingSessionIdentity: ContentIdentity;
  turnAttemptRefs: SourceReceiptRefV1[];
  growthOriginIdentity: ContentIdentity;
  privateSpaceIdentity: ContentIdentity;
  growthCycleRef: SourceReceiptRefV1;
  aggregateRevision: number;
  target: VerifiedRuntimeTargetV1;
  receiptRefs: SourceReceiptRefV1[];
};

async function createExternalCaptureCase(): Promise<{
  root: EvidenceSpineRootV1;
  runtime: RuntimeFixtureGraph;
  carrier: JsonObject;
  carrierBytes: Uint8Array;
  carrierIdentity: ContentIdentity;
  target: VerifiedRuntimeTargetV1;
  receiptFixture: RuntimeReceiptFixture;
}> {
  const receiptFixture = await fixture();
  const baseline = await deriveEvidenceSpineBaseline(repositorySources());
  const subjectIdentity = await fixtureIdentity(`subject:${receiptFixture.sessionId}`);
  const accountScopeIdentity = await fixtureIdentity(`scope:${receiptFixture.ownerKey}`);
  const target: VerifiedRuntimeTargetV1 = {
    rootIdentity: cloneIdentity(baseline.rootIdentity),
    implementationPlanIdentity: cloneIdentity(baseline.sourceIdentities.implementationPlan),
    buildIdentity: await fixtureIdentity('build-artifact'),
    deploymentIdentity: await fixtureIdentity('deployment-artifact'),
    routeManifestIdentity: await fixtureIdentity('route-manifest'),
    controlPlaneIdentity: await fixtureIdentity('control-plane'),
    buildRef: {
      receipt_kind: 'BUILD',
      receipt_id: 'fixture-build-receipt',
      content_identity: await fixtureIdentity('build-receipt'),
    },
    deploymentRef: {
      receipt_kind: 'DEPLOYMENT',
      receipt_id: 'fixture-deployment-receipt',
      content_identity: await fixtureIdentity('deployment-receipt'),
    },
    controlPlaneRef: {
      receipt_kind: 'CONTROL_PLANE',
      receipt_id: 'fixture-control-plane-receipt',
      content_identity: await fixtureIdentity('control-plane-receipt'),
    },
  };
  const requirement = baseline.root.requirements[0];
  if (!requirement) throw new Error('fixture root requirement missing');
  const planSubject = {
    subject_type: 'TRAINING_SESSION',
    subject_key: receiptFixture.sessionId,
    content_identity: cloneIdentity(subjectIdentity),
  };
  const scope = {
    purpose_identity: await fixtureIdentity('artifact-purpose'),
    subject_identity: cloneIdentity(subjectIdentity),
    time_identity: await fixtureIdentity('artifact-time'),
    environment_identity: await fixtureIdentity('artifact-environment'),
    exclusion_identities: [],
  };
  const artifactId = 'fixture-runtime-artifact';
  const invocationRef = receiptFixture.refs.attempt;
  const sourceReceipts = sortRefs([
    target.buildRef,
    target.deploymentRef,
    target.controlPlaneRef,
    invocationRef,
  ]);
  const bindings = {
    source_receipts: sourceReceipts,
    build_identity: cloneIdentity(target.buildIdentity),
    deployment_identity: null,
    account_scope_identity: null,
    capture_environment_identity: null,
    retention_policy_identity: null,
    access_policy_identity: null,
    negative_control_result_ids: [],
    failure_tell_observations: [],
    claim_assertions: [],
    kind_details: {
      kind: 'RUNTIME',
      invocation_receipt_ids: [invocationRef.receipt_id],
      action_log_artifact_id: 'fixture-runtime-action-log',
      started_at: '2023-11-14T22:13:20.001Z',
      completed_at: '2023-11-14T22:13:20.002Z',
    },
  };
  const binding = {
    artifactId,
    sliceId: requirement.slice_id,
    gateId: requirement.gate,
    requirementIds: [requirement.id],
    artifactKind: 'RUNTIME',
    requiredCaptureKinds: ['BUILD', 'CONTROL_PLANE', 'DEPLOYMENT'],
    requiredReceiptKinds: sourceReceipts.map((ref) => ref.receipt_kind),
    maximumClaim: 'DETACHED_ARTIFACT_CANDIDATE_ONLY',
  };
  const plan = {
    schemaVersion: 'MES-ARTIFACT-CAPTURE-PLAN-1',
    rootIdentity: cloneIdentity(baseline.rootIdentity),
    implementationPlanIdentity: cloneIdentity(baseline.sourceIdentities.implementationPlan),
    subject: planSubject,
    accountScopeIdentity: cloneIdentity(accountScopeIdentity),
    buildIdentity: cloneIdentity(target.buildIdentity),
    deploymentIdentity: cloneIdentity(target.deploymentIdentity),
    routeManifestIdentity: cloneIdentity(target.routeManifestIdentity),
    controlPlaneIdentity: cloneIdentity(target.controlPlaneIdentity),
    bindings: [binding],
  };
  const planIdentity = await contentIdentity(canonicalDocument(json(plan)));
  const observation = {
    bindingIndex: 0,
    artifactId,
    capturedAt: '2023-11-14T22:13:20.002Z',
    privacySafeLocator: 'repo://fixture/runtime-artifact',
    artifactBytesIdentity: await fixtureIdentity('artifact-bytes'),
    evidenceLabel: 'CODE_VERIFIED',
    status: 'PASS',
    outcome: 'CLAIM_SUPPORTED',
    producer: {
      producer_id: 'fixture-external-capture',
      role: 'EXTERNAL_CAPTURE',
      vendor_family: 'fixture-vendor',
      attestation: 'fixture-attestation',
    },
    scope,
    limitations: [],
    artifactBindings: bindings,
  };
  const carrier: JsonObject = {
    schemaVersion: 'MES-EXTERNAL-CAPTURE-1',
    rootIdentity: cloneIdentity(baseline.rootIdentity),
    implementationPlanIdentity: cloneIdentity(baseline.sourceIdentities.implementationPlan),
    artifactCapturePlan: plan,
    artifactCapturePlanIdentity: planIdentity,
    subject: planSubject,
    accountScopeIdentity: cloneIdentity(accountScopeIdentity),
    buildRef: target.buildRef,
    deploymentRef: target.deploymentRef,
    controlPlaneRef: target.controlPlaneRef,
    externalContainerIdentity: await fixtureIdentity('external-container'),
    policyIdentity: await fixtureIdentity('external-policy'),
    independentReadbackIdentity: await fixtureIdentity('external-readback'),
    observations: [observation],
  };
  const canonical = await canonicalExternalCaptureFixture(carrier);
  const runtime: RuntimeFixtureGraph = {
    rootIdentity: cloneIdentity(baseline.rootIdentity),
    subjectIdentity: cloneIdentity(subjectIdentity),
    accountScopeIdentity: cloneIdentity(accountScopeIdentity),
    sourceManifestRef: receiptFixture.refs.sourceManifest,
    trainingContextRef: receiptFixture.refs.trainingContext,
    trainingSessionIdentity: await fixtureIdentity(`session:${receiptFixture.sessionId}`),
    turnAttemptRefs: [invocationRef],
    growthOriginIdentity: await fixtureIdentity('growth-origin'),
    privateSpaceIdentity: await fixtureIdentity('private-space'),
    growthCycleRef: {
      receipt_kind: 'GROWTH_CYCLE',
      receipt_id: 'fixture-growth-cycle',
      content_identity: await fixtureIdentity('growth-cycle-receipt'),
    },
    aggregateRevision: 1,
    target,
    receiptRefs: sortRefs([
      receiptFixture.refs.sourceManifest,
      receiptFixture.refs.trainingContext,
      invocationRef,
      {
        receipt_kind: 'GROWTH_CYCLE',
        receipt_id: 'fixture-growth-cycle',
        content_identity: await fixtureIdentity('growth-cycle-receipt'),
      },
      target.buildRef,
      target.deploymentRef,
      target.controlPlaneRef,
    ]),
  };
  return {
    root: baseline.root,
    runtime,
    carrier,
    carrierBytes: canonical.carrierBytes,
    carrierIdentity: canonical.carrierIdentity,
    target,
    receiptFixture,
  };
}

function expectNonPassing(value: unknown, reason?: string): void {
  expect(value).toMatchObject({
    outcome: expect.stringMatching(/^(FAIL|UNKNOWN|UNGRADABLE)$/),
    failureTellIds: [],
    receiptRefs: expect.any(Array),
  });
  if (reason) expect(value).toMatchObject({ reason });
}

async function reencodeCarrier(carrier: JsonObject): Promise<{
  bytes: Uint8Array;
  identity: ContentIdentity;
}> {
  const bytes = canonicalDocument(json(carrier));
  return { bytes, identity: await contentIdentity(bytes) };
}

describe('Critical Path B detached runtime adapter contract', () => {
  it('exposes only the approved receipt, provenance, and detached-candidate seams', () => {
    expect([
      readCommittedReceipt,
      deriveRuntimeProvenance,
      adapterFunction('verifyFrozenArtifactCapturePlan'),
      adapterFunction('deriveVerifiedArtifactProvenance'),
      adapterFunction('buildArtifactCandidate'),
    ].every((value) => typeof value === 'function')).toBe(true);
  });

  it('resolves the exact owner-scoped 0064 Training manifest, context, and terminal attempt', async () => {
    const value = await fixture();
    const resolutions = await Promise.all([
      readCommittedReceipt(value.db, value.ownerKey, value.refs.sourceManifest),
      readCommittedReceipt(value.db, value.ownerKey, value.refs.trainingContext),
      readCommittedReceipt(value.db, value.ownerKey, value.refs.attempt),
    ]);

    expect(resolutions.map((resolution) => resolution.status)).toEqual([
      'RESOLVED', 'RESOLVED', 'RESOLVED',
    ]);
    for (const resolution of resolutions) {
      if (resolution.status !== 'RESOLVED') throw new Error('expected resolved receipt');
      expect(resolution.integrityProof.proofKind).toBe('D1_IMMUTABLE_CORE');
      expect(resolution.privacy).toBe('PUBLIC_METADATA');
      expect(resolution.canonicalBytes).toEqual(expect.any(Uint8Array));
      expect(Object.isFrozen(resolution)).toBe(true);
      expect(Object.isFrozen(resolution.payload)).toBe(true);
      expect(await contentIdentity(resolution.canonicalBytes)).toEqual(resolution.ref.content_identity);
      expect(Object.keys(resolution.payload).sort()).toEqual([
        'accountScopeIdentity', 'causal', 'receiptKind', 'subjectIdentity',
      ]);
    }
    expect(Object.keys((resolutions[0] as Extract<ReceiptResolution, { status: 'RESOLVED' }>).payload.causal).sort())
      .toEqual(['manifestIdentity', 'sessionContextIdentity', 'sourceItemIdentities']);
  });

  it('fails closed for missing, unowned, changed, mutable, and contextless Training rows', async () => {
    const value = await fixture();
    const wrongIdentity = {
      ...value.refs.trainingContext,
      content_identity: { byte_length: 1, sha256: '0'.repeat(64) },
    };
    const missing = { ...value.refs.attempt, receipt_id: 'missing-attempt' };

    expectUnresolved(
      await readCommittedReceipt(value.db, 'fixture-account-private-canary-b', value.refs.trainingContext),
      'OWNER_MISMATCH',
    );
    expectUnresolved(await readCommittedReceipt(value.db, value.ownerKey, missing), 'MISSING');
    expectUnresolved(await readCommittedReceipt(value.db, value.ownerKey, wrongIdentity), 'CONTENT_MISMATCH');

    const mutable = await fixture({ sessionId: 'training-fixture-b', contextId: 'trctx_fixture_b', attemptId: 'attempt-fixture-b-1' });
    mutable.sqlite.exec('DROP TRIGGER ai_invocation_attempts_context_immutable_update');
    mutable.sqlite.prepare(`UPDATE ai_invocation_attempts SET response_sha256 = ?1 WHERE id = ?2`)
      .run('6'.repeat(64), mutable.attemptId);
    expectUnresolved(
      await readCommittedReceipt(mutable.db, mutable.ownerKey, mutable.refs.attempt),
      'MUTABLE',
    );

    const legacy = await fixture({ sessionId: 'training-fixture-c', contextId: 'trctx_fixture_c', attemptId: 'attempt-fixture-c-1' });
    legacy.sqlite.exec('DROP TRIGGER ai_invocation_attempts_context_immutable_update');
    legacy.sqlite.prepare(`
      UPDATE ai_invocation_attempts SET
        session_context_id = NULL, session_id = NULL, turn_number = NULL,
        prompt_cache_namespace = NULL
      WHERE id = ?1
    `).run(legacy.attemptId);
    expectUnresolved(
      await readCommittedReceipt(legacy.db, legacy.ownerKey, legacy.refs.attempt),
      'MUTABLE',
    );
  });

  it('recomputes source hashes, ordering, counts, and the scenario manifest instead of trusting labels', async () => {
    const value = await fixture();
    const first = await readCommittedReceipt(value.db, value.ownerKey, value.refs.sourceManifest);
    expect(first.status).toBe('RESOLVED');
    mutateWithGuardRestored(value, 'training_scenario_evidence_bound_immutable_update', () => {
      value.sqlite.prepare(`
        UPDATE training_scenario_evidence
        SET excerpt = ?1
        WHERE session_id = ?2 AND selection_index = 0
      `).run('changed bytes under a copied receipt id', value.sessionId);
    });

    expectUnresolved(
      await readCommittedReceipt(value.db, value.ownerKey, value.refs.sourceManifest),
      'CONTENT_MISMATCH',
    );
    if (first.status !== 'RESOLVED') throw new Error('expected resolved receipt');
    const before = new Uint8Array(first.canonicalBytes);
    expect(first.canonicalBytes).toEqual(before);
  });

  it('requires the exact 0064 trigger definitions and complete transitive guard closure', async () => {
    const cases = [
      ['training_session_contexts_existing_identity_guard', 'trainingContext'],
      ['training_session_contexts_owner_and_pack_guard', 'trainingContext'],
      ['training_session_contexts_immutable_update', 'trainingContext'],
      ['training_session_contexts_delete_dependencies_first', 'trainingContext'],
      ['training_session_contexts_governed_delete_only', 'trainingContext'],
      ['training_scenario_packs_bound_existing_identity_guard', 'sourceManifest'],
      ['training_scenario_packs_bound_immutable_update', 'sourceManifest'],
      ['training_scenario_packs_bound_delete_dependencies_first', 'sourceManifest'],
      ['training_scenario_packs_bound_governed_delete', 'sourceManifest'],
      ['training_scenario_evidence_bound_existing_identity_guard', 'sourceManifest'],
      ['training_scenario_evidence_bound_immutable_update', 'sourceManifest'],
      ['training_scenario_evidence_bound_governed_delete', 'sourceManifest'],
      ['ai_invocation_attempts_context_existing_identity_guard', 'attempt'],
      ['ai_invocation_attempts_context_immutable_update', 'attempt'],
      ['ai_invocation_attempts_context_immutable_delete', 'attempt'],
      ['ai_invocation_attempts_context_link_guard', 'attempt'],
    ] as const;

    for (const [triggerName, refName] of cases) {
      const value = await fixture();
      const trigger = value.sqlite.prepare(`
        SELECT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name = ?1
      `).get(triggerName) as { tbl_name: string } | undefined;
      if (!trigger || !/^[a-z0-9_]+$/.test(trigger.tbl_name)) throw new Error('invalid fixture trigger table');
      value.sqlite.exec(`DROP TRIGGER ${triggerName}`);
      value.sqlite.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON ${trigger.tbl_name}
        BEGIN SELECT 1; END;
      `);
      expectUnresolved(
        await readCommittedReceipt(value.db, value.ownerKey, value.refs[refName]),
        'MUTABLE',
      );
    }
  });

  it('rejects stale evidence lifecycle and invalid closed route plans even after exact guards are restored', async () => {
    const stale = await fixture();
    stale.sqlite.prepare(`UPDATE training_scenario_evidence SET lifecycle_status = 'deleted' WHERE session_id = ?1`)
      .run(stale.sessionId);
    expectUnresolved(
      await readCommittedReceipt(stale.db, stale.ownerKey, stale.refs.sourceManifest),
      'STALE',
    );

    const route = await fixture({ sessionId: 'training-route', contextId: 'trctx_route', attemptId: 'attempt-route-1' });
    mutateWithGuardRestored(route, 'training_session_contexts_immutable_update', () => {
      route.sqlite.prepare(`UPDATE training_session_contexts SET route_plan_json = ?1 WHERE id = ?2`)
        .run(JSON.stringify({ interactive_generation: ['not-an-authorized-route'] }), route.contextId);
    });
    expectUnresolved(
      await readCommittedReceipt(route.db, route.ownerKey, route.refs.trainingContext),
      'CONTENT_MISMATCH',
    );
    expectUnresolved(
      await readCommittedReceipt(route.db, route.ownerKey, route.refs.attempt),
      'CONTENT_MISMATCH',
    );
  });

  it('rejects unverified carriers and disconnected Training subject graphs before promotion', async () => {
    const fixtureA = await fixture();
    const fixtureB = await fixture({
      ownerKey: fixtureA.ownerKey,
      sessionId: 'training-fixture-b',
      contextId: 'trctx_fixture_b',
      attemptId: 'attempt-fixture-b-1',
    });
    const [manifestA, contextA, attemptB] = await Promise.all([
      readCommittedReceipt(fixtureA.db, fixtureA.ownerKey, fixtureA.refs.sourceManifest),
      readCommittedReceipt(fixtureA.db, fixtureA.ownerKey, fixtureA.refs.trainingContext),
      readCommittedReceipt(fixtureB.db, fixtureB.ownerKey, fixtureB.refs.attempt),
    ]);
    const untrustedClone = manifestA.status === 'RESOLVED'
      ? ({ ...manifestA } as ReceiptResolution)
      : manifestA;

    const root = (await deriveEvidenceSpineBaseline(repositorySources())).root;
    expect(deriveRuntimeProvenance(root, [untrustedClone])).toMatchObject({
      outcome: 'UNGRADABLE', reason: 'AUTHORITY_MISSING',
    });
    expect(deriveRuntimeProvenance(root, [manifestA, contextA, attemptB])).toMatchObject({
      outcome: 'UNKNOWN', reason: 'SUBJECT_GRAPH_DISCONNECTED',
    });
    if (manifestA.status !== 'RESOLVED') throw new Error('expected resolved receipt');
    manifestA.canonicalBytes[0] ^= 1;
    expect(deriveRuntimeProvenance(root, [manifestA])).toMatchObject({
      outcome: 'UNGRADABLE', reason: 'AUTHORITY_MISSING',
    });
  });

  it('keeps seeded private canaries and their direct plaintext hashes outside verified receipt bytes', async () => {
    const value = await fixture();
    const resolutions = await Promise.all([
      readCommittedReceipt(value.db, value.ownerKey, value.refs.sourceManifest),
      readCommittedReceipt(value.db, value.ownerKey, value.refs.trainingContext),
      readCommittedReceipt(value.db, value.ownerKey, value.refs.attempt),
    ]);
    const bytes = resolutions
      .filter((resolution): resolution is Extract<ReceiptResolution, { status: 'RESOLVED' }> => resolution.status === 'RESOLVED')
      .map((resolution) => new TextDecoder().decode(resolution.canonicalBytes))
      .join('\n');
    for (const canary of [
      FIXTURE_ACCOUNT_CANARY,
      FIXTURE_PASSAGE_CANARY,
      FIXTURE_CLAIM_CANARY,
      FIXTURE_BROWSER_CANARY,
    ]) {
      expect(bytes).not.toContain(canary);
      expect(bytes).not.toContain(await sha256Hex(new TextEncoder().encode(canary)));
    }
  });

  it('stops at explicit authority absence rather than inventing the unavailable artifact binding', async () => {
    await expect(adapterFunction('buildArtifactCandidate')({} as never)).resolves.toEqual({
      outcome: 'UNGRADABLE',
      reason: 'AUTHORITY_MISSING',
      failureTellIds: [],
      receiptRefs: [],
    });

  });

  it('keeps the detached adapter outside manifest, grade, closure, provider, and browser authority', () => {
    const source = readFileSync('src/services/admission/runtime-adapter.ts', 'utf8');
    expect(source).not.toMatch(/evidence-spine-manifest|evidence-spine-projection|append|admission|grade|closure|http|fetch|provider|playwright|browser|D1Database|\.prepare\s*\(/i);
  });

  it('freezes a canonical external capture carrier and derives a detached runtime artifact', async () => {
    const value = await createExternalCaptureCase();
    const frozen = await adapterFunction('verifyFrozenArtifactCapturePlan')(
      value.root,
      value.runtime,
      value.carrierBytes,
      value.carrierIdentity,
    );
    expect(frozen).toMatchObject({
      planIdentity: value.carrier.artifactCapturePlanIdentity,
      carrierIdentity: value.carrierIdentity,
    });
    expect(frozen.carrierBytes).toEqual(value.carrierBytes);

    const provenance = await adapterFunction('deriveVerifiedArtifactProvenance')(
      value.root,
      value.runtime,
      frozen,
      0,
    );
    expect(provenance).toMatchObject({
      rootIdentity: value.root && value.carrier.rootIdentity,
      artifactCapturePlanIdentity: value.carrier.artifactCapturePlanIdentity,
      carrierIdentity: value.carrierIdentity,
      bindingIndex: 0,
      binding: value.carrier.artifactCapturePlan.bindings[0],
      observation: value.carrier.observations[0],
      target: value.target,
    });

    const candidate = await adapterFunction('buildArtifactCandidate')(
      value.root,
      value.runtime,
      frozen,
      0,
    );
    expect(candidate).toMatchObject({
      record: {
        schema_version: 'MES-1',
        record_family: 'ARTIFACT',
        root_identity: value.carrier.rootIdentity,
        subject_identity: value.carrier.artifactCapturePlan.subject,
        created_at: value.carrier.observations[0].capturedAt,
        producer_identity: value.carrier.observations[0].producer,
        source_receipts: value.carrier.observations[0].artifactBindings.source_receipts,
        limitations: value.carrier.observations[0].limitations,
        payload: {
          id: value.carrier.artifactCapturePlan.bindings[0].artifactId,
          slice_id: value.carrier.artifactCapturePlan.bindings[0].sliceId,
          gate: value.carrier.artifactCapturePlan.bindings[0].gateId,
          evidence_requirement_ids: value.carrier.artifactCapturePlan.bindings[0].requirementIds,
          path_or_url: value.carrier.observations[0].privacySafeLocator,
          sha256: value.carrier.observations[0].artifactBytesIdentity.sha256,
          captured_at: value.carrier.observations[0].capturedAt,
          evidence_label: value.carrier.observations[0].evidenceLabel,
          outcome: value.carrier.observations[0].outcome,
          status: value.carrier.observations[0].status,
          scope: value.carrier.observations[0].scope,
          limitations: value.carrier.observations[0].limitations,
          kind: value.carrier.artifactCapturePlan.bindings[0].artifactKind,
          bindings: value.carrier.observations[0].artifactBindings,
        },
      },
    });
    const body = { ...candidate.record } as JsonObject;
    delete body.record_id;
    expect(candidate.record.record_id).toBe(await recordSha256(json(body)));
    expect(candidate.record.evidence_key).toBe(await recordSha256(json({
      schema_version: 'MES-EVIDENCE-KEY-1',
      record_family: 'ARTIFACT',
      root_identity: candidate.record.root_identity,
      artifact_kind: candidate.record.payload.kind,
      subject_identity: candidate.record.subject_identity,
      requirement_ids: candidate.record.payload.evidence_requirement_ids,
    })));
    const pendingIdentity = await contentIdentity(canonicalDocument({ schema_version: 'MES-REVIEW-PENDING-1' }));
    expect(candidate.record.independent_review).toEqual({
      builder_identity: candidate.record.producer_identity.producer_id,
      reviewer_identity: 'UNKNOWN',
      separation: 'UNKNOWN',
      review_output_identity: pendingIdentity,
      verdict: 'UNKNOWN',
      vendor_family: 'UNKNOWN',
    });
    expect(() => validateEvidenceRecord(candidate.record)).not.toThrow();
    expect(candidate.canonical_bytes).toEqual(canonicalDocument(json(candidate.record)));
    expect(candidate.record_identity).toEqual(await contentIdentity(candidate.canonical_bytes));
  });

  it('rejects a carrier with absent, wrong, or noncanonical bytes before provenance derivation', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    expectNonPassing(await verify(value.root, value.runtime, new Uint8Array(), value.carrierIdentity), 'AUTHORITY_MISSING');
    expectNonPassing(await verify(value.root, value.runtime, value.carrierBytes, {
      byte_length: value.carrierIdentity.byte_length,
      sha256: '0'.repeat(64),
    }), 'CONTENT_MISMATCH');
    const noncanonical = encoder.encode(` ${new TextDecoder().decode(value.carrierBytes)}`);
    expectNonPassing(await verify(value.root, value.runtime, noncanonical, value.carrierIdentity));
  });

  it('rejects root, plan, subject, scope, and resolved-target drift', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const scopeDrift = await fixtureIdentity('scope-drift');
    const targetDrift = await fixtureIdentity('target-drift');
    const carrierMutators: Array<(carrier: JsonObject) => void> = [
      (carrier) => { carrier.rootIdentity = { ...carrier.rootIdentity, sha256: '1'.repeat(64) }; },
      (carrier) => { carrier.artifactCapturePlan.rootIdentity = { ...carrier.artifactCapturePlan.rootIdentity, sha256: '2'.repeat(64) }; },
      (carrier) => { carrier.subject = { ...carrier.subject, subject_key: 'different-session' }; },
      (carrier) => { carrier.observations[0].scope = { ...carrier.observations[0].scope, subject_identity: scopeDrift }; },
    ];
    for (const mutate of carrierMutators) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      mutate(candidate);
      const bytes = canonicalDocument(json(candidate));
      expectNonPassing(await verify(value.root, value.runtime, bytes, await contentIdentity(bytes)));
    }
    const targetRuntime = {
      ...value.runtime,
      target: { ...value.target, deploymentIdentity: targetDrift },
    };
    expectNonPassing(await verify(value.root, targetRuntime, value.carrierBytes, value.carrierIdentity));
  });

  it('rejects carrier subject content-identity drift even when outer bytes and identity are recomputed', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    candidate.subject.content_identity = await fixtureIdentity('carrier-subject-drift');
    const encoded = await reencodeCarrier(candidate);
    expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
  });

  it('rejects unknown top-level proof fields instead of widening the exact carrier schema', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    for (const [key, field] of [
      ['integrityProof', { proofKind: 'COMMITTED_EXTERNAL_CONTAINER' }],
      ['proofKind', 'COMMITTED_EXTERNAL_CONTAINER'],
    ] as const) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      candidate[key] = field;
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
  });

  it('exhaustively validates structural runtime provenance before using the carrier graph', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const malformedRuntime = {
      ...value.runtime,
      growthCycleRef: { ...value.runtime.growthCycleRef, receipt_kind: 'BUILD' },
    };
    expectNonPassing(await verify(value.root, malformedRuntime, value.carrierBytes, value.carrierIdentity));

    const missingRuntimeReceipt = {
      ...value.runtime,
      receiptRefs: value.runtime.receiptRefs.filter((ref) => ref.receipt_kind !== 'DEPLOYMENT'),
    };
    expectNonPassing(await verify(value.root, missingRuntimeReceipt, value.carrierBytes, value.carrierIdentity));
  });

  it('requires the three literal external target refs and exact target identities', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const refCases = [
      ['buildRef', 'SOURCE_MANIFEST'],
      ['deploymentRef', 'BUILD'],
      ['controlPlaneRef', 'DEPLOYMENT'],
    ] as const;
    for (const [key, kind] of refCases) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      candidate[key].receipt_kind = kind;
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
    const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    candidate.buildRef.content_identity = await fixtureIdentity('different-build-receipt');
    const encoded = await reencodeCarrier(candidate);
    expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
  });

  it('rejects duplicate bindings, artifact observations, receipts, or set members', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const cases: Array<(carrier: JsonObject) => void> = [
      (carrier) => { carrier.artifactCapturePlan.bindings.push(carrier.artifactCapturePlan.bindings[0]); },
      (carrier) => { carrier.observations.push(carrier.observations[0]); },
      (carrier) => { carrier.observations[0].artifactBindings.source_receipts.push(carrier.observations[0].artifactBindings.source_receipts[0]); },
      (carrier) => { carrier.artifactCapturePlan.bindings[0].requirementIds.push(carrier.artifactCapturePlan.bindings[0].requirementIds[0]); },
    ];
    for (const mutate of cases) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      mutate(candidate);
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
  });

  it('uses artifactBindings as the sole canonical receipt and kind source', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const extraCases: Array<(carrier: JsonObject) => void> = [
      (carrier) => { carrier.observations[0].source_receipts = []; },
      (carrier) => { carrier.observations[0].kind_details = { kind: 'STATIC' }; },
      (carrier) => { carrier.observations[0].review = { verdict: 'ADMIT' }; },
      (carrier) => { carrier.observations[0].artifactBindings.kind_details.kind = 'STATIC'; },
      (carrier) => { carrier.observations[0].artifactBindings.source_receipts[0].receipt_kind = 'BUILD'; },
    ];
    for (const mutate of extraCases) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      mutate(candidate);
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
  });

  it('requires committed-container, policy, and independent-readback identities', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    for (const key of ['externalContainerIdentity', 'policyIdentity', 'independentReadbackIdentity']) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      delete candidate[key];
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
    const fake = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    fake.independentReadbackIdentity = cloneIdentity(value.carrier.externalContainerIdentity);
    const encoded = await reencodeCarrier(fake);
    expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));

    const invalid = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    invalid.policyIdentity = { byte_length: -1, sha256: 'invalid' };
    const invalidEncoded = await reencodeCarrier(invalid);
    expectNonPassing(await verify(value.root, value.runtime, invalidEncoded.bytes, invalidEncoded.identity));

    for (const [left, right] of [
      ['externalContainerIdentity', 'policyIdentity'],
      ['externalContainerIdentity', 'independentReadbackIdentity'],
      ['policyIdentity', 'independentReadbackIdentity'],
    ] as const) {
      const collision = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      collision[right] = cloneIdentity(collision[left]);
      const collisionEncoded = await reencodeCarrier(collision);
      expectNonPassing(await verify(value.root, value.runtime, collisionEncoded.bytes, collisionEncoded.identity));
    }
  });

  it('binds non-null artifact policy fields to the normalized carrier policy identity', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const policyBound = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    policyBound.artifactCapturePlan.bindings[0].artifactKind = 'AUTHENTICATED_E2E';
    policyBound.observations[0].artifactBindings.kind_details = {
      kind: 'AUTHENTICATED_E2E',
      journey_id: 'fixture-journey',
      step_ids: ['fixture-step'],
      action_log_artifact_id: 'fixture-action-log',
      capture_artifact_ids: ['fixture-capture'],
      korean_comprehension_artifact_id: 'fixture-korean',
      isolation_result_ids: ['fixture-isolation'],
    };
    policyBound.observations[0].artifactBindings.deployment_identity = cloneIdentity(value.target.deploymentIdentity);
    policyBound.observations[0].artifactBindings.account_scope_identity = cloneIdentity(value.runtime.accountScopeIdentity);
    policyBound.observations[0].artifactBindings.capture_environment_identity = cloneIdentity(
      value.carrier.observations[0].scope.environment_identity,
    );
    policyBound.observations[0].artifactBindings.retention_policy_identity = cloneIdentity(policyBound.policyIdentity);
    policyBound.observations[0].artifactBindings.access_policy_identity = cloneIdentity(policyBound.policyIdentity);
    policyBound.artifactCapturePlanIdentity = await contentIdentity(
      canonicalDocument(json(policyBound.artifactCapturePlan)),
    );
    const validEncoded = await reencodeCarrier(policyBound);
    const valid = await verify(value.root, value.runtime, validEncoded.bytes, validEncoded.identity);
    expect(valid).toMatchObject({ carrierIdentity: validEncoded.identity });

    const mismatch = JSON.parse(JSON.stringify(policyBound)) as JsonObject;
    mismatch.observations[0].artifactBindings.retention_policy_identity = await fixtureIdentity('wrong-policy');
    const mismatchEncoded = await reencodeCarrier(mismatch);
    expectNonPassing(await verify(value.root, value.runtime, mismatchEncoded.bytes, mismatchEncoded.identity));
  });

  it('rejects unsupported artifact kinds and receipt kinds disconnected from the binding', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const cases: Array<(carrier: JsonObject) => void> = [
      (carrier) => { carrier.artifactCapturePlan.bindings[0].artifactKind = 'ACCESSIBILITY'; },
      (carrier) => { carrier.artifactCapturePlan.bindings[0].requiredReceiptKinds = ['SOURCE_MANIFEST']; },
      (carrier) => { carrier.observations[0].artifactBindings.kind_details.invocation_receipt_ids = ['unknown-attempt']; },
      (carrier) => { carrier.observations[0].artifactId = 'different-artifact'; },
    ];
    for (const mutate of cases) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      mutate(candidate);
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
  });

  it('rejects bindings outside the root slice, gate, and requirement graph', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const alternatives = [
      (carrier: JsonObject) => { carrier.artifactCapturePlan.bindings[0].sliceId = 'N10'; },
      (carrier: JsonObject) => { carrier.artifactCapturePlan.bindings[0].gateId = 'V0'; },
      (carrier: JsonObject) => { carrier.artifactCapturePlan.bindings[0].requirementIds = ['not-a-root-requirement']; },
    ];
    for (const mutate of alternatives) {
      const candidate = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
      mutate(candidate);
      const encoded = await reencodeCarrier(candidate);
      expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
    }
  });

  it('rejects binding IDs used as record or evidence identities and never accepts external review', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const frozen = await verify(value.root, value.runtime, value.carrierBytes, value.carrierIdentity);
    if ('carrierBytes' in (frozen as object)) {
      const candidate = await adapterFunction('buildArtifactCandidate')(value.root, value.runtime, frozen, 0);
      expect(candidate.record.record_id).not.toBe(value.carrier.artifactCapturePlan.bindings[0].artifactId);
      expect(candidate.record.evidence_key).not.toBe(value.carrier.artifactCapturePlan.bindings[0].artifactId);
    }
    const externalReview = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    externalReview.observations[0].independent_review = {
      builder_identity: 'fixture-external-capture',
      reviewer_identity: 'someone-else',
      separation: 'VERIFIED',
      review_output_identity: await fixtureIdentity('review'),
      verdict: 'ADMIT',
      vendor_family: 'other-vendor',
    };
    const encoded = await reencodeCarrier(externalReview);
    expectNonPassing(await verify(value.root, value.runtime, encoded.bytes, encoded.identity));
  });

  it('reparses frozen bytes after wrapper mutation and preserves manifest/projection fixtures', async () => {
    const value = await createExternalCaptureCase();
    const baseline = await deriveEvidenceSpineBaseline(repositorySources());
    const beforeManifest = canonicalDocument(json(baseline.verifiedPrefix));
    const beforeProjection = canonicalDocument(json(baseline.projection));
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const frozen = await verify(value.root, value.runtime, value.carrierBytes, value.carrierIdentity);
    expect(frozen).toMatchObject({ carrierBytes: value.carrierBytes });
    const mutableWrapper = {
      ...(frozen as any),
      plan: JSON.parse(JSON.stringify((frozen as any).plan)),
      carrier: JSON.parse(JSON.stringify((frozen as any).carrier)),
    } as any;
    mutableWrapper.plan.bindings[0].artifactId = 'wrapper-only-mutation';
    mutableWrapper.carrier.observations[0].artifactId = 'wrapper-only-observation-mutation';
    const provenance = await adapterFunction('deriveVerifiedArtifactProvenance')(value.root, value.runtime, mutableWrapper, 0);
    expect(provenance.binding.artifactId).toBe(value.carrier.artifactCapturePlan.bindings[0].artifactId);
    const candidate = await adapterFunction('buildArtifactCandidate')(value.root, value.runtime, mutableWrapper, 0);
    expect(candidate.record.payload.id).toBe(value.carrier.artifactCapturePlan.bindings[0].artifactId);
    expect(canonicalDocument(json(baseline.verifiedPrefix))).toEqual(beforeManifest);
    expect(canonicalDocument(json(baseline.projection))).toEqual(beforeProjection);
  });

  it('rejects retained carrier-byte mutation in both provenance derivation and candidate construction', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const frozen = await verify(value.root, value.runtime, value.carrierBytes, value.carrierIdentity);
    expect(frozen).toMatchObject({ carrierBytes: value.carrierBytes });
    frozen.carrierBytes[0] ^= 1;
    expectNonPassing(await adapterFunction('deriveVerifiedArtifactProvenance')(value.root, value.runtime, frozen, 0));
    expectNonPassing(await adapterFunction('buildArtifactCandidate')(value.root, value.runtime, frozen, 0));
  });

  it('rejects raw privacy canaries and a deterministic plaintext-hash canary', async () => {
    const value = await createExternalCaptureCase();
    const verify = adapterFunction('verifyFrozenArtifactCapturePlan');
    const raw = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    raw.observations[0].privacySafeLocator = `repo://fixture/${FIXTURE_CLAIM_CANARY}`;
    const rawEncoded = await reencodeCarrier(raw);
    expectNonPassing(await verify(value.root, value.runtime, rawEncoded.bytes, rawEncoded.identity));

    const hashed = JSON.parse(JSON.stringify(value.carrier)) as JsonObject;
    const plaintext = value.carrier.observations[0].privacySafeLocator;
    hashed.observations[0].artifactBytesIdentity = {
      byte_length: plaintext.length,
      sha256: await sha256Hex(encoder.encode(plaintext)),
    };
    const hashedEncoded = await reencodeCarrier(hashed);
    expectNonPassing(await verify(value.root, value.runtime, hashedEncoded.bytes, hashedEncoded.identity));
  });
});
