import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories are hoisted to the top of the file, BEFORE any const
// declarations. Use vi.hoisted() to declare these refs in the same hoisted
// scope so the factories can close over them. This lets us flip
// stripeSecretKey per-test instead of being locked in by Object.freeze.
const { mockConfig, paymentLinksCreate, paymentLinksUpdate } = vi.hoisted(() => ({
  mockConfig: {
    isTest: true,
    isProd: false,
    nodeEnv: 'test',
    port: 8080,
    baseUrl: 'http://localhost:8080',
    superAdminEmail: '',
    sessionSecret: 'test-secret-do-not-use-anywhere',
    dbPath: ':memory:',
    logLevel: 'silent',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    stripeSecretKey: 'sk_test_unit_default',
    cookiePrefix: 'bi_',
  },
  paymentLinksCreate: vi.fn(),
  paymentLinksUpdate: vi.fn(),
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

import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import { create as createTimeEntry } from '../server/services/timeEntries.js';
import { createDraft, send, voidInvoice, setStripeLink } from '../server/services/invoices.js';
import * as stripeLinks from '../server/services/stripeLinks.js';

let db;
let admin;
let sub;
let project;
let invoice;

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

beforeEach(() => {
  paymentLinksCreate.mockReset();
  paymentLinksUpdate.mockReset();
  paymentLinksCreate.mockResolvedValue({
    id: 'plink_test_default',
    url: 'https://buy.stripe.com/test_default',
  });
  paymentLinksUpdate.mockResolvedValue({});
  mockConfig.stripeSecretKey = 'sk_test_unit_default';
  stripeLinks._resetClient();

  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub', 'subcontractor');

  const c = createClient(
    db,
    { name: 'Acme', payment_terms_days: 14, contact_email: 'billing@acme.example' },
    { actorId: admin.id }
  );
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });

  // Build a real sent invoice — total = 4h × $125 = $500.
  createTimeEntry(
    db,
    { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'Work' },
    { actor: sub }
  );
  const r = createDraft(
    db,
    {
      project_id: project.id,
      through_date: '2026-05-31',
      issue_date: '2026-05-31',
      due_date: '2026-06-14',
    },
    { actor: admin }
  );
  invoice = r.invoice;
});

describe('isEnabled', () => {
  it('returns true when stripeSecretKey is set', () => {
    expect(stripeLinks.isEnabled()).toBe(true);
  });

  it('returns false when stripeSecretKey is empty', () => {
    mockConfig.stripeSecretKey = '';
    stripeLinks._resetClient();
    expect(stripeLinks.isEnabled()).toBe(false);
  });
});

describe('generate — disabled mode', () => {
  beforeEach(() => {
    mockConfig.stripeSecretKey = '';
    stripeLinks._resetClient();
  });

  it("returns 'stripe_disabled' and never calls Stripe", async () => {
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stripe_disabled');
    expect(paymentLinksCreate).not.toHaveBeenCalled();
    const row = db.prepare('SELECT stripe_payment_link_url, stripe_payment_link_id FROM invoices WHERE id = ?').get(invoice.id);
    expect(row.stripe_payment_link_url).toBeNull();
    expect(row.stripe_payment_link_id).toBeNull();
  });
});

describe('generate — auth + status gates', () => {
  it('rejects missing actor with unauthorized', async () => {
    const r = await stripeLinks.generate(db, invoice.id, {});
    expect(r.reason).toBe('unauthorized');
  });

  it('rejects sub actor with forbidden', async () => {
    const r = await stripeLinks.generate(db, invoice.id, { actor: sub });
    expect(r.reason).toBe('forbidden');
  });

  it('returns not_found for unknown invoice', async () => {
    const r = await stripeLinks.generate(db, 99999, { actor: admin });
    expect(r.reason).toBe('not_found');
  });

  it("rejects 'paid' invoice with wrong_status", async () => {
    db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(invoice.id);
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.reason).toBe('wrong_status');
  });

  it("rejects 'void' invoice with wrong_status", async () => {
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(invoice.id);
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.reason).toBe('wrong_status');
  });
});

