-- 0006_invoices.sql — Stage 5: invoices + invoice_lines, plus the long-promised
-- FK on invoice_id for time_entries / expenses / milestones.
--
-- This migration does two things:
--
-- 1. Creates `invoices` (one row per bill to a client; v1 is one project per
--    invoice) and `invoice_lines` (line items snapshotted from time/expense/
--    milestone source rows at draft time).
--
-- 2. Table-rebuilds `time_entries`, `expenses`, and `milestones` to add the
--    real `invoice_id REFERENCES invoices(id) ON DELETE SET NULL` FK that the
--    Stage 3 + Stage 4 migrations had to defer (SQLite refuses INSERTs against
--    a child whose declared parent table doesn't exist, even with NULL FK
--    values; see 0004_time_entries.sql + 0005_expenses_milestones.sql for
--    details).
--
-- The runner in server/db/migrate.js wraps this script in a transaction and
-- toggles PRAGMA foreign_keys = OFF/ON around the wrapper. PRAGMA toggling
-- inside an open transaction is silently ignored by SQLite, which is why the
-- runner has to do it; this script can assume FKs are off and simply do the
-- 12-step ALTER TABLE rebuild dance described at
-- https://www.sqlite.org/lang_altertable.html#otheralter . The runner also
-- runs PRAGMA foreign_key_check before commit, so any rebuild that drops valid
-- FK targets surfaces immediately.

CREATE TABLE invoices (
  id                       INTEGER PRIMARY KEY,
  number                   TEXT    NOT NULL UNIQUE,           -- 'YYYY-NNNN'
  client_id                INTEGER NOT NULL REFERENCES clients(id)  ON DELETE RESTRICT,
  project_id               INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  status                   TEXT    NOT NULL CHECK (status IN ('draft','sent','paid','void')),
  issue_date               TEXT    NOT NULL,                  -- YYYY-MM-DD
  due_date                 TEXT    NOT NULL,                  -- YYYY-MM-DD
  period_start             TEXT,                              -- YYYY-MM-DD
  period_end               TEXT,                              -- YYYY-MM-DD
  subtotal_cents           INTEGER NOT NULL,
  total_cents              INTEGER NOT NULL,                  -- = subtotal in v1 (no tax)
  amount_paid_cents        INTEGER NOT NULL DEFAULT 0,
  notes                    TEXT,
  stripe_payment_link_url  TEXT,
  public_token             TEXT    NOT NULL UNIQUE,
  public_token_revoked_at  TEXT,                              -- ISO when revoked
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at                  TEXT,                              -- ISO when transitioned draft→sent
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
);

CREATE INDEX idx_invoices_status     ON invoices(status);
CREATE INDEX idx_invoices_client     ON invoices(client_id);
CREATE INDEX idx_invoices_project    ON invoices(project_id);
CREATE INDEX idx_invoices_issue_date ON invoices(issue_date);

CREATE TABLE invoice_lines (
  id              INTEGER PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind            TEXT    NOT NULL CHECK (kind IN ('time','expense','milestone')),
  source_id       INTEGER,                                    -- id in source table; NULL for ad-hoc
  description     TEXT    NOT NULL,
  quantity        REAL    NOT NULL,
  unit_rate_cents INTEGER NOT NULL,                           -- snapshotted at create
  amount_cents    INTEGER NOT NULL,
  sort_order      INTEGER NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entry_date      TEXT,                                       -- YYYY-MM-DD; NULL for non-time
  created_at      TEXT    NOT NULL
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id, sort_order);

-- Rebuild time_entries to add the real FK on invoice_id.
CREATE TABLE time_entries_new (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  entry_date  TEXT    NOT NULL,
  hours       REAL    NOT NULL CHECK (hours > 0),
  description TEXT    NOT NULL,
  invoice_id  INTEGER          REFERENCES invoices(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
INSERT INTO time_entries_new
  (id, project_id, user_id, entry_date, hours, description, invoice_id, created_at, updated_at)
  SELECT id, project_id, user_id, entry_date, hours, description, invoice_id, created_at, updated_at
    FROM time_entries;
DROP TABLE time_entries;
ALTER TABLE time_entries_new RENAME TO time_entries;
CREATE INDEX idx_time_entries_project_date ON time_entries(project_id, entry_date);
CREATE INDEX idx_time_entries_user_date    ON time_entries(user_id, entry_date);
CREATE INDEX idx_time_entries_project_inv  ON time_entries(project_id, invoice_id);

-- Rebuild expenses.
CREATE TABLE expenses_new (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  created_by   INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  expense_date TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  invoice_id   INTEGER          REFERENCES invoices(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
INSERT INTO expenses_new
  (id, project_id, created_by, expense_date, description, amount_cents, invoice_id, created_at, updated_at)
  SELECT id, project_id, created_by, expense_date, description, amount_cents, invoice_id, created_at, updated_at
    FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_project_date ON expenses(project_id, expense_date);
CREATE INDEX idx_expenses_project_inv  ON expenses(project_id, invoice_id);

-- Rebuild milestones.
CREATE TABLE milestones_new (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  created_by     INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  milestone_date TEXT    NOT NULL,
  description    TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  invoice_id     INTEGER          REFERENCES invoices(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
INSERT INTO milestones_new
  (id, project_id, created_by, milestone_date, description, amount_cents, invoice_id, created_at, updated_at)
  SELECT id, project_id, created_by, milestone_date, description, amount_cents, invoice_id, created_at, updated_at
    FROM milestones;
DROP TABLE milestones;
ALTER TABLE milestones_new RENAME TO milestones;
CREATE INDEX idx_milestones_project_date ON milestones(project_id, milestone_date);
CREATE INDEX idx_milestones_project_inv  ON milestones(project_id, invoice_id);
