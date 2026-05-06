// Stripe Payment Links service. Optional integration — gated on
// `config.stripeSecretKey`. When the key is unset, `isEnabled()` is false,
// `generate()` returns 'stripe_disabled', and `deactivate()` no-ops.
//
// Pairs with Stage 7's `services/invoices.js#setStripeLink` (manual paste).
// The Stage 7A "Generate" path mints a link via Stripe's API and persists
// both `stripe_payment_link_url` and `stripe_payment_link_id` (the Stripe
// `plink_xxx`). We keep the id so:
//   1) `invoices.voidInvoice` can fire-and-forget `deactivate(...)` to flip
//      the link to inactive — clients with the URL can't pay anymore.
//   2) Repeated Generate clicks are idempotent unless { force: true }.
//
// SDK errors NEVER throw out of this module. Any failure is caught,
// written to the `error_log` table for ops review, logged via pino, and
// returned as `{ ok: false, reason: 'stripe_failure' }` — so Express
// handlers can surface it as a 502 without a try/catch.

import Stripe from 'stripe';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logAction } from './audit.js';

let client = null;

function getClient() {
  if (!config.stripeSecretKey) return null;
  if (client) return client;
  client = new Stripe(config.stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
  return client;
}

export function isEnabled() {
  return Boolean(config.stripeSecretKey);
}

// For tests: drop the cached client so a re-mocked Stripe constructor or a
// toggled STRIPE_SECRET_KEY takes effect on the next getClient() call.
export function _resetClient() {
  client = null;
}

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function getInvoiceRow(db, id) {
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name, p.name AS project_name
         FROM invoices i
         JOIN clients c  ON c.id = i.client_id
         JOIN projects p ON p.id = i.project_id
        WHERE i.id = ?`
    )
    .get(id);
}

function rowToInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    client_id: row.client_id,
    project_id: row.project_id,
    client_name: row.client_name ?? null,
    project_name: row.project_name ?? null,
    status: row.status,
    issue_date: row.issue_date,
    due_date: row.due_date,
    total_cents: row.total_cents,
    amount_paid_cents: row.amount_paid_cents,
    stripe_payment_link_url: row.stripe_payment_link_url,
    stripe_payment_link_id: row.stripe_payment_link_id,
    public_token: row.public_token,
    public_token_revoked_at: row.public_token_revoked_at,
    sent_at: row.sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function logErrorRow(db, { message, stack, route, userId, meta }) {
  try {
    db.prepare(
      `INSERT INTO error_log (at, level, message, stack, route, user_id, meta_json)
       VALUES (?, 'error', ?, ?, ?, ?, ?)`
    ).run(
      nowIso(),
      message,
      stack || null,
      route || null,
      userId ?? null,
      meta ? JSON.stringify(meta) : null
    );
  } catch (err) {
    // If the error_log itself is unavailable, log to pino and move on. We
    // never want a logging failure to mask the original Stripe failure.
    logger.error({ err }, 'error_log insert failed');
  }
}

export async function generate(db, invoiceId, { actor, ip, force = false } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  if (!isEnabled()) return { ok: false, reason: 'stripe_disabled' };

  const existing = getInvoiceRow(db, invoiceId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft' && existing.status !== 'sent') {
    return { ok: false, reason: 'wrong_status' };
  }

  // Idempotency — repeated clicks on Generate are a no-op once a link
  // exists. Use { force: true } from the UI to deliberately replace it.
  if (existing.stripe_payment_link_id && !force) {
    return { ok: true, invoice: rowToInvoice(existing) };
  }

  const stripe = getClient();
  let link;
  try {
    link = await stripe.paymentLinks.create({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: existing.total_cents,
            product_data: {
              name: `Invoice ${existing.number} — ${existing.client_name} — ${existing.project_name}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        invoice_id: String(invoiceId),
        invoice_number: existing.number,
      },
    });
  } catch (err) {
    logger.error(
      { err, invoiceId, invoiceNumber: existing.number },
      'stripe paymentLinks.create failed'
    );
    logErrorRow(db, {
      message: `stripe paymentLinks.create failed: ${err?.message || err}`,
      stack: err?.stack,
      route: 'POST /api/invoices/:id/stripe-link/generate',
      userId: actor.id,
      meta: { invoiceId, invoiceNumber: existing.number, stripeCode: err?.code },
    });
    return { ok: false, reason: 'stripe_failure' };
  }

  const at = nowIso();
  db.prepare(
    `UPDATE invoices
        SET stripe_payment_link_url = ?, stripe_payment_link_id = ?, updated_at = ?
      WHERE id = ?`
  ).run(link.url, link.id, at, invoiceId);

  logAction(db, {
    actorId: actor.id,
    action: 'invoice.generate_stripe_link',
    targetKind: 'invoice',
    targetId: invoiceId,
    summary: `Generated Stripe link for invoice ${existing.number} — ${existing.client_name}`,
    ip,
    changes: [
      {
        field: 'stripe_payment_link_url',
        oldValue: existing.stripe_payment_link_url,
        newValue: link.url,
      },
      {
        field: 'stripe_payment_link_id',
        oldValue: existing.stripe_payment_link_id,
        newValue: link.id,
      },
    ],
  });

  return { ok: true, invoice: rowToInvoice(getInvoiceRow(db, invoiceId)) };
}

// Best-effort. Called fire-and-forget from voidInvoice. Resolves regardless
// of outcome — the void is the source of truth, so a Stripe failure here
// must NOT roll the void back. Operator can deactivate manually in the
// dashboard if this fails.
export async function deactivate(db, invoiceId) {
  if (!isEnabled()) return { ok: false, reason: 'stripe_disabled' };

  const row = db
    .prepare('SELECT stripe_payment_link_id, number FROM invoices WHERE id = ?')
    .get(invoiceId);
  if (!row?.stripe_payment_link_id) return { ok: false, reason: 'no_link' };

  const stripe = getClient();
  try {
    await stripe.paymentLinks.update(row.stripe_payment_link_id, { active: false });
    return { ok: true };
  } catch (err) {
    logger.error(
      { err, invoiceId, linkId: row.stripe_payment_link_id },
      'stripe paymentLinks.update(active:false) failed'
    );
    logErrorRow(db, {
      message: `stripe paymentLinks deactivate failed: ${err?.message || err}`,
      stack: err?.stack,
      route: 'voidInvoice',
      userId: null,
      meta: { invoiceId, invoiceNumber: row.number, stripeCode: err?.code },
    });
    return { ok: false, reason: 'stripe_failure' };
  }
}
