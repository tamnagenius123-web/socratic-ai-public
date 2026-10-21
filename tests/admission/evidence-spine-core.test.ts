import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalDocument, parseAuthorityJson, type CanonicalJsonValue } from '../../src/services/admission/canonical-json';
import {
  deriveEvidenceSpineBaseline,
  type EvidenceSpineRepositorySources,
} from '../../src/services/admission/evidence-spine-records';
import { verifyManifestPrefix } from '../../src/services/admission/evidence-spine-manifest';
import { projectEvidenceSpine } from '../../src/services/admission/evidence-spine-projection';
import { loadEvidenceSpineRoot } from '../../src/services/admission/evidence-spine-root';
import type {
  EvidenceManifestEntryV1,
  EvidenceRecordV1,
  ExpectedRootIdentities,
  RootSourceBytes,
} from '../../src/services/admission/evidence-spine-types';
import { contentIdentity } from '../../src/services/admission/identity';

const repositoryPaths = Object.freeze({
  specification: 'docs/superpowers/specs/2026-09-01-socratic-ai-minimal-evidence-spine-design.md',
  implementationPlan: 'docs/superpowers/plans/2026-09-01-socratic-ai-critical-path-b.md',
  matrix: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/slice-acceptance-matrix.json',
  answerKey: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/COMPOSITE_ANSWER_KEY_CANDIDATE.md',
  historicalTask4Capsule: 'docs/verification/socratic-ai-hle-northstar-2026-08-31/admission/inputs/task-4-cutoff-state-capsule.md',
});

const outputRoot = 'docs/verification/socratic-ai-hle-northstar-2026-08-31/critical-path-b';
const outputPaths = Object.freeze({
  failureTellDefinitions: `${outputRoot}/sources/failure-tells.json`,
  negativeControlDefinitions: `${outputRoot}/sources/negative-controls.json`,
  successorLaneDefinition: `${outputRoot}/sources/n9-successor-lane.json`,
  firstVerticalJourney: `${outputRoot}/sources/first-korean-vertical.json`,
  recordSchemas: `${outputRoot}/sources/record-schemas.json`,
  deterministicReducer: `${outputRoot}/sources/reducer.json`,
  task13Experiment: `${outputRoot}/sources/task-13-experiment.json`,
  closureRule: `${outputRoot}/sources/closure-rule.json`,
  n9SuccessorPolicy: `${outputRoot}/sources/n9-successor-policy.json`,
  root: `${outputRoot}/root.json`,
  manifest: `${outputRoot}/manifest.jsonl`,
  projection: `${outputRoot}/projection.json`,
});

const approvedRepositoryIdentities = Object.freeze({
  specification: { byte_length: 37324, sha256: '132454449036677bbc39678bbf5a31f7f2fd0990860e59a9bcd7b2aef237c59f' },
  implementationPlan: { byte_length: 80405, sha256: 'e4aca90670bebe7adcee106d4df2d63ef6ec01ca476faab4029fd9ba59869756' },
  matrix: { byte_length: 66605, sha256: '6e0184e7c771bad7e95604c8cfc37b0e006064ec9dc9d5a06129b482842f4d60' },
  answerKey: { byte_length: 26213, sha256: '4f16ccdbb7c2d1dceda1994dca49d7e867d3404bf66c4494a3fcccb8fa239137' },
  historicalTask4Capsule: { byte_length: 8942, sha256: '8e04132ffdbd97aea93f49ffedc411d39bccf4a8fe4c6519483ff8aa8f783654' },
});

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(process.cwd(), path)));
}

function repositorySources(): EvidenceSpineRepositorySources {
  return {
    specification: bytes(repositoryPaths.specification),
    implementationPlan: bytes(repositoryPaths.implementationPlan),
    matrix: bytes(repositoryPaths.matrix),
    answerKey: bytes(repositoryPaths.answerKey),
    historicalTask4Capsule: bytes(repositoryPaths.historicalTask4Capsule),
  };
}

function expectExactBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

