export type TrainingEvidenceModelRecord = {
  eventId: string;
  sessionId: string;
  revision: number;
  model: { id: 'training-learner-revision'; version: string };
  recordedAt: number;
  observation: { kind: 'LEARNER_OBSERVATION'; statement: string };
  hypothesis: { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS'; statement: string };
  causalRationale: {
    kind: 'LEARNER_UNVERIFIED_CAUSAL_RATIONALE';
    statement: string;
    validationStatus: 'UNVERIFIED';
  };
  sources: Array<{ sourceId: string; contentSha256: string }>;
  manifestSha256: string;
  confidence: 'UNKNOWN';
  validationStatus: 'UNVERIFIED';
  alternatives: Array<
    | { kind: 'LEARNER_OBSERVATION'; statement: string }
    | { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS'; statement: string }
  >;
  nextAction: {
    status: 'PENDING' | 'CONSUMED';
    turnNumber: number | null;
    tutorAction: string | null;
  };
};

type EvidenceModelEventRow = {
  id: string;
  session_id: string;
  revision_number: number;
  prior_statement: string;
  revised_statement: string;
  explanation: string;
  source_ids_json: string;
  evidence_manifest_sha256: string;
  session_context_manifest_sha256: string | null;
  policy_revision: string;
  created_at: number;
  consumed_turn_number: number | null;
  consumed_tutor_action: string | null;
};

type VerifiedSessionEvidence = {
  manifestSha256: string;
  sources: Array<{ sourceId: string; contentSha256: string }>;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

function parsedSourceIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || !id)) return null;
    return [...new Set(parsed)].sort();
  } catch {
    return null;
  }
}

async function validatedSessionEvidence(
  db: D1Database,
  sessionId: string,
): Promise<VerifiedSessionEvidence | null> {
  const context = await loadTrainingScenarioEvidenceContext(db, sessionId);
  if (context.status !== 'ready') return null;
  if (!SHA256_HEX.test(context.manifestSha256)) return null;
  const verifiedSources = context.sources.map((source) => ({
    sourceId: source.sourceId,
    contentSha256: source.contentSha256,
  }));
  if (verifiedSources.some((source) => !SHA256_HEX.test(source.contentSha256))) return null;
  return {
    manifestSha256: context.manifestSha256,
    sources: verifiedSources,
  };
}

/**
 * Projects only immutable, learner-declared revision records. This is not a
 * learner diagnosis, calibration result, or adaptation-authority signal.
 */
export async function loadOwnedTrainingEvidenceModels(
  db: D1Database,
  ownerUserId: string,
): Promise<{ status: 'AVAILABLE' | 'UNKNOWN' | 'UNAVAILABLE'; records: TrainingEvidenceModelRecord[] }> {
  const activeHeldOut = await db.prepare(`
    SELECT attempt.id
    FROM training_heldout_attempts attempt
    WHERE attempt.owner_user_id = ?1
      AND (
        SELECT event.event_type
        FROM training_heldout_attempt_events event
        WHERE event.attempt_id = attempt.id
        ORDER BY event.revision DESC
        LIMIT 1
      ) IN ('ARM', 'OPEN')
    LIMIT 1
  `).bind(ownerUserId).first<{ id: string }>();
  if (activeHeldOut) return { status: 'UNKNOWN', records: [] };

  const events = await db.prepare(`
    SELECT
      revision.id,
      revision.session_id,
      revision.revision_number,
      revision.prior_statement,
      revision.revised_statement,
      revision.explanation,
      revision.source_ids_json,
      revision.evidence_manifest_sha256,
      context.evidence_manifest_sha256 AS session_context_manifest_sha256,
      revision.policy_revision,
      revision.created_at,
      consumed.turn_number AS consumed_turn_number,
      consumed.tutor_action_type AS consumed_tutor_action
    FROM training_learner_revision_events revision
    INNER JOIN training_sessions session ON session.id = revision.session_id
    LEFT JOIN training_session_contexts context
      ON context.session_id = revision.session_id
      AND context.owner_user_id = ?1
    LEFT JOIN training_turns consumed
      ON consumed.session_id = revision.session_id
      AND consumed.learner_revision_event_id = revision.id
    WHERE revision.owner_user_id = ?1
      AND session.user_id = ?1
    ORDER BY revision.created_at DESC, revision.id DESC
    LIMIT 100
  `).bind(ownerUserId).all<EvidenceModelEventRow>();

  const rows = events.results || [];
  if (rows.length === 0) return { status: 'UNKNOWN', records: [] };

  const records: TrainingEvidenceModelRecord[] = [];
  const evidenceBySession = new Map<string, Promise<VerifiedSessionEvidence | null>>();
  for (const row of rows) {
    const sourceIds = parsedSourceIds(row.source_ids_json);
    if (!sourceIds) return { status: 'UNAVAILABLE', records: [] };
    if (!SHA256_HEX.test(row.evidence_manifest_sha256) || !SHA256_HEX.test(row.session_context_manifest_sha256 || '')) {
      return { status: 'UNAVAILABLE', records: [] };
    }
    const evidence = evidenceBySession.get(row.session_id)
      ?? validatedSessionEvidence(db, row.session_id);
    evidenceBySession.set(row.session_id, evidence);
    const verified = await evidence;
    if (!verified
      || row.evidence_manifest_sha256 !== row.session_context_manifest_sha256
      || row.evidence_manifest_sha256 !== verified.manifestSha256) {
      return { status: 'UNAVAILABLE', records: [] };
    }
    const sourceById = new Map(verified.sources.map((source) => [source.sourceId, source]));
    if (sourceIds.some((sourceId) => !sourceById.has(sourceId))) return { status: 'UNAVAILABLE', records: [] };
    const observation = { kind: 'LEARNER_OBSERVATION' as const, statement: row.prior_statement };
    const hypothesis = { kind: 'UNVERIFIED_LEARNER_HYPOTHESIS' as const, statement: row.revised_statement };
    records.push({
      eventId: row.id,
      sessionId: row.session_id,
      revision: row.revision_number,
      model: { id: 'training-learner-revision', version: row.policy_revision },
      recordedAt: row.created_at,
      observation,
      hypothesis,
      causalRationale: {
        kind: 'LEARNER_UNVERIFIED_CAUSAL_RATIONALE',
        statement: row.explanation,
        validationStatus: 'UNVERIFIED',
      },
      sources: sourceIds.map((sourceId) => sourceById.get(sourceId)!),
      manifestSha256: row.evidence_manifest_sha256,
      confidence: 'UNKNOWN',
      validationStatus: 'UNVERIFIED',
      alternatives: [observation, hypothesis],
      nextAction: row.consumed_turn_number === null
        ? { status: 'PENDING', turnNumber: null, tutorAction: null }
        : { status: 'CONSUMED', turnNumber: row.consumed_turn_number, tutorAction: row.consumed_tutor_action },
    });
  }
  return { status: 'AVAILABLE', records };
}
import { loadTrainingScenarioEvidenceContext } from './scenario-evidence';
