import { Router } from 'express';
import { requireUser } from '../middleware/requireUser.js';
import { isEnabled as stripeEnabled } from '../services/stripeLinks.js';

export const meRouter = Router();

meRouter.get('/', requireUser, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    display_name: req.user.display_name,
    role: req.user.role,
    // Stage 7A — flips on when STRIPE_SECRET_KEY is set; the SPA reads
    // state.currentUser.stripe_enabled to show/hide the Generate button.
    stripe_enabled: stripeEnabled(),
  });
});
