-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS hybrid_kt_states (
  user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS argunet_da_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user_id TEXT,
  turn_number INTEGER,
  utterance TEXT NOT NULL,
  act_type TEXT NOT NULL,
  confidence REAL,
  illocutionary_force REAL,
  argunet_score REAL,
  pipeline_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_argunet_session ON argunet_da_logs(session_id);

CREATE INDEX IF NOT EXISTS idx_argunet_user ON argunet_da_logs(user_id);

CREATE TABLE IF NOT EXISTS oamf_pipeline_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  xaif_graph_json TEXT,
  node_count INTEGER DEFAULT 0,
  edge_count INTEGER DEFAULT 0,
  da_distribution_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oamf_session ON oamf_pipeline_cache(session_id);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
  ('art_photography', 'art_visual', '사진/영상', 'Photography & Film', '📷', 2, 1),
  ('art_music_theory', 'art_performing', '음악 이론', 'Music Theory', '🎵', 2, 1),
  ('art_dance', 'art_performing', '무용/움직임', 'Dance & Movement', '💃', 2, 2),
  ('sci_quantum', 'sci_natural', '양자역학', 'Quantum Mechanics', '⚛️', 2, 1),
  ('sci_neuroscience', 'sci_natural', '뇌과학', 'Neuroscience', '🧠', 2, 2),
  ('sci_ecology', 'sci_natural', '생태학', 'Ecology', '🌿', 2, 3),
  ('sci_ai_ml', 'sci_computer', 'AI/머신러닝', 'AI & Machine Learning', '🤖', 2, 1),
  ('sci_data_science', 'sci_computer', '데이터 사이언스', 'Data Science', '📊', 2, 2),
  ('soc_international', 'ss_political', '국제관계', 'International Relations', '🌍', 2, 1),
  ('soc_law', 'ss_political', '법학', 'Legal Studies', '⚖️', 2, 2),
  ('biz_startup', 'biz_strategy', '스타트업/창업', 'Startups & Entrepreneurship', '🚀', 2, 1),
  ('biz_fintech', 'biz_finance', '핀테크/블록체인', 'FinTech & Blockchain', '₿', 2, 1),
  ('biz_esg', 'biz_strategy', 'ESG/지속가능경영', 'ESG & Sustainability', '♻️', 2, 2),
  ('psy_positive', 'psych_clinical', '긍정심리학', 'Positive Psychology', '😊', 2, 1),
  ('psy_neurocog', 'psych_cognitive', '신경인지과학', 'Neurocognitive Science', '🔬', 2, 1),
  ('phil_logic', 'phil_western', '형식 논리학', 'Formal Logic', '🔢', 2, 5),
  ('phil_bioethics', 'phil_applied', '생명윤리', 'Bioethics', '🧬', 2, 1);
