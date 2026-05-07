import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories hoist before consts. Use vi.hoisted() so the factory
// closes over the same `mockConfig` we mutate in tests. Mirrors the pattern
// in test/stripeLinks.test.js. We need to control superAdminEmail (so
// runDue() resolves the actor) and stripeSecretKey (so the auto-link path
// hits the mocked Stripe client).
const { mockConfig, paymentLinksCreate, paymentLinksUpdate, sendInvoiceEmail } = vi.hoisted(() => ({
  mockConfig: {
    isTest: true,
    isProd: false,
    nodeEnv: 'test',
    port: 8080,
    baseUrl: 'http://localhost:8080',
    superAdminEmail: 'admin@example.com',
    sessionSecret: 'test-secret-do-not-use-anywhere',
    dbPath: ':memory:',
    logLevel: 'silent',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    stripeSecretKey: '',
    cookiePrefix: 'bi_',
  },
  paymentLinksCreate: vi.fn(),
  paymentLinksUpdate: vi.fn(),
  sendInvoiceEmail: vi.fn(),
}));

vi.mock('../server/config.js', () => ({ config: mockConfig }));
vi.mock('stripe', () => ({
  default: class MockStripe {
    constructor(key) {
      this.apiKey = key;
    }
    paymentLinks = { create: paymentLinksCreate, update: paymentLinksUpdate };
  },
}));
// Mock invoiceMail so auto_send tests don't try to launch puppeteer / spin
// up an SMTP transport. The real path is covered in test/invoiceMail.test.js.
vi.mock('../server/services/invoiceMail.js', () => ({
  sendInvoiceEmail,
}));

import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import { create as createTimeEntry } from '../server/services/timeEntries.js';
import * as stripeLinks from '../server/services/stripeLinks.js';
import {
  setSchedule,
  pause,
  resume,
  deleteSchedule,
  getForProject,
  listAll,
  runDue,
  runOnce,
  maybeRunDue,
  tryClaimTick,
  computeFirstRunDate,
  advanceNextRunDate,
  todayIso,
  addDays,
} from '../server/services/recurring.js';

function insertUser(db, email, displayName, role) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, displayName, role, at, at);
  return { id: info.lastInsertRowid, email, display_name: displayName, role };
}

let db;
let admin;
let sub;
let project;

beforeEach(() => {
  mockConfig.superAdminEmail = 'admin@example.com';
  mockConfig.stripeSecretKey = '';
  paymentLinksCreate.mockReset();
  paymentLinksUpdate.mockReset();
  paymentLinksCreate.mockResolvedValue({
    id: 'plink_test_default',
    url: 'https://buy.stripe.com/test_default',
  });
  paymentLinksUpdate.mockResolvedValue({});
  sendInvoiceEmail.mockReset();
  sendInvoiceEmail.mockResolvedValue({ ok: true, dev: true, attachment: true });
  stripeLinks._resetClient();

  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub', 'subcontractor');

  const c = createClient(
    db,
    { name: 'Acme', payment_terms_days: 14, contact_emails: ['billing@acme.example'] },
    { actorId: admin.id }
  );
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
});

describe('date helpers', () => {
  it('todayIso formats UTC date', () => {
    expect(todayIso(new Date('2026-05-06T12:00:00Z'))).toBe('2026-05-06');
  });

  it('addDays handles month + year rollover', () => {
    expect(addDays('2026-12-25', 7)).toBe('2027-01-01');
    expect(addDays('2026-05-31', 14)).toBe('2026-06-14');
  });

  it('computeFirstRunDate stays in current month when day not yet passed', () => {
    expect(computeFirstRunDate('2026-05-06', 15)).toBe('2026-05-15');
    expect(computeFirstRunDate('2026-05-15', 15)).toBe('2026-05-15');
  });

  it('computeFirstRunDate jumps to next month when day already passed', () => {
    expect(computeFirstRunDate('2026-05-20', 15)).toBe('2026-06-15');
  });

  it('computeFirstRunDate jumps year on December rollover', () => {
    expect(computeFirstRunDate('2026-12-25', 1)).toBe('2027-01-01');
  });

  it('advanceNextRunDate adds one month', () => {
    expect(advanceNextRunDate('2026-05-15', 15)).toBe('2026-06-15');
  });

  it('advanceNextRunDate handles December rollover', () => {
    expect(advanceNextRunDate('2026-12-15', 15)).toBe('2027-01-15');
  });
});

