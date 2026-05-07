-- 0013_client_contact_emails.sql — replace clients.contact_email (single TEXT)
-- with clients.contact_emails (JSON array of strings, NOT NULL DEFAULT '[]').
--
-- The runner toggles PRAGMA foreign_keys = OFF/ON around the wrapping
-- transaction (see 0006_invoices.sql for the precedent), so we can do the
-- standard SQLite table-rebuild dance.

CREATE TABLE clients_new (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  billing_address     TEXT,
  contact_emails      TEXT NOT NULL DEFAULT '[]',
  payment_terms_days  INTEGER NOT NULL DEFAULT 14,
  notes               TEXT,
  archived_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

INSERT INTO clients_new
  (id, name, billing_address, contact_emails, payment_terms_days, notes, archived_at, created_at, updated_at)
SELECT
  id,
  name,
  billing_address,
  CASE
    WHEN contact_email IS NULL OR trim(contact_email) = '' THEN '[]'
    ELSE json_array(trim(contact_email))
  END,
  payment_terms_days,
  notes,
  archived_at,
  created_at,
  updated_at
FROM clients;

DROP TABLE clients;
ALTER TABLE clients_new RENAME TO clients;
CREATE INDEX idx_clients_archived ON clients(archived_at);
