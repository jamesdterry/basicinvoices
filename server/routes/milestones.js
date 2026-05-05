import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as milestones from '../services/milestones.js';

export const milestonesRouter = Router();

milestonesRouter.use(requireUser);
milestonesRouter.use(requireSuperAdmin);

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

milestonesRouter.get('/', (req, res) => {
  const q = req.query || {};
  const entries = milestones.list(
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

milestonesRouter.post('/', (req, res) => {
  const r = milestones.create(db, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.status(201).json({ entry: r.entry });
});

milestonesRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = milestones.update(db, id, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});

milestonesRouter.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = milestones.remove(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});
