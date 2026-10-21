-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS learner_claim_attributions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_kind TEXT NOT NULL CHECK (session_kind IN ('sparring', 'training')),
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
  status TEXT NOT NULL CHECK (status IN ('cited', 'uncited', 'unavailable')),
  evaluator_status TEXT NOT NULL CHECK (evaluator_status IN ('verified', 'unavailable')),
  claim_snapshot TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  unavailable_reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, session_kind, session_id, turn_number),
  CHECK ((status = 'cited' AND evaluator_status = 'verified') OR (status = 'uncited' AND evaluator_status = 'verified') OR (status = 'unavailable' AND evaluator_status = 'unavailable'))
);

CREATE TABLE IF NOT EXISTS learner_claim_attribution_sources (
  id TEXT PRIMARY KEY,
  attribution_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  passage_snapshot TEXT NOT NULL,
  book_id TEXT NOT NULL,
  book_title TEXT,
  book_author TEXT,
  chunk_index INTEGER,
  char_start INTEGER,
  char_end INTEGER,
  content_sha256 TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  lifecycle_status TEXT CHECK (lifecycle_status IN ('active', 'quarantined', 'deleted')),
  created_at INTEGER NOT NULL,
  UNIQUE(attribution_id, source_id),
  FOREIGN KEY (attribution_id) REFERENCES learner_claim_attributions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_learner_claim_attribution_owner
  ON learner_claim_attributions(user_id, session_kind, session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_learner_claim_attribution_source_book
  ON learner_claim_attribution_sources(book_id, lifecycle_status);

CREATE TABLE IF NOT EXISTS learner_claim_attribution_cascade_context (
  attribution_id TEXT PRIMARY KEY
);

CREATE TRIGGER learner_claim_attribution_owner_insert
BEFORE INSERT ON learner_claim_attributions
FOR EACH ROW WHEN NOT (
  (NEW.session_kind = 'sparring' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id AND s.user_id = NEW.user_id))
  OR
  (NEW.session_kind = 'training' AND EXISTS (SELECT 1 FROM training_sessions t WHERE t.id = NEW.session_id AND t.user_id = NEW.user_id))
)
BEGIN SELECT RAISE(ABORT, 'learner_claim_attribution_owner_mismatch'); END;

CREATE TRIGGER learner_claim_attribution_immutable
BEFORE UPDATE ON learner_claim_attributions
FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'learner_claim_attribution_immutable'); END;

CREATE TRIGGER learner_claim_attribution_cascade_root_before_delete
BEFORE DELETE ON learner_claim_attributions
FOR EACH ROW BEGIN
  INSERT OR IGNORE INTO learner_claim_attribution_cascade_context (attribution_id) VALUES (OLD.id);
END;

CREATE TRIGGER learner_claim_attribution_cascade_root_after_delete
AFTER DELETE ON learner_claim_attributions
FOR EACH ROW BEGIN
  DELETE FROM learner_claim_attribution_cascade_context WHERE attribution_id = OLD.id;
END;

CREATE TRIGGER learner_claim_attribution_cascade_sparring
AFTER DELETE ON sessions
FOR EACH ROW BEGIN
  INSERT OR IGNORE INTO learner_claim_attribution_cascade_context (attribution_id)
  SELECT id FROM learner_claim_attributions WHERE session_kind = 'sparring' AND session_id = OLD.id;
  DELETE FROM learner_claim_attributions
  WHERE session_kind = 'sparring' AND session_id = OLD.id;
  DELETE FROM learner_claim_attribution_cascade_context;
END;

CREATE TRIGGER learner_claim_attribution_cascade_training
AFTER DELETE ON training_sessions
FOR EACH ROW BEGIN
  INSERT OR IGNORE INTO learner_claim_attribution_cascade_context (attribution_id)
  SELECT id FROM learner_claim_attributions WHERE session_kind = 'training' AND session_id = OLD.id;
  DELETE FROM learner_claim_attributions
  WHERE session_kind = 'training' AND session_id = OLD.id;
  DELETE FROM learner_claim_attribution_cascade_context;
END;

CREATE TRIGGER learner_claim_attribution_source_owner_insert
BEFORE INSERT ON learner_claim_attribution_sources
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM learner_claim_attributions a
  WHERE a.id = NEW.attribution_id
    AND a.status = 'cited'
    AND EXISTS (SELECT 1 FROM json_each(a.manifest_json, '$.sources') j WHERE json_extract(j.value, '$.sourceId') = NEW.source_id)
)
BEGIN SELECT RAISE(ABORT, 'learner_claim_attribution_source_not_in_manifest'); END;

CREATE TRIGGER learner_claim_attribution_source_snapshot_immutable
BEFORE UPDATE ON learner_claim_attribution_sources
FOR EACH ROW WHEN NEW.id IS NOT OLD.id
  OR NEW.attribution_id IS NOT OLD.attribution_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.passage_snapshot IS NOT OLD.passage_snapshot
  OR NEW.book_id IS NOT OLD.book_id
  OR NEW.book_title IS NOT OLD.book_title
  OR NEW.book_author IS NOT OLD.book_author
  OR NEW.chunk_index IS NOT OLD.chunk_index
  OR NEW.char_start IS NOT OLD.char_start
  OR NEW.char_end IS NOT OLD.char_end
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.relevance_score IS NOT OLD.relevance_score
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'learner_claim_attribution_source_immutable'); END;

CREATE TRIGGER learner_claim_attribution_source_no_direct_delete
BEFORE DELETE ON learner_claim_attribution_sources
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM learner_claim_attribution_cascade_context c WHERE c.attribution_id = OLD.attribution_id
)
BEGIN SELECT RAISE(ABORT, 'learner_claim_attribution_source_immutable'); END;

CREATE TRIGGER learner_claim_attribution_source_lifecycle
AFTER UPDATE OF lifecycle_status, visibility ON books
FOR EACH ROW BEGIN
  UPDATE learner_claim_attribution_sources
  SET lifecycle_status = CASE
    WHEN NEW.lifecycle_status = 'deleted' THEN 'deleted'
    WHEN NEW.visibility = 'quarantined' THEN 'quarantined'
    WHEN NEW.lifecycle_status = 'active' THEN 'active'
    ELSE NULL END
  WHERE book_id = NEW.id;
END;

ALTER TABLE training_scenario_evidence ADD COLUMN char_start INTEGER;

ALTER TABLE training_scenario_evidence ADD COLUMN char_end INTEGER;

ALTER TABLE sparring_turn_evidence ADD COLUMN source_id TEXT;

ALTER TABLE sparring_turn_evidence ADD COLUMN book_title TEXT;

ALTER TABLE sparring_turn_evidence ADD COLUMN book_author TEXT;
