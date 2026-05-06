// Recurring billing service. Stage 8.
//
// Per-project monthly schedule. Each due row drops a draft invoice (never
// auto-sends) for the super-admin to review. Two modes:
//   - 'time_and_expenses' sweeps unbilled time + expenses through today via
//     services/invoices.js#createDraft.
//   - 'fixed_milestone' inserts a milestones row first
//     (services/milestones.js#create) then drafts so the new milestone gets
//     pulled into a single invoice line. One code path for both modes.
//
// Actor attribution: runDue() resolves SUPER_ADMIN_EMAIL → real user once per
// tick and uses that as the `actor` argument for invoices.createDraft /
// milestones.create / stripeLinks.generate. This keeps audit + created_by
// columns attributed to a real user. (DEVELOPMENT.md called for `id: null`,
// but milestones.created_by is NOT NULL with an inner JOIN on users; using a
// real user id avoids a schema rebuild and read-path changes.)
//
// runOne(...) is async because the optional auto-Stripe-link call is async.
// The DB work (fixed-milestone insert + invoice draft + schedule advance)
// runs inside a single sync transaction; the Stripe call is fired AFTER the
// transaction commits and never rolls back the draft.
//
// One schedule's failure does NOT block siblings — runDue catches per-row.

import { logger } from '../logger.js';
import { config } from '../config.js';
import { logAction } from './audit.js';
import * as invoices from './invoices.js';
import * as milestones from './milestones.js';
import * as stripeLinks from './stripeLinks.js';

const VALID_MODES = new Set(['time_and_expenses', 'fixed_milestone']);

function nowIso() {
  return new Date().toISOString();
}

