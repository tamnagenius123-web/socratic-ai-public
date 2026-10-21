-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS aif_graph_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
     xaif_json TEXT NOT NULL DEFAULT '{}',
     toulmin_json TEXT NOT NULL DEFAULT '{}',
     total_i_nodes INTEGER NOT NULL DEFAULT 0,
  total_s_nodes INTEGER NOT NULL DEFAULT 0,
  total_edges INTEGER NOT NULL DEFAULT 0,
  argument_strength REAL NOT NULL DEFAULT 0,
  missing_edges_count INTEGER NOT NULL DEFAULT 0,
  grounded_nodes_count INTEGER NOT NULL DEFAULT 0,
  defeated_nodes_count INTEGER NOT NULL DEFAULT 0,
     dialogue_act_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_aif_snapshots_session ON aif_graph_snapshots(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_argument_nodes_session_turn ON argument_nodes(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_argument_edges_session ON argument_edges(session_id);
