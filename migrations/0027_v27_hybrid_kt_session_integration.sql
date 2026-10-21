-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS hybrid_kt_states (
  user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS argunet_classification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user_id TEXT,
  utterance TEXT NOT NULL,
  act_type TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  illocutionary_force REAL DEFAULT 0.5,
  llm_classified INTEGER DEFAULT 0,
  reasoning TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hybrid_kt_user ON hybrid_kt_states(user_id);

CREATE INDEX IF NOT EXISTS idx_argunet_log_session ON argunet_classification_log(session_id);

CREATE INDEX IF NOT EXISTS idx_argunet_log_user ON argunet_classification_log(user_id);
