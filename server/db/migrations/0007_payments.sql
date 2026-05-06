-- 0007_payments.sql — Stage 7: payments.
-- Records receipts against invoices. Every create/update/delete in
-- services/payments.js runs a recompute on invoices.amount_paid_cents and
-- flips status 'sent' → 'paid' once amount_paid >= total_cents (no
-- auto-revert from 'paid' on later deletion — operator handles refunds).
--
-- ON DELETE RESTRICT on invoice_id is intentional: services/invoices.js
-- voidInvoice + deleteDraft also guard with reason 'has_payments' so the
-- operator gets a 409 instead of a raw FK violation.

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  received_date TEXT    NOT NULL,                       -- YYYY-MM-DD
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  method        TEXT    NOT NULL,                       -- free text: stripe/ach/check/wire/cash/other
  reference     TEXT,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice       ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_received_date ON payments(received_date);
