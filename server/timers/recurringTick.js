// Hourly in-process recurring billing tick. Reads from recurring_schedules
// and drops a draft invoice for each due, non-paused project. Mirrors the
// shape of timers/pruneErrors.js. Gated on !config.isTest in server/index.js.
//
// The boot tick fires once immediately so a redeploy/restart catches any
// schedules that came due while the machine was down. fly.toml runs with
// min_machines_running = 1 so the timer keeps firing in prod.

import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import * as recurring from '../services/recurring.js';

const HOUR_MS = 60 * 60 * 1000;
let timer = null;

async function tick() {
  try {
    // maybeRunDue self-gates via the _recurring_meta atomic claim. With
    // min_machines_running = 0 in production, multiple trigger paths
    // (this timer, wake-on-activity, GitHub Action via /cron/recurring-tick)
    // can fire close together; the claim prevents double-runs.
    const results = await recurring.maybeRunDue(db);
    if (results && results.length) {
      logger.info({ ran: results.length }, 'recurring tick ran');
    }
  } catch (err) {
    // runDue catches per-schedule errors itself, so reaching here means
    // something at the harness level (e.g. resolveSuperAdmin lookup) blew up.
    logger.error({ err }, 'recurring tick crashed');
  }
}

export function startRecurringTickTimer({ intervalMs = HOUR_MS } = {}) {
  if (timer) return timer;
  // Fire-and-forget the boot tick — we don't want to block app startup.
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

export function stopRecurringTickTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export { tick };
