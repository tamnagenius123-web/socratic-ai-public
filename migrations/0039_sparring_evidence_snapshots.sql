-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS sparring_evidence_manifests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_number)
);

CREATE INDEX IF NOT EXISTS idx_sparring_evidence_manifest_owner
  ON sparring_evidence_manifests(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sparring_turn_evidence (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  book_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  content_snapshot TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, turn_number, chunk_id),
  FOREIGN KEY (manifest_id) REFERENCES sparring_evidence_manifests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sparring_turn_evidence_session
  ON sparring_turn_evidence(session_id, turn_number, chunk_index);

CREATE INDEX IF NOT EXISTS idx_sparring_turn_evidence_book
  ON sparring_turn_evidence(book_id, created_at DESC);
