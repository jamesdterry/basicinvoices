// Payments service. Super-admin only — subs never see invoices/payments.
//
// Stage 7 flow:
//   - create / update / remove each run inside a transaction that also
//     calls recomputeInvoiceTotals(invoice_id), which refreshes
//     invoices.amount_paid_cents and flips status 'sent' → 'paid' when
//     amount_paid >= total_cents.
//   - Status NEVER auto-reverts from 'paid' to 'sent' (operator decides
//     whether to void on a refund / deletion).
//   - Payments are only allowed on invoices with status IN ('sent','paid');
//     drafts and voided invoices reject with 'wrong_status'.
//   - Payments aren't lockable; the parent invoice's status is the gate.
//     The companion guard lives on services/invoices.js#voidInvoice +
//     deleteDraft, which return 'has_payments' (409) so deleting payments
//     is a deliberate operator step.

import { logAction } from './audit.js';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const PATCHABLE = ['received_date', 'amount_cents', 'method', 'reference', 'note'];

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

function rowToPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number ?? null,
    client_name: row.client_name ?? null,
    received_date: row.received_date,
    amount_cents: row.amount_cents,
    method: row.method,
    reference: row.reference,
    note: row.note,
    created_by: row.created_by,
    created_by_display_name: row.created_by_display_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRaw(db, id) {
  return db
    .prepare(
      `SELECT pmt.*,
              u.display_name AS created_by_display_name,
              i.number       AS invoice_number,
              c.name         AS client_name
         FROM payments pmt
    LEFT JOIN users u ON u.id = pmt.created_by
         JOIN invoices i ON i.id = pmt.invoice_id
         JOIN clients c  ON c.id = i.client_id
        WHERE pmt.id = ?`
    )
    .get(id);
}

function getInvoiceForPayment(db, invoiceId) {
  return db
    .prepare(
      `SELECT i.*, c.name AS client_name
         FROM invoices i
         JOIN clients c ON c.id = i.client_id
        WHERE i.id = ?`
    )
    .get(invoiceId);
}

function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Recomputes the parent invoice's amount_paid_cents and (only) flips its
// status sent → paid when fully covered. MUST be called inside a
// transaction; mutates the row in place. Returns the updated invoice row.
function recomputeInvoiceTotals(db, invoiceId) {
  const sumRow = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE invoice_id = ?')
    .get(invoiceId);
  const paid = Number(sumRow?.total ?? 0);

  const inv = db
    .prepare('SELECT id, status, total_cents FROM invoices WHERE id = ?')
    .get(invoiceId);
  if (!inv) return null;

  let nextStatus = inv.status;
  if (inv.status === 'sent' && paid >= inv.total_cents) {
    nextStatus = 'paid';
  }
  // Deliberate: paid → sent is NOT auto-reverted on partial refund/deletion.

  const at = nowIso();
  db.prepare(
    `UPDATE invoices
        SET amount_paid_cents = ?, status = ?, updated_at = ?
      WHERE id = ?`
  ).run(paid, nextStatus, at, invoiceId);

  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

function rowToInvoiceSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    total_cents: row.total_cents,
    amount_paid_cents: row.amount_paid_cents,
  };
}

export function create(db, input, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const invoiceId = Number.parseInt(input?.invoice_id ?? input?.invoiceId, 10);
  if (!Number.isInteger(invoiceId)) return { ok: false, reason: 'invoice_required' };

  const receivedDate = String(input?.received_date ?? input?.receivedDate ?? '').trim();
  if (!DATE_RX.test(receivedDate)) return { ok: false, reason: 'invalid_date' };

  const amountCents = parseAmount(input?.amount_cents ?? input?.amountCents);
  if (amountCents === null) return { ok: false, reason: 'invalid_amount' };

  const method = String(input?.method ?? '').trim();
  if (!method) return { ok: false, reason: 'method_required' };

  const reference = input?.reference == null || input.reference === ''
    ? null
    : String(input.reference).trim();
  const note = input?.note == null || input.note === ''
    ? null
    : String(input.note);

  const invoice = getInvoiceForPayment(db, invoiceId);
  if (!invoice) return { ok: false, reason: 'not_found' };
  if (invoice.status !== 'sent' && invoice.status !== 'paid') {
    return { ok: false, reason: 'wrong_status' };
  }

  const at = nowIso();

  const result = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payments
           (invoice_id, received_date, amount_cents, method, reference, note,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(invoiceId, receivedDate, amountCents, method, reference, note, actor.id, at, at);
    const paymentId = Number(info.lastInsertRowid);
    const updatedInvoice = recomputeInvoiceTotals(db, invoiceId);
    return { paymentId, invoice: updatedInvoice };
  })();

  const payment = rowToPayment(getRaw(db, result.paymentId));
  logAction(db, {
    actorId: actor.id,
    action: 'payment.create',
    targetKind: 'payment',
    targetId: result.paymentId,
    summary: `Payment recorded: ${invoice.client_name} — ${invoice.number}: ${formatMoney(amountCents)} via ${method} on ${receivedDate}`,
    ip,
  });

  return { ok: true, payment, invoice: rowToInvoiceSummary(result.invoice) };
}

