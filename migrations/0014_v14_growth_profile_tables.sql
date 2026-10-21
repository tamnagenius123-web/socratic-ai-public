-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS student_growth_profile (
  user_id TEXT PRIMARY KEY,
  total_sessions INTEGER DEFAULT 0,
  total_turns INTEGER DEFAULT 0,
  elo_evidence INTEGER DEFAULT 1000,
  elo_reasoning INTEGER DEFAULT 1000,
  elo_defense INTEGER DEFAULT 1000,
  elo_clarity INTEGER DEFAULT 1000,
  elo_consistency INTEGER DEFAULT 1000,
  thought_profile_json TEXT DEFAULT '{}',
  chronic_weaknesses TEXT DEFAULT '[]',
  recent_session_scores TEXT DEFAULT '[]',
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS growth_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  achieved_at INTEGER NOT NULL,
  details TEXT,
  UNIQUE(user_id, milestone_type)
);

CREATE INDEX IF NOT EXISTS idx_growth_milestones_user ON growth_milestones(user_id);
