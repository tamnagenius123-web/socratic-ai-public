-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS dialogue_act_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  utterance_role TEXT NOT NULL CHECK(utterance_role IN ('student', 'tutor')),
  act_code TEXT NOT NULL CHECK(act_code IN (
    'claim', 'evidence', 'rebuttal', 'counterexample',
    'clarification_request', 'evade_question', 'revision',
    'concession', 'meta_reasoning', 'decision_statement',
    'elaboration', 'question'
  )),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
  source_text TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_dialogue_acts_session ON dialogue_act_events(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_dialogue_acts_code ON dialogue_act_events(act_code);
