-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sessions ADD COLUMN tutor_state TEXT NOT NULL DEFAULT 'elicitation';

ALTER TABLE sessions ADD COLUMN student_model TEXT NOT NULL DEFAULT '{}';

ALTER TABLE sessions ADD COLUMN session_goal TEXT NOT NULL DEFAULT '핵심 주장을 명확하게 표현하기';

ALTER TABLE sessions ADD COLUMN deep_hint_level INTEGER NOT NULL DEFAULT 0;

ALTER TABLE evaluations ADD COLUMN tutor_action_type TEXT;

ALTER TABLE evaluations ADD COLUMN deep_hint_level INTEGER;

ALTER TABLE evaluations ADD COLUMN weakness_tags TEXT;

ALTER TABLE evaluations ADD COLUMN diagnosis TEXT;

ALTER TABLE evaluations ADD COLUMN student_model_snapshot TEXT;

ALTER TABLE evaluations ADD COLUMN claim_clarity REAL;

ALTER TABLE evaluations ADD COLUMN reasoning_strength REAL;

CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  category TEXT NOT NULL,              difficulty TEXT NOT NULL,             question TEXT NOT NULL,
  question_title TEXT,
  context TEXT,                         expected_tensions TEXT DEFAULT '[]',    session_goal TEXT NOT NULL DEFAULT '',
  
     tutor_state TEXT NOT NULL DEFAULT 'elicitation',
  student_model TEXT NOT NULL DEFAULT '{}',
  deep_hint_level INTEGER NOT NULL DEFAULT 0,
  
     current_turn INTEGER NOT NULL DEFAULT 1,
  max_turns INTEGER NOT NULL DEFAULT 8,
  
     logic_score REAL DEFAULT 0,
  creativity_score REAL DEFAULT 0,
  evidence_score REAL DEFAULT 0,
  depth_score REAL DEFAULT 0,
  feasibility_score REAL DEFAULT 0,
  avg_score REAL DEFAULT 0,
  
     rating TEXT DEFAULT 'NOVICE',
  
     created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_user_id ON training_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_training_sessions_category ON training_sessions(category);

CREATE INDEX IF NOT EXISTS idx_training_sessions_created_at ON training_sessions(created_at);

CREATE TABLE IF NOT EXISTS training_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  student_message TEXT NOT NULL,
  ai_response TEXT NOT NULL,
  
     claim_clarity REAL DEFAULT 0,
  evidence_use REAL DEFAULT 0,
  reasoning_strength REAL DEFAULT 0,
  consistency_score REAL DEFAULT 0,
  relevance_score REAL DEFAULT 0,
  
     logic_score REAL DEFAULT 0,
  creativity_score REAL DEFAULT 0,
  evidence_score REAL DEFAULT 0,
  depth_score REAL DEFAULT 0,
  feasibility_score REAL DEFAULT 0,
  
     tutor_action_type TEXT,
  hint_level INTEGER DEFAULT 0,
  weakness_tags TEXT,
  diagnosis TEXT,
  student_model_snapshot TEXT,
  tutor_state TEXT,
  
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_turns_session_id ON training_turns(session_id);

CREATE INDEX IF NOT EXISTS idx_training_turns_session_turn ON training_turns(session_id, turn_number);

CREATE TABLE IF NOT EXISTS training_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
  content TEXT NOT NULL,
  turn INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_messages_session_id ON training_messages(session_id);
