-- 0009_recurring_schedules.sql — Stage 8: recurring billing.
-- Per-project monthly schedule. Each due row drops a draft invoice (never
-- auto-sends) for the super-admin to review. Two modes:
--   - 'time_and_expenses' sweeps unbilled time + expenses through today.
--   - 'fixed_milestone' inserts a milestone row first (services/milestones.js)
--     and then drafts so the new milestone gets pulled into a single line.
--
-- Hourly in-process tick (server/timers/recurringTick.js) calls
-- services/recurring.js#runDue. day_of_month is constrained to 1..28 to
-- avoid month-end drift; advance is one calendar month per run.
--
-- auto_stripe_link toggles best-effort stripeLinks.generate after the draft
-- transaction commits; failures land in error_log + audit status='partial'
-- but the draft still drops. Gated on services/stripeLinks.js#isEnabled().

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  mode                TEXT    NOT NULL CHECK (mode IN ('time_and_expenses','fixed_milestone')),
  cadence             TEXT    NOT NULL CHECK (cadence = 'monthly'),
  day_of_month        INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  fixed_amount_cents  INTEGER,                                   -- required at service layer when mode='fixed_milestone'
  fixed_description   TEXT,                                      -- required at service layer when mode='fixed_milestone'
  auto_stripe_link    INTEGER NOT NULL DEFAULT 0 CHECK (auto_stripe_link IN (0,1)),
  next_run_date       TEXT    NOT NULL,                          -- YYYY-MM-DD
  last_run_date       TEXT,
  last_invoice_id     INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  paused_at           TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recurring_due
  ON recurring_schedules(next_run_date)
  WHERE paused_at IS NULL;
