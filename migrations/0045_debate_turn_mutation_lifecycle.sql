-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS debate_turn_mutations (
  mutation_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete', 'unknown')),
  turn_number INTEGER,
  student_turn_id TEXT,
  runtime_result_json TEXT CHECK(runtime_result_json IS NULL OR json_valid(runtime_result_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (room_id) REFERENCES debate_rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES debate_participants(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_debate_turn_mutations_room_status
  ON debate_turn_mutations(room_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_debate_turn_mutations_user_room
  ON debate_turn_mutations(user_id, room_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_debate_turn_mutations_one_active_room
  ON debate_turn_mutations(room_id)
  WHERE status IN ('pending', 'unknown');
