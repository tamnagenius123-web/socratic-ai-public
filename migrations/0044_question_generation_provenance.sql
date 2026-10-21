-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS question_generation_runs (
  id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL CHECK(trigger_source IN ('cron', 'manual')),
  requested_count INTEGER NOT NULL CHECK(requested_count BETWEEN 1 AND 10),
  generated_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'partial', 'failed')),
  provider_policy TEXT NOT NULL,
  initiated_by_user_id TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(errors_json)),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (initiated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_question_generation_runs_status_started
  ON question_generation_runs(status, started_at DESC);

ALTER TABLE daily_question_bank ADD COLUMN generation_run_id TEXT REFERENCES question_generation_runs(id) ON DELETE SET NULL;

ALTER TABLE daily_question_bank ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'legacy_unverified'
  CHECK(validation_status IN ('legacy_unverified', 'provisional', 'validated', 'rejected'));

ALTER TABLE daily_question_bank ADD COLUMN generation_provenance_json TEXT
  CHECK(generation_provenance_json IS NULL OR json_valid(generation_provenance_json));

CREATE INDEX IF NOT EXISTS idx_daily_question_bank_generation_run
  ON daily_question_bank(generation_run_id);

CREATE INDEX IF NOT EXISTS idx_daily_question_bank_validation_status
  ON daily_question_bank(validation_status, is_active);
