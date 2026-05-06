import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import { create as createTimeEntry } from '../server/services/timeEntries.js';
import { createDraft, send } from '../server/services/invoices.js';
import {
  create,
  update,
  remove,
  list,
  get,
  invoiceHasPayments,
} from '../server/services/payments.js';

let db;
let admin;
let sub;
let project;
let sentInvoice;     // status 'sent', total $500.00 (4h × $125/hr)
let draftInvoice;    // status 'draft'

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
  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub Person', 'subcontractor');

  const c = createClient(
    db,
    { name: 'Acme', payment_terms_days: 14, contact_email: 'billing@acme.example' },
    { actorId: admin.id }
  );
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });

  // Sent invoice — 4h × $125 = $500.00 total.
  createTimeEntry(
    db,
    { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'Work' },
    { actor: sub }
  );
  const r1 = createDraft(
    db,
    {
      project_id: project.id,
      through_date: '2026-05-31',
      issue_date: '2026-05-31',
      due_date: '2026-06-14',
    },
    { actor: admin }
  );
  send(db, r1.invoice.id, { actor: admin });
  sentInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(r1.invoice.id);

  // Draft invoice on a second project — for wrong-status checks.
  const c2 = createClient(db, { name: 'Globex', contact_email: 'b@globex.example' }, { actorId: admin.id });
  const p2 = createProject(db, { client_id: c2.client.id, name: 'Intranet' }, { actorId: admin.id });
  addMember(db, p2.project.id, { user_id: sub.id, bill_rate_cents: 10000 }, { actorId: admin.id });
  createTimeEntry(
    db,
    { project_id: p2.project.id, entry_date: '2026-05-04', hours: 2, description: 'Work' },
    { actor: sub }
  );
  const r2 = createDraft(
    db,
    {
      project_id: p2.project.id,
      through_date: '2026-05-31',
      issue_date: '2026-05-31',
      due_date: '2026-06-14',
    },
    { actor: admin }
  );
  draftInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(r2.invoice.id);
});

const goodPayment = (overrides = {}) => ({
  invoice_id: sentInvoice.id,
  received_date: '2026-06-01',
  amount_cents: 25000,         // $250.00 (half of $500)
  method: 'check',
  reference: 'check #1234',
  note: 'partial',
  ...overrides,
});

