-- 0003_clients_projects.sql — Stage 2 domain entities: clients, projects, project memberships.
-- Schema per DEVELOPMENT.md "Schema (table by table)".

CREATE TABLE IF NOT EXISTS clients (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  billing_address     TEXT,
  contact_email       TEXT,
  payment_terms_days  INTEGER NOT NULL DEFAULT 14,
  notes               TEXT,
  archived_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_archived ON clients(archived_at);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  code        TEXT,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (client_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_client   ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived_at);

CREATE TABLE IF NOT EXISTS project_members (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  bill_rate_cents  INTEGER NOT NULL,
  bill_rate_unit   TEXT NOT NULL DEFAULT 'hour' CHECK (bill_rate_unit = 'hour'),
  added_at         TEXT NOT NULL,
  added_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  removed_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_active
  ON project_members(project_id, user_id) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
