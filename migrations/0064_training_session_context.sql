-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS training_session_contexts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  evidence_manifest_sha256 TEXT NOT NULL,
  route_plan_json TEXT NOT NULL,
  prompt_cache_namespace TEXT NOT NULL,
  evidence_policy_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'ACTIVE'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (length(trim(id)) > 0),
  CHECK (length(evidence_manifest_sha256) = 64 AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(route_plan_json) AND json_type(route_plan_json) = 'object'),
  CHECK (length(trim(prompt_cache_namespace)) > 0),
  CHECK (length(trim(evidence_policy_revision)) > 0),
  CHECK (typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991),
  CHECK (updated_at = created_at)
);

CREATE TABLE IF NOT EXISTS training_session_context_deletion_authorizations (
  session_context_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_context_id) REFERENCES training_session_contexts(id) ON DELETE CASCADE,
  CHECK (length(trim(authorization_id)) > 0),
  CHECK (typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991)
);

CREATE TRIGGER IF NOT EXISTS training_session_contexts_existing_identity_guard
BEFORE INSERT ON training_session_contexts
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM training_session_contexts
  WHERE id = NEW.id OR session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SESSION_CONTEXT_ALREADY_EXISTS');
END;

CREATE TRIGGER IF NOT EXISTS training_session_contexts_owner_and_pack_guard
BEFORE INSERT ON training_session_contexts
FOR EACH ROW WHEN
  NOT EXISTS (
    SELECT 1 FROM training_sessions session
    WHERE session.id = NEW.session_id
      AND session.user_id = NEW.owner_user_id
      AND session.training_mode = 'scenario'
  )
  OR NOT EXISTS (
    SELECT 1 FROM training_scenario_packs pack
    WHERE pack.session_id = NEW.session_id
      AND pack.mode = 'scenario'
      AND pack.evidence_status = 'ready'
      AND pack.evidence_manifest_sha256 = NEW.evidence_manifest_sha256
      AND pack.source_count = (
        SELECT COUNT(*) FROM training_scenario_evidence evidence
        WHERE evidence.session_id = NEW.session_id
      )
      AND pack.book_count = (
        SELECT COUNT(DISTINCT evidence.book_id)
        FROM training_scenario_evidence evidence
        WHERE evidence.session_id = NEW.session_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SESSION_CONTEXT_READY_PACK_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS training_session_contexts_immutable_update
BEFORE UPDATE ON training_session_contexts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SESSION_CONTEXT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_session_contexts_delete_dependencies_first
BEFORE DELETE ON training_session_contexts
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_scenario_packs pack WHERE pack.session_id = OLD.session_id)
  OR EXISTS (SELECT 1 FROM training_scenario_evidence evidence WHERE evidence.session_id = OLD.session_id)
  OR EXISTS (SELECT 1 FROM ai_invocation_attempts attempt WHERE attempt.session_context_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SESSION_CONTEXT_DEPENDENCIES_REMAIN');
END;

CREATE TRIGGER IF NOT EXISTS training_session_contexts_governed_delete_only
BEFORE DELETE ON training_session_contexts
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM training_session_context_deletion_authorizations authorization
  WHERE authorization.session_context_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SESSION_CONTEXT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_packs_bound_existing_identity_guard
BEFORE INSERT ON training_scenario_packs
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM training_session_contexts context WHERE context.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_PACK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_packs_bound_immutable_update
BEFORE UPDATE ON training_scenario_packs
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = OLD.session_id)
  OR EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_PACK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_packs_bound_delete_dependencies_first
BEFORE DELETE ON training_scenario_packs
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = OLD.session_id)
  AND EXISTS (SELECT 1 FROM training_scenario_evidence evidence WHERE evidence.session_id = OLD.session_id)
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_PACK_DEPENDENCIES_REMAIN');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_packs_bound_governed_delete
BEFORE DELETE ON training_scenario_packs
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = OLD.session_id)
  AND NOT EXISTS (
    SELECT 1
    FROM training_session_contexts context
    INNER JOIN training_session_context_deletion_authorizations authorization
      ON authorization.session_context_id = context.id
    WHERE context.session_id = OLD.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_PACK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_evidence_bound_existing_identity_guard
BEFORE INSERT ON training_scenario_evidence
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = NEW.session_id)
  OR EXISTS (
    SELECT 1
    FROM training_scenario_evidence current
    INNER JOIN training_session_contexts context ON context.session_id = current.session_id
    WHERE current.id = NEW.id
       OR (current.session_id = NEW.session_id AND current.source_id = NEW.source_id)
  )
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_evidence_bound_immutable_update
BEFORE UPDATE ON training_scenario_evidence
FOR EACH ROW WHEN
  (
    EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = OLD.session_id)
    OR EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = NEW.session_id)
  )
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.source_id IS NOT OLD.source_id
    OR NEW.selection_index IS NOT OLD.selection_index
    OR NEW.book_id IS NOT OLD.book_id
    OR NEW.chunk_id IS NOT OLD.chunk_id
    OR NEW.book_title IS NOT OLD.book_title
    OR NEW.book_author IS NOT OLD.book_author
    OR NEW.chunk_index IS NOT OLD.chunk_index
    OR NEW.char_start IS NOT OLD.char_start
    OR NEW.char_end IS NOT OLD.char_end
    OR NEW.excerpt IS NOT OLD.excerpt
    OR NEW.content_sha256 IS NOT OLD.content_sha256
    OR NEW.relevance_score IS NOT OLD.relevance_score
    OR NEW.created_at IS NOT OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS training_scenario_evidence_bound_governed_delete
