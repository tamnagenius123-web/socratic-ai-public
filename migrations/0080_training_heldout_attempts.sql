-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE training_heldout_attempts (
  id TEXT PRIMARY KEY,
  base_session_id TEXT NOT NULL UNIQUE REFERENCES training_sessions(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL CHECK(case_id = 'HH-INVEST-100B'),
  case_version TEXT NOT NULL CHECK(case_version = '1.1.0-synthetic'),
  locale TEXT NOT NULL CHECK(locale = 'ko-KR'),
  rubric_version TEXT NOT NULL CHECK(rubric_version = 'HH-RUBRIC-1.0.0'),
  baseline_version TEXT NOT NULL CHECK(baseline_version = 'HH-SYNTHETIC-BASE-1.0.0'),
  measurement_id TEXT NOT NULL CHECK(measurement_id = 'M4'),
  opaque_variant_id TEXT NOT NULL CHECK(opaque_variant_id IN ('HH-V-IMMEDIATE-01', 'HH-V-IMMEDIATE-02')),
  adapter_manifest_sha256 TEXT NOT NULL CHECK(length(adapter_manifest_sha256) = 64 AND adapter_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256) = 64 AND source_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  task_text TEXT NOT NULL CHECK(length(trim(task_text)) BETWEEN 1 AND 16000),
  task_sha256 TEXT NOT NULL CHECK(length(task_sha256) = 64 AND task_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
);

CREATE TABLE training_heldout_attempt_events (
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
  reason TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(attempt_id, revision),
  UNIQUE(attempt_id, mutation_key),
  CHECK((event_type = 'SUBMIT' AND response_text IS NOT NULL AND length(trim(response_text)) > 0 AND response_sha256 IS NOT NULL AND length(response_sha256) = 64 AND response_sha256 NOT GLOB '*[^0-9a-f]*' AND missingness = 'NONE') OR (event_type <> 'SUBMIT' AND response_text IS NULL AND response_sha256 IS NULL))
);

CREATE TABLE training_heldout_variant_quarantines (
  opaque_variant_id TEXT PRIMARY KEY CHECK(opaque_variant_id IN ('HH-V-IMMEDIATE-01', 'HH-V-IMMEDIATE-02')),
  attempt_id TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL CHECK(quarantined_at >= 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0)
);

CREATE INDEX training_heldout_attempts_owner_created ON training_heldout_attempts(owner_user_id, created_at DESC);

CREATE INDEX training_heldout_attempt_events_attempt_revision ON training_heldout_attempt_events(attempt_id, revision ASC);

CREATE TRIGGER training_heldout_attempts_immutable_update
BEFORE UPDATE ON training_heldout_attempts
BEGIN SELECT RAISE(ABORT, 'TRAINING_HELDOUT_ASSIGNMENT_IMMUTABLE'); END;

CREATE TRIGGER training_heldout_attempts_preserve_on_delete
BEFORE DELETE ON training_heldout_attempts
WHEN EXISTS(SELECT 1 FROM training_sessions WHERE id = OLD.base_session_id)
BEGIN SELECT RAISE(ABORT, 'TRAINING_HELDOUT_ASSIGNMENT_PRESERVED'); END;

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
