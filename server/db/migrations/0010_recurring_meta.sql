-- 0010_recurring_meta.sql — Stage 8.5: atomic tick-claim row.
--
-- The recurring tick now has multiple potential triggers (in-process timer,
-- wake-on-activity from /api/me, TOTP-gated /cron/recurring-tick from a
-- GitHub Action). Each one calls services/recurring.js#maybeRunDue, which
-- atomically claims the next "tick window" via:
--
--   UPDATE _recurring_meta
--      SET last_tick_at = ?     -- now
--    WHERE id = 1 AND last_tick_at < ?    -- now - intervalMs
--
-- The WHERE clause makes the claim race-free: only the first writer in a
-- window matches. Everyone else's UPDATE returns 0 changes and they bail.
-- Survives restarts because the row is in the file-backed DB.

CREATE TABLE IF NOT EXISTS _recurring_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_tick_at  TEXT    NOT NULL
);

INSERT OR IGNORE INTO _recurring_meta (id, last_tick_at)
  VALUES (1, '1970-01-01T00:00:00.000Z');
