import { Router } from 'express';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { requireUser } from '../middleware/requireUser.js';
import { clientIp } from '../middleware/rateLimit.js';
import { isEnabled as stripeEnabled } from '../services/stripeLinks.js';
import * as recurring from '../services/recurring.js';
import * as users from '../services/users.js';

export const meRouter = Router();

function meShape(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    stripe_enabled: stripeEnabled(),
  };
}

function statusFor(reason) {
  switch (reason) {
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    default:
      return 400;
  }
}

meRouter.get('/', requireUser, (req, res) => {
  res.json(meShape(req.user));

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

meRouter.patch('/', requireUser, (req, res) => {
  const r = users.updateProfile(db, req.user.id, req.body || {}, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json(meShape({ ...req.user, display_name: r.user.display_name }));
});
