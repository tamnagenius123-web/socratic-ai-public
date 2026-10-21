-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE INDEX IF NOT EXISTS idx_document_chunks_offsets ON document_chunks(book_id, char_start, char_end);
