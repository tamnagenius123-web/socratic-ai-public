-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TRIGGER training_source_evidence_guard BEFORE INSERT ON training_scenario_evidence BEGIN
 SELECT RAISE(ABORT,'TRAINING_SOURCE_UNAVAILABLE') WHERE NOT EXISTS(
  SELECT 1 FROM training_sessions s JOIN books b ON b.id=NEW.book_id
  WHERE s.id=NEW.session_id AND s.training_mode='scenario' AND b.lifecycle_status='active'
   AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=s.user_id))
 );
END;

CREATE TRIGGER training_source_turn_guard BEFORE INSERT ON training_turns
WHEN EXISTS(SELECT 1 FROM training_sessions WHERE id=NEW.session_id AND training_mode='scenario') BEGIN
 SELECT RAISE(ABORT,'TRAINING_SOURCE_UNAVAILABLE') WHERE
 NOT EXISTS(SELECT 1 FROM training_scenario_evidence WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM training_scenario_evidence e JOIN training_sessions s ON s.id=e.session_id
  WHERE e.session_id=NEW.session_id AND NOT EXISTS(
   SELECT 1 FROM books b WHERE b.id=e.book_id AND b.lifecycle_status='active'
    AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=s.user_id))
  )
 );
END;

CREATE TRIGGER training_source_support_guard BEFORE INSERT ON training_support_responses BEGIN
 SELECT RAISE(ABORT,'TRAINING_SOURCE_UNAVAILABLE') WHERE
 NOT EXISTS(SELECT 1 FROM training_scenario_evidence WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM training_scenario_evidence e JOIN training_sessions s ON s.id=e.session_id
  WHERE e.session_id=NEW.session_id AND NOT EXISTS(
   SELECT 1 FROM books b WHERE b.id=e.book_id AND b.lifecycle_status='active'
    AND ((b.is_builtin=1 AND b.visibility='builtin') OR (b.visibility='private' AND b.owner_user_id=s.user_id))
  )
 );
END;
