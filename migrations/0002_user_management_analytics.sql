-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  student_id TEXT UNIQUE,
  grade INTEGER,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'instructor', 'admin')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_login INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE INDEX IF NOT EXISTS idx_users_student_id ON users(student_id);

ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT NULL;

ALTER TABLE sessions ADD COLUMN is_completed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN is_abandoned INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN abandoned_at INTEGER;

ALTER TABLE sessions ADD COLUMN abandoned_turn INTEGER;

ALTER TABLE sessions ADD COLUMN ended_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_is_completed ON sessions(is_completed);

CREATE INDEX IF NOT EXISTS idx_sessions_is_abandoned ON sessions(is_abandoned);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT,
  turn INTEGER NOT NULL,
  defense_score REAL NOT NULL DEFAULT 0,
  consistency_score REAL NOT NULL DEFAULT 0,
  evidence_score REAL NOT NULL DEFAULT 0,
  relevance_score REAL NOT NULL DEFAULT 0,
  clarity_score REAL NOT NULL DEFAULT 0,
  avg_score REAL NOT NULL DEFAULT 0,
  evidence_found INTEGER NOT NULL DEFAULT 0,
  fallacy_detected INTEGER NOT NULL DEFAULT 0,
  fallacy_type TEXT,
  weakness TEXT,
  feedback TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_evaluations_session_id ON evaluations(session_id);

CREATE INDEX IF NOT EXISTS idx_evaluations_user_id ON evaluations(user_id);

CREATE INDEX IF NOT EXISTS idx_evaluations_session_turn ON evaluations(session_id, turn);

CREATE TABLE IF NOT EXISTS session_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  initial_radar TEXT NOT NULL DEFAULT '{}',
  final_radar TEXT NOT NULL DEFAULT '{}',
  progress_summary TEXT,
  strengths TEXT,
  improvements TEXT,
  next_recommendation TEXT,
  key_improvements TEXT DEFAULT '[]',
  remaining_weaknesses TEXT DEFAULT '[]',
  completion_rate REAL DEFAULT 0,
  total_turns INTEGER DEFAULT 0,
  total_evidence_cited INTEGER DEFAULT 0,
  avg_logic REAL DEFAULT 0,
  final_rating TEXT DEFAULT 'NOVICE',
  summary TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_session_reports_session_id ON session_reports(session_id);

CREATE INDEX IF NOT EXISTS idx_session_reports_user_id ON session_reports(user_id);