describe('setSchedule validation', () => {
  it('rejects sub actors', () => {
    const r = setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('rejects unauthenticated', () => {
    const r = setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, {});
    expect(r.reason).toBe('unauthorized');
  });

  it('rejects bad mode', () => {
    const r = setSchedule(db, project.id, { mode: 'weekly', day_of_month: 1 }, { actor: admin });
    expect(r.reason).toBe('invalid_mode');
  });

  it('rejects day_of_month outside 1..28', () => {
    expect(setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 0 }, { actor: admin }).reason).toBe('invalid_day_of_month');
    expect(setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 29 }, { actor: admin }).reason).toBe('invalid_day_of_month');
  });

  it('requires fixed_amount + fixed_description for fixed_milestone', () => {
    expect(setSchedule(db, project.id, { mode: 'fixed_milestone', day_of_month: 1 }, { actor: admin }).reason).toBe('fixed_amount_required');
    expect(setSchedule(db, project.id, { mode: 'fixed_milestone', day_of_month: 1, fixed_amount_cents: 50000 }, { actor: admin }).reason).toBe('fixed_description_required');
  });

  it('rejects unknown project', () => {
    const r = setSchedule(db, 9999, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: admin });
    expect(r.reason).toBe('project_not_found');
  });
});

describe('setSchedule insert + update', () => {
  it('creates a new schedule with computed next_run_date', () => {
    const r = setSchedule(
      db,
      project.id,
      { mode: 'fixed_milestone', day_of_month: 1, fixed_amount_cents: 50000, fixed_description: 'Retainer' },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    expect(r.schedule.mode).toBe('fixed_milestone');
    expect(r.schedule.day_of_month).toBe(1);
    expect(r.schedule.fixed_amount_cents).toBe(50000);
    expect(r.schedule.fixed_description).toBe('Retainer');
    expect(r.schedule.next_run_date).toMatch(/^\d{4}-\d{2}-01$/);
    expect(r.schedule.paused).toBe(false);

    // Audit row written
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'recurring.set'").get();
    expect(audit).toBeTruthy();
    expect(audit.actor_id).toBe(admin.id);
  });

  it('updates an existing schedule and recomputes next_run_date when day_of_month changes', () => {
    setSchedule(
      db,
      project.id,
      { mode: 'fixed_milestone', day_of_month: 1, fixed_amount_cents: 50000, fixed_description: 'Retainer' },
      { actor: admin }
    );
    const r = setSchedule(
      db,
      project.id,
      { mode: 'fixed_milestone', day_of_month: 15, fixed_amount_cents: 60000, fixed_description: 'New retainer' },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    expect(r.schedule.day_of_month).toBe(15);
    expect(r.schedule.fixed_amount_cents).toBe(60000);
    expect(r.schedule.next_run_date).toMatch(/^\d{4}-\d{2}-15$/);
  });

  it('toggles auto_stripe_link', () => {
    const r1 = setSchedule(
      db,
      project.id,
      { mode: 'time_and_expenses', day_of_month: 1, auto_stripe_link: true },
      { actor: admin }
    );
    expect(r1.schedule.auto_stripe_link).toBe(true);
    const r2 = setSchedule(
      db,
      project.id,
      { mode: 'time_and_expenses', day_of_month: 1, auto_stripe_link: false },
      { actor: admin }
    );
    expect(r2.schedule.auto_stripe_link).toBe(false);
  });
});

describe('pause / resume / delete', () => {
  beforeEach(() => {
    setSchedule(
      db,
      project.id,
      { mode: 'time_and_expenses', day_of_month: 15 },
      { actor: admin }
    );
  });

  it('pause sets paused_at, resume clears it', () => {
    const p = pause(db, project.id, { actor: admin });
    expect(p.schedule.paused).toBe(true);
    const r = resume(db, project.id, { actor: admin });
    expect(r.schedule.paused).toBe(false);
  });

  it('resume bumps next_run_date when it has drifted into the past', () => {
    pause(db, project.id, { actor: admin });
    // Force next_run_date into the past to simulate a long pause
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2020-01-15', project.id);
    const r = resume(db, project.id, { actor: admin });
    expect(r.schedule.next_run_date).not.toBe('2020-01-15');
    // Should be some future-or-today date with day-15
    expect(r.schedule.next_run_date).toMatch(/^\d{4}-\d{2}-15$/);
  });

  it('delete removes the row', () => {
    const r = deleteSchedule(db, project.id, { actor: admin });
    expect(r.ok).toBe(true);
    expect(getForProject(db, project.id, admin)).toBeNull();
  });

  it('sub callers are forbidden', () => {
    expect(pause(db, project.id, { actor: sub }).reason).toBe('forbidden');
    expect(resume(db, project.id, { actor: sub }).reason).toBe('forbidden');
    expect(deleteSchedule(db, project.id, { actor: sub }).reason).toBe('forbidden');
  });
});

describe('listAll', () => {
  it('returns all schedules for super-admin, empty for sub', () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: admin });
    expect(listAll(db, admin).length).toBe(1);
    expect(listAll(db, sub).length).toBe(0);
  });
});

