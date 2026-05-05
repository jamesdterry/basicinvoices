-- 0001_init.sql — operational tables only. Auth, domain tables come in later migrations.

CREATE TABLE IF NOT EXISTS _health (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  bumped_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO _health (id, bumped_at) VALUES (1, '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  stack      TEXT,
  route      TEXT,
  user_id    INTEGER,
  meta_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_log_at ON error_log(at);
