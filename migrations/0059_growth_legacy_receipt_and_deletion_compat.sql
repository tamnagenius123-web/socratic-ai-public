-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
DROP TRIGGER IF EXISTS growth_event_receipt_links_contract_guard;

CREATE TRIGGER growth_event_receipt_links_contract_guard
BEFORE INSERT ON growth_event_mutation_receipt_links
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_events event
  INNER JOIN growth_mutation_receipts receipt ON receipt.id = NEW.mutation_receipt_id
  INNER JOIN growth_mutation_receipt_replay_payloads payload ON payload.mutation_receipt_id = receipt.id
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
        AND payload.expected_aggregate_revision = event.object_revision - 1
        AND payload.lifecycle_action IS event.lifecycle_action
        AND receipt.route_action = contract.route_action
        AND ((contract.actor_class = 'SYSTEM' AND event.actor_membership_id IS NULL AND event.actor_pseudonym_id = 'system:growth-cycle')
          OR (contract.actor_class = 'PARTICIPANT' AND event.actor_membership_id = cycle.participant_membership_id)))
      OR
      (event.object_type <> 'GROWTH_CYCLE'
        AND payload.expected_aggregate_revision = event.object_revision
        AND payload.lifecycle_action IS NULL
        AND event.actor_membership_id = cycle.participant_membership_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_RECEIPT_LINK_CONTRACT_REQUIRED');
END;

DROP TRIGGER IF EXISTS growth_gap_hypothesis_revision_lineage_immutable_delete;

CREATE TRIGGER growth_gap_hypothesis_revision_lineage_immutable_delete
BEFORE DELETE ON growth_gap_hypothesis_revision_lineage
FOR EACH ROW WHEN EXISTS (
  SELECT 1
  FROM growth_gap_hypotheses hypothesis
  WHERE hypothesis.id = OLD.growth_hypothesis_id
    AND NOT EXISTS (
      SELECT 1 FROM growth_deletion_context context
      WHERE context.growth_cycle_id = hypothesis.growth_cycle_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_REVISION_LINEAGE_IMMUTABLE');
END;
