import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as expenses from '../services/expenses.js';

export const expensesRouter = Router();

expensesRouter.use(requireUser);
expensesRouter.use(requireSuperAdmin);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'project_not_found':
      return 404;
    case 'locked':
      return 409;
    default:
      return 400;
  }
}

expensesRouter.get('/', (req, res) => {
  const q = req.query || {};
  const entries = expenses.list(
    db,
    {
      projectId: q.project_id ?? q.projectId,
      from: q.from,
      to: q.to,
      includeLocked: q.include_locked === '1' || q.includeLocked === '1',
    },
    req.user
  );
  res.json({ entries });
});

expensesRouter.post('/', (req, res) => {
  const r = expenses.create(db, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.status(201).json({ entry: r.entry });
});

expensesRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = expenses.update(db, id, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});

expensesRouter.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = expenses.remove(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});
