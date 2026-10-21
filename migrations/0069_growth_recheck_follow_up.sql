-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE growth_lifecycle_catalog_upgrade (
  from_state TEXT NOT NULL,
  action TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_class TEXT NOT NULL CHECK (actor_class IN ('SYSTEM', 'PARTICIPANT')),
  route_action TEXT NOT NULL CHECK (length(trim(route_action)) > 0),
  contract_matched INTEGER NOT NULL CHECK(contract_matched=1),
  PRIMARY KEY (from_state, action, to_state),
  UNIQUE (from_state, action, event_type)
);

INSERT INTO growth_lifecycle_catalog_upgrade
SELECT from_state,action,to_state,event_type,actor_class,route_action,contract_matched
FROM growth_lifecycle_transitions
NATURAL LEFT JOIN (SELECT *,1 AS contract_matched FROM growth_lifecycle_transition_contracts);

DROP TABLE growth_lifecycle_transitions;

CREATE TABLE growth_lifecycle_transitions (
  from_state TEXT NOT NULL,
  action TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_class TEXT NOT NULL CHECK (actor_class IN ('SYSTEM', 'PARTICIPANT')),
  route_action TEXT NOT NULL CHECK (length(trim(route_action)) > 0),
  PRIMARY KEY (from_state, action, to_state),
  UNIQUE (from_state, action, event_type)
);

INSERT INTO growth_lifecycle_transitions
SELECT from_state,action,to_state,event_type,actor_class,route_action FROM growth_lifecycle_catalog_upgrade;

DROP TABLE growth_lifecycle_catalog_upgrade;

INSERT INTO growth_lifecycle_transitions
  (from_state, action, to_state, event_type, actor_class, route_action)
