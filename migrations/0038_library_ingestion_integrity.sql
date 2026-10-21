-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE books ADD COLUMN content_sha256 TEXT;

ALTER TABLE books ADD COLUMN chunking_version TEXT;

ALTER TABLE books ADD COLUMN vector_status TEXT NOT NULL DEFAULT 'not_indexed';

CREATE TABLE IF NOT EXISTS book_ingestion_attempts (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  chunking_version TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  vector_count INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_ingestion_attempts_book
  ON book_ingestion_attempts(book_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_book_ingestion_attempts_owner
  ON book_ingestion_attempts(owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vector_cleanup_jobs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  vector_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vector_cleanup_jobs_status
  ON vector_cleanup_jobs(status, created_at);
