import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import {
  listAll,
  getById,
  createSubcontractor,
  updateSubcontractor,
  setDisabled,
} from '../services/users.js';
import { requestMagicLink } from '../services/auth.js';
import { logAction } from '../services/audit.js';

export const subcontractorsRouter = Router();

subcontractorsRouter.use(requireSuperAdmin);

const REASON_STATUS = {
  forbidden: 403,
  not_found: 404,
  email_taken: 409,
  disabled: 409,
};

function statusFor(reason) {
  return REASON_STATUS[reason] || 400;
}

function sendInvite(email, ip) {
  // Fire-and-forget. Failures are logged but never fail the route — the UI
  // exposes a "Resend invite" button for recovery.
  Promise.resolve()
    .then(() => requestMagicLink(db, { email, ip }))
    .catch((err) => {
      logger.error(
        { err: { message: err?.message, code: err?.code }, email },
        'subcontractor invite email failed'
      );
    });
}

subcontractorsRouter.get('/', (_req, res) => {
  res.json({ subcontractors: listAll(db) });
});

subcontractorsRouter.post('/', (req, res) => {
  const r = createSubcontractor(db, req.body || {}, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });

  sendInvite(r.user.email, clientIp(req));
  res.status(201).json({ user: r.user });
});

subcontractorsRouter.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const user = getById(db, id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({ user });
});

subcontractorsRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = updateSubcontractor(db, id, req.body || {}, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ user: r.user });
});

subcontractorsRouter.post('/:id/disable', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = setDisabled(db, id, true, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ user: r.user });
});

subcontractorsRouter.post('/:id/enable', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = setDisabled(db, id, false, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ user: r.user });
});

subcontractorsRouter.post('/:id/resend-invite', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const user = getById(db, id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (user.disabled_at) return res.status(409).json({ error: 'disabled' });

  logAction(db, {
    actorId: req.user.id,
    action: 'user.resend_invite',
    targetKind: 'user',
    targetId: user.id,
    summary: `Resent invite to ${user.email}`,
    ip: clientIp(req),
  });
  sendInvite(user.email, clientIp(req));
  res.status(202).json({ user });
});
