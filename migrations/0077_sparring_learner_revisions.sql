-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE sparring_learner_revisions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 context_id TEXT NOT NULL REFERENCES learning_session_contexts(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL CHECK(revision>0),
 expected_revision INTEGER NOT NULL CHECK(expected_revision=revision-1), mutation_key TEXT NOT NULL,
 expected_turn INTEGER NOT NULL, control_revision INTEGER NOT NULL,
 prior_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 prior_evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
 prior_turn INTEGER NOT NULL, prior_statement TEXT NOT NULL,
 revised_statement TEXT NOT NULL CHECK(length(trim(revised_statement)) BETWEEN 1 AND 4000),
 explanation TEXT NOT NULL CHECK(length(trim(explanation)) BETWEEN 1 AND 4000),
 source_ids_json TEXT NOT NULL CHECK(json_valid(source_ids_json) AND json_type(source_ids_json)='array'),
 manifest_id TEXT NOT NULL REFERENCES sparring_evidence_manifests(id) ON DELETE CASCADE,
 manifest_sha256 TEXT NOT NULL, support_id TEXT REFERENCES sparring_hint_responses(id) ON DELETE CASCADE,
 validation_status TEXT NOT NULL CHECK(validation_status='UNVERIFIED'), created_at INTEGER NOT NULL,
 UNIQUE(session_id,revision), UNIQUE(session_id,mutation_key)
);

ALTER TABLE messages ADD COLUMN sparring_revision_id TEXT;

ALTER TABLE messages ADD COLUMN sparring_revision_number INTEGER;

CREATE UNIQUE INDEX sparring_revision_consumed_once ON messages(sparring_revision_id) WHERE sparring_revision_id IS NOT NULL;

CREATE TRIGGER sparring_revision_insert BEFORE INSERT ON sparring_learner_revisions BEGIN
 SELECT RAISE(ABORT,'SPARRING_REVISION_CONFLICT') WHERE
 EXISTS(SELECT 1 FROM sparring_learner_revisions WHERE id=NEW.id OR (session_id=NEW.session_id AND mutation_key=NEW.mutation_key))
 OR NEW.expected_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_learner_revisions WHERE session_id=NEW.session_id)
 OR NEW.control_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_controls WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM sparring_controls WHERE session_id=NEW.session_id AND action='STOP')
 OR NOT EXISTS(
  SELECT 1 FROM sessions s JOIN learning_session_contexts c ON c.id=NEW.context_id AND c.session_id=s.id
  JOIN messages m ON m.id=NEW.prior_message_id AND m.session_id=s.id AND m.role='user'
  JOIN evaluations e ON e.id=NEW.prior_evaluation_id AND e.session_id=s.id AND e.user_id=s.user_id AND e.turn=m.turn
  JOIN sparring_evidence_manifests f ON f.id=NEW.manifest_id AND f.session_id=s.id AND f.turn_number=m.turn AND f.user_id=s.user_id
  WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND c.owner_user_id=s.user_id AND c.session_kind='SPARRING' AND c.status='ACTIVE'
   AND s.is_completed=0 AND s.is_abandoned=0 AND s.current_turn<=s.max_turns AND s.current_turn=NEW.expected_turn
   AND m.turn=NEW.prior_turn AND m.turn<s.current_turn AND m.content=NEW.prior_statement AND f.manifest_sha256=NEW.manifest_sha256
   AND (SELECT COUNT(*) FROM evaluations WHERE session_id=s.id AND user_id=s.user_id AND turn=m.turn)=1
   AND (NEW.support_id IS NULL OR EXISTS(SELECT 1 FROM sparring_hint_responses h WHERE h.id=NEW.support_id AND h.session_id=s.id AND h.context_id=c.id AND h.owner_user_id=s.user_id AND h.prior_message_id=m.id AND h.prior_evaluation_id=e.id))
 )
 OR EXISTS(SELECT 1 FROM json_each(NEW.source_ids_json) j WHERE j.type<>'text' OR NOT EXISTS(SELECT 1 FROM sparring_turn_evidence ev WHERE ev.manifest_id=NEW.manifest_id AND ev.chunk_id=j.value));
