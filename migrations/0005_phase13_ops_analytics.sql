-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE sessions ADD COLUMN session_completion_turn INTEGER;

ALTER TABLE sessions ADD COLUMN dropoff_turn INTEGER;

ALTER TABLE sessions ADD COLUMN hint_success_after INTEGER;

ALTER TABLE sessions ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN weakness_tags_history TEXT NOT NULL DEFAULT '[]';

ALTER TABLE sessions ADD COLUMN last_failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_dropoff_turn ON sessions(dropoff_turn);

CREATE INDEX IF NOT EXISTS idx_sessions_completion_turn ON sessions(session_completion_turn);