export function update(db, id, patch, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const next = { ...existing };

  if (patch?.received_date !== undefined || patch?.receivedDate !== undefined) {
    const v = String(patch.received_date ?? patch.receivedDate ?? '').trim();
    if (!DATE_RX.test(v)) return { ok: false, reason: 'invalid_date' };
    next.received_date = v;
  }
  if (patch?.amount_cents !== undefined || patch?.amountCents !== undefined) {
    const v = parseAmount(patch.amount_cents ?? patch.amountCents);
    if (v === null) return { ok: false, reason: 'invalid_amount' };
    next.amount_cents = v;
  }
  if (patch?.method !== undefined) {
    const v = String(patch.method ?? '').trim();
    if (!v) return { ok: false, reason: 'method_required' };
    next.method = v;
  }
  if (patch?.reference !== undefined) {
    next.reference = patch.reference == null || patch.reference === ''
      ? null
      : String(patch.reference).trim();
  }
  if (patch?.note !== undefined) {
    next.note = patch.note == null || patch.note === '' ? null : String(patch.note);
  }

  const changes = PATCHABLE.filter((f) => existing[f] !== next[f]).map((f) => ({
    field: f,
    oldValue: existing[f],
    newValue: next[f],
  }));
  if (!changes.length) {
    return {
      ok: true,
      payment: rowToPayment(existing),
      invoice: rowToInvoiceSummary(
        db.prepare('SELECT * FROM invoices WHERE id = ?').get(existing.invoice_id)
      ),
    };
  }

  const at = nowIso();
  const updatedInvoice = db.transaction(() => {
    db.prepare(
      `UPDATE payments
          SET received_date = ?, amount_cents = ?, method = ?, reference = ?, note = ?, updated_at = ?
        WHERE id = ?`
    ).run(next.received_date, next.amount_cents, next.method, next.reference, next.note, at, id);
    return recomputeInvoiceTotals(db, existing.invoice_id);
  })();

  const after = getRaw(db, id);
  logAction(db, {
    actorId: actor.id,
    action: 'payment.update',
    targetKind: 'payment',
    targetId: id,
    summary: `Updated payment on ${after.client_name} — ${after.invoice_number}: ${formatMoney(after.amount_cents)} via ${after.method} on ${after.received_date}`,
    ip,
    changes,
  });

  return {
    ok: true,
    payment: rowToPayment(after),
    invoice: rowToInvoiceSummary(updatedInvoice),
  };
}

export function remove(db, id, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const existing = getRaw(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const updatedInvoice = db.transaction(() => {
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    return recomputeInvoiceTotals(db, existing.invoice_id);
  })();

  logAction(db, {
    actorId: actor.id,
    action: 'payment.delete',
    targetKind: 'payment',
    targetId: id,
    summary: `Deleted payment on ${existing.client_name} — ${existing.invoice_number}: ${formatMoney(existing.amount_cents)} via ${existing.method} on ${existing.received_date}`,
    ip,
  });

  return {
    ok: true,
    payment: rowToPayment(existing),
    invoice: rowToInvoiceSummary(updatedInvoice),
  };
}

export function list(db, { invoiceId } = {}, viewer) {
  if (!isSuperAdmin(viewer)) return [];
  const id = Number.parseInt(invoiceId, 10);
  if (!Number.isInteger(id)) return [];
  return db
    .prepare(
      `SELECT pmt.*,
              u.display_name AS created_by_display_name,
              i.number       AS invoice_number,
              c.name         AS client_name
         FROM payments pmt
    LEFT JOIN users u ON u.id = pmt.created_by
         JOIN invoices i ON i.id = pmt.invoice_id
         JOIN clients c  ON c.id = i.client_id
        WHERE pmt.invoice_id = ?
        ORDER BY pmt.received_date DESC, pmt.id DESC`
    )
    .all(id)
    .map(rowToPayment);
}

export function get(db, id, viewer) {
  if (!isSuperAdmin(viewer)) return null;
  const row = getRaw(db, id);
  return row ? rowToPayment(row) : null;
}

// Exposed for services/invoices.js to consult before void/delete.
export function invoiceHasPayments(db, invoiceId) {
  const row = db
    .prepare('SELECT 1 AS x FROM payments WHERE invoice_id = ? LIMIT 1')
    .get(invoiceId);
  return !!row;
}
