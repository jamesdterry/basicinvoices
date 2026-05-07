import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import * as reports from '../services/reports.js';
import { toCsv } from '../lib/csv.js';

export const reportsRouter = Router();

reportsRouter.use(requireUser);
reportsRouter.use(requireSuperAdmin);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    default:
      return 400;
  }
}

function formatDollars(cents) {
  return (Number(cents) / 100).toFixed(2);
}

reportsRouter.get('/payments', (req, res) => {
  const { from, to } = req.query;
  const groupBy = req.query.groupBy || 'client';
  const format = req.query.format === 'csv' ? 'csv' : 'json';

  const r = reports.paymentsReport(db, { from, to, groupBy }, req.user);
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });

  if (format === 'csv') {
    const headers = ['key', 'label', 'total_cents', 'total_dollars', 'payment_count'];
    const rows = r.rows.map((row) => [
      row.key,
      row.label,
      row.totalCents,
      formatDollars(row.totalCents),
      row.count,
    ]);
    res.type('text/csv');
    res.set(
      'Content-Disposition',
      `attachment; filename="payments-${r.groupBy}-${r.from}-${r.to}.csv"`
    );
    return res.send(toCsv(headers, rows));
  }

  res.json({ rows: r.rows, from: r.from, to: r.to, groupBy: r.groupBy });
});