describe('runDue — time_and_expenses', () => {
  it('skipped when nothing has accrued; advances next_run_date', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: admin });
    // Force next_run_date to today so it's due
    const today = todayIso(new Date('2026-05-06T12:00:00Z'));
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run(today, project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('skipped');

    const sched = getForProject(db, project.id, admin);
    expect(sched.next_run_date).toBe('2026-06-01');
    expect(sched.last_run_date).toBe(today);
  });

  it('drafts an invoice with accrued time', async () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'Auth' },
      { actor: sub }
    );
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    const today = '2026-05-06';
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run(today, project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('success');
    expect(results[0].invoice_id).toBeGreaterThan(0);

    // Time entry is now locked
    const te = db.prepare('SELECT invoice_id FROM time_entries WHERE id = ?').get(1);
    expect(te.invoice_id).toBe(results[0].invoice_id);

    // Invoice line snapshot rate matches the project_member rate
    const line = db.prepare('SELECT unit_rate_cents FROM invoice_lines WHERE invoice_id = ?').get(results[0].invoice_id);
    expect(line.unit_rate_cents).toBe(12500);

    // Schedule advanced
    const sched = getForProject(db, project.id, admin);
    expect(sched.last_invoice_id).toBe(results[0].invoice_id);
    expect(sched.next_run_date).toBe('2026-06-06');
  });
});

describe('runDue — fixed_milestone', () => {
  it('inserts a milestone, drafts, and locks it', async () => {
    setSchedule(
      db,
      project.id,
      {
        mode: 'fixed_milestone',
        day_of_month: 6,
        fixed_amount_cents: 50000,
        fixed_description: 'Monthly retainer',
      },
      { actor: admin }
    );
    const today = '2026-05-06';
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run(today, project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');

    const milestone = db.prepare(
      `SELECT * FROM milestones WHERE project_id = ? AND invoice_id IS NOT NULL`
    ).get(project.id);
    expect(milestone).toBeTruthy();
    expect(milestone.amount_cents).toBe(50000);
    expect(milestone.description).toBe('Monthly retainer');
    expect(milestone.created_by).toBe(admin.id);

    const line = db.prepare(
      `SELECT * FROM invoice_lines WHERE invoice_id = ? AND kind = 'milestone'`
    ).get(results[0].invoice_id);
    expect(line.amount_cents).toBe(50000);
    expect(line.unit_rate_cents).toBe(50000);
  });
});

describe('runDue — filtering', () => {
  it('skips paused schedules', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);
    pause(db, project.id, { actor: admin });

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results).toEqual([]);
  });

  it('skips future-dated schedules', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: admin });
    // Force a far-future next_run_date
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2099-01-01', project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results).toEqual([]);
  });

  it('returns [] when SUPER_ADMIN_EMAIL does not resolve to a user', async () => {
    mockConfig.superAdminEmail = 'nobody@example.com';
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results).toEqual([]);
  });
});

