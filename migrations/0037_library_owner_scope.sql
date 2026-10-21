-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE books ADD COLUMN owner_user_id TEXT;

ALTER TABLE books ADD COLUMN visibility TEXT NOT NULL DEFAULT 'quarantined';

ALTER TABLE books ADD COLUMN quarantined_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_books_owner_visibility
  ON books(owner_user_id, visibility, lifecycle_status, created_at);

CREATE INDEX IF NOT EXISTS idx_books_public_builtin
  ON books(is_builtin, visibility, lifecycle_status);
