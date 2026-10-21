-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  concept TEXT NOT NULL,
  category TEXT NOT NULL,
  bloom_level INTEGER NOT NULL DEFAULT 2 CHECK(bloom_level BETWEEN 1 AND 6),
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_domain ON knowledge_nodes(domain_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_category ON knowledge_nodes(category);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK(relation_type IN ('prerequisite', 'includes', 'contradicts', 'supports', 'exemplifies')),
  strength REAL NOT NULL DEFAULT 1.0 CHECK(strength BETWEEN 0 AND 1),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_domain ON knowledge_edges(domain_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_edges_relation ON knowledge_edges(relation_type);

CREATE TABLE IF NOT EXISTS user_concept_mastery (
  user_id TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  p_know REAL NOT NULL DEFAULT 0.3 CHECK(p_know BETWEEN 0 AND 1),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  last_session_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (user_id, concept_id)
);
