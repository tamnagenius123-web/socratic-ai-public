-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE sparring_hint_responses (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 context_id TEXT NOT NULL REFERENCES learning_session_contexts(id) ON DELETE CASCADE,
 owner_user_id TEXT NOT NULL REFERENCES users(id),
 mutation_key TEXT NOT NULL CHECK(length(mutation_key) BETWEEN 8 AND 128),
 prior_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 prior_evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
 turn_number INTEGER NOT NULL CHECK(turn_number>=2),
 hint_revision INTEGER NOT NULL CHECK(hint_revision>=1),
 hint_level INTEGER NOT NULL CHECK(hint_level IN (1,2)),
 response_text TEXT NOT NULL CHECK(length(trim(response_text))>0),
 source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json) AND json_type(source_snapshot_json)='array' AND json_array_length(source_snapshot_json)>0),
 diagnosis_json TEXT NOT NULL CHECK(json_valid(diagnosis_json) AND json_type(diagnosis_json)='object'),
 routing_json TEXT NOT NULL CHECK(json_valid(routing_json) AND json_type(routing_json)='object'),
 policy_revision TEXT NOT NULL CHECK(policy_revision='sparring-bounded-hint-v1'),
 created_at INTEGER NOT NULL,
 UNIQUE(session_id,mutation_key), UNIQUE(session_id,hint_revision)
);

CREATE TRIGGER sparring_hint_response_guard BEFORE INSERT ON sparring_hint_responses
WHEN EXISTS(SELECT 1 FROM sparring_hint_responses WHERE id=NEW.id OR (session_id=NEW.session_id AND (mutation_key=NEW.mutation_key OR hint_revision=NEW.hint_revision)))
OR NOT EXISTS (
 SELECT 1 FROM sessions s
 JOIN learning_session_contexts c ON c.id=NEW.context_id AND c.session_id=s.id
 JOIN messages m ON m.id=NEW.prior_message_id AND m.session_id=s.id AND m.role='user'
 JOIN evaluations e ON e.id=NEW.prior_evaluation_id AND e.session_id=s.id AND e.user_id=s.user_id AND e.turn=m.turn
 WHERE s.id=NEW.session_id AND s.user_id=NEW.owner_user_id
  AND c.owner_user_id=NEW.owner_user_id AND c.session_kind='SPARRING' AND c.status='ACTIVE'
  AND s.is_completed=0 AND s.is_abandoned=0 AND s.current_turn=NEW.turn_number AND s.current_turn<=s.max_turns
  AND m.turn=s.current_turn-1
  AND m.id=(SELECT id FROM messages WHERE session_id=s.id AND role='user' ORDER BY turn DESC,id DESC LIMIT 1)
  AND e.id=(SELECT id FROM evaluations WHERE session_id=s.id AND user_id=s.user_id AND turn=m.turn ORDER BY created_at DESC,id DESC LIMIT 1)
  AND s.hint_request_count=NEW.hint_revision-1
)
BEGIN SELECT RAISE(ABORT,'SPARRING_HINT_CONTEXT_CHANGED'); END;

CREATE TRIGGER sparring_hint_response_immutable BEFORE UPDATE ON sparring_hint_responses
BEGIN SELECT RAISE(ABORT,'SPARRING_HINT_IMMUTABLE'); END;

CREATE TRIGGER sparring_hint_counter_monotonic BEFORE UPDATE OF hint_request_count ON sessions
WHEN NEW.hint_request_count<OLD.hint_request_count
 AND EXISTS(SELECT 1 FROM sparring_hint_responses WHERE session_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'SPARRING_HINT_CONTEXT_CHANGED'); END;

CREATE TRIGGER sparring_hint_response_delete BEFORE DELETE ON sparring_hint_responses
WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
 AND EXISTS(SELECT 1 FROM learning_session_contexts WHERE id=OLD.context_id)
 AND NOT EXISTS(SELECT 1 FROM learning_session_context_deletion_authorizations WHERE session_context_id=OLD.context_id)
BEGIN SELECT RAISE(ABORT,'SPARRING_HINT_IMMUTABLE'); END;
