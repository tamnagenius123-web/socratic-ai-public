-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE training_turns ADD COLUMN evaluation_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE training_turns ADD COLUMN citation_sources TEXT NOT NULL DEFAULT '[]';

ALTER TABLE sessions ADD COLUMN retrieval_trace TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS tutor_service_hooks (
  id TEXT PRIMARY KEY,
  hook_key TEXT NOT NULL UNIQUE,
  description TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tutor_service_hooks_key ON tutor_service_hooks(hook_key);

CREATE TABLE IF NOT EXISTS argument_nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  node_type TEXT NOT NULL,    content TEXT NOT NULL,
  confidence REAL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS argument_edges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,    weight REAL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_argument_nodes_session_turn ON argument_nodes(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_argument_edges_session ON argument_edges(session_id);

INSERT OR IGNORE INTO tutor_service_hooks (id, hook_key, description, config_json, enabled)
VALUES
  ('hook_retrieval_trace', 'retrieval_trace', 'RAG 근거 추적 저장 훅', '{"maxSources":5}', 1),
  ('hook_argument_graph', 'argument_graph', '논증 그래프 생성 훅', '{"minConfidence":0.55}', 0),
  ('hook_regression_loop', 'regression_loop', '근거 부족시 재질문 회귀 훅', '{"threshold":2}', 0);
