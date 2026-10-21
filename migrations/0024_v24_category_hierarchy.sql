-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS category_hierarchy (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name_ko TEXT NOT NULL,
  name_en TEXT NOT NULL,
  icon TEXT DEFAULT '📚',
  level INTEGER DEFAULT 0,     sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (parent_id) REFERENCES category_hierarchy(id)
);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('philosophy', NULL, '철학', 'Philosophy', '🏛️', 0, 1),
('psychology', NULL, '심리학', 'Psychology', '🧠', 0, 2),
('arts', NULL, '예술', 'Arts', '🎨', 0, 3),
('science', NULL, '과학', 'Science', '🔬', 0, 4),
('social_science', NULL, '사회과학', 'Social Science', '🌍', 0, 5),
('business', NULL, '경영/경제', 'Business', '💼', 0, 6);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('phil_western', 'philosophy', '서양철학', 'Western Philosophy', '🏛️', 1, 1),
('phil_eastern', 'philosophy', '동양철학', 'Eastern Philosophy', '☯️', 1, 2),
('phil_applied', 'philosophy', '응용철학', 'Applied Philosophy', '⚖️', 1, 3);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('phil_ancient', 'phil_western', '고대철학', 'Ancient Philosophy', '🏛️', 2, 1),
('phil_medieval', 'phil_western', '중세철학', 'Medieval Philosophy', '⛪', 2, 2),
('phil_modern', 'phil_western', '근대철학', 'Modern Philosophy', '📜', 2, 3),
('phil_contemporary', 'phil_western', '현대철학', 'Contemporary Philosophy', '💡', 2, 4);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('psych_cognitive', 'psychology', '인지심리학', 'Cognitive Psychology', '🧠', 1, 1),
('psych_behavioral', 'psychology', '행동심리학', 'Behavioral Psychology', '🔍', 1, 2),
('psych_clinical', 'psychology', '임상심리학', 'Clinical Psychology', '🩺', 1, 3),
('psych_social', 'psychology', '사회심리학', 'Social Psychology', '👥', 1, 4),
('psych_educational', 'psychology', '교육심리학', 'Educational Psychology', '📚', 1, 5);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('art_visual', 'arts', '시각예술', 'Visual Arts', '🎨', 1, 1),
('art_performing', 'arts', '공연예술', 'Performing Arts', '🎭', 1, 2),
('art_media', 'arts', '미디어아트', 'Media Arts', '🎬', 1, 3),
('art_theory', 'arts', '예술이론', 'Art Theory', '📖', 1, 4);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('sci_natural', 'science', '자연과학', 'Natural Science', '🔬', 1, 1),
('sci_formal', 'science', '형식과학', 'Formal Science', '📐', 1, 2),
('sci_computer', 'science', '컴퓨터과학', 'Computer Science', '💻', 1, 3),
('sci_engineering', 'science', '공학', 'Engineering', '⚙️', 1, 4);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('ss_economics', 'social_science', '경제학', 'Economics', '📊', 1, 1),
('ss_political', 'social_science', '정치학', 'Political Science', '🗳️', 1, 2),
('ss_sociology', 'social_science', '사회학', 'Sociology', '🏘️', 1, 3),
('ss_education', 'social_science', '교육학', 'Education', '🎓', 1, 4);

INSERT OR IGNORE INTO category_hierarchy (id, parent_id, name_ko, name_en, icon, level, sort_order) VALUES
('biz_strategy', 'business', '경영전략', 'Business Strategy', '🎯', 1, 1),
('biz_marketing', 'business', '마케팅', 'Marketing', '📣', 1, 2),
('biz_finance', 'business', '재무', 'Finance', '💰', 1, 3),
('biz_hr', 'business', '인사관리', 'Human Resources', '👔', 1, 4);
