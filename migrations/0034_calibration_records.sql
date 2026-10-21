-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS calibration_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  problem_id TEXT,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  calibration_error REAL NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()*1000)
);

CREATE INDEX IF NOT EXISTS idx_calibration_user ON calibration_records(user_id);

CREATE INDEX IF NOT EXISTS idx_calibration_session ON calibration_records(session_id);

CREATE INDEX IF NOT EXISTS idx_calibration_recorded ON calibration_records(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_calibration_problem ON calibration_records(problem_id);
