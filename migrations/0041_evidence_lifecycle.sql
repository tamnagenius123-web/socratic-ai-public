-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sparring_evidence_manifests
  ADD COLUMN lifecycle_status TEXT
  CHECK (lifecycle_status IN ('active', 'quarantined', 'deleted'));

ALTER TABLE sparring_evidence_manifests ADD COLUMN quarantined_at INTEGER;

ALTER TABLE sparring_evidence_manifests ADD COLUMN deleted_at INTEGER;

ALTER TABLE sparring_turn_evidence
  ADD COLUMN lifecycle_status TEXT
  CHECK (lifecycle_status IN ('active', 'quarantined', 'deleted'));

ALTER TABLE sparring_turn_evidence ADD COLUMN quarantined_at INTEGER;

ALTER TABLE sparring_turn_evidence ADD COLUMN deleted_at INTEGER;

ALTER TABLE training_scenario_evidence
  ADD COLUMN lifecycle_status TEXT
  CHECK (lifecycle_status IN ('active', 'quarantined', 'deleted'));

ALTER TABLE training_scenario_evidence ADD COLUMN quarantined_at INTEGER;

ALTER TABLE training_scenario_evidence ADD COLUMN deleted_at INTEGER;

CREATE TRIGGER prevent_orphaned_sparring_evidence_manifest
BEFORE INSERT ON sparring_evidence_manifests
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM sessions s
  WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'sparring_evidence_session_missing');
END;

CREATE TRIGGER derive_sparring_evidence_manifest_lifecycle
AFTER INSERT ON sparring_evidence_manifests
FOR EACH ROW
BEGIN
  UPDATE sparring_evidence_manifests
  SET lifecycle_status = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted') THEN 'deleted'
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.visibility = 'quarantined') THEN 'quarantined'
        WHEN EXISTS (
          SELECT 1 FROM books b
          WHERE b.id = NEW.book_id
            AND (b.lifecycle_status = 'active' OR b.lifecycle_status IS NULL)
            AND (
              (b.is_builtin = 1 AND b.visibility = 'builtin')
              OR (b.owner_user_id = NEW.user_id AND b.visibility = 'private')
            )
        ) THEN 'active'
        ELSE NULL
      END,
      quarantined_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM books b
          WHERE b.id = NEW.book_id
            AND b.lifecycle_status <> 'deleted'
            AND b.visibility = 'quarantined'
        ) THEN (SELECT b.quarantined_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END,
      deleted_at = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted')
          THEN (SELECT b.deleted_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER derive_sparring_turn_evidence_lifecycle
AFTER INSERT ON sparring_turn_evidence
FOR EACH ROW
BEGIN
  UPDATE sparring_turn_evidence
  SET lifecycle_status = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted') THEN 'deleted'
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.visibility = 'quarantined') THEN 'quarantined'
        WHEN EXISTS (
          SELECT 1
          FROM sparring_evidence_manifests m
          INNER JOIN books b ON b.id = NEW.book_id
          WHERE m.id = NEW.manifest_id AND m.session_id = NEW.session_id
            AND (b.lifecycle_status = 'active' OR b.lifecycle_status IS NULL)
            AND (
              (b.is_builtin = 1 AND b.visibility = 'builtin')
              OR (b.owner_user_id = m.user_id AND b.visibility = 'private')
            )
        ) THEN 'active'
        ELSE NULL
      END,
      quarantined_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM books b
          WHERE b.id = NEW.book_id
            AND b.lifecycle_status <> 'deleted'
            AND b.visibility = 'quarantined'
        ) THEN (SELECT b.quarantined_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END,
      deleted_at = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted')
          THEN (SELECT b.deleted_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER prevent_orphaned_sparring_turn_evidence
BEFORE INSERT ON sparring_turn_evidence
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM sparring_evidence_manifests m
  INNER JOIN sessions s ON s.id = m.session_id
  WHERE m.id = NEW.manifest_id
    AND m.session_id = NEW.session_id
    AND m.book_id = NEW.book_id
    AND s.user_id = m.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'sparring_evidence_session_missing');
END;

CREATE TRIGGER derive_training_scenario_evidence_lifecycle
AFTER INSERT ON training_scenario_evidence
FOR EACH ROW
BEGIN
  UPDATE training_scenario_evidence
  SET lifecycle_status = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted') THEN 'deleted'
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.visibility = 'quarantined') THEN 'quarantined'
        WHEN EXISTS (
          SELECT 1
          FROM training_sessions ts
          INNER JOIN books b ON b.id = NEW.book_id
          WHERE ts.id = NEW.session_id
            AND (b.lifecycle_status = 'active' OR b.lifecycle_status IS NULL)
            AND (
              (b.is_builtin = 1 AND b.visibility = 'builtin')
              OR (b.owner_user_id = ts.user_id AND b.visibility = 'private')
            )
        ) THEN 'active'
        ELSE NULL
      END,
      quarantined_at = CASE
        WHEN EXISTS (
          SELECT 1 FROM books b
          WHERE b.id = NEW.book_id
            AND (b.lifecycle_status <> 'deleted' OR b.lifecycle_status IS NULL)
            AND b.visibility = 'quarantined'
        ) THEN (SELECT b.quarantined_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END,
      deleted_at = CASE
        WHEN EXISTS (SELECT 1 FROM books b WHERE b.id = NEW.book_id AND b.lifecycle_status = 'deleted')
          THEN (SELECT b.deleted_at FROM books b WHERE b.id = NEW.book_id)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_sparring_evidence_manifest_lifecycle
  ON sparring_evidence_manifests(lifecycle_status, book_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sparring_turn_evidence_lifecycle
  ON sparring_turn_evidence(lifecycle_status, book_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_training_scenario_evidence_lifecycle
  ON training_scenario_evidence(lifecycle_status, book_id, created_at DESC);