describe('generate — happy path', () => {
  it('calls Stripe with the expected payload', async () => {
    await stripeLinks.generate(db, invoice.id, { actor: admin, ip: '127.0.0.1' });
    expect(paymentLinksCreate).toHaveBeenCalledTimes(1);
    const arg = paymentLinksCreate.mock.calls[0][0];
    expect(arg.line_items).toHaveLength(1);
    const item = arg.line_items[0];
    expect(item.quantity).toBe(1);
    expect(item.price_data.currency).toBe('usd');
    expect(item.price_data.unit_amount).toBe(invoice.total_cents);
    expect(item.price_data.product_data.name).toContain(invoice.number);
    expect(item.price_data.product_data.name).toContain('Acme');
    expect(item.price_data.product_data.name).toContain('Website');
    expect(arg.metadata.invoice_id).toBe(String(invoice.id));
    expect(arg.metadata.invoice_number).toBe(invoice.number);
  });

  it('persists URL + id on the invoice row', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_happy',
      url: 'https://buy.stripe.com/test_happy',
    });
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/test_happy');
    expect(r.invoice.stripe_payment_link_id).toBe('plink_happy');
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
    expect(row.stripe_payment_link_url).toBe('https://buy.stripe.com/test_happy');
    expect(row.stripe_payment_link_id).toBe('plink_happy');
  });

  it('writes audit with changes for url + id', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_aud',
      url: 'https://buy.stripe.com/test_aud',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });
    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'invoice.generate_stripe_link'")
      .get();
    expect(audit).toBeTruthy();
    expect(audit.summary).toContain(invoice.number);
    expect(audit.summary).toContain('Acme');
    const changes = db
      .prepare(
        'SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field'
      )
      .all(audit.id);
    expect(changes).toEqual([
      { field: 'stripe_payment_link_id', old_value: null, new_value: 'plink_aud' },
      { field: 'stripe_payment_link_url', old_value: null, new_value: 'https://buy.stripe.com/test_aud' },
    ]);
  });
});

describe('generate — idempotency + force', () => {
  it('second call without force is a no-op (Stripe not re-called)', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_first',
      url: 'https://buy.stripe.com/first',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });
    paymentLinksCreate.mockClear();

    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_id).toBe('plink_first');
    expect(paymentLinksCreate).not.toHaveBeenCalled();
  });

  it('force: true replaces the link and audits the change', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_first',
      url: 'https://buy.stripe.com/first',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });

    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_second',
      url: 'https://buy.stripe.com/second',
    });
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin, force: true });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_id).toBe('plink_second');
    expect(paymentLinksCreate).toHaveBeenCalledTimes(2);

    const audits = db
      .prepare("SELECT id FROM admin_audit WHERE action = 'invoice.generate_stripe_link' ORDER BY id DESC")
      .all();
    const latestChanges = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field')
      .all(audits[0].id);
    expect(latestChanges).toEqual([
      { field: 'stripe_payment_link_id', old_value: 'plink_first', new_value: 'plink_second' },
      { field: 'stripe_payment_link_url', old_value: 'https://buy.stripe.com/first', new_value: 'https://buy.stripe.com/second' },
    ]);
  });
});