describe('runDue — resilience', () => {
  it('one schedule failing does not block siblings; failed schedule does not advance', async () => {
    // Two schedules. We'll break one by deleting its project AFTER setting up.
    const c2 = createClient(db, { name: 'Globex', contact_emails: ['x@globex.test'] }, { actorId: admin.id });
    const p2 = createProject(db, { client_id: c2.client.id, name: 'Intranet' }, { actorId: admin.id });
    addMember(db, p2.project.id, { user_id: sub.id, bill_rate_cents: 10000 }, { actorId: admin.id });
    createTimeEntry(
      db,
      { project_id: p2.project.id, entry_date: '2026-05-04', hours: 2, description: 'x' },
      { actor: sub }
    );

    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    setSchedule(db, p2.project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ?').run('2026-05-06');

    // Force a failure on the FIRST schedule by clearing its project's
    // payment_terms_days client and deleting the project. Easier path: pass
    // a corrupt schedule by deleting the project row out from under it.
    // recurring_schedules has ON DELETE CASCADE, so we can't drop the row;
    // instead, mutate fixed_amount_cents path: switch project 1 to
    // fixed_milestone with a NULL fixed_description (bypasses validation by
    // direct UPDATE) so milestones.create rejects.
    db.prepare(
      `UPDATE recurring_schedules
          SET mode = 'fixed_milestone', fixed_amount_cents = 1000,
              fixed_description = NULL
        WHERE project_id = ?`
    ).run(project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results.length).toBe(2);
    const failed = results.find((r) => r.project_id === project.id);
    const succeeded = results.find((r) => r.project_id === p2.project.id);
    expect(failed.status).toBe('error');
    expect(succeeded.status).toBe('success');

    // error_log row written
    const errRow = db.prepare(
      "SELECT * FROM error_log WHERE message LIKE 'recurring runOne failed%'"
    ).get();
    expect(errRow).toBeTruthy();

    // failed schedule's next_run_date should NOT have advanced
    const failedSched = getForProject(db, project.id, admin);
    expect(failedSched.next_run_date).toBe('2026-05-06');

    // succeeded schedule advanced
    const succSched = getForProject(db, p2.project.id, admin);
    expect(succSched.next_run_date).toBe('2026-06-06');
  });
});

describe('runDue — auto_stripe_link', () => {
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'x' },
      { actor: sub }
    );
    setSchedule(
      db,
      project.id,
      { mode: 'time_and_expenses', day_of_month: 6, auto_stripe_link: true },
      { actor: admin }
    );
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);
  });

  it('with Stripe enabled, draft has stripe_payment_link_url', async () => {
    mockConfig.stripeSecretKey = 'sk_test_unit';
    stripeLinks._resetClient();
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_recurring_1',
      url: 'https://buy.stripe.com/recurring_1',
    });

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');
    expect(results[0].stripe).toBe('success');

    const inv = db.prepare(
      'SELECT stripe_payment_link_url, stripe_payment_link_id FROM invoices WHERE id = ?'
    ).get(results[0].invoice_id);
    expect(inv.stripe_payment_link_url).toBe('https://buy.stripe.com/recurring_1');
    expect(inv.stripe_payment_link_id).toBe('plink_recurring_1');
  });

  it('with Stripe disabled, draft is created without a URL and without error', async () => {
    mockConfig.stripeSecretKey = '';
    stripeLinks._resetClient();

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');
    expect(results[0].stripe).toBeNull();

    const inv = db.prepare(
      'SELECT stripe_payment_link_url FROM invoices WHERE id = ?'
    ).get(results[0].invoice_id);
    expect(inv.stripe_payment_link_url).toBeNull();
  });

  it('with Stripe enabled but throwing, draft is kept and status is partial', async () => {
    mockConfig.stripeSecretKey = 'sk_test_unit';
    stripeLinks._resetClient();
    paymentLinksCreate.mockRejectedValueOnce(new Error('stripe boom'));

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('partial');

    const inv = db.prepare(
      'SELECT stripe_payment_link_url FROM invoices WHERE id = ?'
    ).get(results[0].invoice_id);
    expect(inv.stripe_payment_link_url).toBeNull();

    // error_log row written by stripeLinks.generate
    const errRow = db.prepare(
      "SELECT * FROM error_log WHERE message LIKE 'stripe paymentLinks.create failed%'"
    ).get();
    expect(errRow).toBeTruthy();
  });
});

