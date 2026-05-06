-- 0008_invoices_stripe_link_id.sql — Stage 7A: programmatic Stripe links.
-- Persist the Payment Link's Stripe id (plink_xxx) alongside its URL so we
-- can deactivate the link on invoice void and detect "already minted" on
-- repeat Generate clicks. ALTER TABLE ADD COLUMN is the one ergonomic case
-- in SQLite — additive, nullable, no FK/CHECK, so no table-rebuild dance.

ALTER TABLE invoices ADD COLUMN stripe_payment_link_id TEXT;
