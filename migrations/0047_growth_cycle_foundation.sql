-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_private_consent_receipts (
  id TEXT PRIMARY KEY,
  subject_user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  data_classes_json TEXT NOT NULL CHECK (json_valid(data_classes_json) AND json_type(data_classes_json) = 'array'),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  retention_policy TEXT NOT NULL CHECK (length(trim(retention_policy)) > 0),
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX IF NOT EXISTS idx_growth_private_consent_subject_active
  ON growth_private_consent_receipts(subject_user_id, revoked_at, issued_at DESC);

CREATE TRIGGER IF NOT EXISTS growth_private_consent_receipts_immutable_update
BEFORE UPDATE ON growth_private_consent_receipts
FOR EACH ROW WHEN NEW.id IS NOT OLD.id
  OR NEW.subject_user_id IS NOT OLD.subject_user_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.data_classes_json IS NOT OLD.data_classes_json
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.retention_policy IS NOT OLD.retention_policy
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.revoked_at < OLD.issued_at
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRIVATE_CONSENT_RECEIPT_REVOCATION_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS growth_private_consent_receipts_immutable_delete
BEFORE DELETE ON growth_private_consent_receipts
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRIVATE_CONSENT_RECEIPT_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_spaces (
  id TEXT PRIMARY KEY,
  space_type TEXT NOT NULL CHECK (space_type = 'SOLO'),
  host_user_id TEXT NOT NULL,
  privacy_mode TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (privacy_mode = 'PRIVATE'),
  consent_receipt_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_revision >= 1),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (consent_receipt_id) REFERENCES growth_private_consent_receipts(id) ON DELETE RESTRICT,
  CHECK ((status = 'ACTIVE' AND archived_at IS NULL) OR (status = 'ARCHIVED' AND archived_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_growth_spaces_host_status
  ON growth_spaces(host_user_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_spaces_one_active_solo_per_host
  ON growth_spaces(host_user_id)
  WHERE space_type = 'SOLO' AND status = 'ACTIVE';

CREATE TRIGGER IF NOT EXISTS growth_spaces_require_active_private_consent
BEFORE INSERT ON growth_spaces
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_private_consent_receipts receipt
  WHERE receipt.id = NEW.consent_receipt_id
    AND receipt.subject_user_id = NEW.host_user_id
    AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_SPACE_PRIVATE_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_spaces_consent_owner_immutable
BEFORE UPDATE OF host_user_id, consent_receipt_id, space_type, privacy_mode ON growth_spaces
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_SPACE_OWNERSHIP_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_space_memberships (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('HOST', 'FACILITATOR', 'PARTICIPANT')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  pseudonym_id TEXT NOT NULL CHECK (length(trim(pseudonym_id)) > 0),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (space_id) REFERENCES growth_spaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_memberships_active_user
  ON growth_space_memberships(space_id, user_id) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_memberships_active_pseudonym
  ON growth_space_memberships(space_id, pseudonym_id) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_solo_one_active_host
  ON growth_space_memberships(space_id) WHERE status = 'ACTIVE' AND role = 'HOST';

CREATE INDEX IF NOT EXISTS idx_growth_memberships_authorization
  ON growth_space_memberships(user_id, space_id, status, role);

CREATE TRIGGER IF NOT EXISTS growth_solo_membership_guard_insert
BEFORE INSERT ON growth_space_memberships
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_spaces space
  WHERE space.id = NEW.space_id AND space.space_type = 'SOLO'
    AND (NEW.role <> 'HOST' OR NEW.user_id <> space.host_user_id OR NEW.status <> 'ACTIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_SOLO_REQUIRES_HOST_MEMBERSHIP');
END;

CREATE TRIGGER IF NOT EXISTS growth_solo_membership_guard_update
BEFORE UPDATE ON growth_space_memberships
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_spaces space WHERE space.id = OLD.space_id AND space.space_type = 'SOLO'
) OR EXISTS (
  SELECT 1 FROM growth_spaces space
  WHERE space.id = NEW.space_id AND space.space_type = 'SOLO'
    AND (NEW.role <> 'HOST' OR NEW.user_id <> space.host_user_id OR NEW.status <> 'ACTIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_SOLO_HOST_MEMBERSHIP_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_solo_membership_guard_delete
BEFORE DELETE ON growth_space_memberships
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM growth_spaces space WHERE space.id = OLD.space_id AND space.space_type = 'SOLO'
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_SOLO_HOST_MEMBERSHIP_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_create_solo_host_membership
AFTER INSERT ON growth_spaces
FOR EACH ROW WHEN NEW.space_type = 'SOLO'
BEGIN
  INSERT INTO growth_space_memberships (
    id, space_id, user_id, role, status, policy_revision, pseudonym_id,
    granted_at, created_at, updated_at
  ) VALUES (
    'growth-host:' || NEW.id, NEW.id, NEW.host_user_id, 'HOST', 'ACTIVE',
    (SELECT policy_revision FROM growth_private_consent_receipts WHERE id = NEW.consent_receipt_id),
    'growth-host:' || NEW.id, NEW.created_at, NEW.created_at, NEW.updated_at
  );
END;

CREATE TABLE IF NOT EXISTS growth_path_revisions (
  id TEXT PRIMARY KEY,
  path_code TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale = 'en'),
  display_name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  UNIQUE(path_code, revision, locale)
);

CREATE TABLE IF NOT EXISTS growth_capability_definitions (
  id TEXT PRIMARY KEY,
  path_revision_id TEXT NOT NULL,
  capability_code TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  display_name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (path_revision_id) REFERENCES growth_path_revisions(id) ON DELETE RESTRICT,
  UNIQUE(path_revision_id, capability_code, revision),
  UNIQUE(id, revision)
);

CREATE TABLE IF NOT EXISTS growth_observation_rules (
  id TEXT PRIMARY KEY,
  path_revision_id TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (path_revision_id) REFERENCES growth_path_revisions(id) ON DELETE RESTRICT,
  UNIQUE(path_revision_id, rule_code, revision),
  UNIQUE(id, revision)
);

CREATE TABLE IF NOT EXISTS growth_rubric_revisions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  criteria_json TEXT NOT NULL CHECK (json_valid(criteria_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (capability_id, capability_revision) REFERENCES growth_capability_definitions(id, revision) ON DELETE RESTRICT,
  UNIQUE(capability_id, capability_revision, revision)
);

CREATE TABLE IF NOT EXISTS growth_gap_rules (
  id TEXT PRIMARY KEY,
  path_revision_id TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (path_revision_id) REFERENCES growth_path_revisions(id) ON DELETE RESTRICT,
  UNIQUE(path_revision_id, rule_code, revision),
  UNIQUE(id, revision)
);

CREATE TABLE IF NOT EXISTS growth_practice_rules (
  id TEXT PRIMARY KEY,
  path_revision_id TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  rule_json TEXT NOT NULL CHECK (json_valid(rule_json)),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (path_revision_id) REFERENCES growth_path_revisions(id) ON DELETE RESTRICT,
  UNIQUE(path_revision_id, rule_code, revision),
  UNIQUE(id, revision)
);

CREATE TRIGGER IF NOT EXISTS growth_path_revisions_immutable_update
BEFORE UPDATE ON growth_path_revisions
FOR EACH ROW WHEN NEW.path_code IS NOT OLD.path_code
  OR NEW.revision IS NOT OLD.revision
  OR NEW.locale IS NOT OLD.locale
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.definition_json IS NOT OLD.definition_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_PATH_REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_path_revisions_immutable_delete
BEFORE DELETE ON growth_path_revisions BEGIN SELECT RAISE(ABORT, 'GROWTH_PATH_REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_capability_definitions_immutable_update
BEFORE UPDATE ON growth_capability_definitions
FOR EACH ROW WHEN NEW.path_revision_id IS NOT OLD.path_revision_id
  OR NEW.capability_code IS NOT OLD.capability_code
  OR NEW.revision IS NOT OLD.revision
  OR NEW.display_name IS NOT OLD.display_name
  OR NEW.definition_json IS NOT OLD.definition_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_CAPABILITY_DEFINITION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_capability_definitions_immutable_delete
BEFORE DELETE ON growth_capability_definitions BEGIN SELECT RAISE(ABORT, 'GROWTH_CAPABILITY_DEFINITION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_observation_rules_immutable_update
BEFORE UPDATE ON growth_observation_rules
FOR EACH ROW WHEN NEW.path_revision_id IS NOT OLD.path_revision_id
  OR NEW.rule_code IS NOT OLD.rule_code
  OR NEW.revision IS NOT OLD.revision
  OR NEW.rule_json IS NOT OLD.rule_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_RULE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_observation_rules_immutable_delete
BEFORE DELETE ON growth_observation_rules BEGIN SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_RULE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_rubric_revisions_immutable_update
BEFORE UPDATE ON growth_rubric_revisions
FOR EACH ROW WHEN NEW.capability_id IS NOT OLD.capability_id
  OR NEW.capability_revision IS NOT OLD.capability_revision
  OR NEW.revision IS NOT OLD.revision
  OR NEW.criteria_json IS NOT OLD.criteria_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_RUBRIC_REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_rubric_revisions_immutable_delete
BEFORE DELETE ON growth_rubric_revisions BEGIN SELECT RAISE(ABORT, 'GROWTH_RUBRIC_REVISION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_gap_rules_immutable_update
BEFORE UPDATE ON growth_gap_rules
FOR EACH ROW WHEN NEW.path_revision_id IS NOT OLD.path_revision_id
  OR NEW.rule_code IS NOT OLD.rule_code
  OR NEW.revision IS NOT OLD.revision
  OR NEW.rule_json IS NOT OLD.rule_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_GAP_RULE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_gap_rules_immutable_delete
BEFORE DELETE ON growth_gap_rules BEGIN SELECT RAISE(ABORT, 'GROWTH_GAP_RULE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_practice_rules_immutable_update
BEFORE UPDATE ON growth_practice_rules
FOR EACH ROW WHEN NEW.path_revision_id IS NOT OLD.path_revision_id
  OR NEW.rule_code IS NOT OLD.rule_code
  OR NEW.revision IS NOT OLD.revision
  OR NEW.rule_json IS NOT OLD.rule_json
  OR NEW.validation_status IS NOT OLD.validation_status
  OR NEW.status IS NOT OLD.status
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'GROWTH_PRACTICE_RULE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS growth_practice_rules_immutable_delete
BEFORE DELETE ON growth_practice_rules BEGIN SELECT RAISE(ABORT, 'GROWTH_PRACTICE_RULE_IMMUTABLE'); END;

INSERT INTO growth_path_revisions (
  id, path_code, revision, locale, display_name, definition_json,
  validation_status, status, created_at
) VALUES
  ('growth-path:training-five-axis:en:1', 'training-five-axis', 1, 'en',
    'Training five-axis descriptive path',
    '{"source":"legacy-training-evaluator","axes":["claim_clarity","evidence_use","reasoning_strength","consistency","relevance"]}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-path:sparring-five-axis:en:1', 'sparring-five-axis', 1, 'en',
    'Sparring five-axis descriptive path',
    '{"source":"sparring-evaluator","axes":["claim_clarity","evidence_use","reasoning_strength","consistency","relevance"]}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_code = excluded.path_code, revision = excluded.revision, locale = excluded.locale,
  display_name = excluded.display_name, definition_json = excluded.definition_json,
  validation_status = excluded.validation_status, status = excluded.status, created_at = excluded.created_at;

INSERT INTO growth_capability_definitions (
  id, path_revision_id, capability_code, revision, display_name, definition_json,
  validation_status, status, created_at
) VALUES
  ('growth-capability:training-five-axis:claim-clarity:1', 'growth-path:training-five-axis:en:1', 'claim_clarity', 1, 'Claim clarity', '{"axis":"claim_clarity"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:training-five-axis:evidence-use:1', 'growth-path:training-five-axis:en:1', 'evidence_use', 1, 'Evidence use', '{"axis":"evidence_use"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:training-five-axis:reasoning-strength:1', 'growth-path:training-five-axis:en:1', 'reasoning_strength', 1, 'Reasoning strength', '{"axis":"reasoning_strength"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:training-five-axis:consistency:1', 'growth-path:training-five-axis:en:1', 'consistency', 1, 'Consistency', '{"axis":"consistency"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:training-five-axis:relevance:1', 'growth-path:training-five-axis:en:1', 'relevance', 1, 'Relevance', '{"axis":"relevance"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:sparring-five-axis:claim-clarity:1', 'growth-path:sparring-five-axis:en:1', 'claim_clarity', 1, 'Claim clarity', '{"axis":"claim_clarity"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:sparring-five-axis:evidence-use:1', 'growth-path:sparring-five-axis:en:1', 'evidence_use', 1, 'Evidence use', '{"axis":"evidence_use"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:sparring-five-axis:reasoning-strength:1', 'growth-path:sparring-five-axis:en:1', 'reasoning_strength', 1, 'Reasoning strength', '{"axis":"reasoning_strength"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:sparring-five-axis:consistency:1', 'growth-path:sparring-five-axis:en:1', 'consistency', 1, 'Consistency', '{"axis":"consistency"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-capability:sparring-five-axis:relevance:1', 'growth-path:sparring-five-axis:en:1', 'relevance', 1, 'Relevance', '{"axis":"relevance"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_revision_id = excluded.path_revision_id, capability_code = excluded.capability_code,
  revision = excluded.revision, display_name = excluded.display_name,
  definition_json = excluded.definition_json, validation_status = excluded.validation_status,
  status = excluded.status, created_at = excluded.created_at;

INSERT INTO growth_observation_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
  ('growth-observation-rule:training-lowest-axis-descriptive:en:1',
    'growth-path:training-five-axis:en:1', 'lowest_axis_descriptive_signal', 1,
    '{"kind":"LOWEST_AXIS_DESCRIPTIVE_SIGNAL","source":"legacy-training-evaluator","tie_break":"stable_capability_code_ascending","outcome":"UNKNOWN","prohibits":["MEASURED","GAP_PROPOSED","CALIBRATED_CONFIDENCE","IMPROVED"]}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-observation-rule:sparring-five-axis-descriptive:en:1',
    'growth-path:sparring-five-axis:en:1', 'sparring_five_axis_descriptive_signal', 1,
    '{"kind":"SPARRING_FIVE_AXIS_DESCRIPTIVE_SIGNAL","source":"sparring-evaluator","axis_mapping":{"clarity_score":"claim_clarity","evidence_score":"evidence_use","defense_score":"reasoning_strength","consistency_score":"consistency","relevance_score":"relevance"},"tie_break":"stable_capability_code_ascending","outcome":"UNKNOWN","prohibits":["MEASURED","GAP_PROPOSED","CALIBRATED_CONFIDENCE","IMPROVED"]}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_revision_id = excluded.path_revision_id, rule_code = excluded.rule_code,
  revision = excluded.revision, rule_json = excluded.rule_json,
  validation_status = excluded.validation_status, status = excluded.status,
  created_at = excluded.created_at;

INSERT INTO growth_gap_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
  ('growth-gap-rule:training-five-axis:provisional:en:1',
    'growth-path:training-five-axis:en:1', 'validated_gap_required', 1,
    '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-gap-rule:sparring-five-axis:provisional:en:1',
    'growth-path:sparring-five-axis:en:1', 'validated_gap_required', 1,
    '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_revision_id = excluded.path_revision_id, rule_code = excluded.rule_code,
  revision = excluded.revision, rule_json = excluded.rule_json,
  validation_status = excluded.validation_status, status = excluded.status,
  created_at = excluded.created_at;

INSERT INTO growth_practice_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
  ('growth-practice-rule:training-five-axis:provisional:en:1',
    'growth-path:training-five-axis:en:1', 'legacy_provisional_practice_unavailable', 1,
    '{"kind":"LEGACY_PROVISIONAL_PRACTICE_UNAVAILABLE","outcome":"UNAVAILABLE"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-practice-rule:sparring-five-axis:provisional:en:1',
    'growth-path:sparring-five-axis:en:1', 'legacy_provisional_practice_unavailable', 1,
    '{"kind":"LEGACY_PROVISIONAL_PRACTICE_UNAVAILABLE","outcome":"UNAVAILABLE"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-practice-rule:training-five-axis:learner-focus:en:1',
    'growth-path:training-five-axis:en:1', 'learner_chosen_focus_practice', 1,
    '{"kind":"LEARNER_CHOSEN_FOCUS_PRACTICE","axis_to_quest_type":{"claim_clarity":"EXPLANATION","evidence_use":"SOURCE_EVALUATION","reasoning_strength":"VARIANT_PROBLEM","consistency":"REFLECTION","relevance":"ANALOGY"},"source_packet_rule":"owned_origin_evidence_only","retention_horizon_hours":168,"variant_recheck_policy":{"kind":"VARIANT","outcome":"UNKNOWN","prohibits":["MEASURED","IMPROVED","NO_CHANGE","REGRESSED"]},"outcome":"UNKNOWN","requires":"focus_selection"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-practice-rule:sparring-five-axis:learner-focus:en:1',
    'growth-path:sparring-five-axis:en:1', 'learner_chosen_focus_practice', 1,
    '{"kind":"LEARNER_CHOSEN_FOCUS_PRACTICE","axis_to_quest_type":{"claim_clarity":"EXPLANATION","evidence_use":"SOURCE_EVALUATION","reasoning_strength":"SPARRING","consistency":"REFLECTION","relevance":"ANALOGY"},"source_packet_rule":"owned_origin_evidence_only","retention_horizon_hours":168,"variant_recheck_policy":{"kind":"VARIANT","outcome":"UNKNOWN","prohibits":["MEASURED","IMPROVED","NO_CHANGE","REGRESSED"]},"outcome":"UNKNOWN","requires":"focus_selection"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_revision_id = excluded.path_revision_id, rule_code = excluded.rule_code,
  revision = excluded.revision, rule_json = excluded.rule_json,
  validation_status = excluded.validation_status, status = excluded.status,
  created_at = excluded.created_at;

CREATE TABLE IF NOT EXISTS growth_cycles (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  participant_membership_id TEXT NOT NULL,
  path_revision_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('TRAINING', 'SPARRING')),
  origin_attempt_id TEXT NOT NULL,
  origin_turn_number INTEGER,
  origin_event_identity TEXT NOT NULL CHECK (length(trim(origin_event_identity)) > 0),
  origin_lookup_digest TEXT NOT NULL UNIQUE CHECK (length(origin_lookup_digest) = 64),
  origin_request_digest TEXT NOT NULL CHECK (length(origin_request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN (
    'EVIDENCE_PENDING', 'GAP_PROPOSED', 'GAP_ACCEPTED', 'GAP_CONTESTED',
    'GAP_DISMISSED', 'GAP_DEFERRED', 'GAP_UNKNOWN', 'FOCUS_SELECTED',
    'PRACTICE_OFFERED', 'PRACTICE_ACCEPTED', 'PRACTICE_DECLINED',
    'PRACTICE_DEFERRED', 'RECHECK_SCHEDULED', 'RECHECKED',
    'TRANSFER_PENDING', 'CLOSED'
  )),
  aggregate_revision INTEGER NOT NULL DEFAULT 1 CHECK (aggregate_revision >= 1),
  consent_receipt_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  FOREIGN KEY (space_id) REFERENCES growth_spaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (participant_membership_id) REFERENCES growth_space_memberships(id) ON DELETE RESTRICT,
  FOREIGN KEY (path_revision_id) REFERENCES growth_path_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (consent_receipt_id) REFERENCES growth_private_consent_receipts(id) ON DELETE RESTRICT,
  CHECK ((state = 'CLOSED' AND closed_at IS NOT NULL) OR (state <> 'CLOSED' AND closed_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_cycles_origin_once
  ON growth_cycles(space_id, origin_kind, origin_attempt_id, COALESCE(origin_turn_number, -1));

CREATE INDEX IF NOT EXISTS idx_growth_cycles_participant_state
  ON growth_cycles(participant_membership_id, state, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS growth_cycles_initial_state_guard
BEFORE INSERT ON growth_cycles
FOR EACH ROW WHEN NEW.state <> 'EVIDENCE_PENDING' OR NEW.aggregate_revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_MUST_OPEN_EVIDENCE_PENDING');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_resurrection_barrier
BEFORE INSERT ON growth_cycles
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM growth_cycle_resurrection_tombstones tombstone
  WHERE tombstone.origin_lookup_digest = NEW.origin_lookup_digest
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_RESURRECTION_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_owned_private_participant
BEFORE INSERT ON growth_cycles
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_space_memberships membership
  INNER JOIN growth_spaces space ON space.id = membership.space_id
  INNER JOIN growth_private_consent_receipts receipt ON receipt.id = NEW.consent_receipt_id
  WHERE membership.id = NEW.participant_membership_id
    AND membership.space_id = NEW.space_id
    AND membership.status = 'ACTIVE'
    AND membership.role IN ('HOST', 'PARTICIPANT')
    AND space.privacy_mode = 'PRIVATE'
    AND receipt.subject_user_id = membership.user_id
    AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_PRIVATE_OWNERSHIP_OR_CONSENT_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS growth_lifecycle_transitions (
  from_state TEXT NOT NULL,
  action TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_class TEXT NOT NULL CHECK (actor_class IN ('SYSTEM', 'PARTICIPANT')),
  route_action TEXT NOT NULL CHECK (length(trim(route_action)) > 0),
  PRIMARY KEY (from_state, action, to_state),
  UNIQUE (from_state, action, event_type)
);

INSERT INTO growth_lifecycle_transitions (from_state, action, to_state, event_type, actor_class, route_action) VALUES
  ('EVIDENCE_PENDING', 'VALIDATED_OBSERVATION_RECORDED', 'GAP_PROPOSED', 'GAP_PROPOSED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('EVIDENCE_PENDING', 'PROVISIONAL_OR_INSUFFICIENT_SIGNAL_RECORDED', 'GAP_UNKNOWN', 'GAP_REMAINS_UNKNOWN', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('EVIDENCE_PENDING', 'RETRY_EVALUATION', 'EVIDENCE_PENDING', 'EVIDENCE_RETRY_REQUESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('EVIDENCE_PENDING', 'CANCEL_AND_CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_PROPOSED', 'ACCEPT', 'GAP_ACCEPTED', 'GAP_ACCEPTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_PROPOSED', 'CONTEST', 'GAP_CONTESTED', 'GAP_CONTESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_PROPOSED', 'DISMISS', 'GAP_DISMISSED', 'GAP_DISMISSED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_PROPOSED', 'DEFER', 'GAP_DEFERRED', 'GAP_DEFERRED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_CONTESTED', 'SUBMIT_REVISED_VALIDATED_HYPOTHESIS', 'GAP_PROPOSED', 'GAP_REVISED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('GAP_CONTESTED', 'DISMISS', 'GAP_DISMISSED', 'GAP_DISMISSED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_CONTESTED', 'CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_DEFERRED', 'RESUME', 'GAP_PROPOSED', 'GAP_RESUMED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_DEFERRED', 'DISMISS', 'GAP_DISMISSED', 'GAP_DISMISSED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_DEFERRED', 'CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_DISMISSED', 'CLOSE', 'CLOSED', 'CYCLE_CLOSED_DISMISSED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_ACCEPTED', 'OFFER_PRACTICE', 'PRACTICE_OFFERED', 'PRACTICE_OFFERED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('GAP_ACCEPTED', 'RETRY_PRACTICE_OFFER', 'GAP_ACCEPTED', 'PRACTICE_OFFER_RETRY_REQUESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_ACCEPTED', 'CLOSE_WITHOUT_PRACTICE', 'CLOSED', 'CYCLE_CLOSED_WITHOUT_PRACTICE', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_UNKNOWN', 'CHOOSE_FOCUS', 'FOCUS_SELECTED', 'FOCUS_SELECTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/focus'),
  ('GAP_UNKNOWN', 'RETRY_EVIDENCE_VALIDATION', 'EVIDENCE_PENDING', 'EVIDENCE_RETRY_REQUESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('GAP_UNKNOWN', 'DISMISS_AND_CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/gap-response'),
  ('FOCUS_SELECTED', 'OFFER_PRACTICE', 'PRACTICE_OFFERED', 'PRACTICE_OFFERED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('FOCUS_SELECTED', 'REVISE_FOCUS', 'FOCUS_SELECTED', 'FOCUS_REVISED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/focus'),
  ('FOCUS_SELECTED', 'PRACTICE_UNAVAILABLE', 'GAP_UNKNOWN', 'PRACTICE_UNAVAILABLE', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('FOCUS_SELECTED', 'CANCEL_AND_CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/focus'),
  ('PRACTICE_OFFERED', 'ACCEPT', 'PRACTICE_ACCEPTED', 'PRACTICE_ACCEPTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_OFFERED', 'DECLINE', 'PRACTICE_DECLINED', 'PRACTICE_DECLINED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_OFFERED', 'DEFER', 'PRACTICE_DEFERRED', 'PRACTICE_DEFERRED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_DECLINED', 'CLOSE', 'CLOSED', 'CYCLE_CLOSED_PRACTICE_DECLINED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_DEFERRED', 'RESUME', 'PRACTICE_OFFERED', 'PRACTICE_RESUMED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_DEFERRED', 'DECLINE', 'PRACTICE_DECLINED', 'PRACTICE_DECLINED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_DEFERRED', 'CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_ACCEPTED', 'SCHEDULE_RECHECK', 'RECHECK_SCHEDULED', 'RECHECK_SCHEDULED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('PRACTICE_ACCEPTED', 'RETRY_RECHECK_SCHEDULING', 'PRACTICE_ACCEPTED', 'RECHECK_SCHEDULING_RETRY_REQUESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('PRACTICE_ACCEPTED', 'CANCEL_AND_CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/practice-response'),
  ('RECHECK_SCHEDULED', 'RECORD_RECHECK', 'RECHECKED', 'RECHECK_RECORDED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks'),
  ('RECHECK_SCHEDULED', 'DEFER_OR_RESCHEDULE', 'RECHECK_SCHEDULED', 'RECHECK_RESCHEDULED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks'),
  ('RECHECK_SCHEDULED', 'CANCEL_AND_CLOSE_UNKNOWN', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks'),
  ('RECHECKED', 'COMPARE_VALIDATED_OBSERVATIONS', 'TRANSFER_PENDING', 'RECHECK_OUTCOME_RECORDED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('RECHECKED', 'CLOSE_WITHOUT_VALIDATED_COMPARISON', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks'),
  ('TRANSFER_PENDING', 'RECORD_VALIDATED_TRANSFER_TASK', 'CLOSED', 'TRANSFER_OUTCOME_RECORDED', 'SYSTEM', 'SYSTEM:GROWTH_CYCLE'),
  ('TRANSFER_PENDING', 'RETRY_TRANSFER_VALIDATION', 'TRANSFER_PENDING', 'TRANSFER_RETRY_REQUESTED', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks'),
  ('TRANSFER_PENDING', 'CLOSE_WITHOUT_VALIDATED_TRANSFER_EVIDENCE', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks')
ON CONFLICT(from_state, action, to_state) DO UPDATE SET
  event_type = excluded.event_type,
  actor_class = excluded.actor_class,
  route_action = excluded.route_action;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_insert
BEFORE INSERT ON growth_lifecycle_transitions
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_lifecycle_transitions existing
  WHERE existing.from_state = NEW.from_state
    AND existing.action = NEW.action
    AND existing.to_state = NEW.to_state
    AND existing.event_type = NEW.event_type
    AND existing.actor_class = NEW.actor_class
    AND existing.route_action = NEW.route_action
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_update
BEFORE UPDATE ON growth_lifecycle_transitions
FOR EACH ROW WHEN NEW.from_state IS NOT OLD.from_state
  OR NEW.action IS NOT OLD.action
  OR NEW.to_state IS NOT OLD.to_state
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.actor_class IS NOT OLD.actor_class
  OR NEW.route_action IS NOT OLD.route_action
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transitions_immutable_delete
BEFORE DELETE ON growth_lifecycle_transitions
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CATALOG_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_capability_observations (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  rubric_revision_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('MEASURED', 'UNOBSERVED', 'UNKNOWN', 'UNAVAILABLE', 'FAILED', 'IN_PROGRESS')),
  value_numeric REAL,
  value_scale TEXT CHECK (value_scale IS NULL OR value_scale IN ('PERCENT_0_100', 'RUBRIC_LEVEL')),
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_event_ids_json) AND json_type(evidence_event_ids_json) = 'array'),
  inference_rule_id TEXT NOT NULL,
  inference_rule_revision INTEGER NOT NULL CHECK (inference_rule_revision >= 1),
  inference_validation TEXT NOT NULL CHECK (inference_validation IN ('VALIDATED', 'PROVISIONAL_UNCALIBRATED')),
  confidence REAL,
  raw_signal_json TEXT CHECK (raw_signal_json IS NULL OR json_valid(raw_signal_json)),
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (capability_id, capability_revision) REFERENCES growth_capability_definitions(id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (rubric_revision_id) REFERENCES growth_rubric_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (inference_rule_id, inference_rule_revision) REFERENCES growth_observation_rules(id, revision) ON DELETE RESTRICT,
  CHECK (
    (status = 'MEASURED' AND rubric_revision_id IS NOT NULL AND value_numeric IS NOT NULL AND typeof(value_numeric) IN ('integer', 'real')
      AND value_numeric = value_numeric AND abs(value_numeric) < 1.7976931348623157e308
      AND value_scale IN ('PERCENT_0_100', 'RUBRIC_LEVEL')
      AND (value_scale <> 'PERCENT_0_100' OR value_numeric BETWEEN 0 AND 100))
    OR (status <> 'MEASURED' AND value_numeric IS NULL AND value_scale IS NULL)
  ),
  CHECK (confidence IS NULL OR (status = 'MEASURED' AND confidence BETWEEN 0 AND 1))
);

CREATE INDEX IF NOT EXISTS idx_growth_observations_cycle_capability
  ON growth_capability_observations(growth_cycle_id, capability_id, recorded_at DESC);

CREATE TRIGGER IF NOT EXISTS growth_observation_evidence_and_validation_guard
BEFORE INSERT ON growth_capability_observations
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM json_each(NEW.evidence_event_ids_json) WHERE type <> 'text' OR length(value) = 0)
  OR NOT EXISTS (
    SELECT 1
    FROM growth_cycles cycle
    INNER JOIN growth_capability_definitions capability
      ON capability.id = NEW.capability_id AND capability.revision = NEW.capability_revision
    WHERE cycle.id = NEW.growth_cycle_id AND capability.path_revision_id = cycle.path_revision_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM growth_cycles cycle
    INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
    WHERE cycle.id = NEW.growth_cycle_id AND receipt.revoked_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_event_ids_json) evidence
    WHERE NOT EXISTS (
      SELECT 1 FROM growth_events event
      WHERE event.id = evidence.value AND event.growth_cycle_id = NEW.growth_cycle_id
    )
  )
  OR (NEW.status = 'MEASURED' AND json_array_length(NEW.evidence_event_ids_json) = 0)
  OR (NEW.status = 'MEASURED' AND (
    NEW.inference_validation <> 'VALIDATED'
    OR NOT EXISTS (SELECT 1 FROM growth_observation_rules rule WHERE rule.id = NEW.inference_rule_id AND rule.revision = NEW.inference_rule_revision AND rule.validation_status = 'VALIDATED' AND rule.status = 'ACTIVE')
    OR NOT EXISTS (SELECT 1 FROM growth_capability_definitions capability WHERE capability.id = NEW.capability_id AND capability.revision = NEW.capability_revision AND capability.validation_status = 'VALIDATED' AND capability.status = 'ACTIVE')
    OR NOT EXISTS (SELECT 1 FROM growth_rubric_revisions rubric WHERE rubric.id = NEW.rubric_revision_id AND rubric.capability_id = NEW.capability_id AND rubric.capability_revision = NEW.capability_revision AND rubric.validation_status = 'VALIDATED' AND rubric.status = 'ACTIVE')
  ))
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_REQUIRES_CYCLE_PATH_AND_VALIDATED_RULES');
END;

CREATE TRIGGER IF NOT EXISTS growth_capability_observations_immutable_update
BEFORE UPDATE ON growth_capability_observations
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CAPABILITY_OBSERVATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_capability_observations_active_consent_delete_guard
BEFORE DELETE ON growth_capability_observations
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context
  WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CAPABILITY_OBSERVATION_CONTROLLED_DELETION_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS growth_observation_evidence (
  observation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (observation_id, event_id),
  FOREIGN KEY (observation_id) REFERENCES growth_capability_observations(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES growth_events(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_observation_evidence_scope_guard
BEFORE INSERT ON growth_observation_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_capability_observations observation
  INNER JOIN growth_events event ON event.id = NEW.event_id
  WHERE observation.id = NEW.observation_id
    AND event.growth_cycle_id = observation.growth_cycle_id
    AND EXISTS (SELECT 1 FROM growth_cycles cycle INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id WHERE cycle.id = observation.growth_cycle_id AND receipt.revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM json_each(observation.evidence_event_ids_json) WHERE value = NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_EVIDENCE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS growth_observation_evidence_immutable_update
BEFORE UPDATE ON growth_observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_observation_evidence_controlled_delete_only
BEFORE DELETE ON growth_observation_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_capability_observations observation
  INNER JOIN growth_deletion_context context ON context.growth_cycle_id = observation.growth_cycle_id
  WHERE observation.id = OLD.observation_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_OBSERVATION_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_observation_evidence_materialize
AFTER INSERT ON growth_capability_observations
FOR EACH ROW
BEGIN
  INSERT INTO growth_observation_evidence (observation_id, event_id, created_at)
  SELECT NEW.id, value, NEW.recorded_at FROM json_each(NEW.evidence_event_ids_json);
  SELECT CASE WHEN (SELECT count(*) FROM growth_observation_evidence WHERE observation_id = NEW.id)
    <> json_array_length(NEW.evidence_event_ids_json)
    THEN RAISE(ABORT, 'GROWTH_OBSERVATION_EVIDENCE_INCOMPLETE') END;
END;

CREATE TABLE IF NOT EXISTS growth_gap_hypotheses (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  observation_id TEXT,
  capability_id TEXT NOT NULL,
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  gap_rule_id TEXT NOT NULL,
  gap_rule_revision INTEGER NOT NULL CHECK (gap_rule_revision >= 1),
  statement TEXT NOT NULL CHECK (length(trim(statement)) > 0),
  state TEXT NOT NULL CHECK (state IN ('PROPOSED', 'CONTESTED', 'ACCEPTED', 'DISMISSED', 'DEFERRED', 'UNKNOWN')),
  supporting_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supporting_event_ids_json) AND json_type(supporting_event_ids_json) = 'array'),
  contradicting_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(contradicting_event_ids_json) AND json_type(contradicting_event_ids_json) = 'array'),
  participant_rationale TEXT,
  generator_revision TEXT,
  model_revision TEXT,
  prompt_revision TEXT,
  source_revision TEXT,
  revises_hypothesis_id TEXT,
  revision_rationale TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (observation_id) REFERENCES growth_capability_observations(id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id, capability_revision) REFERENCES growth_capability_definitions(id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (gap_rule_id, gap_rule_revision) REFERENCES growth_gap_rules(id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (revises_hypothesis_id) REFERENCES growth_gap_hypotheses(id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_validation_guard
BEFORE INSERT ON growth_gap_hypotheses
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM json_each(NEW.supporting_event_ids_json) WHERE type <> 'text' OR length(value) = 0)
  OR EXISTS (SELECT 1 FROM json_each(NEW.contradicting_event_ids_json) WHERE type <> 'text' OR length(value) = 0)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.supporting_event_ids_json) evidence
    WHERE NOT EXISTS (SELECT 1 FROM growth_events event WHERE event.id = evidence.value AND event.growth_cycle_id = NEW.growth_cycle_id)
  )
  OR NOT EXISTS (
    SELECT 1 FROM growth_cycles cycle
    INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
    WHERE cycle.id = NEW.growth_cycle_id AND receipt.revoked_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.contradicting_event_ids_json) evidence
    WHERE NOT EXISTS (SELECT 1 FROM growth_events event WHERE event.id = evidence.value AND event.growth_cycle_id = NEW.growth_cycle_id)
  )
  OR (NEW.state = 'PROPOSED' AND (
    NEW.observation_id IS NULL
    OR json_array_length(NEW.supporting_event_ids_json) = 0
    OR NOT EXISTS (SELECT 1 FROM growth_gap_rules rule WHERE rule.id = NEW.gap_rule_id AND rule.revision = NEW.gap_rule_revision AND rule.validation_status = 'VALIDATED' AND rule.status = 'ACTIVE')
    OR NOT EXISTS (SELECT 1 FROM growth_capability_observations observation WHERE observation.id = NEW.observation_id AND observation.growth_cycle_id = NEW.growth_cycle_id AND observation.capability_id = NEW.capability_id AND observation.capability_revision = NEW.capability_revision AND observation.status = 'MEASURED' AND observation.inference_validation = 'VALIDATED')
    OR NOT EXISTS (SELECT 1 FROM growth_cycles cycle INNER JOIN growth_gap_rules rule ON rule.id = NEW.gap_rule_id AND rule.revision = NEW.gap_rule_revision WHERE cycle.id = NEW.growth_cycle_id AND rule.path_revision_id = cycle.path_revision_id)
  ))
  OR (NEW.revises_hypothesis_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses previous
    WHERE previous.id = NEW.revises_hypothesis_id
      AND previous.growth_cycle_id = NEW.growth_cycle_id
      AND previous.state IN ('CONTESTED', 'DEFERRED')
  ))
  OR (NEW.revises_hypothesis_id IS NOT NULL AND length(trim(COALESCE(NEW.revision_rationale, ''))) = 0)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_PROPOSAL_REQUIRES_VALIDATED_EVIDENCE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_revision_mechanism_guard
BEFORE INSERT ON growth_gap_hypotheses
FOR EACH ROW WHEN NEW.revises_hypothesis_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM growth_gap_hypotheses previous
    WHERE previous.id = NEW.revises_hypothesis_id
      AND previous.state = 'CONTESTED'
  )
  AND NOT (
    (
      (NEW.supporting_event_ids_json IS NOT (SELECT previous.supporting_event_ids_json FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id)
        OR NEW.contradicting_event_ids_json IS NOT (SELECT previous.contradicting_event_ids_json FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id))
      AND (SELECT count(*) FROM growth_gap_hypothesis_evidence evidence WHERE evidence.gap_hypothesis_id = NEW.revises_hypothesis_id)
        = (SELECT json_array_length(previous.supporting_event_ids_json) + json_array_length(previous.contradicting_event_ids_json) FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id)
    )
    OR EXISTS (
      SELECT 1 FROM growth_gap_rules rule
      WHERE rule.id = NEW.gap_rule_id
        AND rule.revision = NEW.gap_rule_revision
        AND rule.status = 'ACTIVE'
        AND rule.validation_status = 'VALIDATED'
        AND (rule.id IS NOT (SELECT previous.gap_rule_id FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id)
          OR rule.revision IS NOT (SELECT previous.gap_rule_revision FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id))
    )
    OR EXISTS (
      SELECT 1
      FROM growth_capability_observations current_observation
      INNER JOIN growth_capability_observations previous_observation
        ON previous_observation.id = (SELECT previous.observation_id FROM growth_gap_hypotheses previous WHERE previous.id = NEW.revises_hypothesis_id)
      INNER JOIN growth_observation_rules current_rule
        ON current_rule.id = current_observation.inference_rule_id
       AND current_rule.revision = current_observation.inference_rule_revision
      INNER JOIN growth_rubric_revisions current_rubric ON current_rubric.id = current_observation.rubric_revision_id
      WHERE current_observation.id = NEW.observation_id
        AND current_observation.status = 'MEASURED'
        AND current_observation.inference_validation = 'VALIDATED'
        AND current_rule.status = 'ACTIVE'
        AND current_rule.validation_status = 'VALIDATED'
        AND current_rubric.status = 'ACTIVE'
        AND current_rubric.validation_status = 'VALIDATED'
        AND (current_observation.inference_rule_id IS NOT previous_observation.inference_rule_id
          OR current_observation.inference_rule_revision IS NOT previous_observation.inference_rule_revision
          OR current_observation.rubric_revision_id IS NOT previous_observation.rubric_revision_id)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_REVISION_REQUIRES_VALIDATED_DIFFERENCE');
END;

CREATE TABLE IF NOT EXISTS growth_gap_hypothesis_evidence (
  gap_hypothesis_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('SUPPORTING', 'CONTRADICTING')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (gap_hypothesis_id, event_id, evidence_role),
  FOREIGN KEY (gap_hypothesis_id) REFERENCES growth_gap_hypotheses(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES growth_events(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_evidence_scope_guard
BEFORE INSERT ON growth_gap_hypothesis_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_gap_hypotheses hypothesis
  INNER JOIN growth_events event ON event.id = NEW.event_id
  WHERE hypothesis.id = NEW.gap_hypothesis_id
    AND event.growth_cycle_id = hypothesis.growth_cycle_id
    AND EXISTS (SELECT 1 FROM growth_cycles cycle INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id WHERE cycle.id = hypothesis.growth_cycle_id AND receipt.revoked_at IS NULL)
    AND (
      (NEW.evidence_role = 'SUPPORTING' AND EXISTS (SELECT 1 FROM json_each(hypothesis.supporting_event_ids_json) WHERE value = NEW.event_id))
      OR (NEW.evidence_role = 'CONTRADICTING' AND EXISTS (SELECT 1 FROM json_each(hypothesis.contradicting_event_ids_json) WHERE value = NEW.event_id))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_EVIDENCE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_evidence_materialize
AFTER INSERT ON growth_gap_hypotheses
FOR EACH ROW
BEGIN
  INSERT INTO growth_gap_hypothesis_evidence (gap_hypothesis_id, event_id, evidence_role, created_at)
  SELECT NEW.id, value, 'SUPPORTING', NEW.created_at FROM json_each(NEW.supporting_event_ids_json);
  INSERT INTO growth_gap_hypothesis_evidence (gap_hypothesis_id, event_id, evidence_role, created_at)
  SELECT NEW.id, value, 'CONTRADICTING', NEW.created_at FROM json_each(NEW.contradicting_event_ids_json);
  SELECT CASE WHEN (SELECT count(*) FROM growth_gap_hypothesis_evidence WHERE gap_hypothesis_id = NEW.id)
    <> json_array_length(NEW.supporting_event_ids_json) + json_array_length(NEW.contradicting_event_ids_json)
    THEN RAISE(ABORT, 'GROWTH_GAP_EVIDENCE_INCOMPLETE') END;
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypotheses_active_consent_update_guard
BEFORE UPDATE ON growth_gap_hypotheses
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_cycles cycle
  INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
  WHERE cycle.id = OLD.growth_cycle_id AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_ACTIVE_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypotheses_revision_history_guard
BEFORE UPDATE ON growth_gap_hypotheses
FOR EACH ROW WHEN NEW.id IS NOT OLD.id
  OR NEW.growth_cycle_id IS NOT OLD.growth_cycle_id
  OR NEW.observation_id IS NOT OLD.observation_id
  OR NEW.capability_id IS NOT OLD.capability_id
  OR NEW.capability_revision IS NOT OLD.capability_revision
  OR NEW.gap_rule_id IS NOT OLD.gap_rule_id
  OR NEW.gap_rule_revision IS NOT OLD.gap_rule_revision
  OR NEW.statement IS NOT OLD.statement
  OR NEW.supporting_event_ids_json IS NOT OLD.supporting_event_ids_json
  OR NEW.contradicting_event_ids_json IS NOT OLD.contradicting_event_ids_json
  OR NEW.generator_revision IS NOT OLD.generator_revision
  OR NEW.model_revision IS NOT OLD.model_revision
  OR NEW.prompt_revision IS NOT OLD.prompt_revision
  OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.revises_hypothesis_id IS NOT OLD.revises_hypothesis_id
  OR NEW.revision_rationale IS NOT OLD.revision_rationale
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypotheses_controlled_delete_only
BEFORE DELETE ON growth_gap_hypotheses
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_evidence_immutable_update
BEFORE UPDATE ON growth_gap_hypothesis_evidence
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_evidence_controlled_delete_only
BEFORE DELETE ON growth_gap_hypothesis_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_gap_hypotheses hypothesis
  INNER JOIN growth_deletion_context context ON context.growth_cycle_id = hypothesis.growth_cycle_id
  WHERE hypothesis.id = OLD.gap_hypothesis_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_EVIDENCE_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_focus_selections (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  participant_membership_id TEXT NOT NULL,
  capability_id TEXT,
  capability_revision INTEGER,
  selection_kind TEXT NOT NULL DEFAULT 'INITIAL' CHECK (selection_kind IN ('INITIAL', 'REVISION')),
  focus_statement TEXT NOT NULL CHECK (length(trim(focus_statement)) > 0),
  selection_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_membership_id) REFERENCES growth_space_memberships(id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_id, capability_revision) REFERENCES growth_capability_definitions(id, revision) ON DELETE RESTRICT,
  CHECK ((capability_id IS NULL AND capability_revision IS NULL) OR (capability_id IS NOT NULL AND capability_revision IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS growth_focus_selection_participant_guard
BEFORE INSERT ON growth_focus_selections
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_cycles cycle
  WHERE cycle.id = NEW.growth_cycle_id
    AND cycle.participant_membership_id = NEW.participant_membership_id
    AND EXISTS (SELECT 1 FROM growth_private_consent_receipts receipt WHERE receipt.id = cycle.consent_receipt_id AND receipt.revoked_at IS NULL)
    AND (NEW.capability_id IS NULL OR EXISTS (
      SELECT 1
      FROM growth_capability_definitions capability
      WHERE capability.id = NEW.capability_id
        AND capability.revision = NEW.capability_revision
        AND capability.path_revision_id = cycle.path_revision_id
    ))
    AND ((NEW.selection_kind = 'INITIAL' AND cycle.state = 'GAP_UNKNOWN')
      OR (NEW.selection_kind = 'REVISION' AND cycle.state = 'FOCUS_SELECTED'))
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_FOCUS_REQUIRES_PARTICIPANT_AND_FROZEN_STATE');
END;

CREATE TRIGGER IF NOT EXISTS growth_focus_selections_immutable_update
BEFORE UPDATE ON growth_focus_selections
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_FOCUS_SELECTION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_focus_selections_controlled_delete_only
BEFORE DELETE ON growth_focus_selections
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_FOCUS_SELECTION_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_practice_quests (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  gap_hypothesis_id TEXT,
  focus_selection_id TEXT,
  practice_rule_id TEXT NOT NULL,
  practice_rule_revision INTEGER NOT NULL CHECK (practice_rule_revision >= 1),
  quest_type TEXT NOT NULL CHECK (quest_type IN ('RETRIEVAL', 'VARIANT_PROBLEM', 'SPARRING', 'EXPLANATION', 'ANALOGY', 'SOURCE_EVALUATION', 'REFLECTION')),
  source_packet_json TEXT NOT NULL CHECK (json_valid(source_packet_json)),
  selection_reason TEXT NOT NULL CHECK (length(trim(selection_reason)) > 0),
  learning_purpose TEXT NOT NULL CHECK (length(trim(learning_purpose)) > 0),
  status TEXT NOT NULL CHECK (status IN ('OFFERED', 'ACCEPTED', 'DECLINED', 'DEFERRED')),
  target_retention_horizon_hours INTEGER NOT NULL CHECK (target_retention_horizon_hours >= 1),
  revisit_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (gap_hypothesis_id) REFERENCES growth_gap_hypotheses(id) ON DELETE RESTRICT,
  FOREIGN KEY (focus_selection_id) REFERENCES growth_focus_selections(id) ON DELETE RESTRICT,
  FOREIGN KEY (practice_rule_id, practice_rule_revision) REFERENCES growth_practice_rules(id, revision) ON DELETE RESTRICT,
  CHECK ((gap_hypothesis_id IS NOT NULL AND focus_selection_id IS NULL) OR (gap_hypothesis_id IS NULL AND focus_selection_id IS NOT NULL)),
  CHECK ((status = 'DEFERRED' AND revisit_at IS NOT NULL) OR (status <> 'DEFERRED'))
);

CREATE TRIGGER IF NOT EXISTS growth_practice_quests_initial_offer_guard
BEFORE INSERT ON growth_practice_quests
FOR EACH ROW WHEN NEW.status <> 'OFFERED'
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_QUEST_MUST_OPEN_OFFERED');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quest_requires_validated_rule
BEFORE INSERT ON growth_practice_quests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_practice_rules rule
  INNER JOIN growth_cycles cycle ON cycle.id = NEW.growth_cycle_id
  WHERE rule.id = NEW.practice_rule_id
    AND rule.revision = NEW.practice_rule_revision
    AND rule.path_revision_id = cycle.path_revision_id
    AND rule.status = 'ACTIVE'
    AND (
      (NEW.gap_hypothesis_id IS NOT NULL
        AND rule.validation_status = 'VALIDATED'
        AND json_extract(rule.rule_json, '$.kind') = 'VALIDATED_GAP_PRACTICE')
      OR
      (NEW.focus_selection_id IS NOT NULL
        AND rule.validation_status = 'PROVISIONAL_UNCALIBRATED'
        AND json_extract(rule.rule_json, '$.kind') = 'LEARNER_CHOSEN_FOCUS_PRACTICE'
        AND json_extract(rule.rule_json, '$.requires') = 'focus_selection'
        AND json_extract(rule.rule_json, '$.outcome') = 'UNKNOWN'
        AND json_extract(rule.rule_json, '$.source_packet_rule') = 'owned_origin_evidence_only'
        AND json_type(rule.rule_json, '$.axis_to_quest_type') = 'object'
        AND CAST(json_extract(rule.rule_json, '$.retention_horizon_hours') AS INTEGER) >= 1
        AND json_extract(rule.rule_json, '$.variant_recheck_policy.outcome') = 'UNKNOWN'
        AND EXISTS (
          SELECT 1
          FROM growth_focus_selections focus
          INNER JOIN growth_capability_definitions capability
            ON capability.id = focus.capability_id
           AND capability.revision = focus.capability_revision
          WHERE focus.id = NEW.focus_selection_id
            AND focus.growth_cycle_id = cycle.id
            AND capability.path_revision_id = cycle.path_revision_id
            AND NEW.quest_type = json_extract(rule.rule_json, '$.axis_to_quest_type.' || capability.capability_code)
            AND NEW.target_retention_horizon_hours = CAST(json_extract(rule.rule_json, '$.retention_horizon_hours') AS INTEGER)
        ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_REQUIRES_VERSIONED_RULE');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quest_lifecycle_guard
BEFORE INSERT ON growth_practice_quests
FOR EACH ROW WHEN NOT (
  (NEW.gap_hypothesis_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM growth_cycles cycle
    INNER JOIN growth_gap_hypotheses hypothesis ON hypothesis.id = NEW.gap_hypothesis_id
    WHERE cycle.id = NEW.growth_cycle_id
      AND hypothesis.growth_cycle_id = cycle.id
      AND hypothesis.state = 'ACCEPTED'
      AND cycle.state = 'GAP_ACCEPTED'
  ))
  OR
  (NEW.focus_selection_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM growth_cycles cycle
    INNER JOIN growth_focus_selections focus ON focus.id = NEW.focus_selection_id
    WHERE cycle.id = NEW.growth_cycle_id
      AND focus.growth_cycle_id = cycle.id
      AND cycle.state = 'FOCUS_SELECTED'
  ))
)
OR NOT EXISTS (
  SELECT 1 FROM growth_cycles cycle
  INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
  WHERE cycle.id = NEW.growth_cycle_id AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_QUEST_INVALID_LIFECYCLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quests_active_consent_update_guard
BEFORE UPDATE ON growth_practice_quests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_cycles cycle
  INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
  WHERE cycle.id = OLD.growth_cycle_id AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_ACTIVE_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quests_identity_immutable_update
BEFORE UPDATE OF growth_cycle_id, gap_hypothesis_id, focus_selection_id,
  practice_rule_id, practice_rule_revision, quest_type, source_packet_json,
  selection_reason, learning_purpose, target_retention_horizon_hours, created_at
ON growth_practice_quests
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_QUEST_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quests_controlled_delete_only
BEFORE DELETE ON growth_practice_quests
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_QUEST_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_rechecks (
  id TEXT PRIMARY KEY,
  growth_cycle_id TEXT NOT NULL,
  practice_quest_id TEXT NOT NULL,
  target_horizon_hours INTEGER NOT NULL CHECK (target_horizon_hours >= 1),
  scheduled_for INTEGER NOT NULL,
  variant_policy_revision TEXT NOT NULL CHECK (length(trim(variant_policy_revision)) > 0),
  follow_up_origin_kind TEXT CHECK (follow_up_origin_kind IS NULL OR follow_up_origin_kind IN ('TRAINING', 'SPARRING')),
  follow_up_attempt_id TEXT,
  opening_observation_id TEXT,
  recheck_observation_id TEXT,
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_event_ids_json) AND json_type(evidence_event_ids_json) = 'array'),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED', 'INSUFFICIENT_EVIDENCE', 'UNKNOWN')),
  created_at INTEGER NOT NULL,
  recorded_at INTEGER,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (practice_quest_id) REFERENCES growth_practice_quests(id) ON DELETE RESTRICT,
  FOREIGN KEY (opening_observation_id) REFERENCES growth_capability_observations(id) ON DELETE RESTRICT,
  FOREIGN KEY (recheck_observation_id) REFERENCES growth_capability_observations(id) ON DELETE RESTRICT,
  CHECK ((follow_up_origin_kind IS NULL AND follow_up_attempt_id IS NULL AND recorded_at IS NULL AND outcome IS NULL)
    OR (follow_up_origin_kind IS NOT NULL AND follow_up_attempt_id IS NOT NULL AND recorded_at IS NOT NULL AND outcome IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS growth_rechecks_quest_policy_immutable_update
BEFORE UPDATE OF growth_cycle_id, practice_quest_id, target_horizon_hours,
  variant_policy_revision, created_at ON growth_rechecks
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_QUEST_POLICY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_quest_policy_insert_guard
BEFORE INSERT ON growth_rechecks
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_practice_quests quest
    ON quest.id = NEW.practice_quest_id
   AND quest.growth_cycle_id = cycle.id
  INNER JOIN growth_practice_rules rule
    ON rule.id = quest.practice_rule_id
   AND rule.revision = quest.practice_rule_revision
  LEFT JOIN growth_focus_selections focus
    ON focus.id = quest.focus_selection_id
   AND focus.growth_cycle_id = cycle.id
  LEFT JOIN growth_gap_hypotheses hypothesis
    ON hypothesis.id = quest.gap_hypothesis_id
   AND hypothesis.growth_cycle_id = cycle.id
  WHERE cycle.id = NEW.growth_cycle_id
    AND rule.status = 'ACTIVE'
    AND NEW.target_horizon_hours = quest.target_retention_horizon_hours
    AND NEW.variant_policy_revision = quest.practice_rule_id || ':' || CAST(quest.practice_rule_revision AS TEXT)
    AND json_extract(rule.rule_json, '$.variant_recheck_policy.kind') = 'VARIANT'
    AND (
      (NEW.outcome IS NULL
        AND NEW.opening_observation_id IS NULL
        AND NEW.recheck_observation_id IS NULL)
      OR (
        quest.focus_selection_id IS NOT NULL
        AND rule.validation_status = 'PROVISIONAL_UNCALIBRATED'
        AND json_extract(rule.rule_json, '$.kind') = 'LEARNER_CHOSEN_FOCUS_PRACTICE'
        AND json_extract(rule.rule_json, '$.outcome') = 'UNKNOWN'
        AND json_extract(rule.rule_json, '$.variant_recheck_policy.outcome') = 'UNKNOWN'
        AND NEW.outcome = 'UNKNOWN'
        AND json_type(rule.rule_json, '$.variant_recheck_policy.prohibits') = 'array'
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'MEASURED')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'IMPROVED')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'NO_CHANGE')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'REGRESSED')
        AND (NEW.opening_observation_id IS NULL OR EXISTS (
          SELECT 1 FROM growth_capability_observations observation
          WHERE observation.id = NEW.opening_observation_id
            AND observation.growth_cycle_id = cycle.id
            AND observation.capability_id = focus.capability_id
            AND observation.capability_revision = focus.capability_revision
        ))
        AND (NEW.recheck_observation_id IS NULL OR EXISTS (
          SELECT 1 FROM growth_capability_observations observation
          WHERE observation.id = NEW.recheck_observation_id
            AND observation.growth_cycle_id = cycle.id
            AND observation.capability_id = focus.capability_id
            AND observation.capability_revision = focus.capability_revision
        ))
      )
      OR (
        NEW.outcome <> 'UNKNOWN'
        AND rule.validation_status = 'VALIDATED'
        AND json_type(rule.rule_json, '$.variant_recheck_policy.permits') = 'array'
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.permits') WHERE value = NEW.outcome)
        AND NEW.opening_observation_id IS NOT NULL
        AND NEW.recheck_observation_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM growth_capability_observations opening
          INNER JOIN growth_capability_observations recheck
            ON recheck.id = NEW.recheck_observation_id
          WHERE opening.id = NEW.opening_observation_id
            AND opening.growth_cycle_id = cycle.id
            AND recheck.growth_cycle_id = cycle.id
            AND opening.capability_id = COALESCE(focus.capability_id, hypothesis.capability_id)
            AND opening.capability_revision = COALESCE(focus.capability_revision, hypothesis.capability_revision)
            AND recheck.capability_id = opening.capability_id
            AND recheck.capability_revision = opening.capability_revision
            AND opening.status = 'MEASURED' AND recheck.status = 'MEASURED'
            AND opening.inference_validation = 'VALIDATED' AND recheck.inference_validation = 'VALIDATED'
            AND opening.rubric_revision_id = recheck.rubric_revision_id
            AND opening.inference_rule_id = recheck.inference_rule_id
            AND opening.inference_rule_revision = recheck.inference_rule_revision
            AND opening.observed_at < recheck.observed_at
            AND opening.id <> recheck.id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_REQUIRES_QUEST_POLICY_LINEAGE');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_quest_policy_update_guard
BEFORE UPDATE ON growth_rechecks
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_practice_quests quest
    ON quest.id = NEW.practice_quest_id
   AND quest.growth_cycle_id = cycle.id
  INNER JOIN growth_practice_rules rule
    ON rule.id = quest.practice_rule_id
   AND rule.revision = quest.practice_rule_revision
  LEFT JOIN growth_focus_selections focus
    ON focus.id = quest.focus_selection_id
   AND focus.growth_cycle_id = cycle.id
  LEFT JOIN growth_gap_hypotheses hypothesis
    ON hypothesis.id = quest.gap_hypothesis_id
   AND hypothesis.growth_cycle_id = cycle.id
  WHERE cycle.id = NEW.growth_cycle_id
    AND rule.status = 'ACTIVE'
    AND NEW.target_horizon_hours = quest.target_retention_horizon_hours
    AND NEW.variant_policy_revision = quest.practice_rule_id || ':' || CAST(quest.practice_rule_revision AS TEXT)
    AND json_extract(rule.rule_json, '$.variant_recheck_policy.kind') = 'VARIANT'
    AND (
      (NEW.outcome IS NULL
        AND NEW.opening_observation_id IS NULL
        AND NEW.recheck_observation_id IS NULL)
      OR (
        quest.focus_selection_id IS NOT NULL
        AND rule.validation_status = 'PROVISIONAL_UNCALIBRATED'
        AND json_extract(rule.rule_json, '$.kind') = 'LEARNER_CHOSEN_FOCUS_PRACTICE'
        AND json_extract(rule.rule_json, '$.outcome') = 'UNKNOWN'
        AND json_extract(rule.rule_json, '$.variant_recheck_policy.outcome') = 'UNKNOWN'
        AND NEW.outcome = 'UNKNOWN'
        AND json_type(rule.rule_json, '$.variant_recheck_policy.prohibits') = 'array'
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'MEASURED')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'IMPROVED')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'NO_CHANGE')
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.prohibits') WHERE value = 'REGRESSED')
        AND (NEW.opening_observation_id IS NULL OR EXISTS (
          SELECT 1 FROM growth_capability_observations observation
          WHERE observation.id = NEW.opening_observation_id
            AND observation.growth_cycle_id = cycle.id
            AND observation.capability_id = focus.capability_id
            AND observation.capability_revision = focus.capability_revision
        ))
        AND (NEW.recheck_observation_id IS NULL OR EXISTS (
          SELECT 1 FROM growth_capability_observations observation
          WHERE observation.id = NEW.recheck_observation_id
            AND observation.growth_cycle_id = cycle.id
            AND observation.capability_id = focus.capability_id
            AND observation.capability_revision = focus.capability_revision
        ))
      )
      OR (
        NEW.outcome <> 'UNKNOWN'
        AND rule.validation_status = 'VALIDATED'
        AND json_type(rule.rule_json, '$.variant_recheck_policy.permits') = 'array'
        AND EXISTS (SELECT 1 FROM json_each(rule.rule_json, '$.variant_recheck_policy.permits') WHERE value = NEW.outcome)
        AND NEW.opening_observation_id IS NOT NULL
        AND NEW.recheck_observation_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM growth_capability_observations opening
          INNER JOIN growth_capability_observations recheck
            ON recheck.id = NEW.recheck_observation_id
          WHERE opening.id = NEW.opening_observation_id
            AND opening.growth_cycle_id = cycle.id
            AND recheck.growth_cycle_id = cycle.id
            AND opening.capability_id = COALESCE(focus.capability_id, hypothesis.capability_id)
            AND opening.capability_revision = COALESCE(focus.capability_revision, hypothesis.capability_revision)
            AND recheck.capability_id = opening.capability_id
            AND recheck.capability_revision = opening.capability_revision
            AND opening.status = 'MEASURED' AND recheck.status = 'MEASURED'
            AND opening.inference_validation = 'VALIDATED' AND recheck.inference_validation = 'VALIDATED'
            AND opening.rubric_revision_id = recheck.rubric_revision_id
            AND opening.inference_rule_id = recheck.inference_rule_id
            AND opening.inference_rule_revision = recheck.inference_rule_revision
            AND opening.observed_at < recheck.observed_at
            AND opening.id <> recheck.id
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_REQUIRES_QUEST_POLICY_LINEAGE');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_and_outcome_guard
BEFORE INSERT ON growth_rechecks
FOR EACH ROW WHEN
  NOT EXISTS (
    SELECT 1
    FROM growth_cycles cycle
    INNER JOIN growth_practice_quests quest ON quest.id = NEW.practice_quest_id
    WHERE cycle.id = NEW.growth_cycle_id
      AND quest.growth_cycle_id = cycle.id
      AND cycle.state = 'PRACTICE_ACCEPTED'
      AND quest.status = 'ACCEPTED'
  )
  OR
  EXISTS (SELECT 1 FROM json_each(NEW.evidence_event_ids_json) WHERE type <> 'text' OR length(value) = 0)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_event_ids_json) evidence
    WHERE NOT EXISTS (SELECT 1 FROM growth_events event WHERE event.id = evidence.value AND event.growth_cycle_id = NEW.growth_cycle_id)
  )
  OR (NEW.outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED') AND (
    json_array_length(NEW.evidence_event_ids_json) = 0
    OR NEW.opening_observation_id IS NULL
    OR NEW.recheck_observation_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM growth_cycles cycle
      INNER JOIN growth_capability_observations opening ON opening.id = NEW.opening_observation_id
      INNER JOIN growth_capability_observations recheck ON recheck.id = NEW.recheck_observation_id
      WHERE cycle.id = NEW.growth_cycle_id
        AND cycle.state = 'RECHECK_SCHEDULED'
        AND opening.growth_cycle_id = cycle.id
        AND recheck.growth_cycle_id = cycle.id
        AND opening.status = 'MEASURED' AND recheck.status = 'MEASURED'
        AND opening.inference_validation = 'VALIDATED' AND recheck.inference_validation = 'VALIDATED'
        AND opening.capability_id = recheck.capability_id
        AND opening.capability_revision = recheck.capability_revision
        AND opening.rubric_revision_id = recheck.rubric_revision_id
        AND opening.inference_rule_id = recheck.inference_rule_id
        AND opening.inference_rule_revision = recheck.inference_rule_revision
        AND opening.observed_at < recheck.observed_at
        AND opening.id <> recheck.id
    )
  ))
  OR NOT EXISTS (
    SELECT 1 FROM growth_cycles cycle
    INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
    WHERE cycle.id = NEW.growth_cycle_id AND receipt.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_NON_UNKNOWN_OUTCOME_REQUIRES_VALIDATED_COMPARISON');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_and_outcome_update_guard
BEFORE UPDATE OF follow_up_origin_kind, follow_up_attempt_id, opening_observation_id,
  recheck_observation_id, evidence_event_ids_json, outcome, recorded_at ON growth_rechecks
FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM json_each(NEW.evidence_event_ids_json) WHERE type <> 'text' OR length(value) = 0)
  OR EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_event_ids_json) evidence
    WHERE NOT EXISTS (SELECT 1 FROM growth_events event WHERE event.id = evidence.value AND event.growth_cycle_id = NEW.growth_cycle_id)
  )
  OR (NEW.outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED') AND (
    json_array_length(NEW.evidence_event_ids_json) = 0
    OR NEW.opening_observation_id IS NULL
    OR NEW.recheck_observation_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM growth_cycles cycle
      INNER JOIN growth_capability_observations opening ON opening.id = NEW.opening_observation_id
      INNER JOIN growth_capability_observations recheck ON recheck.id = NEW.recheck_observation_id
      WHERE cycle.id = NEW.growth_cycle_id
        AND cycle.state = 'RECHECK_SCHEDULED'
        AND opening.growth_cycle_id = cycle.id
        AND recheck.growth_cycle_id = cycle.id
        AND opening.status = 'MEASURED' AND recheck.status = 'MEASURED'
        AND opening.inference_validation = 'VALIDATED' AND recheck.inference_validation = 'VALIDATED'
        AND opening.capability_id = recheck.capability_id
        AND opening.capability_revision = recheck.capability_revision
        AND opening.rubric_revision_id = recheck.rubric_revision_id
        AND opening.inference_rule_id = recheck.inference_rule_id
        AND opening.inference_rule_revision = recheck.inference_rule_revision
        AND opening.observed_at < recheck.observed_at
        AND opening.id <> recheck.id
    )
  ))
  OR NOT EXISTS (
    SELECT 1 FROM growth_cycles cycle
    INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
    WHERE cycle.id = NEW.growth_cycle_id AND receipt.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_NON_UNKNOWN_OUTCOME_REQUIRES_VALIDATED_COMPARISON');
END;

CREATE TRIGGER IF NOT EXISTS growth_rechecks_active_consent_all_update_guard
BEFORE UPDATE ON growth_rechecks
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
  WHERE cycle.id = OLD.growth_cycle_id AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_ACTIVE_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_rechecks_controlled_delete_only
BEFORE DELETE ON growth_rechecks
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_recheck_evidence (
  growth_recheck_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (growth_recheck_id, event_id),
  FOREIGN KEY (growth_recheck_id) REFERENCES growth_rechecks(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES growth_events(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_scope_guard
BEFORE INSERT ON growth_recheck_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_rechecks recheck
  INNER JOIN growth_events event ON event.id = NEW.event_id
  WHERE recheck.id = NEW.growth_recheck_id
    AND event.growth_cycle_id = recheck.growth_cycle_id
    AND EXISTS (SELECT 1 FROM growth_cycles cycle INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id WHERE cycle.id = recheck.growth_cycle_id AND receipt.revoked_at IS NULL)
    AND EXISTS (SELECT 1 FROM json_each(recheck.evidence_event_ids_json) WHERE value = NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_materialize
AFTER INSERT ON growth_rechecks
FOR EACH ROW
BEGIN
  INSERT INTO growth_recheck_evidence (growth_recheck_id, event_id, created_at)
  SELECT NEW.id, value, NEW.created_at FROM json_each(NEW.evidence_event_ids_json);
  SELECT CASE WHEN (SELECT count(*) FROM growth_recheck_evidence WHERE growth_recheck_id = NEW.id)
    <> json_array_length(NEW.evidence_event_ids_json)
    THEN RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_INCOMPLETE') END;
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_manifest_immutable
BEFORE UPDATE OF evidence_event_ids_json ON growth_rechecks
FOR EACH ROW WHEN json_array_length(OLD.evidence_event_ids_json) > 0
  AND NEW.evidence_event_ids_json IS NOT OLD.evidence_event_ids_json
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_materialize_on_record
AFTER UPDATE OF evidence_event_ids_json ON growth_rechecks
FOR EACH ROW WHEN json_array_length(OLD.evidence_event_ids_json) = 0
  AND json_array_length(NEW.evidence_event_ids_json) > 0
BEGIN
  INSERT INTO growth_recheck_evidence (growth_recheck_id, event_id, created_at)
  SELECT NEW.id, value, NEW.recorded_at FROM json_each(NEW.evidence_event_ids_json);
  SELECT CASE WHEN (SELECT count(*) FROM growth_recheck_evidence WHERE growth_recheck_id = NEW.id)
    <> json_array_length(NEW.evidence_event_ids_json)
    THEN RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_INCOMPLETE') END;
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_immutable_update
BEFORE UPDATE ON growth_recheck_evidence
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_recheck_evidence_controlled_delete_only
BEFORE DELETE ON growth_recheck_evidence
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_rechecks recheck
  INNER JOIN growth_deletion_context context ON context.growth_cycle_id = recheck.growth_cycle_id
  WHERE recheck.id = OLD.growth_recheck_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_RECHECK_EVIDENCE_IMMUTABLE');
END;

CREATE TABLE IF NOT EXISTS growth_deletion_context (
  growth_cycle_id TEXT PRIMARY KEY,
  requested_by_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  route_action TEXT NOT NULL CHECK (route_action = 'DELETE_GROWTH_CYCLE'),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  expected_aggregate_revision INTEGER NOT NULL CHECK (expected_aggregate_revision >= 1),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  idempotency_lookup_digest TEXT NOT NULL CHECK (length(idempotency_lookup_digest) = 64),
  deletion_receipt_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('OWNER_REQUESTED')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (deletion_receipt_id) REFERENCES growth_deletion_receipts(id) ON DELETE RESTRICT,
  UNIQUE(requested_by_user_id, route_action, idempotency_key),
  UNIQUE(idempotency_lookup_digest)
);

CREATE TABLE IF NOT EXISTS growth_deletion_receipts (
  id TEXT PRIMARY KEY,
  idempotency_lookup_digest TEXT NOT NULL UNIQUE CHECK (length(idempotency_lookup_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  completed_at INTEGER,
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  created_at INTEGER NOT NULL
);

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

CREATE TRIGGER IF NOT EXISTS growth_deletion_receipts_completion_once
BEFORE UPDATE ON growth_deletion_receipts
FOR EACH ROW WHEN NEW.id IS NOT OLD.id
  OR NEW.idempotency_lookup_digest IS NOT OLD.idempotency_lookup_digest
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.completed_at IS NOT NULL
  OR NEW.completed_at IS NULL
  OR NEW.completed_at < OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_deletion_receipts_no_delete
BEFORE DELETE ON growth_deletion_receipts
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_deletion_context_owner_guard
BEFORE INSERT ON growth_deletion_context
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_spaces space ON space.id = cycle.space_id
  INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
  WHERE cycle.id = NEW.growth_cycle_id
    AND space.host_user_id = NEW.requested_by_user_id
    AND membership.user_id = NEW.requested_by_user_id
    AND membership.role = 'HOST'
    AND membership.status = 'ACTIVE'
    AND cycle.aggregate_revision = NEW.expected_aggregate_revision
    AND EXISTS (
      SELECT 1
      FROM growth_deletion_receipts receipt
      WHERE receipt.id = NEW.deletion_receipt_id
        AND receipt.idempotency_lookup_digest = NEW.idempotency_lookup_digest
        AND receipt.request_digest = NEW.request_digest
        AND receipt.completed_at IS NULL
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_REQUIRES_PRIVATE_SOLO_OWNER');
END;

CREATE TRIGGER IF NOT EXISTS growth_deletion_context_immutable_update
BEFORE UPDATE ON growth_deletion_context
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_CONTEXT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_deletion_context_single_use_delete
BEFORE DELETE ON growth_deletion_context
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM growth_cycles cycle WHERE cycle.id = OLD.growth_cycle_id)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_DELETION_CONTEXT_SINGLE_USE');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_controlled_delete_only
BEFORE DELETE ON growth_cycles
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context
  WHERE context.growth_cycle_id = OLD.id
    AND context.expected_aggregate_revision = OLD.aggregate_revision
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_CONTROLLED_DELETION_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_clear_deletion_context
AFTER DELETE ON growth_cycles
FOR EACH ROW
BEGIN
  UPDATE growth_deletion_receipts
  SET completed_at = strftime('%s', 'now') * 1000
  WHERE id = (SELECT deletion_receipt_id FROM growth_deletion_context WHERE growth_cycle_id = OLD.id);
  DELETE FROM growth_deletion_context WHERE growth_cycle_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_retain_resurrection_barrier
BEFORE DELETE ON growth_cycles
FOR EACH ROW
BEGIN
  INSERT INTO growth_cycle_resurrection_tombstones (
    origin_lookup_digest, origin_request_digest, deletion_policy_revision, deleted_at, created_at
  ) VALUES (
    OLD.origin_lookup_digest, OLD.origin_request_digest,
    (SELECT policy_revision FROM growth_deletion_receipts WHERE id = (SELECT deletion_receipt_id FROM growth_deletion_context WHERE growth_cycle_id = OLD.id)),
    strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000
  );
END;

CREATE TABLE IF NOT EXISTS growth_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  growth_cycle_id TEXT,
  actor_membership_id TEXT,
  actor_pseudonym_id TEXT NOT NULL CHECK (length(trim(actor_pseudonym_id)) > 0),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  object_type TEXT NOT NULL CHECK (object_type IN ('GROWTH_CYCLE', 'OBSERVATION', 'GAP_HYPOTHESIS', 'FOCUS_SELECTION', 'PRACTICE_QUEST', 'RECHECK')),
  object_id TEXT NOT NULL,
  object_revision INTEGER NOT NULL CHECK (object_revision >= 1),
  lifecycle_action TEXT,
  previous_state TEXT,
  next_state TEXT,
  transition_subject_type TEXT CHECK (transition_subject_type IS NULL OR transition_subject_type IN ('GAP_HYPOTHESIS', 'FOCUS_SELECTION', 'PRACTICE_QUEST', 'RECHECK')),
  transition_subject_id TEXT,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  source_system TEXT NOT NULL CHECK (length(trim(source_system)) > 0),
  source_event_id TEXT NOT NULL CHECK (length(trim(source_event_id)) > 0),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  mutation_receipt_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility = 'PRIVATE'),
  consent_receipt_id TEXT NOT NULL,
  FOREIGN KEY (space_id) REFERENCES growth_spaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_membership_id) REFERENCES growth_space_memberships(id) ON DELETE RESTRICT,
  FOREIGN KEY (consent_receipt_id) REFERENCES growth_private_consent_receipts(id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_receipt_id) REFERENCES growth_mutation_receipts(id) ON DELETE CASCADE,
  UNIQUE(source_system, source_event_id),
  CHECK (
    (object_type = 'GROWTH_CYCLE' AND growth_cycle_id IS NOT NULL AND object_id = growth_cycle_id
      AND lifecycle_action IS NOT NULL AND previous_state IS NOT NULL AND next_state IS NOT NULL)
    OR (object_type <> 'GROWTH_CYCLE' AND lifecycle_action IS NULL AND previous_state IS NULL AND next_state IS NULL
      AND transition_subject_type IS NULL AND transition_subject_id IS NULL)
  ),
  CHECK ((transition_subject_type IS NULL AND transition_subject_id IS NULL)
    OR (transition_subject_type IS NOT NULL AND transition_subject_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_growth_events_cycle_revision
  ON growth_events(growth_cycle_id, object_revision, recorded_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_events_one_lifecycle_event_per_revision
  ON growth_events(growth_cycle_id, object_revision)
  WHERE object_type = 'GROWTH_CYCLE';

CREATE TRIGGER IF NOT EXISTS growth_event_private_actor_consent_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_private_consent_receipts receipt
  WHERE receipt.id = NEW.consent_receipt_id AND receipt.revoked_at IS NULL
)
  OR (NEW.actor_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM growth_space_memberships membership
    WHERE membership.id = NEW.actor_membership_id AND membership.space_id = NEW.space_id
      AND membership.pseudonym_id = NEW.actor_pseudonym_id AND membership.status = 'ACTIVE'
  ))
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_PRIVATE_ACTOR_OR_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_cycle_scope_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NEW.growth_cycle_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM growth_cycles cycle
  WHERE cycle.id = NEW.growth_cycle_id
    AND cycle.space_id = NEW.space_id
    AND cycle.consent_receipt_id = NEW.consent_receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_CYCLE_SCOPE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_lifecycle_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NEW.object_type = 'GROWTH_CYCLE' AND NOT EXISTS (
  SELECT 1
  FROM growth_cycles cycle
  INNER JOIN growth_lifecycle_transitions transition
    ON transition.from_state = NEW.previous_state
   AND transition.action = NEW.lifecycle_action
   AND transition.to_state = NEW.next_state
   AND transition.event_type = NEW.event_type
  WHERE cycle.id = NEW.growth_cycle_id
    AND cycle.state = NEW.previous_state
    AND NEW.object_revision = cycle.aggregate_revision + 1
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_INVALID_LIFECYCLE_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_mutation_receipt_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN
  (NEW.object_type = 'GROWTH_CYCLE' AND NOT EXISTS (
    SELECT 1
    FROM growth_mutation_receipts receipt
    INNER JOIN growth_lifecycle_transitions transition
      ON transition.from_state = NEW.previous_state
     AND transition.action = NEW.lifecycle_action
     AND transition.to_state = NEW.next_state
     AND transition.event_type = NEW.event_type
    INNER JOIN growth_cycles cycle ON cycle.id = NEW.growth_cycle_id
    INNER JOIN growth_space_memberships participant ON participant.id = cycle.participant_membership_id
    WHERE receipt.id = NEW.mutation_receipt_id
      AND receipt.growth_cycle_id = NEW.growth_cycle_id
      AND receipt.expected_aggregate_revision = NEW.object_revision - 1
      AND receipt.lifecycle_action IS NEW.lifecycle_action
      AND receipt.route_action = transition.route_action
      AND receipt.actor_user_id = participant.user_id
      AND (
        (transition.actor_class = 'SYSTEM' AND NEW.actor_membership_id IS NULL AND NEW.actor_pseudonym_id = 'system:growth-cycle')
        OR (transition.actor_class = 'PARTICIPANT' AND NEW.actor_membership_id = cycle.participant_membership_id)
      )
  ))
  OR
  (NEW.object_type <> 'GROWTH_CYCLE' AND NOT EXISTS (
    SELECT 1
    FROM growth_mutation_receipts receipt
    INNER JOIN growth_cycles cycle ON cycle.id = NEW.growth_cycle_id
    INNER JOIN growth_space_memberships participant ON participant.id = cycle.participant_membership_id
    WHERE receipt.id = NEW.mutation_receipt_id
      AND receipt.growth_cycle_id = NEW.growth_cycle_id
      AND receipt.expected_aggregate_revision = cycle.aggregate_revision
      AND receipt.lifecycle_action IS NEW.lifecycle_action
      AND receipt.actor_user_id = participant.user_id
      AND NEW.actor_membership_id = cycle.participant_membership_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_MUTATION_RECEIPT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_transition_subject_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NEW.object_type = 'GROWTH_CYCLE' AND (
  (NEW.event_type IN ('GAP_PROPOSED', 'GAP_REMAINS_UNKNOWN', 'GAP_REVISED', 'GAP_ACCEPTED', 'GAP_CONTESTED', 'GAP_DISMISSED', 'GAP_DEFERRED', 'GAP_RESUMED') AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.id = NEW.transition_subject_id
      AND hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND NEW.transition_subject_type = 'GAP_HYPOTHESIS'
  ))
  OR
  (NEW.event_type IN ('FOCUS_SELECTED', 'FOCUS_REVISED', 'PRACTICE_UNAVAILABLE') AND NOT EXISTS (
    SELECT 1 FROM growth_focus_selections focus
    WHERE focus.id = NEW.transition_subject_id
      AND focus.growth_cycle_id = NEW.growth_cycle_id
      AND NEW.transition_subject_type = 'FOCUS_SELECTION'
  ))
  OR
  (NEW.event_type IN ('PRACTICE_OFFERED', 'PRACTICE_ACCEPTED', 'PRACTICE_DECLINED', 'PRACTICE_DEFERRED', 'PRACTICE_RESUMED') AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.id = NEW.transition_subject_id
      AND quest.growth_cycle_id = NEW.growth_cycle_id
      AND NEW.transition_subject_type = 'PRACTICE_QUEST'
  ))
  OR
  (NEW.event_type IN ('RECHECK_SCHEDULED', 'RECHECK_RECORDED', 'RECHECK_RESCHEDULED', 'RECHECK_OUTCOME_RECORDED') AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.id = NEW.transition_subject_id
      AND recheck.growth_cycle_id = NEW.growth_cycle_id
      AND NEW.transition_subject_type = 'RECHECK'
  ))
  OR
  (NEW.event_type = 'TRANSFER_OUTCOME_RECORDED')
  OR
  (NEW.event_type NOT IN ('GAP_PROPOSED', 'GAP_REMAINS_UNKNOWN', 'GAP_REVISED', 'GAP_ACCEPTED', 'GAP_CONTESTED', 'GAP_DISMISSED', 'GAP_DEFERRED', 'GAP_RESUMED', 'FOCUS_SELECTED', 'FOCUS_REVISED', 'PRACTICE_UNAVAILABLE', 'PRACTICE_OFFERED', 'PRACTICE_ACCEPTED', 'PRACTICE_DECLINED', 'PRACTICE_DEFERRED', 'PRACTICE_RESUMED', 'RECHECK_SCHEDULED', 'RECHECK_RECORDED', 'RECHECK_RESCHEDULED', 'RECHECK_OUTCOME_RECORDED')
    AND (NEW.transition_subject_type IS NOT NULL OR NEW.transition_subject_id IS NOT NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_transition_subject_lineage_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NEW.object_type = 'GROWTH_CYCLE' AND (
  (NEW.event_type = 'GAP_PROPOSED' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_capability_observations observation ON observation.id = hypothesis.observation_id
    WHERE hypothesis.id = NEW.transition_subject_id
      AND hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND hypothesis.state = 'PROPOSED'
      AND observation.growth_cycle_id = hypothesis.growth_cycle_id
      AND observation.status = 'MEASURED'
      AND observation.inference_validation = 'VALIDATED'
      AND json_array_length(observation.evidence_event_ids_json) > 0
      AND EXISTS (SELECT 1 FROM growth_observation_evidence evidence WHERE evidence.observation_id = observation.id)
      AND json_array_length(hypothesis.supporting_event_ids_json) > 0
      AND EXISTS (SELECT 1 FROM growth_gap_hypothesis_evidence evidence WHERE evidence.gap_hypothesis_id = hypothesis.id AND evidence.evidence_role = 'SUPPORTING')
  ))
  OR
  (NEW.event_type = 'GAP_REMAINS_UNKNOWN' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_capability_observations observation ON observation.id = hypothesis.observation_id
    WHERE hypothesis.id = NEW.transition_subject_id
      AND hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND hypothesis.state = 'UNKNOWN'
      AND observation.growth_cycle_id = hypothesis.growth_cycle_id
      AND observation.status = 'UNKNOWN'
      AND json_array_length(observation.evidence_event_ids_json) > 0
      AND EXISTS (
        SELECT 1
        FROM growth_observation_evidence link
        INNER JOIN growth_events raw ON raw.id = link.event_id
        WHERE link.observation_id = observation.id
          AND raw.growth_cycle_id = hypothesis.growth_cycle_id
          AND raw.object_type <> 'GROWTH_CYCLE'
      )
  ))
  OR
  (NEW.event_type IN ('GAP_ACCEPTED', 'GAP_CONTESTED', 'GAP_DISMISSED', 'GAP_DEFERRED') AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_events proposed ON proposed.growth_cycle_id = hypothesis.growth_cycle_id
      AND proposed.event_type IN ('GAP_PROPOSED', 'GAP_REVISED', 'GAP_RESUMED')
      AND proposed.transition_subject_type = 'GAP_HYPOTHESIS'
      AND proposed.transition_subject_id = hypothesis.id
    WHERE hypothesis.id = NEW.transition_subject_id
      AND hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND ((NEW.event_type = 'GAP_ACCEPTED' AND hypothesis.state = 'ACCEPTED')
        OR (NEW.event_type = 'GAP_CONTESTED' AND hypothesis.state = 'CONTESTED' AND length(trim(COALESCE(hypothesis.participant_rationale, ''))) > 0)
        OR (NEW.event_type = 'GAP_DISMISSED' AND hypothesis.state = 'DISMISSED')
        OR (NEW.event_type = 'GAP_DEFERRED' AND hypothesis.state = 'DEFERRED'))
  ))
  OR
  (NEW.event_type = 'GAP_REVISED' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses revised
    INNER JOIN growth_gap_hypotheses contested ON contested.id = revised.revises_hypothesis_id
    INNER JOIN growth_events prior ON prior.growth_cycle_id = revised.growth_cycle_id
      AND prior.event_type = 'GAP_CONTESTED'
      AND prior.transition_subject_type = 'GAP_HYPOTHESIS'
      AND prior.transition_subject_id = contested.id
    WHERE revised.id = NEW.transition_subject_id
      AND revised.growth_cycle_id = NEW.growth_cycle_id
      AND revised.state = 'PROPOSED'
      AND contested.state = 'CONTESTED'
  ))
  OR
  (NEW.event_type = 'GAP_RESUMED' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses resumed
    INNER JOIN growth_gap_hypotheses deferred ON deferred.id = resumed.revises_hypothesis_id
    INNER JOIN growth_events prior ON prior.growth_cycle_id = resumed.growth_cycle_id
      AND prior.event_type = 'GAP_DEFERRED'
      AND prior.transition_subject_type = 'GAP_HYPOTHESIS'
      AND prior.transition_subject_id = deferred.id
    WHERE resumed.id = NEW.transition_subject_id
      AND resumed.growth_cycle_id = NEW.growth_cycle_id
      AND resumed.state = 'PROPOSED'
      AND deferred.state = 'DEFERRED'
  ))
  OR
  (NEW.event_type = 'PRACTICE_OFFERED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.id = NEW.transition_subject_id
      AND quest.growth_cycle_id = NEW.growth_cycle_id
      AND quest.status = 'OFFERED'
  ))
  OR
  (NEW.event_type IN ('PRACTICE_ACCEPTED', 'PRACTICE_DECLINED', 'PRACTICE_DEFERRED') AND NOT EXISTS (
    SELECT 1
    FROM growth_practice_quests quest
    INNER JOIN growth_events offered ON offered.growth_cycle_id = quest.growth_cycle_id
      AND offered.event_type IN ('PRACTICE_OFFERED', 'PRACTICE_RESUMED')
      AND offered.transition_subject_type = 'PRACTICE_QUEST'
      AND offered.transition_subject_id = quest.id
    WHERE quest.id = NEW.transition_subject_id
      AND ((NEW.event_type = 'PRACTICE_ACCEPTED' AND quest.status = 'ACCEPTED')
        OR (NEW.event_type = 'PRACTICE_DECLINED' AND quest.status = 'DECLINED')
        OR (NEW.event_type = 'PRACTICE_DEFERRED' AND quest.status = 'DEFERRED'))
  ))
  OR
  (NEW.event_type = 'PRACTICE_RESUMED' AND NOT EXISTS (
    SELECT 1
    FROM growth_practice_quests quest
    INNER JOIN growth_events deferred ON deferred.growth_cycle_id = quest.growth_cycle_id
      AND deferred.event_type = 'PRACTICE_DEFERRED'
      AND deferred.transition_subject_type = 'PRACTICE_QUEST'
      AND deferred.transition_subject_id = quest.id
    WHERE quest.id = NEW.transition_subject_id AND quest.status = 'OFFERED'
  ))
  OR
  (NEW.event_type = 'RECHECK_SCHEDULED' AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.id = NEW.transition_subject_id
      AND recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.recorded_at IS NULL
  ))
  OR
  (NEW.event_type IN ('RECHECK_RECORDED', 'RECHECK_RESCHEDULED') AND NOT EXISTS (
    SELECT 1
    FROM growth_rechecks recheck
    INNER JOIN growth_events prior ON prior.growth_cycle_id = recheck.growth_cycle_id
      AND prior.event_type IN ('RECHECK_SCHEDULED', 'RECHECK_RESCHEDULED')
      AND prior.transition_subject_type = 'RECHECK'
      AND prior.transition_subject_id = recheck.id
    WHERE recheck.id = NEW.transition_subject_id
      AND ((NEW.event_type = 'RECHECK_RECORDED' AND recheck.recorded_at IS NOT NULL
          AND json_array_length(recheck.evidence_event_ids_json) > 0
          AND EXISTS (SELECT 1 FROM growth_recheck_evidence evidence WHERE evidence.growth_recheck_id = recheck.id))
        OR (NEW.event_type = 'RECHECK_RESCHEDULED' AND recheck.recorded_at IS NULL))
  ))
  OR
  (NEW.event_type = 'RECHECK_OUTCOME_RECORDED' AND NOT EXISTS (
    SELECT 1
    FROM growth_rechecks recheck
    INNER JOIN growth_events recorded ON recorded.growth_cycle_id = recheck.growth_cycle_id
      AND recorded.event_type = 'RECHECK_RECORDED'
      AND recorded.transition_subject_type = 'RECHECK'
      AND recorded.transition_subject_id = recheck.id
    WHERE recheck.id = NEW.transition_subject_id
      AND recheck.outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED')
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_LINEAGE_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_actor_and_object_preconditions
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN
  (NEW.event_type = 'GAP_PROPOSED' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_capability_observations observation ON observation.id = hypothesis.observation_id
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND hypothesis.state = 'PROPOSED'
      AND observation.growth_cycle_id = hypothesis.growth_cycle_id
      AND observation.status = 'MEASURED'
      AND observation.inference_validation = 'VALIDATED'
  ))
  OR
  (NEW.event_type = 'GAP_REMAINS_UNKNOWN' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_capability_observations observation ON observation.id = hypothesis.observation_id
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND hypothesis.state = 'UNKNOWN'
      AND observation.growth_cycle_id = hypothesis.growth_cycle_id
      AND observation.status = 'UNKNOWN'
  ))
  OR
  (NEW.event_type = 'GAP_REVISED' AND NOT EXISTS (
    SELECT 1
    FROM growth_gap_hypotheses hypothesis
    INNER JOIN growth_capability_observations observation ON observation.id = hypothesis.observation_id
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id
      AND hypothesis.state = 'PROPOSED'
      AND observation.growth_cycle_id = hypothesis.growth_cycle_id
      AND observation.status = 'MEASURED'
      AND observation.inference_validation = 'VALIDATED'
  ))
  OR
  (NEW.event_type = 'GAP_ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id AND hypothesis.state = 'ACCEPTED'
  ))
  OR
  (NEW.event_type = 'GAP_CONTESTED' AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id AND hypothesis.state = 'CONTESTED'
  ))
  OR
  (NEW.event_type = 'GAP_DISMISSED' AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id AND hypothesis.state = 'DISMISSED'
  ))
  OR
  (NEW.event_type = 'GAP_DEFERRED' AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id AND hypothesis.state = 'DEFERRED'
  ))
  OR
  (NEW.event_type = 'GAP_RESUMED' AND NOT EXISTS (
    SELECT 1 FROM growth_gap_hypotheses hypothesis
    WHERE hypothesis.growth_cycle_id = NEW.growth_cycle_id AND hypothesis.state = 'PROPOSED'
  ))
  OR
  (NEW.event_type = 'FOCUS_SELECTED' AND NOT EXISTS (
    SELECT 1 FROM growth_focus_selections focus
    WHERE focus.growth_cycle_id = NEW.growth_cycle_id AND focus.selection_kind = 'INITIAL'
  ))
  OR
  (NEW.event_type = 'FOCUS_REVISED' AND NOT EXISTS (
    SELECT 1 FROM growth_focus_selections focus
    WHERE focus.growth_cycle_id = NEW.growth_cycle_id AND focus.selection_kind = 'REVISION'
  ))
  OR
  (NEW.event_type = 'PRACTICE_OFFERED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.growth_cycle_id = NEW.growth_cycle_id AND quest.status = 'OFFERED'
  ))
  OR
  (NEW.event_type = 'PRACTICE_ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.growth_cycle_id = NEW.growth_cycle_id AND quest.status = 'ACCEPTED'
  ))
  OR
  (NEW.event_type = 'PRACTICE_DECLINED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.growth_cycle_id = NEW.growth_cycle_id AND quest.status = 'DECLINED'
  ))
  OR
  (NEW.event_type = 'PRACTICE_DEFERRED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.growth_cycle_id = NEW.growth_cycle_id AND quest.status = 'DEFERRED'
  ))
  OR
  (NEW.event_type = 'PRACTICE_RESUMED' AND NOT EXISTS (
    SELECT 1 FROM growth_practice_quests quest
    WHERE quest.growth_cycle_id = NEW.growth_cycle_id AND quest.status = 'OFFERED'
  ))
  OR
  (NEW.event_type = 'RECHECK_SCHEDULED' AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.recorded_at IS NULL
  ))
  OR
  (NEW.event_type = 'RECHECK_RECORDED' AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.recorded_at IS NOT NULL
      AND json_array_length(recheck.evidence_event_ids_json) > 0
      AND EXISTS (
        SELECT 1 FROM growth_recheck_evidence evidence
        WHERE evidence.growth_recheck_id = recheck.id
      )
  ))
  OR
  (NEW.event_type = 'RECHECK_RESCHEDULED' AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.recorded_at IS NULL
  ))
  OR
  (NEW.event_type = 'RECHECK_OUTCOME_RECORDED' AND NOT EXISTS (
    SELECT 1
    FROM growth_rechecks recheck
    INNER JOIN growth_capability_observations opening ON opening.id = recheck.opening_observation_id
    INNER JOIN growth_capability_observations follow_up ON follow_up.id = recheck.recheck_observation_id
    WHERE recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED')
      AND opening.growth_cycle_id = recheck.growth_cycle_id
      AND follow_up.growth_cycle_id = recheck.growth_cycle_id
      AND opening.status = 'MEASURED'
      AND follow_up.status = 'MEASURED'
      AND opening.inference_validation = 'VALIDATED'
      AND follow_up.inference_validation = 'VALIDATED'
      AND opening.id <> follow_up.id
      AND opening.observed_at < follow_up.observed_at
  ))
  OR
  (NEW.event_type = 'TRANSFER_OUTCOME_RECORDED' AND NOT EXISTS (
    SELECT 1 FROM growth_rechecks recheck
    WHERE recheck.growth_cycle_id = NEW.growth_cycle_id
      AND recheck.outcome IN ('IMPROVED', 'NO_CHANGE', 'REGRESSED')
      AND json_array_length(recheck.evidence_event_ids_json) > 0
      AND EXISTS (
        SELECT 1 FROM growth_recheck_evidence evidence
        WHERE evidence.growth_recheck_id = recheck.id
      )
  ))
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_ACTOR_OR_OBJECT_PRECONDITION_FAILED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_transfer_outcome_unavailable_guard
BEFORE INSERT ON growth_events
FOR EACH ROW WHEN NEW.event_type = 'TRANSFER_OUTCOME_RECORDED'
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_TRANSFER_OUTCOME_UNAVAILABLE_IN_FOUNDATION');
END;

CREATE TRIGGER IF NOT EXISTS growth_events_immutable_update
BEFORE UPDATE ON growth_events
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_events_controlled_delete_only
BEFORE DELETE ON growth_events
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_CONTROLLED_DELETION_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_applies_cycle_transition
AFTER INSERT ON growth_events
FOR EACH ROW WHEN NEW.object_type = 'GROWTH_CYCLE'
BEGIN
  UPDATE growth_cycles
  SET state = NEW.next_state,
      aggregate_revision = NEW.object_revision,
      updated_at = NEW.recorded_at,
      closed_at = CASE WHEN NEW.next_state = 'CLOSED' THEN NEW.occurred_at ELSE NULL END
  WHERE id = NEW.growth_cycle_id;
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_lifecycle_update_guard
BEFORE UPDATE OF state, aggregate_revision, closed_at ON growth_cycles
FOR EACH ROW WHEN
  NEW.aggregate_revision <> OLD.aggregate_revision + 1
  OR NOT EXISTS (
    SELECT 1
    FROM growth_events event
    WHERE event.growth_cycle_id = OLD.id
      AND event.object_type = 'GROWTH_CYCLE'
      AND event.object_revision = NEW.aggregate_revision
      AND event.previous_state = OLD.state
      AND event.next_state = NEW.state
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_REQUIRES_VALIDATED_EVENT_TRANSITION');
END;

CREATE TRIGGER IF NOT EXISTS growth_cycles_active_consent_non_deletion_update_guard
BEFORE UPDATE ON growth_cycles
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_private_consent_receipts receipt
  WHERE receipt.id = OLD.consent_receipt_id AND receipt.revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_CYCLE_ACTIVE_CONSENT_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS growth_mutation_receipts (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  route_action TEXT NOT NULL CHECK (length(trim(route_action)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  growth_cycle_id TEXT,
  expected_aggregate_revision INTEGER NOT NULL CHECK (expected_aggregate_revision >= 0),
  lifecycle_action TEXT,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  response_digest TEXT NOT NULL CHECK (length(response_digest) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  result_resource_type TEXT NOT NULL CHECK (result_resource_type IN ('CONSENT_RECEIPT', 'GROWTH_SPACE', 'GROWTH_CYCLE', 'GROWTH_DELETION_RECEIPT')),
  result_resource_id TEXT NOT NULL CHECK (length(trim(result_resource_id)) > 0),
  result_aggregate_revision INTEGER NOT NULL CHECK (result_aggregate_revision >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (growth_cycle_id) REFERENCES growth_cycles(id) ON DELETE CASCADE,
  UNIQUE(actor_user_id, route_action, idempotency_key),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (growth_cycle_id IS NULL
      AND expected_aggregate_revision = 0
      AND lifecycle_action IS NULL
      AND (
        (route_action = 'POST:/api/growth/privacy/consent' AND result_resource_type = 'CONSENT_RECEIPT')
        OR (route_action = 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke' AND result_resource_type = 'CONSENT_RECEIPT')
        OR (route_action = 'POST:/api/growth/spaces/solo' AND result_resource_type = 'GROWTH_SPACE')
      ))
    OR
    (growth_cycle_id IS NOT NULL
      AND (
        (result_resource_type = 'GROWTH_CYCLE' AND result_resource_id = growth_cycle_id)
        OR result_resource_type = 'GROWTH_DELETION_RECEIPT'
      ))
  )
);

CREATE INDEX IF NOT EXISTS idx_growth_mutation_receipts_cycle
  ON growth_mutation_receipts(growth_cycle_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_consent_guard
BEFORE INSERT ON growth_mutation_receipts
FOR EACH ROW WHEN NEW.route_action NOT IN ('POST:/api/growth/privacy/consent', 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke', 'POST:/api/growth/spaces/solo', 'DELETE_GROWTH_CYCLE')
  AND NOT EXISTS (
    SELECT 1 FROM growth_private_consent_receipts receipt
    WHERE receipt.subject_user_id = NEW.actor_user_id AND receipt.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_ACTIVE_CONSENT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_precycle_scope_guard
BEFORE INSERT ON growth_mutation_receipts
FOR EACH ROW WHEN
  (NEW.growth_cycle_id IS NULL AND NEW.route_action NOT IN ('POST:/api/growth/privacy/consent', 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke', 'POST:/api/growth/spaces/solo'))
  OR (NEW.growth_cycle_id IS NOT NULL AND NEW.route_action IN ('POST:/api/growth/privacy/consent', 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke', 'POST:/api/growth/spaces/solo'))
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_PRE_CYCLE_SCOPE_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_precycle_result_guard
BEFORE INSERT ON growth_mutation_receipts
FOR EACH ROW WHEN NEW.growth_cycle_id IS NULL AND NOT (
  (NEW.route_action = 'POST:/api/growth/privacy/consent'
    AND NEW.result_resource_type = 'CONSENT_RECEIPT'
    AND EXISTS (
      SELECT 1
      FROM growth_private_consent_receipts consent
      WHERE consent.id = NEW.result_resource_id
        AND consent.subject_user_id = NEW.actor_user_id
        AND consent.policy_revision = NEW.result_aggregate_revision
    ))
  OR
  (NEW.route_action = 'POST:/api/growth/privacy/consent/:consentReceiptId/revoke'
    AND NEW.result_resource_type = 'CONSENT_RECEIPT'
    AND EXISTS (
      SELECT 1
      FROM growth_private_consent_receipts consent
      WHERE consent.id = NEW.result_resource_id
        AND consent.subject_user_id = NEW.actor_user_id
        AND consent.policy_revision = NEW.result_aggregate_revision
        AND consent.revoked_at IS NOT NULL
    ))
  OR
  (NEW.route_action = 'POST:/api/growth/spaces/solo'
    AND NEW.result_resource_type = 'GROWTH_SPACE'
    AND EXISTS (
      SELECT 1
      FROM growth_spaces space
      WHERE space.id = NEW.result_resource_id
        AND space.host_user_id = NEW.actor_user_id
        AND space.space_type = 'SOLO'
        AND space.status = 'ACTIVE'
        AND space.aggregate_revision = NEW.result_aggregate_revision
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_PRE_CYCLE_RESULT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_cycle_owner_guard
BEFORE INSERT ON growth_mutation_receipts
FOR EACH ROW WHEN NEW.growth_cycle_id IS NOT NULL
  AND NEW.route_action <> 'DELETE_GROWTH_CYCLE'
  AND NOT EXISTS (
    SELECT 1
    FROM growth_cycles cycle
    INNER JOIN growth_space_memberships membership ON membership.id = cycle.participant_membership_id
    INNER JOIN growth_private_consent_receipts receipt ON receipt.id = cycle.consent_receipt_id
    WHERE cycle.id = NEW.growth_cycle_id
      AND membership.user_id = NEW.actor_user_id
      AND membership.status = 'ACTIVE'
      AND receipt.revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_CYCLE_OWNER_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_immutable_update
BEFORE UPDATE ON growth_mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_controlled_delete_only
BEFORE DELETE ON growth_mutation_receipts
FOR EACH ROW WHEN OLD.growth_cycle_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM growth_deletion_context context WHERE context.growth_cycle_id = OLD.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_precycle_immutable_delete
BEFORE DELETE ON growth_mutation_receipts
FOR EACH ROW WHEN OLD.growth_cycle_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_IMMUTABLE');
END;
