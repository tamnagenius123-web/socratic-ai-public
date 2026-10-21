-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS taiji_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  current_node_id TEXT,
  turn_number INTEGER NOT NULL DEFAULT 0,
  last_counter_example_id TEXT,
  last_classification TEXT CHECK(
    last_classification IN (
      'ignore', 'reject', 'exclude', 'abeyance',
      'reinterpret', 'peripheral', 'theory_change', 'uncertain'
    )
  ),
  last_classification_at INTEGER,
  suspended_until INTEGER,     created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_taiji_sessions_user_id ON taiji_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_taiji_sessions_session_id ON taiji_sessions(session_id);

CREATE INDEX IF NOT EXISTS idx_taiji_sessions_created_at ON taiji_sessions(created_at);

CREATE TABLE IF NOT EXISTS singularities (
  id TEXT PRIMARY KEY,
  taiji_session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  mastery_score REAL NOT NULL CHECK(mastery_score BETWEEN 0 AND 1),
  engagement_score REAL NOT NULL CHECK(engagement_score BETWEEN 0 AND 1),
  grade_level INTEGER NOT NULL,
  gate_passed BOOLEAN NOT NULL DEFAULT 0,
  gate_failure_reason TEXT,     counter_claim TEXT,           counter_premises TEXT,        target_fallacy TEXT,
  counter_confidence REAL CHECK(counter_confidence BETWEEN 0 AND 1),
  walton_scheme_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY(taiji_session_id) REFERENCES taiji_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_singularities_taiji_session ON singularities(taiji_session_id);

CREATE INDEX IF NOT EXISTS idx_singularities_gate_passed ON singularities(gate_passed);

CREATE INDEX IF NOT EXISTS idx_singularities_created_at ON singularities(created_at);

CREATE TABLE IF NOT EXISTS resistance_detections (
  id TEXT PRIMARY KEY,
  taiji_session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  singularity_id TEXT,
  classification TEXT NOT NULL CHECK(
    classification IN (
      'ignore', 'reject', 'exclude', 'abeyance',
      'reinterpret', 'peripheral', 'theory_change', 'uncertain'
    )
  ),
  confidence REAL CHECK(confidence BETWEEN 0 AND 1),
  response_text_hash TEXT,     created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY(taiji_session_id) REFERENCES taiji_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(singularity_id) REFERENCES singularities(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_resistance_detections_taiji_session
  ON resistance_detections(taiji_session_id);

CREATE INDEX IF NOT EXISTS idx_resistance_detections_classification
  ON resistance_detections(classification);

CREATE INDEX IF NOT EXISTS idx_resistance_detections_created_at
  ON resistance_detections(created_at);

CREATE VIEW IF NOT EXISTS taiji_activity_summary AS
SELECT
  ts.id AS session_id,
  ts.user_id,
  ts.turn_number,
  COUNT(DISTINCT CASE WHEN sg.gate_passed = 1 THEN sg.id END) AS singularities_unlocked,
  COUNT(DISTINCT rd.id) AS resistance_events,
  (SELECT classification FROM resistance_detections
   WHERE taiji_session_id = ts.id
   ORDER BY created_at DESC LIMIT 1) AS latest_resistance,
  ts.suspended_until,
  ts.created_at,
  ts.updated_at
FROM taiji_sessions ts
LEFT JOIN singularities sg ON ts.id = sg.taiji_session_id
LEFT JOIN resistance_detections rd ON ts.id = rd.taiji_session_id
GROUP BY ts.id;
