import { db } from '../db/connection.js';
import { logger } from '../logger.js';

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 30;

let timer = null;

function pruneOnce() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * HOUR_MS).toISOString();
  const result = db.prepare('DELETE FROM error_log WHERE at < ?').run(cutoff);
  if (result.changes > 0) {
    logger.info({ pruned: result.changes, cutoff }, 'error_log pruned');
  }
}

export function startPruneErrorsTimer({ intervalMs = HOUR_MS } = {}) {
  if (timer) return timer;
  pruneOnce();
  timer = setInterval(pruneOnce, intervalMs);
  timer.unref?.();
  return timer;
}

export function stopPruneErrorsTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export { pruneOnce };
