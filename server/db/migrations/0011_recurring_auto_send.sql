-- 0011_recurring_auto_send.sql — Stage 8.6: opt-in auto-send for recurring drafts.
--
-- When auto_send = 1 on a schedule, services/recurring.js#runOne calls
-- invoices.send(...) immediately after createDraft (and after the optional
-- auto_stripe_link generation, so the email body sees the Payment Link).
-- send() failures (no client contact_email, SMTP error, etc.) are caught
-- inside runOne and surface as audit meta.send + meta.status = 'partial';
-- the draft persists for the operator to handle manually.
--
-- Additive nullable column with a CHECK constraint and DEFAULT 0 — no
-- table rebuild needed. Existing schedules default to off.

ALTER TABLE recurring_schedules
  ADD COLUMN auto_send INTEGER NOT NULL DEFAULT 0
    CHECK (auto_send IN (0, 1));