BEFORE DELETE ON training_scenario_evidence
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM training_session_contexts context WHERE context.session_id = OLD.session_id)
  AND NOT EXISTS (
    SELECT 1
    FROM training_session_contexts context
    INNER JOIN training_session_context_deletion_authorizations authorization
      ON authorization.session_context_id = context.id
    WHERE context.session_id = OLD.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_SCENARIO_EVIDENCE_IMMUTABLE');
END;

DROP TRIGGER IF EXISTS ai_invocation_attempts_context_link_guard;

CREATE TRIGGER ai_invocation_attempts_context_link_guard
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
    OR (
      (
        SELECT COUNT(*) FROM learning_session_contexts context
        WHERE context.id = NEW.session_context_id
          AND context.session_kind = 'SPARRING'
          AND context.session_id = NEW.session_id
          AND context.prompt_cache_namespace = NEW.prompt_cache_namespace
          AND json_valid(context.route_plan_json)
          AND EXISTS (
            SELECT 1 FROM json_each(context.route_plan_json, '$."' || NEW.lane || '"') route
            WHERE route.type = 'text' AND route.value = NEW.route_id
          )
      )
      +
      (
        SELECT COUNT(*) FROM training_session_contexts context
        WHERE context.id = NEW.session_context_id
          AND context.session_id = NEW.session_id
          AND context.prompt_cache_namespace = NEW.prompt_cache_namespace
          AND context.status = 'ACTIVE'
          AND json_valid(context.route_plan_json)
          AND EXISTS (
            SELECT 1 FROM json_each(context.route_plan_json, '$."' || NEW.lane || '"') route
            WHERE route.type = 'text' AND route.value = NEW.route_id
          )
      )
    ) <> 1
  ))
BEGIN
  SELECT RAISE(ABORT, 'AI_INVOCATION_ATTEMPT_CONTEXT_LINK_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS ai_invocation_attempts_context_existing_identity_guard
BEFORE INSERT ON ai_invocation_attempts
FOR EACH ROW WHEN
  EXISTS (
    SELECT 1 FROM ai_invocation_attempts current
    WHERE current.id = NEW.id
       OR (current.invocation_id = NEW.invocation_id AND current.attempt_index = NEW.attempt_index)
  )
  AND (
    NEW.session_context_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM ai_invocation_attempts current
      WHERE (current.id = NEW.id
         OR (current.invocation_id = NEW.invocation_id AND current.attempt_index = NEW.attempt_index))
        AND current.session_context_id IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'AI_INVOCATION_ATTEMPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS ai_invocation_attempts_context_immutable_update
BEFORE UPDATE ON ai_invocation_attempts
FOR EACH ROW WHEN
  (OLD.session_context_id IS NULL AND (
    NEW.session_context_id IS NOT NULL
    OR NEW.session_id IS NOT NULL
    OR NEW.turn_number IS NOT NULL
    OR NEW.prompt_cache_namespace IS NOT NULL
  ))
  OR EXISTS (
    SELECT 1 FROM training_session_contexts context
    WHERE context.id = OLD.session_context_id OR context.id = NEW.session_context_id
  )
BEGIN
  SELECT RAISE(ABORT, 'AI_INVOCATION_ATTEMPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS ai_invocation_attempts_context_immutable_delete
BEFORE DELETE ON ai_invocation_attempts
FOR EACH ROW WHEN
  EXISTS (
    SELECT 1 FROM training_session_contexts context
    WHERE context.id = OLD.session_context_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM training_session_contexts context
    INNER JOIN training_session_context_deletion_authorizations authorization
      ON authorization.session_context_id = context.id
    WHERE context.id = OLD.session_context_id
  )
BEGIN
  SELECT RAISE(ABORT, 'AI_INVOCATION_ATTEMPT_IMMUTABLE');
END;

CREATE INDEX IF NOT EXISTS idx_training_session_contexts_owner
  ON training_session_contexts (owner_user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_training_session_contexts_manifest
  ON training_session_contexts (evidence_manifest_sha256);
