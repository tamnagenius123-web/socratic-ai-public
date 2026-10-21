-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS aif_l_nodes (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  turn_number     INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  person_id       TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  char_start      INTEGER,
  char_end        INTEGER,
  timestamp_ms    INTEGER NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_l_nodes_session ON aif_l_nodes(session_id, turn_number);

CREATE TABLE IF NOT EXISTS aif_ta_edges (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  turn_number     INTEGER NOT NULL,
  l_node_id       TEXT NOT NULL,
  i_node_id       TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ta_edges_session ON aif_ta_edges(session_id, turn_number);

CREATE TABLE IF NOT EXISTS argument_scheme_stats (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  turn_number     INTEGER NOT NULL,
  scheme          TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_scheme_stats_session ON argument_scheme_stats(session_id);

CREATE TABLE IF NOT EXISTS session_process_snapshots (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  turn_number            INTEGER NOT NULL,
  logical_score          REAL NOT NULL DEFAULT 0,
  data_score             REAL NOT NULL DEFAULT 0,
  flexibility_score      REAL NOT NULL DEFAULT 0,
  communication_score    REAL NOT NULL DEFAULT 0,
  overall_score          REAL NOT NULL DEFAULT 0,
  da_act                 TEXT,
  illocutionary_strength REAL DEFAULT 0,
  pressure_move          TEXT,
  revision_occurred      INTEGER DEFAULT 0,
  state                  TEXT,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sps_session ON session_process_snapshots(session_id, turn_number);

CREATE TABLE IF NOT EXISTS session_process_evaluations (
  id                              TEXT PRIMARY KEY,
  session_id                      TEXT NOT NULL UNIQUE,
  user_id                         TEXT,
  logical_progression_rate        REAL DEFAULT 0,
  revision_quality_index          REAL DEFAULT 0,
  pressure_response_score         REAL DEFAULT 0,
  argument_depth_growth           REAL DEFAULT 0,
  peak_flexibility_turn           INTEGER DEFAULT 0,
  sustained_flexibility           REAL DEFAULT 0,
  metacognition_activation_rate   REAL DEFAULT 0,
  self_correction_depth           REAL DEFAULT 0,
  process_score                   REAL DEFAULT 0,
  snapshot_json                   TEXT,
  created_at                      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_spe_user ON session_process_evaluations(user_id);

CREATE TABLE IF NOT EXISTS talent_trend_data (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  user_id         TEXT,
  period_type     TEXT NOT NULL DEFAULT 'weekly',
  period_start    INTEGER NOT NULL,
  period_end      INTEGER NOT NULL,
  avg_logical     REAL DEFAULT 0,
  avg_data        REAL DEFAULT 0,
  avg_flexibility REAL DEFAULT 0,
  avg_communication REAL DEFAULT 0,
  avg_process_score REAL DEFAULT 0,
  session_count   INTEGER DEFAULT 0,
  total_turns     INTEGER DEFAULT 0,
  hipo_score      REAL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_trend_org ON talent_trend_data(org_id, period_type);

CREATE INDEX IF NOT EXISTS idx_trend_user ON talent_trend_data(user_id, period_type);

CREATE TABLE IF NOT EXISTS linucb_arms (
  id              TEXT PRIMARY KEY,
  action          TEXT NOT NULL UNIQUE,
  a_matrix_json   TEXT NOT NULL,
  b_vector_json   TEXT NOT NULL,
  times_selected  INTEGER DEFAULT 0,
  total_reward    REAL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
