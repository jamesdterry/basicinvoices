-- 0002_users_sessions_auth.sql — users, sessions, magic-link tokens, audit log.
-- Schema per DEVELOPMENT.md "Schema (table by table)".

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT,
  role          TEXT NOT NULL CHECK (role IN ('super_admin', 'subcontractor')),
  disabled_at   TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE,
  token_hash    TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('login', 'password_reset')),
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  requested_ip  TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email_purpose
  ON magic_link_tokens(email COLLATE NOCASE, purpose);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   INTEGER,
  summary     TEXT NOT NULL,
  at          TEXT NOT NULL,
  ip          TEXT,
  meta_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_kind, target_id);

CREATE TABLE IF NOT EXISTS audit_changes (
  id        INTEGER PRIMARY KEY,
  audit_id  INTEGER NOT NULL REFERENCES admin_audit(id) ON DELETE CASCADE,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_changes_audit_id ON audit_changes(audit_id);
