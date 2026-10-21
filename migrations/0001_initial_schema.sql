-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  chapter TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'ko',
  text TEXT NOT NULL,
  key_passages TEXT NOT NULL DEFAULT '[]',    is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  book_title TEXT NOT NULL,
  book_chapter TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL,
  created_at INTEGER NOT NULL,

     initial_radar_scores TEXT NOT NULL DEFAULT '{"defense":30,"consistency":30,"evidence":10,"relevance":40,"clarity":30}',

     current_turn INTEGER NOT NULL DEFAULT 1,
  max_turns INTEGER NOT NULL DEFAULT 10,
  current_phase TEXT NOT NULL DEFAULT 'thesis',

     core_claim TEXT NOT NULL DEFAULT '',
  current_claim TEXT NOT NULL DEFAULT '',
  evidence_used TEXT NOT NULL DEFAULT '[]',    weakness_pattern TEXT NOT NULL DEFAULT '[]',  
     hint_level INTEGER NOT NULL DEFAULT 0,
  hint_request_count INTEGER NOT NULL DEFAULT 0,
  consecutive_no_evidence INTEGER NOT NULL DEFAULT 0,

     radar_scores TEXT NOT NULL DEFAULT '{"defense":30,"consistency":30,"evidence":10,"relevance":40,"clarity":30}',
  previous_radar_scores TEXT NOT NULL DEFAULT '{"defense":30,"consistency":30,"evidence":10,"relevance":40,"clarity":30}',

     textual_evidence_cited INTEGER NOT NULL DEFAULT 0,
  logical_fallacies_avoided INTEGER NOT NULL DEFAULT 0,
  fallacies_detected INTEGER NOT NULL DEFAULT 0,

     avg_logic INTEGER NOT NULL DEFAULT 28,
  rating TEXT NOT NULL DEFAULT 'NOVICE',
  dialectic_pace REAL NOT NULL DEFAULT 0,
  credibility TEXT NOT NULL DEFAULT '{"level":"NOVICE","tier":1}',  
     current_weakness TEXT,

     last_question_type TEXT NOT NULL DEFAULT '',

     turn_start_times TEXT NOT NULL DEFAULT '[]',

     session_report TEXT,

  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'ai')),
  content TEXT NOT NULL,
  turn INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_book_id ON sessions(book_id);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(session_id, turn);

CREATE INDEX IF NOT EXISTS idx_books_is_builtin ON books(is_builtin);
