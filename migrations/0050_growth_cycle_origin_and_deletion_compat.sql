-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_cycle_origin_identities (
  growth_cycle_id TEXT PRIMARY KEY,
  origin_lookup_digest TEXT NOT NULL UNIQUE CHECK (length(origin_lookup_digest) = 64),
  origin_request_digest TEXT NOT NULL CHECK (length(origin_request_digest) = 64),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_cycle_origin_identities_immutable_update
BEFORE UPDATE ON growth_cycle_origin_identities
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_ORIGIN_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycle_origin_identities_immutable_delete
BEFORE DELETE ON growth_cycle_origin_identities
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM growth_cycles cycle WHERE cycle.id = OLD.growth_cycle_id)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_ORIGIN_IDENTITY_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_cycle_resurrection_tombstones (
  origin_lookup_digest TEXT PRIMARY KEY CHECK (length(origin_lookup_digest) = 64),
  origin_request_digest TEXT NOT NULL CHECK (length(origin_request_digest) = 64),
  deletion_policy_revision INTEGER NOT NULL CHECK (deletion_policy_revision >= 1),
  deleted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS growth_cycle_resurrection_tombstones_immutable_update
BEFORE UPDATE ON growth_cycle_resurrection_tombstones
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_RESURRECTION_TOMBSTONE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycle_resurrection_tombstones_immutable_delete
BEFORE DELETE ON growth_cycle_resurrection_tombstones
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_RESURRECTION_TOMBSTONE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_origin_identity_resurrection_barrier
BEFORE DELETE ON growth_cycles
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_cycle_origin_identities identity
  WHERE identity.growth_cycle_id = OLD.id
    AND NOT EXISTS (
      SELECT 1 FROM growth_cycle_resurrection_tombstones tombstone
      WHERE tombstone.origin_lookup_digest = identity.origin_lookup_digest
    )
)
BEGIN
  INSERT INTO growth_cycle_resurrection_tombstones (
    origin_lookup_digest, origin_request_digest, deletion_policy_revision, deleted_at, created_at
  )
  SELECT identity.origin_lookup_digest, identity.origin_request_digest,
    COALESCE((
      SELECT receipt.policy_revision
      FROM growth_deletion_context context
      INNER JOIN growth_deletion_receipts receipt ON receipt.id = context.deletion_receipt_id
      WHERE context.growth_cycle_id = OLD.id
    ), 1),
    strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000
  FROM growth_cycle_origin_identities identity
  WHERE identity.growth_cycle_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS growth_deletion_idempotency_records (
  idempotency_lookup_digest TEXT PRIMARY KEY CHECK (length(idempotency_lookup_digest) = 64),
  deletion_receipt_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (deletion_receipt_id) REFERENCES growth_deletion_receipts(id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS growth_deletion_idempotency_records_immutable_update
BEFORE UPDATE ON growth_deletion_idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_IDEMPOTENCY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_deletion_idempotency_records_immutable_delete
BEFORE DELETE ON growth_deletion_idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_IDEMPOTENCY_IMMUTABLE');
END;
