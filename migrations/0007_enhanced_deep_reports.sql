-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
ALTER TABLE session_deep_reports ADD COLUMN growth_trajectory TEXT;

ALTER TABLE session_deep_reports ADD COLUMN strengths_json TEXT;

ALTER TABLE session_deep_reports ADD COLUMN weaknesses_json TEXT;

ALTER TABLE session_deep_reports ADD COLUMN completed_at INTEGER;

ALTER TABLE document_chunks ADD COLUMN char_start INTEGER DEFAULT 0;

ALTER TABLE document_chunks ADD COLUMN char_end INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS custom_rubrics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_by TEXT,
    rubric_json TEXT NOT NULL,              is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notification_log (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,                     event TEXT NOT NULL,                    session_id TEXT,
    user_id TEXT,
    payload TEXT,                           status TEXT DEFAULT 'pending',          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_notification_session ON notification_log(session_id);

CREATE INDEX IF NOT EXISTS idx_notification_type ON notification_log(type, status);
