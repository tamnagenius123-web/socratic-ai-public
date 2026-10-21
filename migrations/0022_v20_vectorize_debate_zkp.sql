-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS vector_documents (
  id                  TEXT PRIMARY KEY,
  source_type         TEXT NOT NULL,         source_id           TEXT NOT NULL,
  chunk_count         INTEGER NOT NULL DEFAULT 0,
  embedding_model     TEXT NOT NULL,
  vector_index_name   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  metadata_json       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_vector_documents_source ON vector_documents(source_type, source_id);

CREATE TABLE IF NOT EXISTS vector_query_log (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT,
  source_id           TEXT,
  query_text          TEXT NOT NULL,
  top_k               INTEGER NOT NULL DEFAULT 3,
  latency_ms          INTEGER,
  hit_count           INTEGER NOT NULL DEFAULT 0,
  retrieval_json      TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_vector_query_user ON vector_query_log(user_id, created_at);

CREATE TABLE IF NOT EXISTS debate_rooms (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT,
  host_user_id        TEXT,
  topic               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  mode                TEXT NOT NULL DEFAULT 'critic_advocate_moderator',
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  closed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_debate_rooms_org ON debate_rooms(org_id, created_at);

CREATE TABLE IF NOT EXISTS debate_participants (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL,
  participant_type    TEXT NOT NULL,         role                TEXT NOT NULL,         user_id             TEXT,
  display_name        TEXT,
  joined_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  left_at             INTEGER,
  FOREIGN KEY (room_id) REFERENCES debate_rooms(id)
);

CREATE INDEX IF NOT EXISTS idx_debate_participants_room ON debate_participants(room_id);

CREATE TABLE IF NOT EXISTS debate_turns (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL,
  participant_id      TEXT NOT NULL,
  turn_number         INTEGER NOT NULL,
  content             TEXT NOT NULL,
  role                TEXT NOT NULL,
  xaif_snapshot_id    TEXT,
  retrieval_trace     TEXT,
  moderation_json     TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (room_id) REFERENCES debate_rooms(id),
  FOREIGN KEY (participant_id) REFERENCES debate_participants(id)
);

CREATE INDEX IF NOT EXISTS idx_debate_turns_room ON debate_turns(room_id, turn_number);

CREATE TABLE IF NOT EXISTS zkp_proofs (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  proof_system        TEXT NOT NULL,
  public_input_json   TEXT NOT NULL,
  proof_json          TEXT NOT NULL,
  verifier_status     TEXT NOT NULL DEFAULT 'pending',
  created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  verified_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_zkp_user_session ON zkp_proofs(user_id, session_id);

CREATE TABLE IF NOT EXISTS cognitive_badges (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  proof_id            TEXT NOT NULL,
  badge_type          TEXT NOT NULL,
  process_score       REAL NOT NULL,
  trajectory_hash     TEXT NOT NULL,
  issued_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  revoked_at          INTEGER,
  FOREIGN KEY (proof_id) REFERENCES zkp_proofs(id)
);

CREATE INDEX IF NOT EXISTS idx_cognitive_badges_user ON cognitive_badges(user_id, issued_at);
