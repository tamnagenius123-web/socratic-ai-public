-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE training_sessions ADD COLUMN learning_route_version INTEGER CHECK (learning_route_version IS NULL OR learning_route_version = 1);

ALTER TABLE training_turns ADD COLUMN learning_route_decision_id TEXT REFERENCES training_route_decisions(id);

ALTER TABLE training_turns ADD COLUMN learning_route_revision INTEGER;

CREATE TABLE training_route_offers (
 session_id TEXT PRIMARY KEY REFERENCES training_sessions(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), offer_json TEXT NOT NULL CHECK (json_valid(offer_json)), created_at INTEGER NOT NULL
);

CREATE TABLE training_route_decisions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES training_route_offers(session_id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), decision_revision INTEGER NOT NULL CHECK (decision_revision > 0),
 selected_route TEXT NOT NULL CHECK (selected_route IN ('case-first','proof-first','mixed')),
 effective_from_turn INTEGER NOT NULL CHECK (effective_from_turn > 0), mutation_key TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK (expected_revision = decision_revision - 1), created_at INTEGER NOT NULL,
 UNIQUE(session_id, decision_revision), UNIQUE(session_id, mutation_key)
);

CREATE TRIGGER training_route_offer_owner BEFORE INSERT ON training_route_offers BEGIN
 SELECT RAISE(ABORT, 'TRAINING_ROUTE_CONFLICT') WHERE EXISTS (SELECT 1 FROM training_route_offers WHERE session_id=NEW.session_id)
 OR NOT EXISTS (SELECT 1 FROM training_sessions WHERE id=NEW.session_id AND user_id=NEW.owner_user_id AND training_mode='scenario' AND learning_route_version=1)
 OR NOT EXISTS (SELECT 1 FROM training_session_contexts c WHERE c.session_id=NEW.session_id AND c.owner_user_id=NEW.owner_user_id AND c.evidence_manifest_sha256=json_extract(NEW.offer_json,'$.manifestSha256'));
END;

CREATE TRIGGER training_route_offer_immutable BEFORE UPDATE ON training_route_offers BEGIN SELECT RAISE(ABORT,'TRAINING_ROUTE_IMMUTABLE'); END;

CREATE TRIGGER training_route_revision_guard BEFORE INSERT ON training_route_decisions BEGIN
 SELECT RAISE(ABORT,'TRAINING_ROUTE_CONFLICT') WHERE EXISTS (SELECT 1 FROM training_route_decisions WHERE id=NEW.id)
 OR NEW.expected_revision <> (SELECT COALESCE(MAX(decision_revision),0) FROM training_route_decisions WHERE session_id=NEW.session_id)
 OR NOT EXISTS (SELECT 1 FROM training_sessions s JOIN training_route_offers o ON o.session_id=s.id WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND o.owner_user_id=NEW.owner_user_id AND s.is_completed=0 AND s.current_turn=NEW.effective_from_turn);
END;

CREATE TRIGGER training_route_revision_immutable BEFORE UPDATE ON training_route_decisions BEGIN SELECT RAISE(ABORT,'TRAINING_ROUTE_IMMUTABLE'); END;

CREATE TRIGGER training_route_offer_delete_guard BEFORE DELETE ON training_route_offers WHEN EXISTS (SELECT 1 FROM training_sessions WHERE id=OLD.session_id) AND NOT EXISTS (SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id AND c.owner_user_id=OLD.owner_user_id) BEGIN SELECT RAISE(ABORT,'TRAINING_ROUTE_IMMUTABLE'); END;

CREATE TRIGGER training_route_revision_delete_guard BEFORE DELETE ON training_route_decisions WHEN EXISTS (SELECT 1 FROM training_sessions WHERE id=OLD.session_id) AND NOT EXISTS (SELECT 1 FROM training_session_contexts c JOIN training_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id AND c.owner_user_id=OLD.owner_user_id) BEGIN SELECT RAISE(ABORT,'TRAINING_ROUTE_IMMUTABLE'); END;

CREATE TRIGGER training_route_turn_guard BEFORE INSERT ON training_turns WHEN (SELECT learning_route_version FROM training_sessions WHERE id=NEW.session_id)=1 BEGIN
 SELECT RAISE(ABORT,'TRAINING_ROUTE_CONFLICT') WHERE EXISTS (SELECT 1 FROM training_turns WHERE session_id=NEW.session_id AND turn_number=NEW.turn_number) OR NOT EXISTS (
  SELECT 1 FROM training_route_decisions d JOIN training_sessions s ON s.id=d.session_id
  WHERE d.id=NEW.learning_route_decision_id AND d.session_id=NEW.session_id AND d.owner_user_id=s.user_id
  AND d.decision_revision=NEW.learning_route_revision AND d.decision_revision=(SELECT MAX(decision_revision) FROM training_route_decisions WHERE session_id=NEW.session_id)
  AND s.current_turn=NEW.turn_number AND s.is_completed=0 AND d.effective_from_turn<=NEW.turn_number
 );
END;

CREATE TRIGGER training_route_turn_link_pair BEFORE INSERT ON training_turns BEGIN
 SELECT RAISE(ABORT,'TRAINING_ROUTE_CONFLICT') WHERE
 (NEW.learning_route_decision_id IS NULL) <> (NEW.learning_route_revision IS NULL)
 OR (NEW.learning_route_decision_id IS NOT NULL AND COALESCE((SELECT learning_route_version FROM training_sessions WHERE id=NEW.session_id),0)<>1);
END;

CREATE TRIGGER training_route_turn_link_immutable BEFORE UPDATE OF learning_route_decision_id, learning_route_revision ON training_turns
WHEN OLD.learning_route_decision_id IS NOT NEW.learning_route_decision_id OR OLD.learning_route_revision IS NOT NEW.learning_route_revision
BEGIN SELECT RAISE(ABORT,'TRAINING_ROUTE_IMMUTABLE'); END;