function isSuperAdmin(actor) {
  return actor?.role === 'super_admin';
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Date helpers — operate on YYYY-MM-DD strings (UTC).

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatIsoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function todayIso(now = new Date()) {
  return formatIsoDate(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

// Adds `days` calendar days to an ISO date. Used to compute due dates from
// the project's payment_terms_days.
export function addDays(iso, days) {
  const { y, m, d } = parseIsoDate(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days));
  return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Returns the next ISO date with the given day-of-month that is ≥ today.
// dayOfMonth is constrained to 1..28 by the migration's CHECK.
export function computeFirstRunDate(todayIsoStr, dayOfMonth) {
  const { y, m, d } = parseIsoDate(todayIsoStr);
  if (d <= dayOfMonth) {
    return formatIsoDate(y, m, dayOfMonth);
  }
  if (m === 12) return formatIsoDate(y + 1, 1, dayOfMonth);
  return formatIsoDate(y, m + 1, dayOfMonth);
}

// Adds one calendar month to currentRunDate, keeping the day-of-month. Since
// dayOfMonth ≤ 28 (schema CHECK), no clamping is required.
export function advanceNextRunDate(currentRunDate, dayOfMonth) {
  const { y, m } = parseIsoDate(currentRunDate);
  if (m === 12) return formatIsoDate(y + 1, 1, dayOfMonth);
  return formatIsoDate(y, m + 1, dayOfMonth);
}

// ──────────────────────────────────────────────────────────────────────────
// error_log writer — same shape as services/stripeLinks.js#logErrorRow.

function logErrorRow(db, { message, stack, route, userId, meta }) {
  try {
    db.prepare(
      `INSERT INTO error_log (at, level, message, stack, route, user_id, meta_json)
       VALUES (?, 'error', ?, ?, ?, ?, ?)`
    ).run(
      nowIso(),
      message,
      stack || null,
      route || null,
      userId ?? null,
      meta ? JSON.stringify(meta) : null
    );
  } catch (err) {
    logger.error({ err }, 'recurring: error_log insert failed');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Row helpers.

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name ?? null,
    client_name: row.client_name ?? null,
    mode: row.mode,
    cadence: row.cadence,
    day_of_month: row.day_of_month,
    fixed_amount_cents: row.fixed_amount_cents,
    fixed_description: row.fixed_description,
    auto_stripe_link: row.auto_stripe_link === 1,
    next_run_date: row.next_run_date,
    last_run_date: row.last_run_date,
    last_invoice_id: row.last_invoice_id,
    paused_at: row.paused_at,
    paused: row.paused_at != null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRawByProjectId(db, projectId) {
  return db
    .prepare(
      `SELECT r.*, p.name AS project_name, c.name AS client_name
         FROM recurring_schedules r
         JOIN projects p ON p.id = r.project_id
         JOIN clients  c ON c.id = p.client_id
        WHERE r.project_id = ?`
    )
    .get(projectId);
}

function projectSummary(db, projectId) {
  return db
    .prepare(
      `SELECT p.id, p.name AS project_name, c.name AS client_name,
              c.payment_terms_days
         FROM projects p
         JOIN clients c ON c.id = p.client_id
        WHERE p.id = ?`
    )
    .get(projectId);
}

// ──────────────────────────────────────────────────────────────────────────
// Validation.

function parsePositiveCents(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function validateSetInput(input) {
  const mode = String(input?.mode ?? '').trim();
  if (!VALID_MODES.has(mode)) return { ok: false, reason: 'invalid_mode' };

  const dayOfMonth = Number.parseInt(input?.day_of_month ?? input?.dayOfMonth, 10);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    return { ok: false, reason: 'invalid_day_of_month' };
  }

  let fixedAmountCents = null;
  let fixedDescription = null;
  if (mode === 'fixed_milestone') {
    fixedAmountCents = parsePositiveCents(input?.fixed_amount_cents ?? input?.fixedAmountCents);
    if (fixedAmountCents === null) return { ok: false, reason: 'fixed_amount_required' };
    fixedDescription = String(input?.fixed_description ?? input?.fixedDescription ?? '').trim();
    if (!fixedDescription) return { ok: false, reason: 'fixed_description_required' };
  }

  const autoStripeLink =
    input?.auto_stripe_link === true ||
    input?.auto_stripe_link === 1 ||
    input?.autoStripeLink === true ||
    input?.autoStripeLink === 1
      ? 1
      : 0;

  return {
    ok: true,
    parsed: { mode, dayOfMonth, fixedAmountCents, fixedDescription, autoStripeLink },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Public API.

export function setSchedule(db, projectId, input, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const pid = Number.parseInt(projectId, 10);
  if (!Number.isInteger(pid)) return { ok: false, reason: 'project_required' };

  const project = projectSummary(db, pid);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const v = validateSetInput(input);
  if (!v.ok) return v;
  const { mode, dayOfMonth, fixedAmountCents, fixedDescription, autoStripeLink } = v.parsed;

  const existing = getRawByProjectId(db, pid);
  const at = nowIso();

  if (!existing) {
    const nextRun = computeFirstRunDate(todayIso(), dayOfMonth);
    db.prepare(
      `INSERT INTO recurring_schedules
         (project_id, mode, cadence, day_of_month, fixed_amount_cents,
          fixed_description, auto_stripe_link, next_run_date,
          created_at, updated_at)
       VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pid,
      mode,
      dayOfMonth,
      fixedAmountCents,
      fixedDescription,
      autoStripeLink,
      nextRun,
      at,
      at
    );

    logAction(db, {
      actorId: actor.id,
      action: 'recurring.set',
      targetKind: 'recurring_schedule',
      targetId: pid,
      summary: `Set recurring schedule for ${project.client_name} — ${project.project_name} (${mode}, day ${dayOfMonth})`,
      ip,
      meta: { project_id: pid, mode, day_of_month: dayOfMonth },
    });

    return { ok: true, schedule: rowToSchedule(getRawByProjectId(db, pid)) };
  }

  // Update existing: recompute next_run_date when day_of_month changes (so a
  // shifted day takes effect on the next tick instead of waiting a month).
  const changes = [];
  if (existing.mode !== mode) {
    changes.push({ field: 'mode', oldValue: existing.mode, newValue: mode });
  }
  if (existing.day_of_month !== dayOfMonth) {
    changes.push({
      field: 'day_of_month',
      oldValue: existing.day_of_month,
      newValue: dayOfMonth,
    });
  }
  if (existing.fixed_amount_cents !== fixedAmountCents) {
    changes.push({
      field: 'fixed_amount_cents',
      oldValue: existing.fixed_amount_cents,
      newValue: fixedAmountCents,
    });
  }
  if ((existing.fixed_description ?? null) !== (fixedDescription ?? null)) {
    changes.push({
      field: 'fixed_description',
      oldValue: existing.fixed_description,
      newValue: fixedDescription,
    });
  }
  if (existing.auto_stripe_link !== autoStripeLink) {
    changes.push({
      field: 'auto_stripe_link',
      oldValue: existing.auto_stripe_link,
      newValue: autoStripeLink,
    });
  }

  const nextRunDate =
    existing.day_of_month === dayOfMonth
      ? existing.next_run_date
      : computeFirstRunDate(todayIso(), dayOfMonth);
  if (nextRunDate !== existing.next_run_date) {
    changes.push({
      field: 'next_run_date',
      oldValue: existing.next_run_date,
      newValue: nextRunDate,
    });
  }

  if (changes.length === 0) {
    return { ok: true, schedule: rowToSchedule(existing) };
  }

  db.prepare(
    `UPDATE recurring_schedules
        SET mode = ?, day_of_month = ?, fixed_amount_cents = ?,
            fixed_description = ?, auto_stripe_link = ?, next_run_date = ?,
            updated_at = ?
      WHERE project_id = ?`
  ).run(
    mode,
    dayOfMonth,
    fixedAmountCents,
    fixedDescription,
    autoStripeLink,
    nextRunDate,
    at,
    pid
  );

  logAction(db, {
    actorId: actor.id,
    action: 'recurring.set',
    targetKind: 'recurring_schedule',
    targetId: pid,
    summary: `Updated recurring schedule for ${project.client_name} — ${project.project_name}`,
    ip,
    changes,
    meta: { project_id: pid, mode, day_of_month: dayOfMonth },
  });

  return { ok: true, schedule: rowToSchedule(getRawByProjectId(db, pid)) };
}

export function pause(db, projectId, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const pid = Number.parseInt(projectId, 10);
  const existing = getRawByProjectId(db, pid);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.paused_at) return { ok: true, schedule: rowToSchedule(existing) };

  const at = nowIso();
  db.prepare(
    `UPDATE recurring_schedules SET paused_at = ?, updated_at = ? WHERE project_id = ?`
  ).run(at, at, pid);

  logAction(db, {
    actorId: actor.id,
    action: 'recurring.pause',
    targetKind: 'recurring_schedule',
    targetId: pid,
    summary: `Paused recurring schedule for ${existing.client_name} — ${existing.project_name}`,
    ip,
    meta: { project_id: pid },
  });

  return { ok: true, schedule: rowToSchedule(getRawByProjectId(db, pid)) };
}

export function resume(db, projectId, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const pid = Number.parseInt(projectId, 10);
  const existing = getRawByProjectId(db, pid);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!existing.paused_at) return { ok: true, schedule: rowToSchedule(existing) };

  // If we paused for a while and next_run_date is now in the past, bump to
  // the next valid occurrence so resume doesn't immediately backfire on the
  // next tick.
  const today = todayIso();
  let nextRun = existing.next_run_date;
  if (nextRun < today) {
    nextRun = computeFirstRunDate(today, existing.day_of_month);
  }

  const at = nowIso();
  db.prepare(
    `UPDATE recurring_schedules
        SET paused_at = NULL, next_run_date = ?, updated_at = ?
      WHERE project_id = ?`
  ).run(nextRun, at, pid);

  logAction(db, {
    actorId: actor.id,
    action: 'recurring.resume',
    targetKind: 'recurring_schedule',
    targetId: pid,
    summary: `Resumed recurring schedule for ${existing.client_name} — ${existing.project_name}`,
    ip,
    meta: { project_id: pid, next_run_date: nextRun },
  });

  return { ok: true, schedule: rowToSchedule(getRawByProjectId(db, pid)) };
}

export function deleteSchedule(db, projectId, { actor, ip } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const pid = Number.parseInt(projectId, 10);
  const existing = getRawByProjectId(db, pid);
  if (!existing) return { ok: false, reason: 'not_found' };

  db.prepare('DELETE FROM recurring_schedules WHERE project_id = ?').run(pid);

  logAction(db, {
    actorId: actor.id,
    action: 'recurring.delete',
    targetKind: 'recurring_schedule',
    targetId: pid,
    summary: `Deleted recurring schedule for ${existing.client_name} — ${existing.project_name}`,
    ip,
    meta: { project_id: pid },
  });

  return { ok: true };
}

export function getForProject(db, projectId, viewer) {
  if (!isSuperAdmin(viewer)) return null;
  const pid = Number.parseInt(projectId, 10);
  if (!Number.isInteger(pid)) return null;
  return rowToSchedule(getRawByProjectId(db, pid));
}

// Lists every schedule with denormalized client + project names for the
// top-level /#recurring dashboard. Super-admin only.
export function listAll(db, viewer) {
  if (!isSuperAdmin(viewer)) return [];
  return db
    .prepare(
      `SELECT r.*, p.name AS project_name, c.name AS client_name
         FROM recurring_schedules r
         JOIN projects p ON p.id = r.project_id
         JOIN clients  c ON c.id = p.client_id
        ORDER BY (r.paused_at IS NOT NULL) ASC, r.next_run_date ASC, c.name ASC`
    )
    .all()
    .map(rowToSchedule);
}

// ──────────────────────────────────────────────────────────────────────────
// runDue / runOnce — the recurring tick entry points.

function resolveSuperAdmin(db) {
  const email = config.superAdminEmail;
  if (!email) return null;
  const row = db
    .prepare(
      'SELECT id, email, display_name, role FROM users WHERE email = ? COLLATE NOCASE'
    )
    .get(email);
  if (!row || row.role !== 'super_admin') return null;
  return row;
}

// Internal: runs one schedule. Async because of the optional Stripe call.
// Returns a result object — never throws.
async function runOne(db, schedule, { actor, ip, now }) {
  const today = todayIso(now);
  const project = projectSummary(db, schedule.project_id);
  if (!project) {
    logErrorRow(db, {
      message: 'recurring runOne: project not found',
      route: 'recurring.runOne',
      userId: actor.id,
      meta: { schedule_id: schedule.id, project_id: schedule.project_id },
    });
    return { schedule_id: schedule.id, project_id: schedule.project_id, status: 'error', error: 'project_not_found' };
  }

  const issueDate = today;
  const throughDate = today;
  const dueDate = addDays(today, project.payment_terms_days || 14);

  // Outcome variables set inside the transaction.
  let invoiceId = null;
  let invoiceNumber = null;
  let outcome = 'success'; // 'success' | 'skipped' | 'error'
  let errorMsg = null;

  try {
    db.transaction(() => {
      if (schedule.mode === 'fixed_milestone') {
        const mr = milestones.create(
          db,
          {
            project_id: schedule.project_id,
            milestone_date: today,
            description: schedule.fixed_description,
            amount_cents: schedule.fixed_amount_cents,
          },
          { actor, ip }
        );
        if (!mr.ok) throw new Error(`milestone_failed:${mr.reason}`);
      }

      const dr = invoices.createDraft(
        db,
        {
          project_id: schedule.project_id,
          through_date: throughDate,
          issue_date: issueDate,
          due_date: dueDate,
          notes: null,
        },
        { actor, ip }
      );

      if (!dr.ok) {
        // 'no_lines' is benign for time_and_expenses — nothing accrued this
        // period. Advance next_run_date and audit as 'skipped'. Anything
        // else is an actual error.
        if (dr.reason === 'no_lines') {
          outcome = 'skipped';
          db.prepare(
            `UPDATE recurring_schedules
                SET last_run_date = ?, next_run_date = ?, updated_at = ?
              WHERE id = ?`
          ).run(
            today,
            advanceNextRunDate(schedule.next_run_date, schedule.day_of_month),
            nowIso(),
            schedule.id
          );
          return;
        }
        throw new Error(`createDraft_failed:${dr.reason}`);
      }

      invoiceId = dr.invoice.id;
      invoiceNumber = dr.invoice.number;

      db.prepare(
        `UPDATE recurring_schedules
            SET last_run_date = ?, last_invoice_id = ?, next_run_date = ?, updated_at = ?
          WHERE id = ?`
      ).run(
        today,
        invoiceId,
        advanceNextRunDate(schedule.next_run_date, schedule.day_of_month),
        nowIso(),
        schedule.id
      );
    })();
  } catch (err) {
    outcome = 'error';
    errorMsg = err?.message || String(err);
    logger.error(
      { err, scheduleId: schedule.id, projectId: schedule.project_id },
      'recurring runOne failed'
    );
    logErrorRow(db, {
      message: `recurring runOne failed: ${errorMsg}`,
      stack: err?.stack,
      route: 'recurring.runOne',
      userId: actor.id,
      meta: {
        schedule_id: schedule.id,
        project_id: schedule.project_id,
        mode: schedule.mode,
      },
    });

    logAction(db, {
      actorId: actor.id,
      action: 'recurring.run',
      targetKind: 'recurring_schedule',
      targetId: schedule.id,
      summary: `Recurring run failed for ${project.client_name} — ${project.project_name}: ${errorMsg}`,
      ip,
      meta: {
        schedule_id: schedule.id,
        status: 'error',
        mode: schedule.mode,
        error: errorMsg,
      },
    });

    return {
      schedule_id: schedule.id,
      project_id: schedule.project_id,
      status: 'error',
      error: errorMsg,
    };
  }

  // Best-effort Stripe link. Outside the transaction so a Stripe failure
  // doesn't roll back the draft. stripeLinks.generate already catches its
  // own SDK errors and writes to error_log; we still wrap defensively.
  let stripeStatus = null;
  if (
    outcome === 'success' &&
    schedule.auto_stripe_link === 1 &&
    stripeLinks.isEnabled() &&
    invoiceId != null
  ) {
    try {
      const sr = await stripeLinks.generate(db, invoiceId, { actor, ip });
      stripeStatus = sr.ok ? 'success' : sr.reason;
      if (!sr.ok) outcome = 'partial';
    } catch (err) {
      logger.error({ err, invoiceId }, 'recurring stripe generate threw');
      logErrorRow(db, {
        message: `recurring stripe generate threw: ${err?.message || err}`,
        stack: err?.stack,
        route: 'recurring.runOne',
        userId: actor.id,
        meta: { schedule_id: schedule.id, invoice_id: invoiceId },
      });
      stripeStatus = 'failure';
      outcome = 'partial';
    }
  }

  // Audit the run (success / skipped / partial).
  let summary;
  if (outcome === 'skipped') {
    summary = `Recurring tick skipped (no unbilled rows) for ${project.client_name} — ${project.project_name}`;
  } else if (outcome === 'partial') {
    summary = `Recurring tick drafted invoice ${invoiceNumber} for ${project.client_name} — ${project.project_name} (Stripe link generation failed)`;
  } else {
    summary = `Recurring tick drafted invoice ${invoiceNumber} for ${project.client_name} — ${project.project_name}`;
    if (schedule.mode === 'fixed_milestone') {
      summary += ` (${formatMoney(schedule.fixed_amount_cents)} retainer)`;
    }
  }

  logAction(db, {
    actorId: actor.id,
    action: 'recurring.run',
    targetKind: 'recurring_schedule',
    targetId: schedule.id,
    summary,
    ip,
    meta: {
      schedule_id: schedule.id,
      status: outcome,
      mode: schedule.mode,
      invoice_id: invoiceId,
      stripe: stripeStatus,
    },
  });

  return {
    schedule_id: schedule.id,
    project_id: schedule.project_id,
    status: outcome,
    invoice_id: invoiceId,
    stripe: stripeStatus,
  };
}

// Default cool-off between ticks for trigger paths that self-gate
// (wake-on-activity, in-process timer). The TOTP-gated cron endpoint bypasses
// this by calling runDue directly — that path is rate-limited at the route
// layer and intended as the safety net.
export const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;

// Atomically claims the right to run the next tick. Returns true if this
// caller "won" the claim (UPDATE matched), false otherwise. The WHERE clause
// makes the claim race-free across concurrent requests / processes; the row
// is in the file-backed DB so it survives restarts.
export function tryClaimTick(db, { now = new Date(), intervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
  const cutoff = new Date(now.getTime() - intervalMs).toISOString();
  const result = db
    .prepare(
      `UPDATE _recurring_meta
          SET last_tick_at = ?
        WHERE id = 1 AND last_tick_at < ?`
    )
    .run(now.toISOString(), cutoff);
  return result.changes === 1;
}

// Self-gating wrapper around runDue. Used by the in-process timer and the
// wake-on-activity hook in routes/me.js. Returns null when the claim was
// not won (interval not elapsed, another caller already running), or the
// runDue results array when it did run.
export async function maybeRunDue(db, { now = new Date(), intervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
  if (!tryClaimTick(db, { now, intervalMs })) return null;
  return runDue(db, { now });
}

export async function runDue(db, { now = new Date() } = {}) {
  const sysActor = resolveSuperAdmin(db);
  if (!sysActor) {
    logger.error(
      { superAdminEmail: config.superAdminEmail || '(unset)' },
      'recurring.runDue: no super-admin user resolved'
    );
    return [];
  }

  const today = todayIso(now);
  const rows = db
    .prepare(
      `SELECT * FROM recurring_schedules
        WHERE paused_at IS NULL AND next_run_date <= ?
        ORDER BY next_run_date ASC, id ASC`
    )
    .all(today);

  const out = [];
  for (const schedule of rows) {
    const r = await runOne(db, schedule, { actor: sysActor, ip: null, now });
    out.push(r);
  }
  return out;
}

// Manual per-project trigger from the UI. Ignores next_run_date but still
// honors paused_at (so a paused schedule can't be force-fired without resume).
export async function runOnce(db, projectId, { actor, ip, now = new Date() } = {}) {
  if (!actor) return { ok: false, reason: 'unauthorized' };
  if (!isSuperAdmin(actor)) return { ok: false, reason: 'forbidden' };

  const pid = Number.parseInt(projectId, 10);
  if (!Number.isInteger(pid)) return { ok: false, reason: 'project_required' };

  const schedule = db
    .prepare('SELECT * FROM recurring_schedules WHERE project_id = ?')
    .get(pid);
  if (!schedule) return { ok: false, reason: 'not_found' };
  if (schedule.paused_at) return { ok: false, reason: 'paused' };

  const result = await runOne(db, schedule, { actor, ip, now });
  return { ok: true, result };
}
