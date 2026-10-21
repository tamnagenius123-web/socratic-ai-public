-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS scenario_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  domain TEXT NOT NULL,
  sub_domain TEXT,
  difficulty REAL DEFAULT 1.0,
  scenario_json TEXT NOT NULL,
  data_context_json TEXT,
  status TEXT DEFAULT 'active',
  current_turn INTEGER DEFAULT 0,
  final_scores_json TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000),
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS scenario_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  user_response TEXT NOT NULL,
  evaluation_json TEXT,
  next_challenge_json TEXT,
  academic_refs_json TEXT,
  difficulty_at_turn REAL,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES scenario_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_scenario_sessions_user ON scenario_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_scenario_turns_session ON scenario_turns(session_id);
