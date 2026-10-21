-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_lifecycle_transition_contracts (
  from_state TEXT NOT NULL,
  action TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_class TEXT NOT NULL CHECK (actor_class IN ('SYSTEM', 'PARTICIPANT')),
  route_action TEXT NOT NULL CHECK (length(trim(route_action)) > 0),
  PRIMARY KEY (from_state, action, to_state),
  UNIQUE (from_state, action, event_type)
);

INSERT OR IGNORE INTO growth_lifecycle_transition_contracts (from_state, action, to_state, event_type, actor_class, route_action) VALUES
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
  ('TRANSFER_PENDING', 'CLOSE_WITHOUT_VALIDATED_TRANSFER_EVIDENCE', 'CLOSED', 'CYCLE_CLOSED_UNKNOWN', 'PARTICIPANT', 'POST:/api/growth/spaces/:spaceId/cycles/:cycleId/rechecks');

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transition_contracts_immutable_update
BEFORE UPDATE ON growth_lifecycle_transition_contracts
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CONTRACT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_lifecycle_transition_contracts_immutable_delete
BEFORE DELETE ON growth_lifecycle_transition_contracts
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_LIFECYCLE_CONTRACT_IMMUTABLE');
END;
