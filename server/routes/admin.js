// Stage 8 — admin endpoints (super-admin only). Currently just the manual
// "process all due recurring schedules" trigger; mounted under /api/admin in
// server/index.js. Future ops endpoints (e.g. error_log viewers) can sit
// here alongside.

import { Router } from 'express';
import { db } from '../db/connection.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import * as recurring from '../services/recurring.js';

export const adminRouter = Router();

adminRouter.get('/recurring', requireSuperAdmin, (req, res) => {
  res.json({ schedules: recurring.listAll(db, req.user) });
});

adminRouter.post('/recurring/run-now', requireSuperAdmin, async (_req, res) => {
  // runDue resolves SUPER_ADMIN_EMAIL → user internally for actor attribution
  // (see services/recurring.js). The route auth check above is the
  // gatekeeper; the resolved actor is what audit rows + invoices.created_by
  // show. Returns the per-schedule summary so the UI can render results.
  const results = await recurring.runDue(db);
  res.json({ results });
});
