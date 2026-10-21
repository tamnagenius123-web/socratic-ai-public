-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sparring_controls ADD COLUMN origin TEXT NOT NULL DEFAULT 'LEARNER' CHECK(origin IN ('LEARNER','POLICY'));

ALTER TABLE sparring_controls ADD COLUMN policy_reason TEXT CHECK(policy_reason='NON_PROGRESS');

ALTER TABLE sparring_controls ADD COLUMN previous_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE sparring_controls ADD COLUMN previous_evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE CASCADE;

ALTER TABLE sparring_controls ADD COLUMN latest_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE sparring_controls ADD COLUMN latest_evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX sparring_policy_observation_once ON sparring_controls(session_id,latest_message_id) WHERE origin='POLICY';

CREATE TRIGGER sparring_policy_observation_guard BEFORE INSERT ON sparring_controls BEGIN
 SELECT RAISE(ABORT,'SPARRING_CONTROL_CONFLICT') WHERE
 (NEW.origin='LEARNER' AND (NEW.policy_reason IS NOT NULL OR NEW.previous_message_id IS NOT NULL OR NEW.previous_evaluation_id IS NOT NULL OR NEW.latest_message_id IS NOT NULL OR NEW.latest_evaluation_id IS NOT NULL))
 OR (NEW.origin='POLICY' AND (NEW.action<>'PAUSE' OR NEW.reason<>'INSUFFICIENT_EVIDENCE' OR NEW.policy_reason IS NOT 'NON_PROGRESS'
 OR NOT EXISTS(
  SELECT 1 FROM sessions s
  JOIN messages a ON a.id=NEW.previous_message_id AND a.session_id=s.id AND a.role='user'
  JOIN messages b ON b.id=NEW.latest_message_id AND b.session_id=s.id AND b.role='user' AND b.turn=a.turn+1
  JOIN evaluations ea ON ea.id=NEW.previous_evaluation_id AND ea.session_id=s.id AND ea.user_id=s.user_id AND ea.turn=a.turn
  JOIN evaluations eb ON eb.id=NEW.latest_evaluation_id AND eb.session_id=s.id AND eb.user_id=s.user_id AND eb.turn=b.turn
  WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND b.turn=s.current_turn-1
   AND ea.defense_score IN (20,40) AND ea.evidence_score IN (20,40) AND eb.defense_score IN (20,40) AND eb.evidence_score IN (20,40)
   AND (SELECT COUNT(*) FROM evaluations WHERE session_id=s.id AND user_id=s.user_id AND turn IN (a.turn,b.turn))=2
   AND (SELECT COUNT(*) FROM messages WHERE session_id=s.id AND role='user' AND turn IN (a.turn,b.turn))=2
 )));
END;

DROP TRIGGER sparring_control_hint_guard;

CREATE TRIGGER sparring_control_hint_guard BEFORE INSERT ON sparring_hint_responses BEGIN
 SELECT RAISE(ABORT,'SPARRING_CONTROL_CONFLICT') WHERE
 NEW.control_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_controls WHERE session_id=NEW.session_id)
 OR NOT (
  COALESCE((SELECT action FROM sparring_controls WHERE session_id=NEW.session_id ORDER BY revision DESC LIMIT 1),'RESUME')='RESUME'
  OR EXISTS(SELECT 1 FROM sparring_controls c WHERE c.session_id=NEW.session_id AND c.revision=NEW.control_revision AND c.action='PAUSE' AND c.origin='POLICY' AND c.policy_reason='NON_PROGRESS'
    AND NOT EXISTS(SELECT 1 FROM sparring_hint_responses h WHERE h.session_id=c.session_id AND h.control_revision=c.revision))
 );
END;
