-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS growth_gap_hypothesis_revision_lineage (
  growth_hypothesis_id TEXT PRIMARY KEY,
  revises_hypothesis_id TEXT NOT NULL,
  revision_rationale TEXT NOT NULL CHECK (length(trim(revision_rationale)) > 0),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (growth_hypothesis_id) REFERENCES growth_gap_hypotheses(id) ON DELETE CASCADE,
  FOREIGN KEY (revises_hypothesis_id) REFERENCES growth_gap_hypotheses(id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_revision_lineage_immutable_update
BEFORE UPDATE ON growth_gap_hypothesis_revision_lineage
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_REVISION_LINEAGE_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS growth_gap_hypothesis_revision_lineage_same_cycle_guard
BEFORE INSERT ON growth_gap_hypothesis_revision_lineage
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM growth_gap_hypotheses revised
  INNER JOIN growth_gap_hypotheses previous ON previous.id = NEW.revises_hypothesis_id
  WHERE revised.id = NEW.growth_hypothesis_id
    AND revised.growth_cycle_id = previous.growth_cycle_id
)
BEGIN
  SELECT RAISE(ABORT, 'GROWTH_GAP_HYPOTHESIS_REVISION_LINEAGE_CROSS_CYCLE');
END;
