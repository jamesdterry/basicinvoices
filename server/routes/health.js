import { Router } from 'express';
import { db } from '../db/connection.js';

export const healthRouter = Router();

let bump, read;
function prepareOnce() {
  if (bump) return;
  bump = db.prepare(
    'INSERT INTO _health (id, bumped_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET bumped_at = excluded.bumped_at'
  );
  read = db.prepare('SELECT bumped_at FROM _health WHERE id = 1');
}

healthRouter.get('/', (_req, res) => {
  prepareOnce();
  const at = new Date().toISOString();
  bump.run(at);
  const row = read.get();
  res.json({ ok: true, bumped_at: row.bumped_at });
});