describe('Critical Path B truthful zero-promotion baseline', () => {
  it('rehashes every approved repository source before deriving authority bytes', async () => {
    const sources = repositorySources();
    for (const key of Object.keys(repositoryPaths) as Array<keyof typeof repositoryPaths>) {
      expect(await contentIdentity(sources[key])).toEqual(approvedRepositoryIdentities[key]);
    }
    const before = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, new Uint8Array(value)]));
    await deriveEvidenceSpineBaseline(sources);
    for (const key of Object.keys(repositoryPaths) as Array<keyof typeof repositoryPaths>) {
      expectExactBytes(sources[key], before[key]);
    }
  });

  it.each(Object.keys(repositoryPaths) as Array<keyof typeof repositoryPaths>)(
    'rejects changed approved %s bytes before deriving a baseline',
    async (key) => {
      const sources = repositorySources();
      const changed = new Uint8Array(sources[key]);
      changed[0] ^= 0x01;
      const candidate = { ...sources, [key]: changed };
      await expect(deriveEvidenceSpineBaseline(candidate)).rejects.toThrow(
        `MES_BASELINE_SOURCE_IDENTITY_MISMATCH:${key}`,
      );
    },
  );

  it('rebuilds and rereads the exact canonical root, genesis, and zero-promotion projection', async () => {
    const derived = await deriveEvidenceSpineBaseline(repositorySources());
    for (const key of Object.keys(derived.documents.sources) as Array<keyof typeof derived.documents.sources>) {
      const settled = bytes(outputPaths[key]);
      expectExactBytes(settled, derived.documents.sources[key]);
      expectExactBytes(canonicalDocument(parseAuthorityJson(settled)), settled);
      expect(await contentIdentity(settled)).toEqual(derived.sourceIdentities[key]);
    }

    const settledRoot = bytes(outputPaths.root);
    const settledManifest = bytes(outputPaths.manifest);
    const settledProjection = bytes(outputPaths.projection);
    expectExactBytes(settledRoot, derived.documents.root);
    expectExactBytes(settledManifest, derived.documents.manifest);
    expectExactBytes(settledProjection, derived.documents.projection);
    expectExactBytes(canonicalDocument(parseAuthorityJson(settledRoot)), settledRoot);
    expectExactBytes(canonicalDocument(parseAuthorityJson(settledManifest)), settledManifest);
    expectExactBytes(canonicalDocument(parseAuthorityJson(settledProjection)), settledProjection);
    expect(Array.from(settledManifest).filter((value) => value === 0x0a)).toHaveLength(1);
    expect(await contentIdentity(settledRoot)).toEqual(derived.rootIdentity);
    expect(derived.genesisEntry.root_identity).toEqual(derived.rootIdentity);
    expect(derived.verifiedPrefix).toMatchObject({ status: 'VERIFIED', root_identity: derived.rootIdentity });
    expect(derived.projection).toMatchObject({
      schema_version: 'MES-PROJECTION-1',
      root_identity: derived.rootIdentity,
      manifest_status: 'VERIFIED',
      active_artifact_count: 0,
      active_grade_count: 0,
      same_grade_count: 0,
      closure_status: 'NOT_EVALUATED',
    });
    expect(derived.projection.slices).toHaveLength(11);
    expect(derived.projection.requirements).toHaveLength(64);
    expect(derived.projection.requirements.filter((row) => row.status === 'PENDING')).toHaveLength(59);
    expect(derived.projection.requirements.filter((row) => row.status === 'BLOCKED_CONTRACT')).toHaveLength(5);
    expect(derived.root.task13_experiment.pre_authorization_output).toBe('CONFIGURATION_ONLY');
    expect(derived.root.task13_experiment.prohibited_claims).toEqual([
      'EXPERIMENT_PASSED',
      'FIFTY_PERCENT_REDUCTION_PROVED',
    ]);

    for (const source of Object.values(derived.documents.sources)) {
      expect(new TextDecoder().decode(source)).not.toContain(derived.rootIdentity.sha256);
    }

    const settledSources: RootSourceBytes = {
      ...repositorySources(),
      failureTellDefinitions: bytes(outputPaths.failureTellDefinitions),
      negativeControlDefinitions: bytes(outputPaths.negativeControlDefinitions),
      successorLaneDefinition: bytes(outputPaths.successorLaneDefinition),
      firstVerticalJourney: bytes(outputPaths.firstVerticalJourney),
      recordSchemas: bytes(outputPaths.recordSchemas),
      deterministicReducer: bytes(outputPaths.deterministicReducer),
      task13Experiment: bytes(outputPaths.task13Experiment),
      closureRule: bytes(outputPaths.closureRule),
      n9SuccessorPolicy: bytes(outputPaths.n9SuccessorPolicy),
    };
    const settledIdentities: ExpectedRootIdentities = {
      specification: await contentIdentity(settledSources.specification),
      implementationPlan: await contentIdentity(settledSources.implementationPlan),
      matrix: await contentIdentity(settledSources.matrix),
      answerKey: await contentIdentity(settledSources.answerKey),
      historicalTask4Capsule: await contentIdentity(settledSources.historicalTask4Capsule),
      failureTellDefinitions: await contentIdentity(settledSources.failureTellDefinitions),
      negativeControlDefinitions: await contentIdentity(settledSources.negativeControlDefinitions),
      successorLaneDefinition: await contentIdentity(settledSources.successorLaneDefinition),
      firstVerticalJourney: await contentIdentity(settledSources.firstVerticalJourney),
      recordSchemas: await contentIdentity(settledSources.recordSchemas),
      deterministicReducer: await contentIdentity(settledSources.deterministicReducer),
      task13Experiment: await contentIdentity(settledSources.task13Experiment),
      closureRule: await contentIdentity(settledSources.closureRule),
      n9SuccessorPolicy: await contentIdentity(settledSources.n9SuccessorPolicy),
    };
    const reloaded = await loadEvidenceSpineRoot(settledSources, settledIdentities);
    expect(reloaded.identity).toEqual(derived.rootIdentity);
    expectExactBytes(canonicalDocument(reloaded.root as unknown as CanonicalJsonValue), settledRoot);
    const parsedGenesis = parseAuthorityJson(settledManifest) as unknown as EvidenceManifestEntryV1;
    const reverified = await verifyManifestPrefix(reloaded.identity, [parsedGenesis]);
    expect(reverified.status).toBe('VERIFIED');
    const settledManifestIdentity = await contentIdentity(settledManifest);
    expect(reverified.entry_identities).toEqual([settledManifestIdentity]);
    expect(reverified.head_identity).toEqual(settledManifestIdentity);
    const reprojected = projectEvidenceSpine(
      reloaded.root,
      reverified,
      new Map<string, EvidenceRecordV1>(),
    );
    expect(reprojected.manifest_head_identity).toEqual(settledManifestIdentity);
    expectExactBytes(canonicalDocument(reprojected as unknown as CanonicalJsonValue), settledProjection);

    const fresh = await deriveEvidenceSpineBaseline(repositorySources());
    expectExactBytes(fresh.documents.root, derived.documents.root);
    expectExactBytes(fresh.documents.manifest, derived.documents.manifest);
    expectExactBytes(fresh.documents.projection, derived.documents.projection);
    expect(fresh.root as unknown as CanonicalJsonValue).toEqual(derived.root as unknown as CanonicalJsonValue);
  });
});
