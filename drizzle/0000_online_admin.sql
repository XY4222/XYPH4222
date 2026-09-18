CREATE TABLE IF NOT EXISTS admin_state (
  state_key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  model TEXT,
  role TEXT,
  code TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  input_chars INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_run_logs_at ON run_logs(at);
CREATE INDEX IF NOT EXISTS idx_run_logs_ok_at ON run_logs(ok, at);