describe('create', () => {
  it('records a partial payment without flipping status', () => {
    const r = create(db, goodPayment(), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.payment.amount_cents).toBe(25000);
    expect(r.payment.method).toBe('check');
    expect(r.invoice.status).toBe('sent');
    expect(r.invoice.amount_paid_cents).toBe(25000);
  });

  it('flips status to paid when fully covered', () => {
    const r = create(db, goodPayment({ amount_cents: 50000 }), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.status).toBe('paid');
    expect(r.invoice.amount_paid_cents).toBe(50000);
  });

  it('two partial payments summing to total flip status to paid on the second', () => {
    const a = create(db, goodPayment({ amount_cents: 30000 }), { actor: admin });
    expect(a.invoice.status).toBe('sent');
    const b = create(db, goodPayment({ amount_cents: 20000, received_date: '2026-06-02' }), { actor: admin });
    expect(b.invoice.status).toBe('paid');
    expect(b.invoice.amount_paid_cents).toBe(50000);
    const audits = db
      .prepare("SELECT id FROM admin_audit WHERE action = 'payment.create'")
      .all();
    expect(audits).toHaveLength(2);
  });

  it('rejects sub actor with forbidden', () => {
    expect(create(db, goodPayment(), { actor: sub }).reason).toBe('forbidden');
  });

  it('rejects unauthenticated callers', () => {
    expect(create(db, goodPayment(), {}).reason).toBe('unauthorized');
  });

  it('rejects unknown invoice', () => {
    expect(create(db, goodPayment({ invoice_id: 99999 }), { actor: admin }).reason).toBe('not_found');
  });

  it('rejects payment on a draft invoice (wrong_status)', () => {
    expect(
      create(db, goodPayment({ invoice_id: draftInvoice.id }), { actor: admin }).reason
    ).toBe('wrong_status');
  });

  it('rejects payment on a void invoice (wrong_status)', () => {
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(sentInvoice.id);
    expect(create(db, goodPayment(), { actor: admin }).reason).toBe('wrong_status');
  });

  it('validates date format', () => {
    expect(create(db, goodPayment({ received_date: '6/1/2026' }), { actor: admin }).reason).toBe('invalid_date');
    expect(create(db, goodPayment({ received_date: '' }), { actor: admin }).reason).toBe('invalid_date');
  });

  it('rejects non-positive or non-integer amounts', () => {
    expect(create(db, goodPayment({ amount_cents: 0 }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodPayment({ amount_cents: -100 }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodPayment({ amount_cents: 4.2 }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodPayment({ amount_cents: '' }), { actor: admin }).reason).toBe('invalid_amount');
  });

  it('requires a non-empty method', () => {
    expect(create(db, goodPayment({ method: '   ' }), { actor: admin }).reason).toBe('method_required');
    expect(create(db, goodPayment({ method: '' }), { actor: admin }).reason).toBe('method_required');
  });

  it('writes an audit row with display strings', () => {
    create(db, goodPayment(), { actor: admin });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'payment.create'").get();
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain(sentInvoice.number);
    expect(row.summary).toContain('$250.00');
    expect(row.summary).toContain('check');
    expect(row.summary).toContain('2026-06-01');
  });
});

describe('update', () => {
  it('recomputes invoice totals when amount changes', () => {
    const r = create(db, goodPayment({ amount_cents: 25000 }), { actor: admin });
    const u = update(db, r.payment.id, { amount_cents: 50000 }, { actor: admin });
    expect(u.ok).toBe(true);
    expect(u.payment.amount_cents).toBe(50000);
    expect(u.invoice.status).toBe('paid');
    expect(u.invoice.amount_paid_cents).toBe(50000);
  });

  it('writes audit_changes for changed fields', () => {
    const r = create(db, goodPayment(), { actor: admin });
    update(db, r.payment.id, { amount_cents: 30000, method: 'wire' }, { actor: admin });
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'payment.update'").get();
    const changes = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field')
      .all(audit.id);
    expect(changes).toEqual([
      { field: 'amount_cents', old_value: '25000', new_value: '30000' },
      { field: 'method', old_value: 'check', new_value: 'wire' },
    ]);
  });

  it('is a no-op when nothing changes', () => {
    const r = create(db, goodPayment(), { actor: admin });
    const u = update(db, r.payment.id, {}, { actor: admin });
    expect(u.ok).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'payment.update'").get().n;
    expect(count).toBe(0);
  });

  it('rejects sub actor', () => {
    const r = create(db, goodPayment(), { actor: admin });
    expect(update(db, r.payment.id, { amount_cents: 10000 }, { actor: sub }).reason).toBe('forbidden');
  });

  it('returns not_found for unknown id', () => {
    expect(update(db, 9999, { amount_cents: 10000 }, { actor: admin }).reason).toBe('not_found');
  });

  it('validates patched fields', () => {
    const r = create(db, goodPayment(), { actor: admin });
    expect(update(db, r.payment.id, { received_date: '6/1/2026' }, { actor: admin }).reason).toBe('invalid_date');
    expect(update(db, r.payment.id, { amount_cents: 0 }, { actor: admin }).reason).toBe('invalid_amount');
    expect(update(db, r.payment.id, { method: '' }, { actor: admin }).reason).toBe('method_required');
  });
});

describe('remove', () => {
  it('recomputes amount_paid_cents but does NOT auto-revert paid → sent', () => {
    const a = create(db, goodPayment({ amount_cents: 25000 }), { actor: admin });
    const b = create(db, goodPayment({ amount_cents: 25000, received_date: '2026-06-02' }), { actor: admin });
    expect(b.invoice.status).toBe('paid');

    const r = remove(db, b.payment.id, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.status).toBe('paid');                 // sticky
    expect(r.invoice.amount_paid_cents).toBe(25000);       // recomputed

    // sanity: deleting the remaining payment leaves status paid but paid=0.
    const r2 = remove(db, a.payment.id, { actor: admin });
    expect(r2.invoice.status).toBe('paid');
    expect(r2.invoice.amount_paid_cents).toBe(0);
  });

  it('writes a delete audit row', () => {
    const r = create(db, goodPayment(), { actor: admin });
    remove(db, r.payment.id, { actor: admin });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'payment.delete'").get();
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('$250.00');
  });

  it('rejects sub actor', () => {
    const r = create(db, goodPayment(), { actor: admin });
    expect(remove(db, r.payment.id, { actor: sub }).reason).toBe('forbidden');
  });
});

describe('list / get', () => {
  it('returns empty for non-super-admin viewers', () => {
    create(db, goodPayment(), { actor: admin });
    expect(list(db, { invoiceId: sentInvoice.id }, sub)).toEqual([]);
    expect(list(db, { invoiceId: sentInvoice.id }, undefined)).toEqual([]);
  });

  it('lists payments for an invoice ordered by date desc', () => {
    create(db, goodPayment({ amount_cents: 10000, received_date: '2026-06-01' }), { actor: admin });
    create(db, goodPayment({ amount_cents: 20000, received_date: '2026-06-03' }), { actor: admin });
    create(db, goodPayment({ amount_cents: 5000, received_date: '2026-06-02' }), { actor: admin });
    const rows = list(db, { invoiceId: sentInvoice.id }, admin);
    expect(rows.map((r) => r.received_date)).toEqual(['2026-06-03', '2026-06-02', '2026-06-01']);
  });

  it('get returns the row for super-admin and null otherwise', () => {
    const r = create(db, goodPayment(), { actor: admin });
    expect(get(db, r.payment.id, admin)?.id).toBe(r.payment.id);
    expect(get(db, r.payment.id, sub)).toBeNull();
  });
});

describe('invoiceHasPayments', () => {
  it('returns false for an invoice with no payments and true once one is recorded', () => {
    expect(invoiceHasPayments(db, sentInvoice.id)).toBe(false);
    create(db, goodPayment(), { actor: admin });
    expect(invoiceHasPayments(db, sentInvoice.id)).toBe(true);
  });
});
