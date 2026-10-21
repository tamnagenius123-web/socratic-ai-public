-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE training_learner_revision_events (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), revision_number INTEGER NOT NULL CHECK(revision_number>0),
 expected_revision INTEGER NOT NULL CHECK(expected_revision=revision_number-1), mutation_key TEXT NOT NULL,
 prior_turn_id INTEGER NOT NULL, prior_turn_number INTEGER NOT NULL, prior_statement TEXT NOT NULL,
 revised_statement TEXT NOT NULL CHECK(length(trim(revised_statement)) BETWEEN 1 AND 4000),
 explanation TEXT NOT NULL CHECK(length(trim(explanation)) BETWEEN 1 AND 4000),
 source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json) AND json_type(source_ids_json)='array'),
 evidence_manifest_sha256 TEXT NOT NULL, validation_status TEXT NOT NULL CHECK(validation_status='UNVERIFIED'),
 policy_revision TEXT NOT NULL CHECK(policy_revision='learner-revision-v1'), created_at INTEGER NOT NULL,
 UNIQUE(session_id,revision_number), UNIQUE(session_id,mutation_key)
);

ALTER TABLE training_turns ADD COLUMN learner_revision_event_id TEXT REFERENCES training_learner_revision_events(id);

ALTER TABLE training_turns ADD COLUMN learner_revision_number INTEGER;

CREATE UNIQUE INDEX training_revision_consumed_once ON training_turns(learner_revision_event_id) WHERE learner_revision_event_id IS NOT NULL;

CREATE TRIGGER training_revision_insert_guard BEFORE INSERT ON training_learner_revision_events BEGIN
 SELECT RAISE(ABORT,'TRAINING_REVISION_CONFLICT') WHERE
 EXISTS(SELECT 1 FROM training_learner_revision_events WHERE id=NEW.id)
 OR NEW.expected_revision<>(SELECT COALESCE(MAX(revision_number),0) FROM training_learner_revision_events WHERE session_id=NEW.session_id)
 OR NOT EXISTS(SELECT 1 FROM training_sessions s JOIN training_session_contexts c ON c.session_id=s.id JOIN training_turns t ON t.session_id=s.id
 WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND s.is_completed=0 AND c.owner_user_id=s.user_id AND c.evidence_manifest_sha256=NEW.evidence_manifest_sha256
 AND t.id=NEW.prior_turn_id AND t.turn_number=NEW.prior_turn_number AND t.student_message=NEW.prior_statement AND t.turn_number<s.current_turn)
 OR EXISTS(SELECT 1 FROM json_each(NEW.source_ids_json) j WHERE j.type<>'text' OR NOT EXISTS(SELECT 1 FROM training_scenario_evidence e WHERE e.session_id=NEW.session_id AND e.source_id=j.value));
END;

CREATE TRIGGER training_revision_immutable BEFORE UPDATE ON training_learner_revision_events BEGIN SELECT RAISE(ABORT,'TRAINING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER training_revision_delete_guard BEFORE DELETE ON training_learner_revision_events WHEN EXISTS(SELECT 1 FROM training_sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id AND c.owner_user_id=OLD.owner_user_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER training_revision_context_delete_guard BEFORE DELETE ON training_session_contexts WHEN EXISTS(SELECT 1 FROM training_learner_revision_events WHERE session_id=OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER training_revision_turn_guard BEFORE INSERT ON training_turns BEGIN
 SELECT RAISE(ABORT,'TRAINING_REVISION_CONFLICT') WHERE
 (NEW.learner_revision_event_id IS NULL)<>(NEW.learner_revision_number IS NULL)
 OR (NEW.learner_revision_event_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM training_learner_revision_events e JOIN training_sessions s ON s.id=e.session_id WHERE e.id=NEW.learner_revision_event_id AND e.session_id=NEW.session_id AND e.owner_user_id=s.user_id
 AND e.revision_number=NEW.learner_revision_number AND e.revision_number=(SELECT MAX(revision_number) FROM training_learner_revision_events WHERE session_id=NEW.session_id)
 AND s.current_turn=NEW.turn_number AND s.is_completed=0 AND e.prior_turn_number<NEW.turn_number
 AND NOT EXISTS(SELECT 1 FROM training_turns t WHERE t.learner_revision_event_id=e.id)))
 OR (NEW.learner_revision_event_id IS NULL AND EXISTS(SELECT 1 FROM training_learner_revision_events e WHERE e.session_id=NEW.session_id
 AND e.revision_number=(SELECT MAX(revision_number) FROM training_learner_revision_events WHERE session_id=NEW.session_id)
 AND NOT EXISTS(SELECT 1 FROM training_turns t WHERE t.learner_revision_event_id=e.id)))
 OR EXISTS(SELECT 1 FROM training_turns t WHERE (t.id=NEW.id OR (t.session_id=NEW.session_id AND t.turn_number=NEW.turn_number))
 AND (t.learner_revision_event_id IS NOT NULL OR EXISTS(SELECT 1 FROM training_learner_revision_events e WHERE e.prior_turn_id=t.id)));
END;

CREATE TRIGGER training_revision_turn_immutable BEFORE UPDATE OF id,learner_revision_event_id,learner_revision_number,session_id,turn_number,student_message,ai_response,evaluation_json,student_model_snapshot ON training_turns
 WHEN OLD.learner_revision_event_id IS NOT NEW.learner_revision_event_id OR OLD.learner_revision_number IS NOT NEW.learner_revision_number
 OR ((OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.turn_number IS NOT NEW.turn_number OR OLD.student_message IS NOT NEW.student_message OR OLD.ai_response IS NOT NEW.ai_response OR OLD.evaluation_json IS NOT NEW.evaluation_json OR OLD.student_model_snapshot IS NOT NEW.student_model_snapshot)
 AND (OLD.learner_revision_event_id IS NOT NULL OR EXISTS(SELECT 1 FROM training_learner_revision_events WHERE prior_turn_id=OLD.id)))
 BEGIN SELECT RAISE(ABORT,'TRAINING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER training_revision_prior_delete_guard BEFORE DELETE ON training_turns
 WHEN (OLD.learner_revision_event_id IS NOT NULL OR EXISTS(SELECT 1 FROM training_learner_revision_events WHERE prior_turn_id=OLD.id))
 AND EXISTS(SELECT 1 FROM training_sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_REVISION_IMMUTABLE'); END;
