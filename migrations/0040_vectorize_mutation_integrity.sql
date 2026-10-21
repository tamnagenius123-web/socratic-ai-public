-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE books ADD COLUMN current_ingestion_attempt_id TEXT;

ALTER TABLE vector_cleanup_jobs ADD COLUMN ingestion_attempt_id TEXT;

ALTER TABLE vector_cleanup_jobs ADD COLUMN vector_id_start TEXT;

ALTER TABLE vector_cleanup_jobs ADD COLUMN vector_id_end TEXT;

CREATE INDEX IF NOT EXISTS idx_books_current_ingestion_attempt
  ON books(current_ingestion_attempt_id, lifecycle_status, vector_status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_cleanup_jobs_attempt_range
  ON vector_cleanup_jobs(book_id, ingestion_attempt_id, vector_id_start, vector_id_end)
  WHERE ingestion_attempt_id IS NOT NULL
    AND vector_id_start IS NOT NULL
    AND vector_id_end IS NOT NULL;
