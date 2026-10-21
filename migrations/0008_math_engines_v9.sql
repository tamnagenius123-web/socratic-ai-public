-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS bkt_knowledge_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    concept TEXT NOT NULL,
    p_know REAL DEFAULT 0.3,
    p_transit REAL DEFAULT 0.1,
    p_slip REAL DEFAULT 0.15,
    p_guess REAL DEFAULT 0.25,
    observations INTEGER DEFAULT 0,
    last_session_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bkt_user_concept ON bkt_knowledge_states(user_id, concept);

CREATE INDEX IF NOT EXISTS idx_bkt_p_know ON bkt_knowledge_states(p_know);

ALTER TABLE argument_nodes ADD COLUMN author TEXT DEFAULT 'student';

ALTER TABLE argument_nodes ADD COLUMN strength REAL DEFAULT 0.5;

ALTER TABLE argument_nodes ADD COLUMN is_grounded INTEGER DEFAULT 0;

ALTER TABLE argument_nodes ADD COLUMN depth INTEGER DEFAULT 0;

ALTER TABLE argument_nodes ADD COLUMN parent_node_id TEXT;

ALTER TABLE argument_edges ADD COLUMN edge_type_faf TEXT DEFAULT 'attack';

ALTER TABLE argument_edges ADD COLUMN attack_weight REAL DEFAULT 1.0;

CREATE TABLE IF NOT EXISTS tutor_policy_q_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_level_bucket TEXT NOT NULL,
    tutor_action TEXT NOT NULL,
    times_selected INTEGER DEFAULT 0,
    total_reward REAL DEFAULT 0.0,
    avg_reward REAL DEFAULT 0.0,
    last_used_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qtable_bucket_action ON tutor_policy_q_table(student_level_bucket, tutor_action);

INSERT OR IGNORE INTO tutor_policy_q_table (student_level_bucket, tutor_action, avg_reward)
VALUES
  ('novice', 'ask_evidence', 0.5), ('novice', 'ask_reasoning', 0.4), ('novice', 'ask_clarification', 0.6),
  ('novice', 'ask_counterexample', 0.3), ('novice', 'ask_revision', 0.4), ('novice', 'narrow_scope', 0.5),
  ('novice', 'give_hint', 0.7), ('novice', 'request_text_reference', 0.5), ('novice', 'move_to_synthesis', 0.3),
  ('apprentice', 'ask_evidence', 0.5), ('apprentice', 'ask_reasoning', 0.5), ('apprentice', 'ask_clarification', 0.5),
  ('apprentice', 'ask_counterexample', 0.4), ('apprentice', 'ask_revision', 0.5), ('apprentice', 'narrow_scope', 0.4),
  ('apprentice', 'give_hint', 0.6), ('apprentice', 'request_text_reference', 0.5), ('apprentice', 'move_to_synthesis', 0.4),
  ('journeyman', 'ask_evidence', 0.5), ('journeyman', 'ask_reasoning', 0.6), ('journeyman', 'ask_clarification', 0.4),
  ('journeyman', 'ask_counterexample', 0.5), ('journeyman', 'ask_revision', 0.5), ('journeyman', 'narrow_scope', 0.3),
  ('journeyman', 'give_hint', 0.4), ('journeyman', 'request_text_reference', 0.5), ('journeyman', 'move_to_synthesis', 0.5),
  ('expert', 'ask_evidence', 0.5), ('expert', 'ask_reasoning', 0.7), ('expert', 'ask_clarification', 0.3),
  ('expert', 'ask_counterexample', 0.6), ('expert', 'ask_revision', 0.5), ('expert', 'narrow_scope', 0.2),
  ('expert', 'give_hint', 0.3), ('expert', 'request_text_reference', 0.4), ('expert', 'move_to_synthesis', 0.6),
  ('master', 'ask_evidence', 0.4), ('master', 'ask_reasoning', 0.7), ('master', 'ask_clarification', 0.2),
  ('master', 'ask_counterexample', 0.7), ('master', 'ask_revision', 0.5), ('master', 'narrow_scope', 0.2),
  ('master', 'give_hint', 0.2), ('master', 'request_text_reference', 0.3), ('master', 'move_to_synthesis', 0.7);

CREATE TABLE IF NOT EXISTS daily_question_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    question_type TEXT NOT NULL DEFAULT 'training',
    scenario TEXT NOT NULL,
    challenge TEXT,
    expected_tensions TEXT,
    difficulty TEXT DEFAULT 'intermediate',
    bkt_source_concept TEXT,
    source_session_ids TEXT,
    times_used INTEGER DEFAULT 0,
    avg_score REAL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_qbank_category ON daily_question_bank(category, is_active);

CREATE INDEX IF NOT EXISTS idx_qbank_bkt ON daily_question_bank(bkt_source_concept);

CREATE INDEX IF NOT EXISTS idx_qbank_created ON daily_question_bank(created_at DESC);

CREATE TABLE IF NOT EXISTS semantic_entropy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    sample_scores TEXT NOT NULL,
    mean_score REAL NOT NULL,
    std_dev REAL NOT NULL,
    entropy_flag TEXT DEFAULT 'normal',
    action_taken TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_entropy_session ON semantic_entropy_log(session_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_entropy_flag ON semantic_entropy_log(entropy_flag);
