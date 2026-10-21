-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_spaces_one_active_solo_per_host
  ON growth_spaces(host_user_id)
  WHERE space_type = 'SOLO' AND status = 'ACTIVE';

CREATE TRIGGER IF NOT EXISTS growth_mutation_receipts_precycle_immutable_delete
BEFORE DELETE ON growth_mutation_receipts
FOR EACH ROW WHEN OLD.growth_cycle_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_MUTATION_RECEIPT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_practice_quests_identity_immutable_update
BEFORE UPDATE OF growth_cycle_id, gap_hypothesis_id, focus_selection_id,
  practice_rule_id, practice_rule_revision, quest_type, source_packet_json,
  selection_reason, learning_purpose, target_retention_horizon_hours, created_at
ON growth_practice_quests
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_PRACTICE_QUEST_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_receipt_links_contract_guard
BEFORE INSERT ON growth_event_mutation_receipt_links
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_events event
  INNER JOIN growth_mutation_receipts receipt ON receipt.id = NEW.mutation_receipt_id
  LEFT JOIN growth_cycles cycle ON cycle.id = event.growth_cycle_id
  LEFT JOIN growth_space_memberships participant ON participant.id = cycle.participant_membership_id
  LEFT JOIN growth_lifecycle_transitions transition
    ON transition.from_state = event.previous_state
   AND transition.action = event.lifecycle_action
   AND transition.to_state = event.next_state
   AND transition.event_type = event.event_type
  LEFT JOIN growth_lifecycle_transition_contracts contract
    ON contract.from_state = transition.from_state
   AND contract.action = transition.action
   AND contract.to_state = transition.to_state
   AND contract.event_type = transition.event_type
  WHERE event.id = NEW.growth_event_id
    AND receipt.growth_cycle_id IS event.growth_cycle_id
    AND participant.user_id = receipt.actor_user_id
    AND (
      (event.object_type = 'GROWTH_CYCLE'
        AND receipt.expected_aggregate_revision = event.object_revision - 1
        AND receipt.lifecycle_action IS event.lifecycle_action
        AND receipt.route_action = contract.route_action
        AND ((contract.actor_class = 'SYSTEM' AND event.actor_membership_id IS NULL AND event.actor_pseudonym_id = 'system:growth-cycle')
          OR (contract.actor_class = 'PARTICIPANT' AND event.actor_membership_id = cycle.participant_membership_id)))
      OR
      (event.object_type <> 'GROWTH_CYCLE'
        AND receipt.expected_aggregate_revision = event.object_revision
        AND receipt.lifecycle_action IS NULL
        AND event.actor_membership_id = cycle.participant_membership_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_RECEIPT_LINK_CONTRACT_REQUIRED');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_transition_subjects_contract_guard
BEFORE INSERT ON growth_event_transition_subjects
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_events event
  WHERE event.id = NEW.growth_event_id
    AND event.object_type = 'GROWTH_CYCLE'
    AND (
      (NEW.transition_subject_type = 'GAP_HYPOTHESIS'
        AND event.event_type IN ('GAP_PROPOSED','GAP_REMAINS_UNKNOWN','GAP_REVISED','GAP_ACCEPTED','GAP_CONTESTED','GAP_DISMISSED','GAP_DEFERRED','GAP_RESUMED')
        AND EXISTS (SELECT 1 FROM growth_gap_hypotheses subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
      OR (NEW.transition_subject_type = 'FOCUS_SELECTION'
        AND event.event_type IN ('FOCUS_SELECTED','FOCUS_REVISED','PRACTICE_UNAVAILABLE')
        AND EXISTS (SELECT 1 FROM growth_focus_selections subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
      OR (NEW.transition_subject_type = 'PRACTICE_QUEST'
        AND event.event_type IN ('PRACTICE_OFFERED','PRACTICE_ACCEPTED','PRACTICE_DECLINED','PRACTICE_DEFERRED','PRACTICE_RESUMED')
        AND EXISTS (SELECT 1 FROM growth_practice_quests subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
      OR (NEW.transition_subject_type = 'RECHECK'
        AND event.event_type IN ('RECHECK_SCHEDULED','RECHECK_RECORDED','RECHECK_RESCHEDULED','RECHECK_OUTCOME_RECORDED')
        AND EXISTS (SELECT 1 FROM growth_rechecks subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_CONTRACT_REQUIRED');
END;
