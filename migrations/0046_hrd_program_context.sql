-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS hrd_programs (
  id TEXT PRIMARY KEY,
  program_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_reference TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (scope_type = 'ORGANIZATION' AND length(trim(scope_reference)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_hrd_programs_status_scope
  ON hrd_programs(status, scope_type, scope_reference);

CREATE TABLE IF NOT EXISTS hrd_program_memberships (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('HRD_OPERATOR', 'HRD_VIEWER')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (program_id) REFERENCES hrd_programs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hrd_program_memberships_one_active_member
  ON hrd_program_memberships(program_id, user_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_hrd_program_memberships_authorization
  ON hrd_program_memberships(user_id, status, program_id, role);

CREATE TABLE IF NOT EXISTS hrd_program_enrollments (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  learner_user_id TEXT NOT NULL,
  learner_display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'REMOVED')),
  enrollment_revision INTEGER NOT NULL CHECK (enrollment_revision >= 1),
  allocation_source TEXT NOT NULL CHECK (allocation_source IN ('MANUAL', 'RULE', 'IMPORT')),
  scheduled_start_at INTEGER,
  scheduled_end_at INTEGER,
  schedule_timezone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (program_id) REFERENCES hrd_programs(id) ON DELETE CASCADE,
  FOREIGN KEY (learner_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at >= scheduled_start_at),
  UNIQUE (program_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hrd_program_enrollments_program_learner
  ON hrd_program_enrollments(program_id, learner_user_id);

CREATE INDEX IF NOT EXISTS idx_hrd_program_enrollments_read
  ON hrd_program_enrollments(program_id, status, scheduled_start_at, id);

CREATE TABLE IF NOT EXISTS hrd_competencies (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  competency_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  active_rubric_version_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (program_id) REFERENCES hrd_programs(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, active_rubric_version_id, id)
    REFERENCES hrd_rubric_versions(program_id, id, competency_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (status <> 'ACTIVE' OR active_rubric_version_id IS NOT NULL),
  UNIQUE (program_id, competency_code),
  UNIQUE (program_id, id)
);

CREATE INDEX IF NOT EXISTS idx_hrd_competencies_program_status
  ON hrd_competencies(program_id, status, sort_order, id);

CREATE TABLE IF NOT EXISTS hrd_rubric_versions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (program_id, competency_id)
    REFERENCES hrd_competencies(program_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (program_id, competency_id, version),
  UNIQUE (program_id, id, competency_id)
);

CREATE INDEX IF NOT EXISTS idx_hrd_rubric_versions_competency_version
  ON hrd_rubric_versions(competency_id, version DESC);

CREATE TRIGGER IF NOT EXISTS prevent_hrd_rubric_version_update
BEFORE UPDATE ON hrd_rubric_versions
BEGIN
  SELECT RAISE(ABORT, 'HRD_RUBRIC_VERSION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS prevent_hrd_rubric_version_delete
BEFORE DELETE ON hrd_rubric_versions
BEGIN
  SELECT RAISE(ABORT, 'HRD_RUBRIC_VERSION_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS hrd_program_competency_observations (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  competency_id TEXT NOT NULL,
  rubric_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('MEASURED', 'UNOBSERVED', 'UNKNOWN', 'UNAVAILABLE', 'FAILED', 'IN_PROGRESS')),
  value_numeric REAL,
  value_scale TEXT CHECK (value_scale IS NULL OR value_scale IN ('PERCENT_0_100', 'RUBRIC_LEVEL')),
  evidence_manifest_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_manifest_ids_json)),
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (program_id, enrollment_id)
    REFERENCES hrd_program_enrollments(program_id, id) ON DELETE CASCADE,
  FOREIGN KEY (program_id, competency_id)
    REFERENCES hrd_competencies(program_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (program_id, rubric_version_id, competency_id)
    REFERENCES hrd_rubric_versions(program_id, id, competency_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'MEASURED'
      AND value_numeric IS NOT NULL
      AND typeof(value_numeric) IN ('integer', 'real')
      AND value_scale IN ('PERCENT_0_100', 'RUBRIC_LEVEL')
      AND (value_scale <> 'PERCENT_0_100' OR value_numeric BETWEEN 0 AND 100))
    OR
    (status <> 'MEASURED' AND value_numeric IS NULL AND value_scale IS NULL)
  )
);

CREATE TRIGGER IF NOT EXISTS validate_hrd_observation_evidence_manifest_insert
BEFORE INSERT ON hrd_program_competency_observations
WHEN CASE
  WHEN json_valid(NEW.evidence_manifest_ids_json) = 0 THEN 1
  WHEN json_type(NEW.evidence_manifest_ids_json) <> 'array' THEN 1
  WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.evidence_manifest_ids_json)
    WHERE type <> 'text' OR length(value) = 0
  ) THEN 1
  WHEN NEW.status = 'MEASURED' AND json_array_length(NEW.evidence_manifest_ids_json) = 0 THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'HRD_EVIDENCE_MANIFEST_IDS_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS validate_hrd_observation_evidence_manifest_update
BEFORE UPDATE OF status, evidence_manifest_ids_json ON hrd_program_competency_observations
WHEN CASE
  WHEN json_valid(NEW.evidence_manifest_ids_json) = 0 THEN 1
  WHEN json_type(NEW.evidence_manifest_ids_json) <> 'array' THEN 1
  WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.evidence_manifest_ids_json)
    WHERE type <> 'text' OR length(value) = 0
  ) THEN 1
  WHEN NEW.status = 'MEASURED' AND json_array_length(NEW.evidence_manifest_ids_json) = 0 THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'HRD_EVIDENCE_MANIFEST_IDS_INVALID');
END;

CREATE INDEX IF NOT EXISTS idx_hrd_observations_enrollment_competency_latest
  ON hrd_program_competency_observations(enrollment_id, competency_id, observed_at DESC, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_hrd_observations_competency_status
  ON hrd_program_competency_observations(competency_id, status, observed_at DESC);
