-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE training_interventions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL CHECK(revision>0),
 expected_revision INTEGER NOT NULL CHECK(expected_revision=revision-1), mutation_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('HELP','PAUSE','RESUME','STOP')),
 reason TEXT NOT NULL CHECK(reason IN ('LEARNER_REQUEST','NON_PROGRESS','DISTRESS','UNSAFE_ERROR','TIME_LIMIT','INSUFFICIENT_EVIDENCE')),
 origin TEXT NOT NULL CHECK(origin IN ('LEARNER','POLICY')), prior_turn_id INTEGER, created_at INTEGER NOT NULL,
 UNIQUE(session_id,revision), UNIQUE(session_id,mutation_key)
);

CREATE TABLE training_support_responses (
 intervention_id TEXT PRIMARY KEY REFERENCES training_interventions(id), session_id TEXT NOT NULL REFERENCES training_sessions(id),
 response TEXT NOT NULL, source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json) AND json_type(source_ids_json)='array' AND json_array_length(source_ids_json)>0),
 diagnosis_snapshot TEXT NOT NULL, routing_json TEXT NOT NULL CHECK(json_valid(routing_json)),
 policy_revision TEXT NOT NULL CHECK(policy_revision='bounded-support-v1'), created_at INTEGER NOT NULL
);

ALTER TABLE training_turns ADD COLUMN intervention_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER training_intervention_insert BEFORE INSERT ON training_interventions BEGIN
 SELECT RAISE(ABORT,'TRAINING_INTERVENTION_CONFLICT') WHERE EXISTS(SELECT 1 FROM training_interventions WHERE id=NEW.id)
 OR NEW.expected_revision<>(SELECT COALESCE(MAX(revision),0) FROM training_interventions WHERE session_id=NEW.session_id)
 OR NOT EXISTS(SELECT 1 FROM training_sessions WHERE id=NEW.session_id AND user_id=NEW.owner_user_id AND is_completed=0)
 OR EXISTS(SELECT 1 FROM training_interventions WHERE session_id=NEW.session_id AND action='STOP')
 OR (NEW.prior_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM training_turns WHERE id=NEW.prior_turn_id AND session_id=NEW.session_id))
 OR (NEW.action='HELP' AND (NEW.prior_turn_id IS NULL OR NOT EXISTS(SELECT 1 FROM training_session_contexts WHERE session_id=NEW.session_id AND owner_user_id=NEW.owner_user_id)))
 OR (NEW.action='RESUME' AND COALESCE((SELECT action FROM training_interventions WHERE session_id=NEW.session_id ORDER BY revision DESC LIMIT 1),'')<>'PAUSE');
END;

CREATE TRIGGER training_intervention_immutable BEFORE UPDATE ON training_interventions BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_delete BEFORE DELETE ON training_interventions WHEN EXISTS(SELECT 1 FROM training_sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id AND c.owner_user_id=OLD.owner_user_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_context_delete BEFORE DELETE ON training_session_contexts WHEN EXISTS(SELECT 1 FROM training_interventions WHERE session_id=OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_support_insert BEFORE INSERT ON training_support_responses BEGIN
 SELECT RAISE(ABORT,'TRAINING_INTERVENTION_CONFLICT') WHERE EXISTS(SELECT 1 FROM training_support_responses WHERE intervention_id=NEW.intervention_id)
 OR NOT EXISTS(SELECT 1 FROM training_interventions e JOIN training_sessions s ON s.id=e.session_id WHERE e.id=NEW.intervention_id AND e.session_id=NEW.session_id AND e.action='HELP'
 AND e.revision=(SELECT MAX(revision) FROM training_interventions WHERE session_id=NEW.session_id) AND s.user_id=e.owner_user_id AND s.is_completed=0)
 OR EXISTS(SELECT 1 FROM json_each(NEW.source_ids_json) j WHERE j.type<>'text' OR NOT EXISTS(SELECT 1 FROM training_scenario_evidence WHERE session_id=NEW.session_id AND source_id=j.value));
END;

CREATE TRIGGER training_support_immutable BEFORE UPDATE ON training_support_responses BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_support_delete BEFORE DELETE ON training_support_responses WHEN NOT EXISTS(SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_turn_guard BEFORE INSERT ON training_turns BEGIN
 SELECT RAISE(ABORT,'TRAINING_INTERVENTION_CONFLICT') WHERE NEW.intervention_revision<>(SELECT COALESCE(MAX(revision),0) FROM training_interventions WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM training_interventions e WHERE e.session_id=NEW.session_id AND e.revision=NEW.intervention_revision AND
 (e.action IN ('PAUSE','STOP') OR (e.action='HELP' AND NOT EXISTS(SELECT 1 FROM training_support_responses WHERE intervention_id=e.id))));
END;

CREATE TRIGGER training_intervention_turn_revision_immutable BEFORE UPDATE OF intervention_revision ON training_turns WHEN OLD.intervention_revision IS NOT NEW.intervention_revision
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_prior_replace BEFORE INSERT ON training_turns WHEN EXISTS(
 SELECT 1 FROM training_turns t JOIN training_interventions e ON e.prior_turn_id=t.id
 WHERE t.id=NEW.id OR (t.session_id=NEW.session_id AND t.turn_number=NEW.turn_number))
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_prior_update BEFORE UPDATE OF id,session_id,turn_number,student_message,diagnosis,tutor_state,evaluation_json,student_model_snapshot ON training_turns
 WHEN EXISTS(SELECT 1 FROM training_interventions WHERE prior_turn_id=OLD.id) AND
 (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.turn_number IS NOT NEW.turn_number OR OLD.student_message IS NOT NEW.student_message
 OR OLD.diagnosis IS NOT NEW.diagnosis OR OLD.tutor_state IS NOT NEW.tutor_state OR OLD.evaluation_json IS NOT NEW.evaluation_json OR OLD.student_model_snapshot IS NOT NEW.student_model_snapshot)
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_intervention_prior_delete BEFORE DELETE ON training_turns WHEN EXISTS(SELECT 1 FROM training_interventions WHERE prior_turn_id=OLD.id)
 AND EXISTS(SELECT 1 FROM training_sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_IMMUTABLE'); END;

CREATE TRIGGER training_stopped_route_guard BEFORE INSERT ON training_route_decisions
 WHEN EXISTS(SELECT 1 FROM training_interventions WHERE session_id=NEW.session_id AND action='STOP')
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_TERMINAL'); END;

CREATE TRIGGER training_stopped_revision_guard BEFORE INSERT ON training_learner_revision_events
 WHEN EXISTS(SELECT 1 FROM training_interventions WHERE session_id=NEW.session_id AND action='STOP')
 BEGIN SELECT RAISE(ABORT,'TRAINING_INTERVENTION_TERMINAL'); END;
