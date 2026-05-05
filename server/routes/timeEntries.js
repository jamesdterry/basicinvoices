import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireUser } from '../middleware/requireUser.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as timeEntries from '../services/timeEntries.js';

export const timeEntriesRouter = Router();

timeEntriesRouter.use(requireUser);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
    case 'not_member':
      return 403;
    case 'not_found':
    case 'project_not_found':
    case 'unknown_user':
      return 404;
    case 'locked':
      return 409;
    default:
      return 400;
  }
}

timeEntriesRouter.get('/', (req, res) => {
  const q = req.query || {};
  const entries = timeEntries.list(
    db,
    {
      projectId: q.project_id ?? q.projectId,
      userId: q.user_id ?? q.userId,
      from: q.from,
      to: q.to,
      includeLocked: q.include_locked === '1' || q.includeLocked === '1',
    },
    req.user
  );
  res.json({ entries });
});

timeEntriesRouter.post('/', (req, res) => {
  const r = timeEntries.create(db, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.status(201).json({ entry: r.entry });
});

timeEntriesRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = timeEntries.update(db, id, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});

timeEntriesRouter.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = timeEntries.remove(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ entry: r.entry });
});
