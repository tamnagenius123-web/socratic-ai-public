-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS session_deep_reports (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT DEFAULT 'processing',       arg_graph_json TEXT,                    micro_metrics TEXT,                     prescriptive_feedback TEXT,             created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_deep_reports_session ON session_deep_reports(session_id);

CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,                          created_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE INDEX IF NOT EXISTS idx_chunks_book ON document_chunks(book_id);
