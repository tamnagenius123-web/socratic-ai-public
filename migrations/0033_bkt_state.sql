-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS bkt_states (
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  p_know REAL NOT NULL DEFAULT 0.3 CHECK(p_know BETWEEN 0 AND 1),
  n_opportunities INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_bkt_skill ON bkt_states(skill_id);

CREATE INDEX IF NOT EXISTS idx_bkt_user ON bkt_states(user_id);

CREATE INDEX IF NOT EXISTS idx_bkt_updated ON bkt_states(last_updated DESC);
