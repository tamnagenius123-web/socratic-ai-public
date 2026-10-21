-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_event_mutation_receipt_links (
  growth_event_id TEXT PRIMARY KEY,
  mutation_receipt_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_event_id) REFERENCES growth_events(id) ON DELETE CASCADE,
  FOREIGN KEY (mutation_receipt_id) REFERENCES growth_mutation_receipts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_growth_event_receipt_links_receipt
  ON growth_event_mutation_receipt_links(mutation_receipt_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS growth_event_receipt_links_immutable_update
BEFORE UPDATE ON growth_event_mutation_receipt_links
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_RECEIPT_LINK_IMMUTABLE');
END;
