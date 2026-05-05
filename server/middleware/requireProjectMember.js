// 404 if the project doesn't exist; super-admin always passes; subs must have
// an active project_members row. Attaches req.project on success.

import { db } from '../db/connection.js';

export function requireProjectMember(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  const id = Number.parseInt(req.params?.id ?? req.params?.projectId, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });

  const project = db
    .prepare(
      `SELECT p.*, c.name AS client_name
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(id);
  if (!project) return res.status(404).json({ error: 'not_found' });

  if (req.user.role === 'super_admin') {
    req.project = project;
    return next();
  }

  const member = db
    .prepare(
      `SELECT id FROM project_members
        WHERE project_id = ? AND user_id = ? AND removed_at IS NULL
        LIMIT 1`
    )
    .get(id, req.user.id);
  if (!member) return res.status(403).json({ error: 'forbidden' });

  req.project = project;
  next();
}
