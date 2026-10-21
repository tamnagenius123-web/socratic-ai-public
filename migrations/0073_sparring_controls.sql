-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE sparring_controls (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 context_id TEXT NOT NULL REFERENCES learning_session_contexts(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 expected_revision INTEGER NOT NULL CHECK(expected_revision=revision-1),
 mutation_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('PAUSE','RESUME','STOP')),
 reason TEXT NOT NULL CHECK(reason IN ('LEARNER_REQUEST','DISTRESS','UNSAFE_ERROR','TIME_LIMIT','INSUFFICIENT_EVIDENCE')),
 created_at INTEGER NOT NULL,
 UNIQUE(session_id,revision), UNIQUE(session_id,mutation_key)
);

CREATE TRIGGER sparring_control_insert BEFORE INSERT ON sparring_controls BEGIN
 SELECT RAISE(ABORT,'SPARRING_CONTROL_CONFLICT') WHERE
 EXISTS(SELECT 1 FROM sparring_controls WHERE id=NEW.id OR (session_id=NEW.session_id AND mutation_key=NEW.mutation_key))
 OR NEW.expected_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_controls WHERE session_id=NEW.session_id)
 OR NOT EXISTS(SELECT 1 FROM sessions s JOIN learning_session_contexts c ON c.session_id=s.id
  WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id AND s.is_completed=0 AND s.is_abandoned=0 AND s.current_turn<=s.max_turns
   AND c.id=NEW.context_id AND c.session_kind='SPARRING' AND c.owner_user_id=NEW.owner_user_id AND c.status='ACTIVE')
 OR EXISTS(SELECT 1 FROM sparring_controls WHERE session_id=NEW.session_id AND action='STOP')
 OR (NEW.action='RESUME' AND COALESCE((SELECT action FROM sparring_controls WHERE session_id=NEW.session_id ORDER BY revision DESC LIMIT 1),'')<>'PAUSE')
 OR (NEW.action='PAUSE' AND (SELECT action FROM sparring_controls WHERE session_id=NEW.session_id ORDER BY revision DESC LIMIT 1)='PAUSE');
END;

CREATE TRIGGER sparring_control_immutable BEFORE UPDATE ON sparring_controls
BEGIN SELECT RAISE(ABORT,'SPARRING_CONTROL_IMMUTABLE'); END;

CREATE TRIGGER sparring_control_delete BEFORE DELETE ON sparring_controls
WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND EXISTS(SELECT 1 FROM learning_session_contexts WHERE id=OLD.context_id)
 AND NOT EXISTS(SELECT 1 FROM learning_session_context_deletion_authorizations WHERE session_context_id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'SPARRING_CONTROL_IMMUTABLE'); END;

ALTER TABLE messages ADD COLUMN sparring_control_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sparring_hint_responses ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER sparring_control_turn_guard BEFORE INSERT ON messages WHEN NEW.role='user' BEGIN
 SELECT RAISE(ABORT,'SPARRING_CONTROL_CONFLICT') WHERE
 NEW.sparring_control_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_controls WHERE session_id=NEW.session_id)
 OR COALESCE((SELECT action FROM sparring_controls WHERE session_id=NEW.session_id ORDER BY revision DESC LIMIT 1),'RESUME')<>'RESUME'
 OR EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND is_abandoned=1);
END;

CREATE TRIGGER sparring_accepted_turn_guard BEFORE INSERT ON messages
WHEN NEW.role='user' AND EXISTS(SELECT 1 FROM learning_session_contexts WHERE session_id=NEW.session_id AND session_kind='SPARRING') BEGIN
 SELECT RAISE(ABORT,'SPARRING_TURN_CONFLICT') WHERE
 EXISTS(SELECT 1 FROM messages WHERE session_id=NEW.session_id AND role='user' AND turn=NEW.turn)
 OR NOT EXISTS(SELECT 1 FROM sessions s JOIN learning_session_contexts c ON c.session_id=s.id
  WHERE s.id=NEW.session_id AND c.session_kind='SPARRING' AND c.owner_user_id=s.user_id AND c.status='ACTIVE'
   AND s.current_turn=NEW.turn+1 AND NEW.turn>=1 AND NEW.turn<=s.max_turns AND s.is_abandoned=0);
END;

CREATE TRIGGER sparring_control_turn_revision_immutable BEFORE UPDATE OF sparring_control_revision ON messages
WHEN OLD.sparring_control_revision IS NOT NEW.sparring_control_revision
BEGIN SELECT RAISE(ABORT,'SPARRING_CONTROL_IMMUTABLE'); END;

CREATE TRIGGER sparring_control_hint_guard BEFORE INSERT ON sparring_hint_responses BEGIN
 SELECT RAISE(ABORT,'SPARRING_CONTROL_CONFLICT') WHERE
 NEW.control_revision<>(SELECT COALESCE(MAX(revision),0) FROM sparring_controls WHERE session_id=NEW.session_id)
 OR EXISTS(SELECT 1 FROM sparring_controls WHERE session_id=NEW.session_id AND action='STOP');
END;
