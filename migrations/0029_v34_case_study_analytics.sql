-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS case_studies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scenario_json TEXT NOT NULL,
  financial_data_json TEXT,
  personas_json TEXT NOT NULL,
  data_points_json TEXT NOT NULL,
  difficulty REAL DEFAULT 1.0,
  industry TEXT,
  target_competencies TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_case_studies_user ON case_studies(user_id);

CREATE INDEX IF NOT EXISTS idx_case_studies_industry ON case_studies(industry);

CREATE TABLE IF NOT EXISTS case_study_sessions (
  id TEXT PRIMARY KEY,
  case_study_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  active_persona TEXT NOT NULL,
  conversation_json TEXT DEFAULT '[]',
  data_references_json TEXT DEFAULT '[]',
  micro_scores_json TEXT DEFAULT '{}',
  turn_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (case_study_id) REFERENCES case_studies(id)
);

CREATE INDEX IF NOT EXISTS idx_css_user ON case_study_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_css_case ON case_study_sessions(case_study_id);

CREATE TABLE IF NOT EXISTS analytics_reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_type TEXT DEFAULT 'sparring',
  report_json TEXT NOT NULL,
  axis_scores_json TEXT NOT NULL,
  overall_score REAL,
  indicator_count INTEGER,
  processing_time_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ar_user ON analytics_reports(user_id);

CREATE INDEX IF NOT EXISTS idx_ar_session ON analytics_reports(session_id);

CREATE TABLE IF NOT EXISTS indicator_definitions (
  id TEXT PRIMARY KEY,
  axis TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ko TEXT NOT NULL,
  description TEXT,
  tier TEXT DEFAULT 'realtime',
  weight REAL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);
