export type RevisionAttemptScope = 'SPARRING' | 'TRAINING';

// Only canonical accepted follow-ups before this turn pace the hint ladder.
// Declarations, evaluator paraphrases and serialized model counters are not attempts.
// This count establishes neither correction quality nor complete historical coverage.
export async function readPriorAcceptedRevisionAttempts(
  db: D1Database, owner: string, sessionId: string, scope: RevisionAttemptScope, turn: number,
): Promise<number | null> {
  if (!Number.isSafeInteger(turn) || turn < 1) return null;
  const sql = scope === 'SPARRING'
    ? `SELECT /* PRIOR_ACCEPTED_REVISION_ATTEMPTS */ COUNT(DISTINCT r.id) AS count
       FROM sparring_learner_revisions r
       JOIN sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id
       JOIN messages m ON m.session_id=s.id AND m.role='user' AND m.sparring_revision_id=r.id
         AND m.sparring_revision_number=r.revision
       JOIN evaluations e ON e.session_id=s.id AND e.user_id=s.user_id AND e.turn=m.turn
       WHERE s.id=?1 AND s.user_id=?2 AND m.turn<?3`
    : `SELECT /* PRIOR_ACCEPTED_REVISION_ATTEMPTS */ COUNT(DISTINCT r.id) AS count
       FROM training_learner_revision_events r
       JOIN training_sessions s ON s.id=r.session_id AND s.user_id=r.owner_user_id
       JOIN training_turns t ON t.session_id=s.id AND t.learner_revision_event_id=r.id
         AND t.learner_revision_number=r.revision_number
       WHERE s.id=?1 AND s.user_id=?2 AND t.turn_number<?3`;
  try {
    const row = await db.prepare(sql).bind(sessionId, owner, turn).first<{count: number}>();
    return row && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : null;
  } catch {
    return null;
  }
}
