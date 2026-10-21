-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS ai_invocation_attempts (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('route', 'smoke')),
  lane TEXT NOT NULL,
  route_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_alias TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 1),
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  failure_class TEXT,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  prompt_schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  response_sha256 TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (invocation_id, attempt_index),
  CHECK (
    (outcome = 'success' AND failure_class IS NULL AND retryable = 0)
    OR (outcome = 'failure' AND failure_class IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_invocation_attempts_route_outcome_completed
  ON ai_invocation_attempts (route_id, outcome, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_invocation_attempts_invocation
  ON ai_invocation_attempts (invocation_id, attempt_index);
