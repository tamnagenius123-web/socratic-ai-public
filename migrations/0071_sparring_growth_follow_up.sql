-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE growth_recheck_sparring_follow_up_launches (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL REFERENCES growth_cycles(id) ON DELETE CASCADE,
  recheck_id TEXT NOT NULL UNIQUE REFERENCES growth_rechecks(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  baseline_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  baseline_context_id TEXT NOT NULL REFERENCES learning_session_contexts(id) ON DELETE CASCADE,
  changed_condition TEXT NOT NULL CHECK (length(trim(changed_condition)) BETWEEN 10 AND 1000),
  semantic_validation TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (semantic_validation='UNKNOWN'),
  protocol_revision TEXT NOT NULL CHECK(protocol_revision='growth-follow-up-local-v1'),
  assistance_policy_revision TEXT NOT NULL CHECK(assistance_policy_revision='sparring-assistance-capture-v1'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE growth_recheck_sparring_follow_up_bindings (
  launch_id TEXT PRIMARY KEY REFERENCES growth_recheck_sparring_follow_up_launches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL UNIQUE REFERENCES learning_session_contexts(id) ON DELETE CASCADE,
  completed_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  completed_evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TRIGGER growth_sparring_follow_up_launch_guard BEFORE INSERT ON growth_recheck_sparring_follow_up_launches
WHEN EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_launches WHERE id=NEW.id OR recheck_id=NEW.recheck_id)
OR EXISTS (SELECT 1 FROM growth_recheck_follow_up_launches WHERE id=NEW.id OR recheck_id=NEW.recheck_id)
OR NOT EXISTS (
  SELECT 1 FROM growth_cycles c
  JOIN growth_rechecks r ON r.growth_cycle_id=c.id
  JOIN growth_spaces s ON s.id=c.space_id
  JOIN growth_space_memberships m ON m.id=c.participant_membership_id
  JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
  JOIN learning_session_contexts context ON context.session_id=c.origin_attempt_id
  JOIN sessions baseline ON baseline.id=context.session_id AND baseline.user_id=NEW.owner_user_id AND baseline.is_completed=1
  WHERE c.id=NEW.growth_cycle_id AND c.state='RECHECK_SCHEDULED' AND c.origin_kind='SPARRING'
    AND r.id=NEW.recheck_id AND r.recorded_at IS NULL AND NEW.created_at>=r.scheduled_for
    AND s.host_user_id=NEW.owner_user_id AND s.status='ACTIVE'
    AND m.user_id=NEW.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
    AND consent.subject_user_id=NEW.owner_user_id AND consent.revoked_at IS NULL
    AND context.id=NEW.baseline_context_id AND context.session_id=NEW.baseline_session_id
    AND context.owner_user_id=NEW.owner_user_id AND NEW.created_at>context.created_at
    AND context.session_kind='SPARRING' AND context.status='ACTIVE'
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_LAUNCH_INVALID'); END;

CREATE TRIGGER growth_sparring_follow_up_launch_immutable BEFORE UPDATE ON growth_recheck_sparring_follow_up_launches
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;

CREATE TRIGGER growth_sparring_follow_up_binding_guard BEFORE INSERT ON growth_recheck_sparring_follow_up_bindings
WHEN NEW.completed_message_id IS NOT NULL OR NEW.completed_evaluation_id IS NOT NULL
OR EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_bindings WHERE launch_id=NEW.launch_id OR session_id=NEW.session_id OR context_id=NEW.context_id)
OR NOT EXISTS (
  SELECT 1 FROM growth_recheck_sparring_follow_up_launches launch
  JOIN growth_cycles c ON c.id=launch.growth_cycle_id
  JOIN growth_rechecks r ON r.id=launch.recheck_id
  JOIN growth_spaces s ON s.id=c.space_id
  JOIN growth_space_memberships m ON m.id=c.participant_membership_id
  JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
  JOIN learning_session_contexts context ON context.id=NEW.context_id
  JOIN sessions session ON session.id=context.session_id AND session.user_id=launch.owner_user_id
  WHERE launch.id=NEW.launch_id AND c.state='RECHECK_SCHEDULED' AND r.recorded_at IS NULL
    AND s.host_user_id=launch.owner_user_id AND s.status='ACTIVE'
    AND m.user_id=launch.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
    AND consent.subject_user_id=launch.owner_user_id AND consent.revoked_at IS NULL
    AND context.session_id=NEW.session_id AND context.owner_user_id=launch.owner_user_id
    AND context.session_id<>launch.baseline_session_id
    AND context.created_at>=r.scheduled_for AND context.created_at>=launch.created_at
    AND NEW.created_at>=context.created_at
    AND context.session_kind='SPARRING' AND context.status='ACTIVE'
    AND session.topic=launch.changed_condition AND session.is_completed=0
    AND json_extract(session.student_model,'$.sessionId')=session.id
    AND EXISTS (SELECT 1 FROM messages opening WHERE opening.session_id=session.id AND opening.role='ai' AND opening.turn=0)
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_BINDING_INVALID'); END;

CREATE TRIGGER growth_sparring_follow_up_binding_immutable BEFORE UPDATE ON growth_recheck_sparring_follow_up_bindings
WHEN NEW.launch_id IS NOT OLD.launch_id OR NEW.session_id IS NOT OLD.session_id
 OR NEW.context_id IS NOT OLD.context_id OR NEW.created_at IS NOT OLD.created_at
 OR OLD.completed_message_id IS NOT NULL OR OLD.completed_evaluation_id IS NOT NULL
 OR NEW.completed_message_id IS NULL
 OR NOT EXISTS (
  SELECT 1 FROM messages message
  JOIN sessions session ON session.id=message.session_id
  JOIN growth_recheck_sparring_follow_up_launches launch ON launch.id=OLD.launch_id
  JOIN growth_rechecks recheck ON recheck.id=launch.recheck_id
  JOIN growth_cycles c ON c.id=launch.growth_cycle_id
  JOIN growth_spaces s ON s.id=c.space_id
  JOIN growth_space_memberships m ON m.id=c.participant_membership_id
  JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
  WHERE s.host_user_id=launch.owner_user_id AND s.status='ACTIVE'
   AND m.user_id=launch.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
   AND consent.subject_user_id=launch.owner_user_id AND consent.revoked_at IS NULL
   AND message.id=NEW.completed_message_id AND message.role='user' AND message.session_id=OLD.session_id
   AND message.id=(SELECT id FROM messages WHERE session_id=OLD.session_id AND role='user' ORDER BY turn DESC,id DESC LIMIT 1)
   AND NEW.completed_evaluation_id IS (SELECT id FROM evaluations WHERE session_id=OLD.session_id AND user_id=launch.owner_user_id AND turn=message.turn ORDER BY created_at DESC,id DESC LIMIT 1)
   AND session.user_id=launch.owner_user_id AND session.is_completed=1
   AND message.turn=session.session_completion_turn
   AND recheck.follow_up_origin_kind='SPARRING' AND recheck.follow_up_attempt_id=OLD.session_id
   AND recheck.recorded_at IS NOT NULL AND recheck.outcome='UNKNOWN'
 )
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_COMPLETION_INVALID'); END;

CREATE TRIGGER growth_training_follow_up_cross_origin_guard BEFORE INSERT ON growth_recheck_follow_up_launches
WHEN EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_launches WHERE id=NEW.id OR recheck_id=NEW.recheck_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_LAUNCH_INVALID'); END;

DROP TRIGGER growth_follow_up_event_guard;

CREATE TRIGGER growth_follow_up_event_guard BEFORE INSERT ON growth_events
WHEN NEW.lifecycle_action='LAUNCH_RECHECK_FOLLOW_UP' AND NOT EXISTS (
 SELECT 1 FROM growth_recheck_follow_up_launches launch
 WHERE launch.growth_cycle_id=NEW.growth_cycle_id AND launch.created_at=NEW.occurred_at
   AND EXISTS (SELECT 1 FROM growth_rechecks r WHERE r.id=launch.recheck_id AND r.recorded_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM growth_recheck_follow_up_bindings WHERE launch_id=launch.id)
) AND NOT EXISTS (
 SELECT 1 FROM growth_recheck_sparring_follow_up_launches launch
 WHERE launch.growth_cycle_id=NEW.growth_cycle_id AND launch.created_at=NEW.occurred_at
   AND EXISTS (SELECT 1 FROM growth_rechecks r WHERE r.id=launch.recheck_id AND r.recorded_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_bindings WHERE launch_id=launch.id)
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_LAUNCH_REQUIRED'); END;

CREATE TRIGGER growth_sparring_follow_up_launch_delete BEFORE DELETE ON growth_recheck_sparring_follow_up_launches
WHEN NOT EXISTS (SELECT 1 FROM growth_deletion_context WHERE growth_cycle_id=OLD.growth_cycle_id)
 AND EXISTS (SELECT 1 FROM sessions WHERE id=OLD.baseline_session_id)
 AND EXISTS (SELECT 1 FROM learning_session_contexts WHERE id=OLD.baseline_context_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;

CREATE TRIGGER growth_sparring_follow_up_binding_delete BEFORE DELETE ON growth_recheck_sparring_follow_up_bindings
WHEN EXISTS (SELECT 1 FROM growth_recheck_sparring_follow_up_launches launch WHERE launch.id=OLD.launch_id
 AND NOT EXISTS (SELECT 1 FROM growth_deletion_context WHERE growth_cycle_id=launch.growth_cycle_id))
 AND EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND EXISTS (SELECT 1 FROM learning_session_contexts WHERE id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;
