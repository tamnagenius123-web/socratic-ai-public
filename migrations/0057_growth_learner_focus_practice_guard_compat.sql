-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
DROP TRIGGER IF EXISTS growth_practice_quest_requires_validated_rule;

CREATE TRIGGER growth_practice_quest_requires_validated_rule
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
