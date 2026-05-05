import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as clients from '../services/clients.js';

export const clientsRouter = Router();

clientsRouter.use(requireSuperAdmin);

clientsRouter.get('/', (req, res) => {
  const includeArchived = req.query?.include_archived === '1';
  res.json({ clients: clients.list(db, { includeArchived }) });
});

clientsRouter.post('/', (req, res) => {
  const r = clients.create(db, req.body || {}, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.status(201).json({ client: r.client });
});

clientsRouter.get('/:id', (req, res) => {
  const client = clients.get(db, Number.parseInt(req.params.id, 10));
  if (!client) return res.status(404).json({ error: 'not_found' });
  res.json({ client });
});

clientsRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = clients.update(db, id, req.body || {}, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) {
    return res.status(r.reason === 'not_found' ? 404 : 400).json({ error: r.reason });
  }
  res.json({ client: r.client });
});

clientsRouter.post('/:id/archive', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = clients.archive(db, id, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(404).json({ error: r.reason });
  res.json({ client: r.client });
});

clientsRouter.post('/:id/unarchive', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = clients.unarchive(db, id, { actorId: req.user.id, ip: clientIp(req) });
  if (!r.ok) return res.status(404).json({ error: r.reason });
  res.json({ client: r.client });
});
