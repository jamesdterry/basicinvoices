-- 0004_time_entries.sql — Stage 3: time entries.
-- Manual decimal-hour logs by an active project member. Locks (becomes
-- read-only) once attached to an invoice via invoice_id.
--
-- invoice_id has no FK declaration here: the invoices table doesn't exist
-- until Stage 5, and with foreign_keys=ON SQLite refuses INSERTs against a
-- table whose declared parent is missing — even when the FK column is NULL.
-- The Stage 5 migration will rebuild this table to add the real FK
-- (REFERENCES invoices(id) ON DELETE SET NULL). Until then, the lock
-- semantics live in services/timeEntries.js.

CREATE TABLE IF NOT EXISTS time_entries (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  entry_date  TEXT    NOT NULL,                        -- YYYY-MM-DD
  hours       REAL    NOT NULL CHECK (hours > 0),
  description TEXT    NOT NULL,
  invoice_id  INTEGER,                                 -- FK added in Stage 5
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_entries_project_date ON time_entries(project_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_date    ON time_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_project_inv  ON time_entries(project_id, invoice_id);
