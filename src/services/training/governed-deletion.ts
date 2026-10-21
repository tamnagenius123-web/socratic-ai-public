export class TrainingDeletionError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

function validId(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 160;
}

async function growthFollowUpBlocksDeletion(db: D1Database, sessionId: string): Promise<boolean> {
  const linked = await db.prepare(`
    SELECT 1 AS present
    FROM growth_recheck_follow_up_launches launch
    LEFT JOIN growth_recheck_follow_up_bindings binding ON binding.launch_id = launch.id
    WHERE launch.baseline_session_id = ?1 OR binding.session_id = ?1
    LIMIT 1
  `).bind(sessionId).first<{ present: number }>();
  return Boolean(linked);
}

/**
 * Erases one owner's complete Training graph through the existing context
 * deletion authorization.  Growth follow-up state is deliberately a conflict:
 * it has its own lifecycle and must be deleted there before its Training input.
 */
export async function deleteOwnedTrainingSession(db: D1Database, ownerUserId: string, sessionId: string) {
  if (!validId(ownerUserId) || !validId(sessionId)) {
    throw new TrainingDeletionError(400, 'TRAINING_DELETION_INPUT_INVALID');
  }
  const session = await db.prepare('SELECT id, user_id FROM training_sessions WHERE id = ?1').bind(sessionId)
    .first<{ id: string; user_id: string }>();
  if (!session) return { deletedSessionId: sessionId, deleted: true, replayed: true };
  if (session.user_id !== ownerUserId) throw new TrainingDeletionError(404, 'TRAINING_DELETION_NOT_FOUND');
  if (await growthFollowUpBlocksDeletion(db, sessionId)) {
    throw new TrainingDeletionError(409, 'TRAINING_DELETION_GROWTH_PREREQUISITE');
  }

  const authorizationId = `training-delete-${crypto.randomUUID()}`;
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO training_session_context_deletion_authorizations (
          session_context_id, authorization_id, created_at
        )
        SELECT id, ?3, ?4
        FROM training_session_contexts
        WHERE session_id = ?1 AND owner_user_id = ?2
      `).bind(sessionId, ownerUserId, authorizationId, Date.now()),
      db.prepare(`
        DELETE FROM ai_invocation_attempts
        WHERE session_context_id IN (
          SELECT id FROM training_session_contexts WHERE session_id = ?1 AND owner_user_id = ?2
        )
      `).bind(sessionId, ownerUserId),
      db.prepare('DELETE FROM training_support_responses WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_turns WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_learner_revision_events WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_interventions WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_route_decisions WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_route_offers WHERE session_id = ?1 AND owner_user_id = ?2').bind(sessionId, ownerUserId),
      db.prepare('DELETE FROM training_scenario_evidence WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_scenario_packs WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_session_contexts WHERE session_id = ?1 AND owner_user_id = ?2').bind(sessionId, ownerUserId),
      db.prepare('DELETE FROM training_messages WHERE session_id = ?1').bind(sessionId),
      db.prepare('DELETE FROM training_sessions WHERE id = ?1 AND user_id = ?2').bind(sessionId, ownerUserId),
    ]);
  } catch (error) {
    if (error instanceof TrainingDeletionError) throw error;
    throw new TrainingDeletionError(500, 'TRAINING_DELETION_UNAVAILABLE');
  }

  const remaining = await db.prepare('SELECT 1 AS present FROM training_sessions WHERE id = ?1').bind(sessionId).first();
  if (remaining) throw new TrainingDeletionError(503, 'TRAINING_DELETION_INCOMPLETE');
  return { deletedSessionId: sessionId, deleted: true, replayed: false };
}