describe('runDue — auto_send', () => {
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 2, description: 'x' },
      { actor: sub }
    );
  });

  function makeAutoSendSchedule({ autoStripe = false } = {}) {
    setSchedule(
      db,
      project.id,
      {
        mode: 'time_and_expenses',
        day_of_month: 6,
        auto_send: true,
        auto_stripe_link: autoStripe,
      },
      { actor: admin }
    );
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);
  }

  it('with at least one contact email, invoice flips to sent + meta.send=success', async () => {
    makeAutoSendSchedule();
    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');
    expect(results[0].send).toBe('success');

    const inv = db.prepare('SELECT status, sent_at FROM invoices WHERE id = ?').get(results[0].invoice_id);
    expect(inv.status).toBe('sent');
    expect(inv.sent_at).not.toBeNull();

    // sendInvoiceEmail mock was actually called
    expect(sendInvoiceEmail).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmail).toHaveBeenCalledWith(expect.anything(), results[0].invoice_id);

    // Audit captures send=success
    const audit = db.prepare(
      "SELECT * FROM admin_audit WHERE action = 'recurring.run' ORDER BY id DESC LIMIT 1"
    ).get();
    const meta = JSON.parse(audit.meta_json);
    expect(meta.send).toBe('success');
    expect(meta.status).toBe('success');
    expect(audit.summary).toContain('sent invoice');
  });

  it('with empty contact_emails, invoice stays draft + meta.send=no_client_email', async () => {
    // Strip the client's contact_emails
    db.prepare("UPDATE clients SET contact_emails = '[]' WHERE id = ?").run(project.client_id);
    makeAutoSendSchedule();

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('partial');
    expect(results[0].send).toBe('no_client_email');

    const inv = db.prepare('SELECT status, sent_at FROM invoices WHERE id = ?').get(results[0].invoice_id);
    expect(inv.status).toBe('draft');
    expect(inv.sent_at).toBeNull();

    // The mail dispatch was NOT called (invoices.send rejected first)
    expect(sendInvoiceEmail).not.toHaveBeenCalled();

    // error_log row written
    const errRow = db.prepare(
      "SELECT * FROM error_log WHERE message LIKE 'recurring auto-send rejected%'"
    ).get();
    expect(errRow).toBeTruthy();
    expect(errRow.message).toContain('no_client_email');
  });

  it('with email dispatch throwing, invoice is sent but audit is partial + error logged', async () => {
    sendInvoiceEmail.mockRejectedValueOnce(new Error('SMTP down'));
    makeAutoSendSchedule();

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('partial');
    expect(results[0].send).toBe('failure');

    // invoices.send already flipped status before the mail dispatch threw —
    // matches the route-level behavior (no rollback on SMTP failure).
    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(results[0].invoice_id);
    expect(inv.status).toBe('sent');

    const errRow = db.prepare(
      "SELECT * FROM error_log WHERE message LIKE 'recurring auto-send mail threw%'"
    ).get();
    expect(errRow).toBeTruthy();
  });

  it('with email dispatch returning ok:false, invoice is sent but audit is partial', async () => {
    sendInvoiceEmail.mockResolvedValueOnce({ ok: false, reason: 'send_failed' });
    makeAutoSendSchedule();

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('partial');
    expect(results[0].send).toBe('send_failed');
  });

  it('combined with auto_stripe_link, both succeed and link is generated before send', async () => {
    mockConfig.stripeSecretKey = 'sk_test_unit';
    stripeLinks._resetClient();
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_combined',
      url: 'https://buy.stripe.com/combined',
    });
    makeAutoSendSchedule({ autoStripe: true });

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');
    expect(results[0].stripe).toBe('success');
    expect(results[0].send).toBe('success');

    // Stripe was called BEFORE the email dispatch
    const stripeOrder = paymentLinksCreate.mock.invocationCallOrder[0];
    const sendOrder = sendInvoiceEmail.mock.invocationCallOrder[0];
    expect(stripeOrder).toBeLessThan(sendOrder);

    // Invoice has both the URL and 'sent' status
    const inv = db.prepare(
      'SELECT status, stripe_payment_link_url FROM invoices WHERE id = ?'
    ).get(results[0].invoice_id);
    expect(inv.status).toBe('sent');
    expect(inv.stripe_payment_link_url).toBe('https://buy.stripe.com/combined');
  });

  it('auto_send=0 (default) preserves existing draft-only behavior', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);

    const results = await runDue(db, { now: new Date('2026-05-06T12:00:00Z') });
    expect(results[0].status).toBe('success');
    expect(results[0].send).toBeNull();

    const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(results[0].invoice_id);
    expect(inv.status).toBe('draft');
    expect(sendInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe('tryClaimTick + maybeRunDue (atomic claim)', () => {
  it('first call wins, second call within interval loses', () => {
    const now = new Date('2026-05-06T12:00:00Z');
    expect(tryClaimTick(db, { now, intervalMs: 60 * 60 * 1000 })).toBe(true);
    expect(tryClaimTick(db, { now, intervalMs: 60 * 60 * 1000 })).toBe(false);
  });

  it('a second call after the interval succeeds again', () => {
    const t1 = new Date('2026-05-06T12:00:00Z');
    const t2 = new Date('2026-05-06T13:00:01Z');
    expect(tryClaimTick(db, { now: t1, intervalMs: 60 * 60 * 1000 })).toBe(true);
    expect(tryClaimTick(db, { now: t2, intervalMs: 60 * 60 * 1000 })).toBe(true);
  });

  it('maybeRunDue returns null on a second call inside the interval', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);
    const now = new Date('2026-05-06T12:00:00Z');
    const first = await maybeRunDue(db, { now });
    expect(first).not.toBeNull();
    const second = await maybeRunDue(db, { now });
    expect(second).toBeNull();
  });

  it('maybeRunDue runs again after the interval', async () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'x' },
      { actor: sub }
    );
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', project.id);
    const t1 = new Date('2026-05-06T12:00:00Z');
    const r1 = await maybeRunDue(db, { now: t1 });
    expect(r1).not.toBeNull();
    expect(r1[0].status).toBe('success');

    // Force a second schedule to be due AFTER the interval passes.
    const c2 = createClient(db, { name: 'Globex', contact_emails: ['x@globex.test'] }, { actorId: admin.id });
    const p2 = createProject(db, { client_id: c2.client.id, name: 'P2' }, { actorId: admin.id });
    addMember(db, p2.project.id, { user_id: sub.id, bill_rate_cents: 5000 }, { actorId: admin.id });
    createTimeEntry(
      db,
      { project_id: p2.project.id, entry_date: '2026-05-04', hours: 1, description: 'x' },
      { actor: sub }
    );
    setSchedule(db, p2.project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2026-05-06', p2.project.id);

    // Just past 1 hour later
    const t2 = new Date('2026-05-06T13:00:01Z');
    const r2 = await maybeRunDue(db, { now: t2 });
    expect(r2).not.toBeNull();
    expect(r2.length).toBe(1);
    expect(r2[0].project_id).toBe(p2.project.id);
  });
});

describe('runOnce', () => {
  it('runs a future-dated schedule regardless of next_run_date', async () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'x' },
      { actor: sub }
    );
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 1 }, { actor: admin });
    db.prepare('UPDATE recurring_schedules SET next_run_date = ? WHERE project_id = ?')
      .run('2099-01-01', project.id);

    const r = await runOnce(db, project.id, { actor: admin, now: new Date('2026-05-06T12:00:00Z') });
    expect(r.ok).toBe(true);
    expect(r.result.status).toBe('success');
    expect(r.result.invoice_id).toBeGreaterThan(0);
  });

  it('rejects paused schedules', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    pause(db, project.id, { actor: admin });
    const r = await runOnce(db, project.id, { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('paused');
  });

  it('rejects sub actors', async () => {
    setSchedule(db, project.id, { mode: 'time_and_expenses', day_of_month: 6 }, { actor: admin });
    const r = await runOnce(db, project.id, { actor: sub });
    expect(r.reason).toBe('forbidden');
  });

  it('returns not_found when no schedule exists', async () => {
    const r = await runOnce(db, project.id, { actor: admin });
    expect(r.reason).toBe('not_found');
  });
});
