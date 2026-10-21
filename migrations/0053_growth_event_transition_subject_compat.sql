-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_event_transition_subjects (
  growth_event_id TEXT PRIMARY KEY,
  transition_subject_type TEXT NOT NULL CHECK (transition_subject_type IN ('GAP_HYPOTHESIS', 'FOCUS_SELECTION', 'PRACTICE_QUEST', 'RECHECK')),
  transition_subject_id TEXT NOT NULL CHECK (length(trim(transition_subject_id)) > 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_event_id) REFERENCES growth_events(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS growth_event_transition_subjects_immutable_update
BEFORE UPDATE ON growth_event_transition_subjects
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_EVENT_TRANSITION_SUBJECT_IMMUTABLE');
END;
