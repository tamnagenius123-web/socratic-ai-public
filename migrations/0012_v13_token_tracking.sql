-- Public fresh-database derivative: schema and reviewed product catalogs only.
-- Historical row backfills and bootstrap user are excluded; not a production upgrade path.
CREATE TABLE IF NOT EXISTS token_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT,
  turn_number INTEGER NOT NULL,
  
     call_type TEXT NOT NULL,              model_used TEXT NOT NULL,             
     prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  
     estimated_credits REAL DEFAULT 0,     
     latency_ms INTEGER DEFAULT 0,        is_fallback INTEGER DEFAULT 0,       is_cached INTEGER DEFAULT 0,         
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS token_usage_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,                  model TEXT NOT NULL,
  
  total_calls INTEGER DEFAULT 0,
  total_prompt_tokens INTEGER DEFAULT 0,
  total_completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  total_estimated_credits REAL DEFAULT 0,
  fallback_count INTEGER DEFAULT 0,
  avg_latency_ms REAL DEFAULT 0,
  
  PRIMARY KEY (user_id, date, model)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage_log(session_id);

CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_log(user_id);

CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage_log(created_at);

CREATE INDEX IF NOT EXISTS idx_token_daily_user ON token_usage_daily(user_id, date);

CREATE INDEX IF NOT EXISTS idx_token_daily_date ON token_usage_daily(date);
