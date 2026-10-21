-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS training_argument_nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  node_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  author TEXT DEFAULT 'student',
  strength REAL DEFAULT 0.5,
  is_grounded INTEGER DEFAULT 0,
  depth INTEGER DEFAULT 0,
  parent_node_id TEXT,
  UNIQUE (session_id, id),
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, parent_node_id)
    REFERENCES training_argument_nodes(session_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS training_argument_edges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  edge_type_faf TEXT DEFAULT 'attack',
  attack_weight REAL DEFAULT 1.0,
  FOREIGN KEY (session_id) REFERENCES training_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, from_node_id)
    REFERENCES training_argument_nodes(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, to_node_id)
    REFERENCES training_argument_nodes(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_training_argument_nodes_session_turn
  ON training_argument_nodes(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_training_argument_edges_session
  ON training_argument_edges(session_id);
