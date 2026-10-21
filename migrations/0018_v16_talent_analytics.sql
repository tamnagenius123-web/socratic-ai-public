-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS org_memberships (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'manager', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON org_memberships(org_id);

CREATE INDEX IF NOT EXISTS idx_org_memberships_team ON org_memberships(org_id, team_id);

CREATE TABLE IF NOT EXISTS talent_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
     logical_structuring REAL NOT NULL DEFAULT 50,
  data_literacy REAL NOT NULL DEFAULT 50,
  cognitive_flexibility REAL NOT NULL DEFAULT 50,
  business_communication REAL NOT NULL DEFAULT 50,
     hipo_score REAL NOT NULL DEFAULT 50,
  decision_rigor_index REAL NOT NULL DEFAULT 50,
  revision_maturity REAL NOT NULL DEFAULT 50,
  evidence_discipline REAL NOT NULL DEFAULT 50,
     session_count INTEGER NOT NULL DEFAULT 0,
  total_turns INTEGER NOT NULL DEFAULT 0,
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_talent_snapshots_org ON talent_snapshots(org_id);

CREATE INDEX IF NOT EXISTS idx_talent_snapshots_user ON talent_snapshots(user_id);

CREATE INDEX IF NOT EXISTS idx_talent_snapshots_date ON talent_snapshots(snapshot_date);

CREATE INDEX IF NOT EXISTS idx_talent_snapshots_hipo ON talent_snapshots(org_id, hipo_score DESC);
