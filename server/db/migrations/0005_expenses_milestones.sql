-- 0005_expenses_milestones.sql — Stage 4: expenses + milestones.
-- Super-admin-only line-item sources. Each row locks (becomes read-only)
-- once attached to an invoice via invoice_id, mirroring time_entries.
--
-- invoice_id has no FK declaration here for the same reason it doesn't on
-- time_entries (see 0004_time_entries.sql): the invoices table doesn't
-- exist until Stage 5, and with foreign_keys=ON SQLite refuses INSERTs
-- against a table whose declared parent is missing — even when the FK
-- column is NULL. Stage 5's 0006_invoices.sql will table-rebuild all three
-- (time_entries, expenses, milestones) to add the real FK
-- (REFERENCES invoices(id) ON DELETE SET NULL). Until then, the lock
-- semantics live in services/expenses.js + services/milestones.js.

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  created_by   INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  expense_date TEXT    NOT NULL,                        -- YYYY-MM-DD
  description  TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  invoice_id   INTEGER,                                 -- FK added in Stage 5
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_project_date ON expenses(project_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_project_inv  ON expenses(project_id, invoice_id);

CREATE TABLE IF NOT EXISTS milestones (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  created_by     INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  milestone_date TEXT    NOT NULL,                        -- YYYY-MM-DD
  description    TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  invoice_id     INTEGER,                                 -- FK added in Stage 5
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_milestones_project_date ON milestones(project_id, milestone_date);
CREATE INDEX IF NOT EXISTS idx_milestones_project_inv  ON milestones(project_id, invoice_id);
