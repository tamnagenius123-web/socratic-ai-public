-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TRIGGER IF NOT EXISTS growth_event_receipt_links_immutable_delete
BEFORE DELETE ON growth_event_mutation_receipt_links
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM growth_events event WHERE event.id = OLD.growth_event_id)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_RECEIPT_LINK_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_event_transition_subjects_immutable_delete
BEFORE DELETE ON growth_event_transition_subjects
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM growth_events event WHERE event.id = OLD.growth_event_id)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_revision_lineage_immutable_delete
BEFORE DELETE ON growth_gap_hypothesis_revision_lineage
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM growth_gap_hypotheses hypothesis WHERE hypothesis.id = OLD.growth_hypothesis_id)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_REVISION_LINEAGE_IMMUTABLE');
END;
