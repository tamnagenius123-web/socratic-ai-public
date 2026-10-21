-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
DROP TRIGGER IF EXISTS growth_receipt_replay_payload_controlled_delete_only;

CREATE TRIGGER growth_receipt_replay_payload_controlled_delete_only
BEFORE DELETE ON growth_mutation_receipt_replay_payloads
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_mutation_receipts receipt
  WHERE receipt.id = OLD.mutation_receipt_id
    AND (
      receipt.growth_cycle_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM growth_deletion_context context
        WHERE context.growth_cycle_id = receipt.growth_cycle_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECEIPT_REPLAY_PAYLOAD_IMMUTABLE');
END;
