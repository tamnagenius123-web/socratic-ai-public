-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sessions ADD COLUMN layer_state_json TEXT DEFAULT '{"currentLayer":"surface","layerHistory":["surface"],"surfaceCleared":false,"structureCleared":false,"assumptionCleared":false,"turnsInCurrentLayer":0,"layerTransitionTurns":[]}';

ALTER TABLE sessions ADD COLUMN initial_claim_v12 TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS student_growth_profile (
  user_id TEXT PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  total_turns INTEGER DEFAULT 0,

     elo_evidence REAL DEFAULT 1000,
  elo_reasoning REAL DEFAULT 1000,
  elo_defense REAL DEFAULT 1000,
  elo_clarity REAL DEFAULT 1000,
  elo_consistency REAL DEFAULT 1000,

     thought_profile_json TEXT DEFAULT '{}',

     chronic_weaknesses TEXT DEFAULT '[]',

     milestones TEXT DEFAULT '[]',

     recent_session_scores TEXT DEFAULT '[]',

  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS growth_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  achieved_at INTEGER NOT NULL,
  session_id TEXT,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_growth_milestones_user ON growth_milestones(user_id);

CREATE INDEX IF NOT EXISTS idx_student_growth_updated ON student_growth_profile(updated_at);
