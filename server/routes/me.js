import { Router } from 'express';
import { requireUser } from '../middleware/requireUser.js';

export const meRouter = Router();

meRouter.get('/', requireUser, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    display_name: req.user.display_name,
    role: req.user.role,
  });
});
