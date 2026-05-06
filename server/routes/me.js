import { Router } from 'express';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { requireUser } from '../middleware/requireUser.js';
import { isEnabled as stripeEnabled } from '../services/stripeLinks.js';
import * as recurring from '../services/recurring.js';

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

  // Stage 8.5 — wake-on-activity recurring tick. /api/me is hit on every
  // app-shell load and after auth state changes, so it's a natural choke
  // point for "is the consultant working today? then run any due
  // schedules now." maybeRunDue is self-gating (atomic claim against
  // _recurring_meta), so this is cheap when nothing is due. Fire after
  // the response is sent so it never blocks the user. The GitHub Action
  // at .github/workflows/recurring-tick.yml is the safety net for periods
  // of inactivity.
  setImmediate(() => {
    recurring.maybeRunDue(db).catch((err) => {
      logger.error({ err }, 'wake-on-activity tick failed');
    });
  });
});
