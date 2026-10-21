-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE growth_human_review_requests (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'PENDING'),
  request_dedup_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (growth_cycle_id, owner_user_id),
  UNIQUE (owner_user_id, request_dedup_digest),
  CHECK (length(trim(id)) > 0),
  CHECK (length(request_dedup_digest) = 64 AND request_dedup_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(created_at) = 'integer' AND created_at >= 0 AND created_at <= 9007199254740991)
);

CREATE TRIGGER growth_human_review_requests_id_collision_guard
BEFORE INSERT ON growth_human_review_requests
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_human_review_requests current WHERE current.id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS');
END;

CREATE TRIGGER growth_human_review_requests_owner_cycle_collision_guard
BEFORE INSERT ON growth_human_review_requests
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_human_review_requests current
  WHERE current.growth_cycle_id = NEW.growth_cycle_id
    AND current.owner_user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS');
END;

CREATE TRIGGER growth_human_review_requests_owner_digest_collision_guard
BEFORE INSERT ON growth_human_review_requests
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_human_review_requests current
  WHERE current.owner_user_id = NEW.owner_user_id
    AND current.request_dedup_digest = NEW.request_dedup_digest
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_ALREADY_EXISTS');
END;

CREATE TRIGGER growth_human_review_requests_owner_cycle_guard
BEFORE INSERT ON growth_human_review_requests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_spaces space ON space.id = cycle.space_id
  INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
  INNER JOIN growth_private_consent_receipts consent ON consent.id = cycle.consent_receipt_id
  WHERE cycle.id = NEW.growth_cycle_id
    AND membership.space_id = cycle.space_id
    AND space.host_user_id = NEW.owner_user_id
    AND space.status = 'ACTIVE'
    AND membership.user_id = NEW.owner_user_id
    AND membership.role = 'HOST'
    AND membership.status = 'ACTIVE'
    AND consent.subject_user_id = NEW.owner_user_id
    AND consent.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_OWNER_REQUIRED');
END;

CREATE TRIGGER growth_human_review_requests_immutable_update
BEFORE UPDATE ON growth_human_review_requests
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE');
END;

CREATE TRIGGER growth_human_review_requests_controlled_delete_only
BEFORE DELETE ON growth_human_review_requests
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_cycles cycle WHERE cycle.id = OLD.growth_cycle_id
) OR NOT EXISTS (
  SELECT 1
  FROM growth_deletion_context context
  WHERE context.growth_cycle_id = OLD.growth_cycle_id
    AND context.requested_by_user_id = OLD.owner_user_id
    AND context.route_action = 'DELETE_GROWTH_CYCLE'
    AND context.reason_code = 'OWNER_REQUESTED'
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_HUMAN_REVIEW_REQUEST_IMMUTABLE');
END;
