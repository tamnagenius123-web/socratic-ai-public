-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS arc_weight_snapshots (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL,
  weights_json      TEXT NOT NULL,
  training_samples  INTEGER NOT NULL DEFAULT 0,
  accuracy          REAL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS queue_dead_letter_log (
  id                TEXT PRIMARY KEY,
  queue_name        TEXT NOT NULL,
  message_json      TEXT NOT NULL,
  error_message     TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS _v21_migration_check (id INTEGER PRIMARY KEY);
