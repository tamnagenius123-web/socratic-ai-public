-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
INSERT INTO growth_observation_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
  ('growth-observation-rule:training-lowest-axis-descriptive:en:2',
    'growth-path:training-five-axis:en:1', 'lowest_axis_descriptive_signal', 2,
    '{"kind":"LOWEST_AXIS_DESCRIPTIVE_SIGNAL","source":"legacy-training-evaluator","tie_break":"stable_capability_code_ascending","outcome":"UNKNOWN","prohibits":["MEASURED","GAP_PROPOSED","CALIBRATED_CONFIDENCE","IMPROVED"]}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-observation-rule:sparring-five-axis-descriptive:en:2',
    'growth-path:sparring-five-axis:en:1', 'sparring_five_axis_descriptive_signal', 2,
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
  ('growth-gap-rule:training-five-axis:provisional:en:2',
    'growth-path:training-five-axis:en:1', 'validated_gap_required', 2,
    '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0),
  ('growth-gap-rule:sparring-five-axis:provisional:en:2',
    'growth-path:sparring-five-axis:en:1', 'validated_gap_required', 2,
    '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0)
ON CONFLICT(id) DO UPDATE SET
  path_revision_id = excluded.path_revision_id, rule_code = excluded.rule_code,
  revision = excluded.revision, rule_json = excluded.rule_json,
  validation_status = excluded.validation_status, status = excluded.status,
  created_at = excluded.created_at;
