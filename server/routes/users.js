import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { listByRole } from '../services/users.js';

export const usersRouter = Router();

usersRouter.use(requireSuperAdmin);

usersRouter.get('/', (req, res) => {
  const role = req.query?.role;
  if (!role) return res.status(400).json({ error: 'role_required' });
  res.json({
    users: listByRole(db, String(role)).map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      role: u.role,
    })),
  });
});
