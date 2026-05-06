import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as payments from '../services/payments.js';

export const paymentsRouter = Router();

paymentsRouter.use(requireUser);
paymentsRouter.use(requireSuperAdmin);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'wrong_status':
    case 'has_payments':
      return 409;
    default:
      return 400;
  }
}

paymentsRouter.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const payment = payments.get(db, id, req.user);
  if (!payment) return res.status(404).json({ error: 'not_found' });
  res.json({ payment });
});

paymentsRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = payments.update(db, id, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ payment: r.payment, invoice: r.invoice });
});

paymentsRouter.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = payments.remove(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ payment: r.payment, invoice: r.invoice });
});
