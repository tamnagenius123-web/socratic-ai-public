-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS user_knowledge_synapses (
  user_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  synapse_weight REAL NOT NULL CHECK (synapse_weight >= 0 AND synapse_weight <= 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  last_session_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain_id, from_node_id, to_node_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (from_node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (to_node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_knowledge_synapses_domain
  ON user_knowledge_synapses(user_id, domain_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS taiji_session_canonical_0043 (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);

DROP TABLE taiji_session_canonical_0043;

CREATE UNIQUE INDEX IF NOT EXISTS idx_taiji_sessions_user_session
  ON taiji_sessions(user_id, session_id);

CREATE TABLE IF NOT EXISTS taiji_responses (
  id TEXT PRIMARY KEY,
  taiji_session_id TEXT NOT NULL,
  claim_attribution_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  response_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (taiji_session_id, claim_attribution_id),
  FOREIGN KEY (taiji_session_id) REFERENCES taiji_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (claim_attribution_id) REFERENCES learner_claim_attributions(id) ON DELETE RESTRICT,
  FOREIGN KEY (from_node_id) REFERENCES knowledge_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY (to_node_id) REFERENCES knowledge_nodes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS taiji_classifications (
  id TEXT PRIMARY KEY,
  taiji_response_id TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL CHECK (classification IN (
    'ignore', 'reject', 'exclude', 'abeyance', 'reinterpret', 'peripheral', 'theory_change', 'uncertain'
  )),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (taiji_response_id) REFERENCES taiji_responses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS taiji_actions (
  id TEXT PRIMARY KEY,
  taiji_classification_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('continue', 'suspend', 'reinforce', 'clarify', 'unavailable')),
  detail TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (taiji_classification_id) REFERENCES taiji_classifications(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_knowledge_synapse_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  taiji_action_id TEXT NOT NULL UNIQUE,
  domain_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  old_weight REAL CHECK (old_weight >= 0 AND old_weight <= 1),
  new_weight REAL NOT NULL CHECK (new_weight >= 0 AND new_weight <= 1),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (taiji_action_id) REFERENCES taiji_actions(id) ON DELETE CASCADE
);

ALTER TABLE singularities ADD COLUMN response_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_singularities_response_id
  ON singularities(response_id) WHERE response_id IS NOT NULL;

CREATE TRIGGER taiji_response_attribution_owner
BEFORE INSERT ON taiji_responses
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1
  FROM taiji_sessions ts
  INNER JOIN learner_claim_attributions a ON a.id = NEW.claim_attribution_id
  WHERE ts.id = NEW.taiji_session_id
    AND a.user_id = ts.user_id
    AND a.session_kind = 'sparring'
    AND a.session_id = ts.session_id
    AND a.claim_snapshot = NEW.response_snapshot
)
BEGIN SELECT RAISE(ABORT, 'taiji_response_attribution_owner_mismatch'); END;

CREATE TRIGGER taiji_response_nodes_same_domain
BEFORE INSERT ON taiji_responses
FOR EACH ROW WHEN NOT EXISTS (
  SELECT 1 FROM knowledge_nodes source
  INNER JOIN knowledge_nodes target ON target.id = NEW.to_node_id
  WHERE source.id = NEW.from_node_id AND source.domain_id = target.domain_id
)
BEGIN SELECT RAISE(ABORT, 'taiji_response_nodes_cross_domain'); END;
