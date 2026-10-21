-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS interaction_history (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  concept       TEXT NOT NULL,
  correct       INTEGER NOT NULL,
  difficulty    REAL NOT NULL DEFAULT 0.5,
  session_id    TEXT NOT NULL,
  turn_number   INTEGER NOT NULL,
  hybrid_kt_json TEXT,     created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_interaction_user_concept ON interaction_history(user_id, concept);

CREATE INDEX IF NOT EXISTS idx_interaction_session ON interaction_history(session_id);

CREATE TABLE IF NOT EXISTS arc_training_log (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_number   INTEGER NOT NULL,
  predicted_arc TEXT NOT NULL,
  prob_support  REAL NOT NULL DEFAULT 0.333,
  prob_attack   REAL NOT NULL DEFAULT 0.333,
  prob_neutral  REAL NOT NULL DEFAULT 0.333,
  entropy       REAL NOT NULL DEFAULT 0,
  actual_arc    TEXT,             features_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_arc_session ON arc_training_log(session_id, turn_number);

CREATE TABLE IF NOT EXISTS linucb_experiment_log (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_number   INTEGER NOT NULL,
  engine        TEXT NOT NULL,        action        TEXT NOT NULL,
  reward        REAL,
  context_json  TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_linucb_exp_session ON linucb_experiment_log(session_id);

CREATE TABLE IF NOT EXISTS xaif_jsonld_cache (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_number   INTEGER NOT NULL,
  jsonld_text   TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_jsonld_session ON xaif_jsonld_cache(session_id, turn_number);
