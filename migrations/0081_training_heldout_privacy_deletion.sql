-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
DROP TRIGGER IF EXISTS training_heldout_attempt_events_append_only_update;

DROP TRIGGER IF EXISTS training_heldout_attempt_events_append_only_delete;

DROP TRIGGER IF EXISTS training_heldout_attempt_events_transition_guard;

CREATE TABLE training_heldout_attempt_events_0081 (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES training_heldout_attempts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  event_type TEXT NOT NULL CHECK(event_type IN ('ARM', 'OPEN', 'SUBMIT', 'STOP', 'QUARANTINE')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mutation_key TEXT NOT NULL CHECK(length(trim(mutation_key)) BETWEEN 8 AND 128),
  missingness TEXT NOT NULL CHECK(missingness IN ('NONE', 'NO_RESPONSE', 'NOT_STARTED', 'PAYLOAD_UNAVAILABLE', 'CONTAMINATED', 'UNKNOWN')),
  response_text TEXT,
  response_sha256 TEXT,
  assistance_ids_json TEXT NOT NULL CHECK(json_valid(assistance_ids_json) AND json_type(assistance_ids_json) = 'array' AND json_array_length(assistance_ids_json) = 0),
  contamination_code TEXT CHECK(contamination_code IS NULL OR contamination_code IN ('LEARNER_REPORTED_EXPOSURE', 'LOCAL_ASSISTANCE_REFERENCE', 'GLOBAL_VARIANT_QUARANTINE', 'LEGACY_QUARANTINE')),
  reason TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(attempt_id, revision),
  UNIQUE(attempt_id, mutation_key),
  CHECK((event_type = 'SUBMIT' AND response_text IS NOT NULL AND length(trim(response_text)) > 0 AND response_sha256 IS NOT NULL AND length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*' AND missingness = 'NONE') OR (event_type <> 'SUBMIT' AND response_text IS NULL AND response_sha256 IS NULL))
);

DROP TABLE training_heldout_attempt_events;

ALTER TABLE training_heldout_attempt_events_0081 RENAME TO training_heldout_attempt_events;

CREATE INDEX training_heldout_attempt_events_attempt_revision ON training_heldout_attempt_events(attempt_id, revision ASC);

CREATE TABLE training_heldout_variant_quarantines_0081 (
  opaque_variant_id TEXT PRIMARY KEY CHECK(opaque_variant_id IN ('HH-V-IMMEDIATE-01', 'HH-V-IMMEDIATE-02')),
  contamination_code TEXT NOT NULL CHECK(contamination_code IN ('LEARNER_REPORTED_EXPOSURE', 'LOCAL_ASSISTANCE_REFERENCE', 'GLOBAL_VARIANT_QUARANTINE', 'LEGACY_QUARANTINE')),
  quarantined_at INTEGER NOT NULL CHECK(quarantined_at >= 0)
);

DROP TABLE training_heldout_variant_quarantines;

ALTER TABLE training_heldout_variant_quarantines_0081 RENAME TO training_heldout_variant_quarantines;

CREATE TRIGGER training_heldout_attempt_events_append_only_update
BEFORE UPDATE ON training_heldout_attempt_events
BEGIN SELECT RAISE(ABORT, 'TRAINING_HELDOUT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER training_heldout_attempt_events_append_only_delete
BEFORE DELETE ON training_heldout_attempt_events
WHEN EXISTS(SELECT 1 FROM training_heldout_attempts WHERE id = OLD.attempt_id)
BEGIN SELECT RAISE(ABORT, 'TRAINING_HELDOUT_EVENT_IMMUTABLE'); END;

CREATE TRIGGER training_heldout_attempt_events_transition_guard
BEFORE INSERT ON training_heldout_attempt_events
BEGIN
  SELECT RAISE(ABORT, 'TRAINING_HELDOUT_CONTAMINATION_CODE_INVALID')
  WHERE NEW.reason IS NOT NULL
    OR (NEW.event_type = 'QUARANTINE' AND NEW.missingness = 'CONTAMINATED'
      AND (NEW.contamination_code IS NULL OR NEW.contamination_code NOT IN ('LEARNER_REPORTED_EXPOSURE', 'LOCAL_ASSISTANCE_REFERENCE', 'GLOBAL_VARIANT_QUARANTINE', 'LEGACY_QUARANTINE')))
    OR ((NEW.event_type <> 'QUARANTINE' OR NEW.missingness <> 'CONTAMINATED') AND NEW.contamination_code IS NOT NULL);
  SELECT RAISE(ABORT, 'TRAINING_HELDOUT_REVISION_CONFLICT')
  WHERE NEW.revision <> COALESCE((SELECT MAX(revision) + 1 FROM training_heldout_attempt_events WHERE attempt_id = NEW.attempt_id), 1);
  SELECT RAISE(ABORT, 'TRAINING_HELDOUT_ARM_INVALID')
  WHERE NEW.revision = 1 AND (NEW.event_type <> 'ARM' OR NEW.missingness <> 'NOT_STARTED');
  SELECT RAISE(ABORT, 'TRAINING_HELDOUT_TRANSITION_INVALID')
  WHERE NEW.revision > 1 AND (
    (NEW.event_type = 'OPEN' AND (SELECT event_type FROM training_heldout_attempt_events WHERE attempt_id = NEW.attempt_id ORDER BY revision DESC LIMIT 1) <> 'ARM')
    OR (NEW.event_type = 'SUBMIT' AND (SELECT event_type FROM training_heldout_attempt_events WHERE attempt_id = NEW.attempt_id ORDER BY revision DESC LIMIT 1) <> 'OPEN')
    OR (NEW.event_type = 'STOP' AND (SELECT event_type FROM training_heldout_attempt_events WHERE attempt_id = NEW.attempt_id ORDER BY revision DESC LIMIT 1) NOT IN ('ARM', 'OPEN'))
    OR (NEW.event_type = 'QUARANTINE' AND (SELECT event_type FROM training_heldout_attempt_events WHERE attempt_id = NEW.attempt_id ORDER BY revision DESC LIMIT 1) = 'QUARANTINE')
    OR NEW.event_type = 'ARM'
  );
END;
