// Reports service (Stage 9). Read-only aggregation; super-admin only.
//
// paymentsReport groups payments by client OR by project over a closed
// [from, to] range on payments.received_date (cash basis). All payments
// are by definition recorded against invoices in status sent/paid (see
// services/payments.js#create wrong_status guard), so no extra status
// filter is needed — voided/draft invoices simply have no rows.
//
// Returns integer cents; the route layer adds a formatted dollars column
// when emitting CSV. USD only in v1.

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_GROUPS = new Set(['client', 'project']);

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

export function paymentsReport(db, { from, to, groupBy } = {}, viewer) {
  if (!isSuperAdmin(viewer)) return { ok: false, reason: 'forbidden' };

  const fromDate = String(from ?? '').trim();
  const toDate = String(to ?? '').trim();
  if (!DATE_RX.test(fromDate) || !DATE_RX.test(toDate)) {
    return { ok: false, reason: 'invalid_date' };
  }
  if (toDate < fromDate) return { ok: false, reason: 'invalid_range' };

  const group = String(groupBy ?? 'client');
  if (!VALID_GROUPS.has(group)) return { ok: false, reason: 'invalid_group' };

  const sql =
    group === 'client'
      ? `SELECT c.id   AS key,
                c.name AS label,
                COALESCE(SUM(pmt.amount_cents), 0) AS total_cents,
                COUNT(*) AS payment_count
           FROM payments pmt
           JOIN invoices i ON i.id = pmt.invoice_id
           JOIN clients  c ON c.id = i.client_id
          WHERE pmt.received_date BETWEEN ? AND ?
          GROUP BY c.id
          ORDER BY c.name COLLATE NOCASE`
      : `SELECT p.id AS key,
                c.name || ' — ' || p.name AS label,
                COALESCE(SUM(pmt.amount_cents), 0) AS total_cents,
                COUNT(*) AS payment_count
           FROM payments pmt
           JOIN invoices i ON i.id = pmt.invoice_id
           JOIN projects p ON p.id = i.project_id
           JOIN clients  c ON c.id = i.client_id
          WHERE pmt.received_date BETWEEN ? AND ?
          GROUP BY p.id
          ORDER BY label COLLATE NOCASE`;

  const rows = db
    .prepare(sql)
    .all(fromDate, toDate)
    .map((r) => ({
      key: r.key,
      label: r.label,
      totalCents: Number(r.total_cents),
      count: Number(r.payment_count),
    }));

  return { ok: true, rows, from: fromDate, to: toDate, groupBy: group };
}