VALUES ('RECHECK_SCHEDULED','LAUNCH_RECHECK_FOLLOW_UP','RECHECK_SCHEDULED',
  'RECHECK_FOLLOW_UP_LAUNCHED','PARTICIPANT',
  'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/recheck-follow-up-launches');

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_insert
BEFORE INSERT ON growth_lifecycle_transitions
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_lifecycle_transitions existing
  WHERE existing.from_state = NEW.from_state
    AND existing.action = NEW.action
    AND existing.to_state = NEW.to_state
    AND existing.event_type = NEW.event_type
    AND existing.actor_class = NEW.actor_class
    AND existing.route_action = NEW.route_action
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_update
BEFORE UPDATE ON growth_lifecycle_transitions
FOR EACH ROW WHEN NEW.from_state IS NOT OLD.from_state
  OR NEW.action IS NOT OLD.action
  OR NEW.to_state IS NOT OLD.to_state
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.actor_class IS NOT OLD.actor_class
  OR NEW.route_action IS NOT OLD.route_action
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_delete
BEFORE DELETE ON growth_lifecycle_transitions
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TABLE growth_recheck_follow_up_launches (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL REFERENCES growth_cycles(id) ON DELETE CASCADE,
  recheck_id TEXT NOT NULL UNIQUE REFERENCES growth_rechecks(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  baseline_session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  baseline_context_id TEXT NOT NULL REFERENCES training_session_contexts(id) ON DELETE CASCADE,
  changed_condition TEXT NOT NULL CHECK (length(trim(changed_condition)) BETWEEN 10 AND 1000),
  semantic_validation TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (semantic_validation='UNKNOWN'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE growth_recheck_follow_up_bindings (
  launch_id TEXT PRIMARY KEY REFERENCES growth_recheck_follow_up_launches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES training_sessions(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL UNIQUE REFERENCES training_session_contexts(id) ON DELETE CASCADE,
  completed_turn_id TEXT REFERENCES training_turns(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TRIGGER growth_follow_up_launch_guard BEFORE INSERT ON growth_recheck_follow_up_launches
WHEN EXISTS (SELECT 1 FROM growth_recheck_follow_up_launches WHERE id=NEW.id OR recheck_id=NEW.recheck_id)
OR NOT EXISTS (
  SELECT 1 FROM growth_cycles c
  JOIN growth_rechecks r ON r.growth_cycle_id=c.id
  JOIN growth_spaces s ON s.id=c.space_id
  JOIN growth_space_memberships m ON m.id=c.participant_membership_id
  JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
  JOIN training_session_contexts context ON context.session_id=c.origin_attempt_id
  WHERE c.id=NEW.growth_cycle_id AND c.state='RECHECK_SCHEDULED' AND c.origin_kind='TRAINING'
    AND r.id=NEW.recheck_id AND r.recorded_at IS NULL AND NEW.created_at>=r.scheduled_for
    AND s.host_user_id=NEW.owner_user_id AND s.status='ACTIVE'
    AND m.user_id=NEW.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
    AND consent.subject_user_id=NEW.owner_user_id AND consent.revoked_at IS NULL
    AND context.id=NEW.baseline_context_id AND context.session_id=NEW.baseline_session_id
    AND context.owner_user_id=NEW.owner_user_id AND NEW.created_at>context.created_at
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_LAUNCH_INVALID'); END;

CREATE TRIGGER growth_follow_up_launch_immutable BEFORE UPDATE ON growth_recheck_follow_up_launches
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;

CREATE TRIGGER growth_follow_up_binding_guard BEFORE INSERT ON growth_recheck_follow_up_bindings
WHEN NEW.completed_turn_id IS NOT NULL
OR EXISTS (SELECT 1 FROM growth_recheck_follow_up_bindings WHERE launch_id=NEW.launch_id OR session_id=NEW.session_id OR context_id=NEW.context_id)
OR NOT EXISTS (
  SELECT 1 FROM growth_recheck_follow_up_launches launch
  JOIN growth_cycles c ON c.id=launch.growth_cycle_id
  JOIN growth_rechecks r ON r.id=launch.recheck_id
  JOIN growth_spaces s ON s.id=c.space_id
  JOIN growth_space_memberships m ON m.id=c.participant_membership_id
  JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
  JOIN training_session_contexts context ON context.id=NEW.context_id
  JOIN training_scenario_packs pack ON pack.session_id=context.session_id
  WHERE launch.id=NEW.launch_id AND c.state='RECHECK_SCHEDULED' AND r.recorded_at IS NULL
    AND s.host_user_id=launch.owner_user_id AND s.status='ACTIVE'
    AND m.user_id=launch.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
    AND consent.subject_user_id=launch.owner_user_id AND consent.revoked_at IS NULL
    AND context.session_id=NEW.session_id AND context.owner_user_id=launch.owner_user_id
    AND context.session_id<>launch.baseline_session_id
    AND context.created_at>=r.scheduled_for AND context.created_at>=launch.created_at
    AND NEW.created_at>=context.created_at
    AND json_extract(pack.scenario_json,'$.followUpVariant.launchId')=launch.id
    AND json_extract(pack.scenario_json,'$.followUpVariant.changedCondition')=launch.changed_condition
    AND json_extract(pack.scenario_json,'$.followUpVariant.semanticValidation')='UNKNOWN'
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_BINDING_INVALID'); END;

CREATE TRIGGER growth_follow_up_binding_immutable BEFORE UPDATE ON growth_recheck_follow_up_bindings
WHEN NEW.launch_id IS NOT OLD.launch_id OR NEW.session_id IS NOT OLD.session_id
  OR NEW.context_id IS NOT OLD.context_id OR NEW.created_at IS NOT OLD.created_at
  OR OLD.completed_turn_id IS NOT NULL OR NEW.completed_turn_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM training_turns turn
    JOIN training_sessions session ON session.id=turn.session_id
    JOIN growth_recheck_follow_up_launches launch ON launch.id=OLD.launch_id
    JOIN growth_rechecks recheck ON recheck.id=launch.recheck_id
    JOIN growth_cycles c ON c.id=launch.growth_cycle_id
    JOIN growth_spaces s ON s.id=c.space_id
    JOIN growth_space_memberships m ON m.id=c.participant_membership_id
    JOIN growth_private_consent_receipts consent ON consent.id=c.consent_receipt_id
    WHERE s.host_user_id=launch.owner_user_id AND s.status='ACTIVE'
      AND m.user_id=launch.owner_user_id AND m.status='ACTIVE' AND m.role='HOST'
      AND consent.subject_user_id=launch.owner_user_id AND consent.revoked_at IS NULL
      AND turn.id=(SELECT latest.id FROM training_turns latest WHERE latest.session_id=OLD.session_id ORDER BY latest.turn_number DESC,latest.id DESC LIMIT 1)
      AND turn.id=NEW.completed_turn_id AND turn.session_id=OLD.session_id
      AND session.is_completed=1 AND recheck.follow_up_attempt_id=OLD.session_id
      AND recheck.recorded_at IS NOT NULL AND recheck.outcome='UNKNOWN'
  )
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_COMPLETION_INVALID'); END;

INSERT INTO growth_lifecycle_transition_contracts (from_state,action,to_state,event_type,actor_class,route_action)
SELECT from_state,action,to_state,event_type,actor_class,route_action FROM growth_lifecycle_transitions WHERE action='LAUNCH_RECHECK_FOLLOW_UP';

CREATE TRIGGER growth_follow_up_event_guard BEFORE INSERT ON growth_events
WHEN NEW.lifecycle_action='LAUNCH_RECHECK_FOLLOW_UP' AND NOT EXISTS (
 SELECT 1 FROM growth_recheck_follow_up_launches launch
 WHERE launch.growth_cycle_id=NEW.growth_cycle_id AND launch.created_at=NEW.occurred_at
   AND EXISTS (SELECT 1 FROM growth_rechecks r WHERE r.id=launch.recheck_id AND r.recorded_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM growth_recheck_follow_up_bindings WHERE launch_id=launch.id)
)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_LAUNCH_REQUIRED'); END;

CREATE TRIGGER growth_follow_up_launch_delete BEFORE DELETE ON growth_recheck_follow_up_launches
WHEN NOT EXISTS (SELECT 1 FROM growth_deletion_context WHERE growth_cycle_id=OLD.growth_cycle_id)
 AND EXISTS (SELECT 1 FROM training_sessions WHERE id=OLD.baseline_session_id)
 AND EXISTS (SELECT 1 FROM training_session_contexts WHERE id=OLD.baseline_context_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;

CREATE TRIGGER growth_follow_up_binding_delete BEFORE DELETE ON growth_recheck_follow_up_bindings
WHEN EXISTS (SELECT 1 FROM growth_recheck_follow_up_launches launch WHERE launch.id=OLD.launch_id
 AND NOT EXISTS (SELECT 1 FROM growth_deletion_context WHERE growth_cycle_id=launch.growth_cycle_id))
 AND EXISTS (SELECT 1 FROM training_sessions WHERE id=OLD.session_id)
 AND EXISTS (SELECT 1 FROM training_session_contexts WHERE id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'GROWTH_FOLLOW_UP_IMMUTABLE'); END;
