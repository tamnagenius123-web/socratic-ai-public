-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE books ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE books ADD COLUMN ingestion_status TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE books ADD COLUMN last_ingestion_error TEXT;

ALTER TABLE books ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE books ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_books_lifecycle_status ON books(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_books_ingestion_status ON books(ingestion_status);