describe('generate — Stripe failure', () => {
  it("returns 'stripe_failure', writes error_log, leaves invoice untouched", async () => {
    paymentLinksCreate.mockRejectedValueOnce(new Error('rate limited'));
    const r = await stripeLinks.generate(db, invoice.id, { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stripe_failure');

    const row = db
      .prepare('SELECT stripe_payment_link_url, stripe_payment_link_id FROM invoices WHERE id = ?')
      .get(invoice.id);
    expect(row.stripe_payment_link_url).toBeNull();
    expect(row.stripe_payment_link_id).toBeNull();

    const errors = db.prepare('SELECT * FROM error_log').all();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('paymentLinks.create failed');
    expect(errors[0].message).toContain('rate limited');
    expect(errors[0].user_id).toBe(admin.id);
  });
});

describe('deactivate', () => {
  async function withGeneratedLink() {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_to_deactivate',
      url: 'https://buy.stripe.com/x',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });
  }

  it('happy path: calls paymentLinks.update with active:false', async () => {
    await withGeneratedLink();
    const r = await stripeLinks.deactivate(db, invoice.id);
    expect(r.ok).toBe(true);
    expect(paymentLinksUpdate).toHaveBeenCalledWith('plink_to_deactivate', { active: false });
  });

  it('no-op when invoice has no stripe_payment_link_id', async () => {
    const r = await stripeLinks.deactivate(db, invoice.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_link');
    expect(paymentLinksUpdate).not.toHaveBeenCalled();
  });

  it("returns 'stripe_disabled' when key is unset", async () => {
    await withGeneratedLink();
    mockConfig.stripeSecretKey = '';
    stripeLinks._resetClient();
    const r = await stripeLinks.deactivate(db, invoice.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stripe_disabled');
    expect(paymentLinksUpdate).not.toHaveBeenCalled();
  });

  it('Stripe error writes error_log + does not throw', async () => {
    await withGeneratedLink();
    paymentLinksUpdate.mockRejectedValueOnce(new Error('stripe down'));
    const r = await stripeLinks.deactivate(db, invoice.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stripe_failure');
    const errors = db.prepare('SELECT * FROM error_log').all();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const last = errors[errors.length - 1];
    expect(last.message).toContain('deactivate failed');
    expect(last.message).toContain('stripe down');
  });
});

describe('voidInvoice integration', () => {
  it('fires deactivate when the invoice has a Stripe link', async () => {
    // Send first so we can void.
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_voided',
      url: 'https://buy.stripe.com/voided',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });
    send(db, invoice.id, { actor: admin });

    voidInvoice(db, invoice.id, { actor: admin });
    // deactivate is fire-and-forget — wait a microtask for the promise.
    await new Promise((r) => setImmediate(r));
    expect(paymentLinksUpdate).toHaveBeenCalledWith('plink_voided', { active: false });
    const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice.id);
    expect(row.status).toBe('void');
  });

  it('void survives if Stripe.deactivate throws', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_will_fail',
      url: 'https://buy.stripe.com/wf',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });
    send(db, invoice.id, { actor: admin });
    paymentLinksUpdate.mockRejectedValueOnce(new Error('boom'));

    const r = voidInvoice(db, invoice.id, { actor: admin });
    expect(r.ok).toBe(true);
    await new Promise((r) => setImmediate(r));
    const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice.id);
    expect(row.status).toBe('void');
    // error_log captured the Stripe failure but the void itself succeeded.
    const errors = db.prepare("SELECT * FROM error_log WHERE message LIKE '%deactivate failed%'").all();
    expect(errors.length).toBe(1);
  });

  it('void without a Stripe link does NOT call Stripe', async () => {
    send(db, invoice.id, { actor: admin });
    voidInvoice(db, invoice.id, { actor: admin });
    await new Promise((r) => setImmediate(r));
    expect(paymentLinksUpdate).not.toHaveBeenCalled();
  });
});

describe('setStripeLink clears stripe_payment_link_id', () => {
  it('manually overwriting URL nulls out the stale plink id and audits the change', async () => {
    paymentLinksCreate.mockResolvedValueOnce({
      id: 'plink_to_clear',
      url: 'https://buy.stripe.com/will_be_replaced',
    });
    await stripeLinks.generate(db, invoice.id, { actor: admin });

    const r = setStripeLink(db, invoice.id, 'https://buy.stripe.com/manual', { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/manual');
    expect(r.invoice.stripe_payment_link_id).toBeNull();

    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'invoice.update_stripe_link' ORDER BY id DESC LIMIT 1")
      .get();
    const changes = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field')
      .all(audit.id);
    expect(changes).toEqual([
      { field: 'stripe_payment_link_id', old_value: 'plink_to_clear', new_value: null },
      { field: 'stripe_payment_link_url', old_value: 'https://buy.stripe.com/will_be_replaced', new_value: 'https://buy.stripe.com/manual' },
    ]);
  });
});
