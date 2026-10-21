-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS linucb_arms (
  arm_id TEXT PRIMARY KEY,
  context_dim INTEGER NOT NULL DEFAULT 8,
  A_matrix_json TEXT NOT NULL,
  b_vector_json TEXT NOT NULL,
  n_pulls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_linucb_arms_updated
  ON linucb_arms(updated_at DESC);

CREATE TABLE IF NOT EXISTS linucb_session_arms (
  session_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  A_matrix_json TEXT NOT NULL,
  b_vector_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, arm_id)
);

CREATE INDEX IF NOT EXISTS idx_linucb_session_arms_session
  ON linucb_session_arms(session_id);