END;

CREATE TRIGGER sparring_revision_immutable BEFORE UPDATE ON sparring_learner_revisions
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER sparring_revision_delete BEFORE DELETE ON sparring_learner_revisions
WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM learning_session_context_deletion_authorizations WHERE session_context_id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER sparring_revision_message_guard BEFORE INSERT ON messages
WHEN EXISTS(SELECT 1 FROM learning_session_contexts WHERE session_id=NEW.session_id AND session_kind='SPARRING') BEGIN
 SELECT RAISE(ABORT,'SPARRING_REVISION_CONFLICT') WHERE
 (NEW.sparring_revision_id IS NULL)<>(NEW.sparring_revision_number IS NULL)
 OR (NEW.sparring_revision_id IS NOT NULL AND (NEW.role<>'user' OR NOT EXISTS(
  SELECT 1 FROM sparring_learner_revisions r WHERE r.id=NEW.sparring_revision_id AND r.session_id=NEW.session_id
   AND r.revision=NEW.sparring_revision_number AND r.expected_turn=NEW.turn
   AND r.revision=(SELECT MAX(revision) FROM sparring_learner_revisions WHERE session_id=NEW.session_id)
   AND NOT EXISTS(SELECT 1 FROM messages WHERE sparring_revision_id=r.id))))
 OR (NEW.role='user' AND NEW.sparring_revision_id IS NULL AND EXISTS(SELECT 1 FROM sparring_learner_revisions r
  WHERE r.session_id=NEW.session_id AND r.revision=(SELECT MAX(revision) FROM sparring_learner_revisions WHERE session_id=NEW.session_id)
   AND NOT EXISTS(SELECT 1 FROM messages WHERE sparring_revision_id=r.id)))
 OR EXISTS(SELECT 1 FROM sparring_learner_revisions WHERE prior_message_id=NEW.id)
 OR EXISTS(SELECT 1 FROM messages WHERE id=NEW.id AND sparring_revision_id IS NOT NULL);
END;

CREATE TRIGGER sparring_revision_message_immutable BEFORE UPDATE ON messages
WHEN OLD.sparring_revision_id IS NOT NEW.sparring_revision_id OR OLD.sparring_revision_number IS NOT NEW.sparring_revision_number
 OR ((OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.role IS NOT NEW.role OR OLD.turn IS NOT NEW.turn OR OLD.content IS NOT NEW.content OR OLD.timestamp IS NOT NEW.timestamp)
  AND (OLD.sparring_revision_id IS NOT NULL OR EXISTS(SELECT 1 FROM sparring_learner_revisions WHERE prior_message_id=OLD.id)))
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER sparring_revision_evaluation_immutable BEFORE UPDATE ON evaluations
WHEN EXISTS(SELECT 1 FROM sparring_learner_revisions WHERE prior_evaluation_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER sparring_revision_evaluation_replace BEFORE INSERT ON evaluations
WHEN EXISTS(SELECT 1 FROM sparring_learner_revisions r JOIN evaluations e ON e.id=r.prior_evaluation_id
 WHERE e.id=NEW.id OR (e.session_id=NEW.session_id AND e.turn=NEW.turn))
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;

CREATE TRIGGER sparring_revision_consumed_delete BEFORE DELETE ON messages
WHEN OLD.sparring_revision_id IS NOT NULL AND EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND NOT EXISTS(SELECT 1 FROM learning_session_contexts c JOIN learning_session_context_deletion_authorizations a ON a.session_context_id=c.id WHERE c.session_id=OLD.session_id AND c.session_kind='SPARRING')
BEGIN SELECT RAISE(ABORT,'SPARRING_REVISION_IMMUTABLE'); END;
