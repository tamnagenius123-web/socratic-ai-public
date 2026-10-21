-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE training_sessions
  ADD COLUMN training_mode TEXT NOT NULL DEFAULT 'discussion'
  CHECK (training_mode IN ('discussion', 'scenario'));

CREATE TABLE IF NOT EXISTS training_scenario_packs (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'scenario'),
  evidence_query TEXT NOT NULL,
  evidence_status TEXT NOT NULL CHECK (evidence_status = 'ready'),
  evidence_manifest_sha256 TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK (source_count >= 3),
  book_count INTEGER NOT NULL CHECK (book_count >= 2),
  scenario_json TEXT NOT NULL,
  rubric_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_scenario_evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  selection_index INTEGER NOT NULL CHECK (selection_index >= 0),
  book_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  book_title TEXT NOT NULL,
  book_author TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES training_scenario_packs(session_id) ON DELETE CASCADE,
  UNIQUE (session_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_training_scenario_evidence_session
  ON training_scenario_evidence(session_id, selection_index ASC);

CREATE INDEX IF NOT EXISTS idx_training_scenario_evidence_book
  ON training_scenario_evidence(book_id, chunk_id);
