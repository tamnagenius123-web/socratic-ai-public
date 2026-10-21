-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS argument_scheme_matches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  scheme_type TEXT NOT NULL,
  critical_questions TEXT,
  match_confidence REAL DEFAULT 0.0,
  walton_reference TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS canvas_node_positions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  x REAL DEFAULT 0.0,
  y REAL DEFAULT 0.0,
  user_label TEXT,
  color TEXT,
  is_pinned INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS enterprise_dashboards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  dashboard_type TEXT NOT NULL DEFAULT 'team',
  config_json TEXT,
  created_by TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS deepskill_fidelity_scores (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  neural_score REAL DEFAULT 0.0,
  bridge_score REAL DEFAULT 0.0,
  symbolic_score REAL DEFAULT 0.0,
  analytics_score REAL DEFAULT 0.0,
  overall_fidelity REAL DEFAULT 0.0,
  breakdown_json TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS custom_rubrics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by TEXT,
  rubric_json TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  event TEXT NOT NULL,
  session_id TEXT,
  user_id TEXT,
  payload TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS classchat_sessions (
  id TEXT PRIMARY KEY,
  room_name TEXT NOT NULL,
  topic TEXT NOT NULL,
  max_participants INTEGER DEFAULT 6,
  facilitator_mode TEXT DEFAULT 'ai_guided',
  status TEXT DEFAULT 'open',
  created_by TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS classchat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  role TEXT DEFAULT 'student',
  content TEXT NOT NULL,
  da_classification TEXT,
  arc_relation TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS pdf_exports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  format TEXT DEFAULT 'json',
  export_data TEXT,
  created_at INTEGER DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_scheme_matches_session ON argument_scheme_matches(session_id);

CREATE INDEX IF NOT EXISTS idx_canvas_positions_session ON canvas_node_positions(session_id);

CREATE INDEX IF NOT EXISTS idx_enterprise_dash_org ON enterprise_dashboards(org_id);

CREATE INDEX IF NOT EXISTS idx_fidelity_session ON deepskill_fidelity_scores(session_id);

CREATE INDEX IF NOT EXISTS idx_classchat_session ON classchat_messages(session_id);
