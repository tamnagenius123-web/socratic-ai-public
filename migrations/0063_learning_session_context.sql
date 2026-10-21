-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS learning_session_contexts (
  id TEXT PRIMARY KEY,
  session_kind TEXT NOT NULL CHECK (session_kind = 'SPARRING'),
  session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind = 'GROWTH_LAB'),
  subject_id TEXT NOT NULL,
  authority_capabilities_json TEXT NOT NULL,
  context_policy_revision TEXT NOT NULL,
  corpus_binding_id TEXT NOT NULL,
  corpus_manifest_revision TEXT NOT NULL,
  route_plan_json TEXT NOT NULL,
  prompt_cache_namespace TEXT NOT NULL,
  evidence_policy_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'ACTIVE'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_kind, session_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS learning_session_context_deletion_authorizations (
  session_context_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_context_id) REFERENCES learning_session_contexts(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS learning_session_contexts_opening_manifest_guard
BEFORE INSERT ON learning_session_contexts
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM sparring_evidence_manifests manifest
  WHERE manifest.session_id = NEW.session_id
    AND manifest.turn_number = 0
    AND manifest.user_id = NEW.owner_user_id
    AND manifest.manifest_sha256 = NEW.corpus_manifest_revision
    AND NEW.corpus_binding_id = 'book:' || manifest.book_id
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_SESSION_CONTEXT_OPENING_MANIFEST_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS learning_session_contexts_sparring_owner_guard
BEFORE INSERT ON learning_session_contexts
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM sessions
  WHERE id = NEW.session_id
    AND user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_SESSION_CONTEXT_SESSION_OWNER_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS learning_session_contexts_existing_identity_guard
BEFORE INSERT ON learning_session_contexts
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM learning_session_contexts
  WHERE id = NEW.id
     OR (session_kind = NEW.session_kind AND session_id = NEW.session_id)
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_SESSION_CONTEXT_ALREADY_EXISTS');
END;

CREATE TRIGGER IF NOT EXISTS learning_session_contexts_immutable_update
BEFORE UPDATE ON learning_session_contexts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_SESSION_CONTEXT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS learning_session_contexts_governed_delete_only
BEFORE DELETE ON learning_session_contexts
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM learning_session_context_deletion_authorizations
  WHERE session_context_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'LEARNING_SESSION_CONTEXT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_evidence_manifests_existing_identity_guard
BEFORE INSERT ON sparring_evidence_manifests
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM sparring_evidence_manifests
  WHERE id = NEW.id
     OR (session_id = NEW.session_id AND turn_number = NEW.turn_number)
)
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_evidence_manifests_immutable_update
BEFORE UPDATE ON sparring_evidence_manifests
FOR EACH ROW WHEN
  NEW.id IS NOT OLD.id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.turn_number IS NOT OLD.turn_number
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.book_id IS NOT OLD.book_id
  OR NEW.query_text IS NOT OLD.query_text
  OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
  OR NEW.source_count IS NOT OLD.source_count
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_evidence_manifests_immutable_delete
BEFORE DELETE ON sparring_evidence_manifests
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM learning_session_contexts context
  WHERE context.session_kind = 'SPARRING'
    AND context.session_id = OLD.session_id
    AND NOT EXISTS (
      SELECT 1
      FROM learning_session_context_deletion_authorizations authorization
      WHERE authorization.session_context_id = context.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_EVIDENCE_MANIFEST_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_turn_evidence_existing_identity_guard
BEFORE INSERT ON sparring_turn_evidence
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM sparring_turn_evidence
  WHERE id = NEW.id
     OR (session_id = NEW.session_id AND turn_number = NEW.turn_number AND chunk_id = NEW.chunk_id)
)
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_TURN_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_turn_evidence_immutable_update
BEFORE UPDATE ON sparring_turn_evidence
FOR EACH ROW WHEN
  NEW.id IS NOT OLD.id
  OR NEW.manifest_id IS NOT OLD.manifest_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.turn_number IS NOT OLD.turn_number
  OR NEW.book_id IS NOT OLD.book_id
  OR NEW.chunk_id IS NOT OLD.chunk_id
  OR NEW.chunk_index IS NOT OLD.chunk_index
  OR NEW.char_start IS NOT OLD.char_start
  OR NEW.char_end IS NOT OLD.char_end
  OR NEW.content_snapshot IS NOT OLD.content_snapshot
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.relevance_score IS NOT OLD.relevance_score
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.book_title IS NOT OLD.book_title
  OR NEW.book_author IS NOT OLD.book_author
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_TURN_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS sparring_turn_evidence_immutable_delete
BEFORE DELETE ON sparring_turn_evidence
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM learning_session_contexts context
  WHERE context.session_kind = 'SPARRING'
    AND context.session_id = OLD.session_id
    AND NOT EXISTS (
      SELECT 1
      FROM learning_session_context_deletion_authorizations authorization
      WHERE authorization.session_context_id = context.id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'SPARRING_TURN_EVIDENCE_IMMUTABLE');
END;

ALTER TABLE ai_invocation_attempts ADD COLUMN session_context_id TEXT;

ALTER TABLE ai_invocation_attempts ADD COLUMN session_id TEXT;

ALTER TABLE ai_invocation_attempts ADD COLUMN turn_number INTEGER;

ALTER TABLE ai_invocation_attempts ADD COLUMN prompt_cache_namespace TEXT;

CREATE TRIGGER IF NOT EXISTS ai_invocation_attempts_context_link_guard
BEFORE INSERT ON ai_invocation_attempts
FOR EACH ROW WHEN
  (NEW.session_context_id IS NULL AND (
    NEW.session_id IS NOT NULL
    OR NEW.turn_number IS NOT NULL
    OR NEW.prompt_cache_namespace IS NOT NULL
  ))
  OR
  (NEW.session_context_id IS NOT NULL AND (
    NEW.session_id IS NULL
    OR NEW.turn_number IS NULL
    OR NEW.prompt_cache_namespace IS NULL
    OR typeof(NEW.turn_number) <> 'integer'
    OR NEW.turn_number < 0
    OR NEW.turn_number > 9007199254740991
    OR length(trim(NEW.prompt_cache_namespace)) = 0
    OR NOT EXISTS (
      SELECT 1
      FROM learning_session_contexts context
      WHERE context.id = NEW.session_context_id
        AND context.session_kind = 'SPARRING'
        AND context.session_id = NEW.session_id
        AND context.prompt_cache_namespace = NEW.prompt_cache_namespace
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
END;

CREATE INDEX IF NOT EXISTS idx_learning_session_contexts_session
  ON learning_session_contexts (session_kind, session_id);

CREATE INDEX IF NOT EXISTS idx_learning_session_contexts_owner
  ON learning_session_contexts (owner_user_id, session_kind, session_id);

CREATE INDEX IF NOT EXISTS idx_ai_invocation_attempts_session_context
  ON ai_invocation_attempts (session_context_id, session_id, turn_number);
