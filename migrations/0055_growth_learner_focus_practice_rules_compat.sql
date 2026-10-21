-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
INSERT OR IGNORE INTO growth_path_revisions (
  id, path_code, revision, locale, display_name, definition_json,
  validation_status, status, created_at
) VALUES
(
  'growth-path:training-five-axis:en:1', 'training-five-axis', 1, 'en',
  'Training five-axis descriptive path',
  '{"source":"legacy-training-evaluator","axes":["claim_clarity","evidence_use","reasoning_strength","consistency","relevance"]}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
),
(
  'growth-path:sparring-five-axis:en:1', 'sparring-five-axis', 1, 'en',
  'Sparring five-axis descriptive path',
  '{"source":"sparring-evaluator","axes":["claim_clarity","evidence_use","reasoning_strength","consistency","relevance"]}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
);

INSERT OR IGNORE INTO growth_capability_definitions (
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
  ('growth-capability:sparring-five-axis:relevance:1', 'growth-path:sparring-five-axis:en:1', 'relevance', 1, 'Relevance', '{"axis":"relevance"}', 'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0);

INSERT OR IGNORE INTO growth_observation_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
(
  'growth-observation-rule:training-lowest-axis-descriptive:en:1',
  'growth-path:training-five-axis:en:1', 'lowest_axis_descriptive_signal', 1,
  '{"kind":"LOWEST_AXIS_DESCRIPTIVE_SIGNAL","source":"legacy-training-evaluator","tie_break":"stable_capability_code_ascending","outcome":"UNKNOWN","prohibits":["MEASURED","GAP_PROPOSED","CALIBRATED_CONFIDENCE","IMPROVED"]}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
),
(
  'growth-observation-rule:sparring-five-axis-descriptive:en:1',
  'growth-path:sparring-five-axis:en:1', 'sparring_five_axis_descriptive_signal', 1,
  '{"kind":"SPARRING_FIVE_AXIS_DESCRIPTIVE_SIGNAL","source":"sparring-evaluator","axis_mapping":{"clarity_score":"claim_clarity","evidence_score":"evidence_use","defense_score":"reasoning_strength","consistency_score":"consistency","relevance_score":"relevance"},"tie_break":"stable_capability_code_ascending","outcome":"UNKNOWN","prohibits":["MEASURED","GAP_PROPOSED","CALIBRATED_CONFIDENCE","IMPROVED"]}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
);

INSERT OR IGNORE INTO growth_gap_rules (
  id, path_revision_id, rule_code, revision, rule_json, validation_status, status, created_at
) VALUES
(
  'growth-gap-rule:training-five-axis:provisional:en:1',
  'growth-path:training-five-axis:en:1', 'validated_gap_required', 1,
  '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
),
(
  'growth-gap-rule:sparring-five-axis:provisional:en:1',
  'growth-path:sparring-five-axis:en:1', 'validated_gap_required', 1,
  '{"kind":"PROVISIONAL_GAP_UNAVAILABLE","requires":"validated_observation_and_exact_evidence","outcome":"UNKNOWN"}',
  'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0
);

INSERT OR IGNORE INTO growth_practice_rules (
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
    'PROVISIONAL_UNCALIBRATED', 'ACTIVE', 0);
