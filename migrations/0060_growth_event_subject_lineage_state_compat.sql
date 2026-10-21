-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
DROP TRIGGER IF EXISTS growth_event_transition_subjects_contract_guard;

CREATE TRIGGER growth_event_transition_subjects_contract_guard
BEFORE INSERT ON growth_event_transition_subjects
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_events event
  WHERE event.id = NEW.growth_event_id
    AND event.object_type = 'GROWTH_CYCLE'
    AND (
      (NEW.transition_subject_type = 'GAP_HYPOTHESIS'
        AND EXISTS (
          SELECT 1 FROM growth_gap_hypotheses subject
          WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id
            AND ((event.event_type IN ('GAP_PROPOSED','GAP_REVISED','GAP_RESUMED') AND subject.state = 'PROPOSED')
              OR (event.event_type = 'GAP_REMAINS_UNKNOWN' AND subject.state = 'UNKNOWN')
              OR (event.event_type = 'GAP_ACCEPTED' AND subject.state = 'ACCEPTED')
              OR (event.event_type = 'GAP_CONTESTED' AND subject.state = 'CONTESTED' AND length(trim(COALESCE(subject.participant_rationale, ''))) > 0)
              OR (event.event_type = 'GAP_DISMISSED' AND subject.state = 'DISMISSED')
              OR (event.event_type = 'GAP_DEFERRED' AND subject.state = 'DEFERRED'))))
      OR (NEW.transition_subject_type = 'FOCUS_SELECTION'
        AND event.event_type IN ('FOCUS_SELECTED','FOCUS_REVISED','PRACTICE_UNAVAILABLE')
        AND EXISTS (SELECT 1 FROM growth_focus_selections subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
      OR (NEW.transition_subject_type = 'PRACTICE_QUEST'
        AND EXISTS (
          SELECT 1 FROM growth_practice_quests subject
          WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id
            AND ((event.event_type IN ('PRACTICE_OFFERED','PRACTICE_RESUMED') AND subject.status = 'OFFERED')
              OR (event.event_type = 'PRACTICE_ACCEPTED' AND subject.status = 'ACCEPTED')
              OR (event.event_type = 'PRACTICE_DECLINED' AND subject.status = 'DECLINED')
              OR (event.event_type = 'PRACTICE_DEFERRED' AND subject.status = 'DEFERRED'))))
      OR (NEW.transition_subject_type = 'RECHECK'
        AND event.event_type IN ('RECHECK_SCHEDULED','RECHECK_RECORDED','RECHECK_RESCHEDULED','RECHECK_OUTCOME_RECORDED')
        AND EXISTS (SELECT 1 FROM growth_rechecks subject WHERE subject.id = NEW.transition_subject_id AND subject.growth_cycle_id = event.growth_cycle_id))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_CONTRACT_REQUIRED');
END;
