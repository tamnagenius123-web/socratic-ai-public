-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_mutation_receipt_replay_payloads (
  mutation_receipt_id TEXT PRIMARY KEY,
  expected_aggregate_revision INTEGER NOT NULL CHECK (expected_aggregate_revision >= 0),
  lifecycle_action TEXT,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  result_resource_type TEXT NOT NULL CHECK (
    result_resource_type IN ('CONSENT_RECEIPT', 'GROWTH_SPACE', 'GROWTH_CYCLE', 'GROWTH_DELETION_RECEIPT')
  ),
  result_resource_id TEXT NOT NULL CHECK (length(trim(result_resource_id)) > 0),
  result_aggregate_revision INTEGER NOT NULL CHECK (result_aggregate_revision >= 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (mutation_receipt_id) REFERENCES growth_mutation_receipts(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_receipt_replay_payload_parent_guard
BEFORE INSERT ON growth_mutation_receipt_replay_payloads
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_mutation_receipts receipt
  WHERE receipt.id = NEW.mutation_receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECEIPT_REPLAY_PARENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_receipt_replay_payload_scope_guard
BEFORE INSERT ON growth_mutation_receipt_replay_payloads
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_mutation_receipts receipt
  WHERE receipt.id = NEW.mutation_receipt_id
    AND (
      (receipt.growth_cycle_id IS NULL
        AND NEW.expected_aggregate_revision = 0
        AND NEW.lifecycle_action IS NULL
        AND (
          (receipt.route_action = 'POST:/api/growth/privacy/consent'
            AND NEW.result_resource_type = 'CONSENT_RECEIPT'
            AND EXISTS (
              SELECT 1 FROM growth_private_consent_receipts consent
              WHERE consent.id = NEW.result_resource_id
                AND consent.subject_user_id = receipt.actor_user_id
                AND consent.policy_revision = NEW.result_aggregate_revision
            ))
          OR (receipt.route_action = 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke'
            AND NEW.result_resource_type = 'CONSENT_RECEIPT'
            AND EXISTS (
              SELECT 1 FROM growth_private_consent_receipts consent
              WHERE consent.id = NEW.result_resource_id
                AND consent.subject_user_id = receipt.actor_user_id
                AND consent.policy_revision = NEW.result_aggregate_revision
                AND consent.revoked_at IS NOT NULL
            ))
          OR (receipt.route_action = 'POST:/api/growth/spaces/solo'
            AND NEW.result_resource_type = 'GROWTH_SPACE'
            AND EXISTS (
              SELECT 1 FROM growth_spaces space
              WHERE space.id = NEW.result_resource_id
                AND space.host_user_id = receipt.actor_user_id
                AND space.space_type = 'SOLO'
                AND space.status = 'ACTIVE'
                AND space.aggregate_revision = NEW.result_aggregate_revision
            ))
        ))
      OR
      (receipt.growth_cycle_id IS NOT NULL
        AND (
          (NEW.result_resource_type = 'GROWTH_CYCLE' AND NEW.result_resource_id = receipt.growth_cycle_id)
          OR NEW.result_resource_type = 'GROWTH_DELETION_RECEIPT'
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECEIPT_REPLAY_SCOPE_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS growth_receipt_replay_payload_immutable_update
BEFORE UPDATE ON growth_mutation_receipt_replay_payloads
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECEIPT_REPLAY_PAYLOAD_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_receipt_replay_payload_controlled_delete_only
BEFORE DELETE ON growth_mutation_receipt_replay_payloads
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_mutation_receipts receipt
  INNER JOIN growth_deletion_context context ON context.growth_cycle_id = receipt.growth_cycle_id
  WHERE receipt.id = OLD.mutation_receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECEIPT_REPLAY_PAYLOAD_IMMUTABLE');
END;
