import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb, insertStubInvoice } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import {
  create,
  update,
  remove,
  list,
  get,
} from '../server/services/expenses.js';

let db;
let admin;
let sub;
let project;
let otherProject;

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

  const c = createClient(db, { name: 'Acme' }, { actorId: admin.id });
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  const c2 = createClient(db, { name: 'Globex' }, { actorId: admin.id });
  const p2 = createProject(db, { client_id: c2.client.id, name: 'Intranet' }, { actorId: admin.id });
  otherProject = p2.project;
});

const goodExpense = (overrides = {}) => ({
  project_id: project.id,
  expense_date: '2026-05-04',
  description: 'Domain renewal',
  amount_cents: 4200,
  ...overrides,
});

describe('create', () => {
  it('lets super_admin add an expense to any project', () => {
    const r = create(db, goodExpense(), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.entry.project_id).toBe(project.id);
    expect(r.entry.created_by).toBe(admin.id);
    expect(r.entry.description).toBe('Domain renewal');
    expect(r.entry.amount_cents).toBe(4200);
    expect(r.entry.invoice_id).toBeNull();
    expect(r.entry.locked).toBe(false);
  });

  it('rejects a sub with forbidden', () => {
    const r = create(db, goodExpense(), { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('rejects unauthenticated callers', () => {
    const r = create(db, goodExpense(), {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unauthorized');
  });

  it('validates date format', () => {
    expect(create(db, goodExpense({ expense_date: '5/4/2026' }), { actor: admin }).reason).toBe('invalid_date');
    expect(create(db, goodExpense({ expense_date: '' }), { actor: admin }).reason).toBe('invalid_date');
  });

  it('requires a description', () => {
    expect(create(db, goodExpense({ description: '   ' }), { actor: admin }).reason).toBe('description_required');
    expect(create(db, goodExpense({ description: '' }), { actor: admin }).reason).toBe('description_required');
  });

  it('rejects non-integer or negative amounts', () => {
    expect(create(db, goodExpense({ amount_cents: -1 }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodExpense({ amount_cents: 4.2 }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodExpense({ amount_cents: 'abc' }), { actor: admin }).reason).toBe('invalid_amount');
    expect(create(db, goodExpense({ amount_cents: '' }), { actor: admin }).reason).toBe('invalid_amount');
  });

  it('allows zero-amount expense', () => {
    const r = create(db, goodExpense({ amount_cents: 0 }), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.entry.amount_cents).toBe(0);
  });

  it('rejects an unknown project', () => {
    const r = create(db, goodExpense({ project_id: 99999 }), { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('project_not_found');
  });

  it('writes an audit row with display strings', () => {
    create(db, goodExpense(), { actor: admin });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'expense.create'").get();
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
    expect(row.summary).toContain('Domain renewal');
    expect(row.summary).toContain('$42.00');
    expect(row.summary).toContain('2026-05-04');
  });
});

describe('update', () => {
  it('allows super_admin to patch fields', () => {
    const r = create(db, goodExpense(), { actor: admin });
    const u = update(db, r.entry.id, { description: 'Domain + email', amount_cents: 5000 }, { actor: admin });
    expect(u.ok).toBe(true);
    expect(u.entry.description).toBe('Domain + email');
    expect(u.entry.amount_cents).toBe(5000);
  });

  it('rejects a sub with forbidden', () => {
    const r = create(db, goodExpense(), { actor: admin });
    const u = update(db, r.entry.id, { description: 'X' }, { actor: sub });
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('forbidden');
  });

  it('writes audit_changes for changed fields', () => {
    const r = create(db, goodExpense(), { actor: admin });
    update(db, r.entry.id, { amount_cents: 5000 }, { actor: admin });
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'expense.update'").get();
    const changes = db.prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?').all(audit.id);
    expect(changes).toEqual([{ field: 'amount_cents', old_value: '4200', new_value: '5000' }]);
  });

  it('rejects update on a locked (invoiced) row', () => {
    const r = create(db, goodExpense(), { actor: admin });
    const invoiceId = insertStubInvoice(db, project.id);
    db.prepare('UPDATE expenses SET invoice_id = ? WHERE id = ?').run(invoiceId, r.entry.id);
    const u = update(db, r.entry.id, { description: 'X' }, { actor: admin });
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('locked');
  });

  it('returns not_found for unknown id', () => {
    expect(update(db, 999, { description: 'X' }, { actor: admin }).reason).toBe('not_found');
  });

  it('is a no-op when nothing changes', () => {
    const r = create(db, goodExpense(), { actor: admin });
    const u = update(db, r.entry.id, {}, { actor: admin });
    expect(u.ok).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'expense.update'").get().n;
    expect(count).toBe(0);
  });

  it('validates patched date', () => {
    const r = create(db, goodExpense(), { actor: admin });
    expect(update(db, r.entry.id, { expense_date: '5/4/2026' }, { actor: admin }).reason).toBe('invalid_date');
  });
});

describe('remove', () => {
  it('hard-deletes an unlocked row', () => {
    const r = create(db, goodExpense(), { actor: admin });
    remove(db, r.entry.id, { actor: admin });
    expect(db.prepare('SELECT id FROM expenses WHERE id = ?').get(r.entry.id)).toBeUndefined();
  });

  it('rejects deleting a locked row', () => {
    const r = create(db, goodExpense(), { actor: admin });
    const invoiceId = insertStubInvoice(db, project.id);
    db.prepare('UPDATE expenses SET invoice_id = ? WHERE id = ?').run(invoiceId, r.entry.id);
    expect(remove(db, r.entry.id, { actor: admin }).reason).toBe('locked');
  });

  it('rejects a sub with forbidden', () => {
    const r = create(db, goodExpense(), { actor: admin });
    expect(remove(db, r.entry.id, { actor: sub }).reason).toBe('forbidden');
  });

  it('writes an audit row', () => {
    const r = create(db, goodExpense(), { actor: admin });
    remove(db, r.entry.id, { actor: admin });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'expense.delete'").get();
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
    expect(row.summary).toContain('$42.00');
  });
});

describe('list', () => {
  beforeEach(() => {
    create(db, goodExpense({ expense_date: '2026-05-01', amount_cents: 100 }), { actor: admin });
    create(db, goodExpense({ expense_date: '2026-05-02', amount_cents: 200 }), { actor: admin });
    create(db, goodExpense({ project_id: otherProject.id, expense_date: '2026-05-03', amount_cents: 300 }), { actor: admin });
    create(db, goodExpense({ expense_date: '2026-05-04', amount_cents: 400 }), { actor: admin });
  });

  it('returns empty array for non-super_admin viewers', () => {
    expect(list(db, {}, sub)).toEqual([]);
    expect(list(db, {}, undefined)).toEqual([]);
  });

  it('super_admin sees all expenses by default', () => {
    expect(list(db, {}, admin)).toHaveLength(4);
  });

  it('filters by projectId', () => {
    const rows = list(db, { projectId: otherProject.id }, admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(otherProject.id);
  });

  it('filters by date range', () => {
    const rows = list(db, { from: '2026-05-02', to: '2026-05-03' }, admin);
    expect(rows.map((r) => r.expense_date).sort()).toEqual(['2026-05-02', '2026-05-03']);
  });

  it('hides locked rows by default and reveals them with includeLocked', () => {
    const all = list(db, {}, admin);
    const invoiceId = insertStubInvoice(db, all[0].project_id);
    db.prepare('UPDATE expenses SET invoice_id = ? WHERE id = ?').run(invoiceId, all[0].id);
    expect(list(db, {}, admin)).toHaveLength(3);
    expect(list(db, { includeLocked: true }, admin)).toHaveLength(4);
  });

  it('orders entries by expense_date DESC', () => {
    const rows = list(db, {}, admin);
    const dates = rows.map((r) => r.expense_date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });
});

describe('get', () => {
  it('returns the row to super_admin and null to others', () => {
    const r = create(db, goodExpense(), { actor: admin });
    expect(get(db, r.entry.id, admin)?.id).toBe(r.entry.id);
    expect(get(db, r.entry.id, sub)).toBeNull();
    expect(get(db, r.entry.id, undefined)).toBeNull();
  });

  it('returns null for unknown id', () => {
    expect(get(db, 9999, admin)).toBeNull();
  });
});
