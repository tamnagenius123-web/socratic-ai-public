-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS arc_teacher_feedback (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  turn_number       INTEGER NOT NULL,
  predicted_arc     TEXT NOT NULL,
  gold_arc          TEXT NOT NULL,
  adapter_id        TEXT,
  reviewer_id       TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_arc_feedback_session ON arc_teacher_feedback(session_id, turn_number);

CREATE TABLE IF NOT EXISTS argunet_adapter_registry (
  id                TEXT PRIMARY KEY,
  adapter_name      TEXT NOT NULL UNIQUE,
  provider          TEXT NOT NULL,
  inference_url     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  dataset_name      TEXT NOT NULL DEFAULT 'OpenDebateEvidence',
  dataset_version   TEXT,
  metadata_json     TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS jsonld_export_log (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  turn_number       INTEGER NOT NULL,
  export_type       TEXT NOT NULL DEFAULT 'application/ld+json',
  consumer          TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_jsonld_export_session ON jsonld_export_log(session_id, turn_number);
