// /cron/* — system-level endpoints that don't ride a session cookie.
// Mounted in server/index.js BEFORE the global csrf + loadSessionFromCookie
// middleware, parallel to the public invoice viewer at /i/*.
//
// POST /cron/recurring-tick is the external trigger for services/recurring.js
// when fly.io is running with auto_stop_machines = "stop". The GitHub Action
// at .github/workflows/recurring-tick.yml fires it on a daily cron and
// authenticates with a TOTP code computed from RECURRING_TICK_SECRET. The
// HTTP request itself wakes a stopped machine via auto_start_machines = true,
// runs the tick, and the machine sleeps again afterward.
//
// Runs through maybeRunDue (not runDue) so it shares the _recurring_meta
// atomic claim with the wake-on-activity hook in routes/me.js. Without the
// shared claim, a daily cron firing while wake-on-activity is mid-run could
// double-process a schedule (both runDue calls SELECT the same not-yet-
// advanced row, then both runOne transactions insert + advance). The claim
// makes the second caller a no-op. Recurring schedules become due at midnight
// UTC and stay due all day, so a cron-no-op-because-wake-already-ran is
// safe — there's nothing left to do.

import { Router } from 'express';
import { db } from '../db/connection.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { verifyTotp } from '../lib/totp.js';
import { makeRateLimiter, clientIp } from '../middleware/rateLimit.js';
import * as recurring from '../services/recurring.js';

export const cronRouter = Router();

// 6 attempts/min/IP — generous enough for retries, tight enough to
// blunt brute-force against a 6-digit TOTP code (which only changes every
// 30s anyway).
const tickRateLimiter = makeRateLimiter({
  capacity: 6,
  refillPerSec: 6 / 60,
  name: 'cron-tick',
});

const HEADER = 'x-recurring-tick';

cronRouter.post(
  '/recurring-tick',
  tickRateLimiter.middleware((req) => clientIp(req)),
  async (req, res) => {
    if (!config.recurringTickSecret) {
      return res.status(503).json({ error: 'tick_disabled' });
    }
    const code = String(req.get(HEADER) || '').trim();
    if (!code) return res.status(401).json({ error: 'missing_code' });
    if (!verifyTotp(config.recurringTickSecret, code)) {
      logger.warn(
        { ip: clientIp(req), ua: req.get('user-agent') || '' },
        'cron tick: invalid TOTP'
      );
      return res.status(401).json({ error: 'invalid_code' });
    }
    try {
      // null = the atomic claim was held by another trigger in the last
      // interval (typically wake-on-activity firing within the past hour).
      // Surface it as 200 with an empty results array so the GH Action
      // doesn't alarm — this is correct no-op behavior, not a failure.
      const results = await recurring.maybeRunDue(db);
      if (results === null) {
        logger.info('cron tick: claim held by recent trigger, skipping');
        return res.json({ results: [], skipped: true });
      }
      logger.info({ ran: results.length }, 'cron tick ran');
      return res.json({ results });
    } catch (err) {
      logger.error({ err }, 'cron tick crashed');
      return res.status(500).json({ error: 'tick_failed' });
    }
  }
);

// Exported for tests that want to reset the rate limiter between cases.
export const _tickRateLimiter = tickRateLimiter;
