import { GrowthServiceError, type GrowthOriginKind } from './growth-cycle-types';
import { loadOwnedTrainingSessionContext, TrainingSessionContextError } from './training/training-session-context';
import { loadTrainingScenarioEvidenceContext } from './training/scenario-evidence';
import { loadOwnedSparringContext, LearningSessionContextError } from './learning-session-context';
import { sha256Hex } from './library-ingestion';

type ContextSnapshot = { contextId: string; createdAt: number; manifestSha256: string; contentFingerprint: string };

function unavailable(): never {
  throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_CONTEXT_UNAVAILABLE', phase: 'evidence' });
}

async function snapshot(db: D1Database, owner: string, kind: GrowthOriginKind, sessionId: string): Promise<ContextSnapshot> {
  try {
    if (kind === 'TRAINING') {
      const context = await loadOwnedTrainingSessionContext(db, sessionId, owner);
      const evidence = await loadTrainingScenarioEvidenceContext(db, sessionId);
      if (evidence.status !== 'ready' || evidence.manifestSha256 !== context.evidenceManifestSha256) unavailable();
      return { contextId: context.id, createdAt: context.createdAt, manifestSha256: evidence.manifestSha256,
        contentFingerprint: await sha256Hex(JSON.stringify([...new Set(evidence.sources.map(source => source.contentSha256))].sort())) };
    }
    const context = await loadOwnedSparringContext(db, sessionId, owner);
    const manifest = await db.prepare(`SELECT id, source_count FROM sparring_evidence_manifests
      WHERE session_id=?1 AND user_id=?2 AND turn_number=0 AND manifest_sha256=?3`)
      .bind(sessionId, owner, context.corpus.manifestRevision).first<{ id: string; source_count: number }>();
    if (!manifest) unavailable();
    const sources = await db.prepare(`SELECT content_snapshot, content_sha256 FROM sparring_turn_evidence
      WHERE manifest_id=?1 AND session_id=?2 AND turn_number=0`)
      .bind(manifest.id, sessionId).all<{ content_snapshot: string; content_sha256: string }>();
    const rows = sources.results ?? [];
    if (!rows.length || rows.length !== manifest.source_count) unavailable();
    for (const row of rows) if (await sha256Hex(row.content_snapshot) !== row.content_sha256) unavailable();
    return { contextId: context.id, createdAt: context.createdAt, manifestSha256: context.corpus.manifestRevision,
      contentFingerprint: await sha256Hex(JSON.stringify([...new Set(rows.map(row => row.content_sha256))].sort())) };
  } catch (error) {
    if (error instanceof TrainingSessionContextError || error instanceof LearningSessionContextError) unavailable();
    throw error;
  }
}

/** Source differences describe a follow-up; they do not validate a changed task or transfer. */
export async function compareRecheckContexts(db: D1Database, input: {
  owner: string; kind: GrowthOriginKind; baselineSessionId: string; followUpSessionId: string;
  scheduledFor: number; recordedAt: number;
}) {
  if (input.baselineSessionId === input.followUpSessionId) {
    throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_NEW_ATTEMPT_REQUIRED', phase: 'evidence' });
  }
  const [baseline, followUp] = await Promise.all([
    snapshot(db, input.owner, input.kind, input.baselineSessionId),
    snapshot(db, input.owner, input.kind, input.followUpSessionId),
  ]);
  if (followUp.createdAt < input.scheduledFor || followUp.createdAt > input.recordedAt || followUp.createdAt <= baseline.createdAt) {
    throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_FOLLOW_UP_STARTED_TOO_EARLY', phase: 'evidence' });
  }
  if (baseline.contextId === followUp.contextId) {
    throw new GrowthServiceError({ status: 422, code: 'GROWTH_RECHECK_NEW_ATTEMPT_REQUIRED', phase: 'evidence' });
  }
  const status = baseline.contentFingerprint === followUp.contentFingerprint
    ? 'SAME_EVIDENCE_CONTENT' : 'DISTINCT_EVIDENCE_CONTENT';
  return { policyRevision: 'recheck-context-v1', status, semanticValidation: 'UNKNOWN',
    scheduledFor: input.scheduledFor, baseline, followUp } as const;
}
