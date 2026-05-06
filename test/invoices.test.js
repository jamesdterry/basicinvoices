import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember, updateRate } from '../server/services/projectMembers.js';
import { create as createTimeEntry, update as updateTimeEntry } from '../server/services/timeEntries.js';
import { create as createExpense } from '../server/services/expenses.js';
import { create as createMilestone } from '../server/services/milestones.js';
import {
  previewDraft,
  createDraft,
  updateDraft,
  send,
  resendEmail,
  voidInvoice,
  deleteDraft,
  rotatePublicToken,
  revokePublicLink,
  setStripeLink,
  list,
  get,
  getByPublicToken,
} from '../server/services/invoices.js';
import { create as createPayment } from '../server/services/payments.js';

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

  const c = createClient(
    db,
    { name: 'Acme', payment_terms_days: 14, contact_email: 'billing@acme.example' },
    { actorId: admin.id }
  );
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  const c2 = createClient(db, { name: 'Globex' }, { actorId: admin.id });
  const p2 = createProject(db, { client_id: c2.client.id, name: 'Intranet' }, { actorId: admin.id });
  otherProject = p2.project;

  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
});

const draftPayload = (overrides = {}) => ({
  project_id: project.id,
  through_date: '2026-05-31',
  issue_date: '2026-05-31',
  due_date: '2026-06-14',
  notes: null,
  ...overrides,
});

describe('previewDraft', () => {
  it('rejects sub viewers', () => {
    const r = previewDraft(db, draftPayload(), sub);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('returns nothing when there are no unbilled rows', () => {
    const r = previewDraft(db, draftPayload(), admin);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.subtotal_cents).toBe(0);
  });

  it('groups time + expense + milestone lines and computes subtotal', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'Auth flow' },
      { actor: sub }
    );
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-05', hours: 1.5, description: 'Cleanup' },
      { actor: sub }
    );
    createExpense(
      db,
      { project_id: project.id, expense_date: '2026-05-04', description: 'Domain', amount_cents: 1500 },
      { actor: admin }
    );
    createMilestone(
      db,
      { project_id: project.id, milestone_date: '2026-05-31', description: 'May retainer', amount_cents: 200000 },
      { actor: admin }
    );

    const r = previewDraft(db, draftPayload(), admin);
    expect(r.ok).toBe(true);
    expect(r.lines).toHaveLength(4);
    expect(r.lines.map((l) => l.kind)).toEqual(['time', 'time', 'expense', 'milestone']);
    // 4*$125 + 1.5*$125 + $15 + $2000 = $500 + $187.50 + $15 + $2000 = $2702.50
    expect(r.subtotal_cents).toBe(50000 + 18750 + 1500 + 200000);
    expect(r.lines[0].unit_rate_cents).toBe(12500);
  });

  it('respects throughDate (excludes future rows)', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'In range' },
      { actor: sub }
    );
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-06-01', hours: 1, description: 'After cutoff' },
      { actor: sub }
    );
    const r = previewDraft(db, draftPayload({ through_date: '2026-05-31' }), admin);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].description).toContain('In range');
  });
});

describe('createDraft', () => {
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 4, description: 'Auth flow' },
      { actor: sub }
    );
    createExpense(
      db,
      { project_id: project.id, expense_date: '2026-05-05', description: 'Domain', amount_cents: 1500 },
      { actor: admin }
    );
  });

  it('rejects sub callers', () => {
    const r = createDraft(db, draftPayload(), { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('creates an invoice with snapshotted rates and locks source rows', () => {
    const r = createDraft(db, draftPayload(), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.status).toBe('draft');
    expect(r.invoice.number).toBe('2026-0001');
    expect(r.invoice.subtotal_cents).toBe(4 * 12500 + 1500);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].kind).toBe('time');
    expect(r.lines[0].unit_rate_cents).toBe(12500);
    // public_token is 32-char base64url
    expect(r.invoice.public_token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // Source rows are now locked
    const te = db.prepare('SELECT invoice_id FROM time_entries').all();
    expect(te.every((row) => row.invoice_id === r.invoice.id)).toBe(true);
    const ex = db.prepare('SELECT invoice_id FROM expenses').all();
    expect(ex.every((row) => row.invoice_id === r.invoice.id)).toBe(true);
  });

  it('rejects creation when there are no unbilled lines', () => {
    // Drain everything in a first invoice; second create should fail.
    createDraft(db, draftPayload(), { actor: admin });
    const r = createDraft(db, draftPayload(), { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_lines');
  });

  it('snapshots unit_rate_cents — later rate changes do not affect existing lines', () => {
    const r = createDraft(db, draftPayload(), { actor: admin });
    const memberId = db
      .prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(project.id, sub.id).id;

    updateRate(db, memberId, { bill_rate_cents: 99999 }, { actorId: admin.id });

    const lineRate = db
      .prepare("SELECT unit_rate_cents FROM invoice_lines WHERE invoice_id = ? AND kind = 'time'")
      .get(r.invoice.id).unit_rate_cents;
    expect(lineRate).toBe(12500);
  });

  it('a locked time entry rejects further updates', () => {
    const r = createDraft(db, draftPayload(), { actor: admin });
    const teId = db.prepare('SELECT id FROM time_entries').get().id;
    const u = updateTimeEntry(db, teId, { hours: 99 }, { actor: sub });
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('locked');
    expect(r.invoice.id).toBeGreaterThan(0);
  });

  it('numbers invoices YYYY-NNNN per calendar year', () => {
    const a = createDraft(db, draftPayload(), { actor: admin });
    expect(a.invoice.number).toBe('2026-0001');

    // Add more billable activity
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-10', hours: 1, description: 'More' },
      { actor: sub }
    );
    const b = createDraft(db, draftPayload({ through_date: '2026-05-15' }), { actor: admin });
    expect(b.invoice.number).toBe('2026-0002');

    // Year rollover
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2027-01-04', hours: 1, description: 'Next year' },
      { actor: sub }
    );
    const c = createDraft(
      db,
      draftPayload({ through_date: '2027-01-31', issue_date: '2027-01-31', due_date: '2027-02-14' }),
      { actor: admin }
    );
    expect(c.invoice.number).toBe('2027-0001');
  });

  it('writes an audit row that includes the invoice number and total', () => {
    createDraft(db, draftPayload(), { actor: admin });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'invoice.create'").get();
    expect(row.summary).toContain('2026-0001');
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
    expect(row.summary).toContain('$515.00');
  });
});

describe('updateDraft', () => {
  let invoiceId;
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    invoiceId = r.invoice.id;
  });

  it('updates notes / dates / Stripe url and writes audit_changes', () => {
    const r = updateDraft(
      db,
      invoiceId,
      {
        notes: 'Net 14',
        due_date: '2026-06-30',
        stripe_payment_link_url: 'https://buy.stripe.com/abc',
      },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    expect(r.invoice.notes).toBe('Net 14');
    expect(r.invoice.due_date).toBe('2026-06-30');
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/abc');

    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'invoice.update'").get();
    const fields = db.prepare('SELECT field FROM audit_changes WHERE audit_id = ?').all(audit.id).map((c) => c.field);
    expect(fields.sort()).toEqual(['due_date', 'notes', 'stripe_payment_link_url']);
  });

  it('rejects updates on a sent invoice', () => {
    send(db, invoiceId, { actor: admin });
    const r = updateDraft(db, invoiceId, { notes: 'late' }, { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_status');
  });

  it('rejects sub callers', () => {
    const r = updateDraft(db, invoiceId, { notes: 'x' }, { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('rejects invalid stripe URLs', () => {
    const r = updateDraft(db, invoiceId, { stripe_payment_link_url: 'javascript:alert(1)' }, { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_stripe_url');
  });

  it('updates a line description and sort_order', () => {
    const lineId = db
      .prepare('SELECT id FROM invoice_lines WHERE invoice_id = ?')
      .get(invoiceId).id;
    const r = updateDraft(
      db,
      invoiceId,
      { lines: [{ id: lineId, description: 'Renamed line', sort_order: 99 }] },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    const after = db.prepare('SELECT description, sort_order FROM invoice_lines WHERE id = ?').get(lineId);
    expect(after.description).toBe('Renamed line');
    expect(after.sort_order).toBe(99);
  });
});

describe('send', () => {
  it('flips draft → sent and stamps sent_at', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    const s = send(db, r.invoice.id, { actor: admin });
    expect(s.ok).toBe(true);
    expect(s.invoice.status).toBe('sent');
    expect(s.invoice.sent_at).toBeTruthy();

    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'invoice.send'").get();
    expect(audit.summary).toContain('2026-0001');
  });

  it('rejects with no_client_email when client has no contact_email', () => {
    db.prepare('UPDATE clients SET contact_email = NULL').run();
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    const s = send(db, r.invoice.id, { actor: admin });
    expect(s.ok).toBe(false);
    expect(s.reason).toBe('no_client_email');

    const after = db.prepare('SELECT status FROM invoices WHERE id = ?').get(r.invoice.id);
    expect(after.status).toBe('draft');

    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'invoice.send'").get();
    expect(audit).toBeUndefined();
  });
});

describe('resendEmail', () => {
  function setupSent() {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    send(db, r.invoice.id, { actor: admin });
    return r.invoice.id;
  }

  it('rejects subs', () => {
    const id = setupSent();
    const r = resendEmail(db, id, { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('rejects drafts', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    const out = resendEmail(db, r.invoice.id, { actor: admin });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('wrong_status');
  });

  it('rejects void invoices', () => {
    const id = setupSent();
    voidInvoice(db, id, { actor: admin });
    const out = resendEmail(db, id, { actor: admin });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('wrong_status');
  });

  it('rejects when client has no email', () => {
    const id = setupSent();
    db.prepare('UPDATE clients SET contact_email = NULL').run();
    const out = resendEmail(db, id, { actor: admin });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('no_client_email');
  });

  it('writes invoice.resend_email audit on a sent invoice', () => {
    const id = setupSent();
    const before = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'invoice.resend_email'").get();
    expect(before.n).toBe(0);

    const out = resendEmail(db, id, { actor: admin });
    expect(out.ok).toBe(true);

    const after = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'invoice.resend_email'")
      .all();
    expect(after).toHaveLength(1);
    expect(after[0].summary).toMatch(/^Re-sent invoice 2026-\d{4} to Acme$/);
  });

  it('does not mutate invoice rows', () => {
    const id = setupSent();
    const before = db.prepare('SELECT updated_at, sent_at FROM invoices WHERE id = ?').get(id);
    resendEmail(db, id, { actor: admin });
    const after = db.prepare('SELECT updated_at, sent_at FROM invoices WHERE id = ?').get(id);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.sent_at).toBe(before.sent_at);
  });
});

describe('voidInvoice', () => {
  it('detaches every source row and sets status void', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    createExpense(
      db,
      { project_id: project.id, expense_date: '2026-05-05', description: 'Domain', amount_cents: 1500 },
      { actor: admin }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    voidInvoice(db, r.invoice.id, { actor: admin });

    const voided = db.prepare('SELECT status FROM invoices WHERE id = ?').get(r.invoice.id);
    expect(voided.status).toBe('void');
    expect(db.prepare('SELECT invoice_id FROM time_entries').get().invoice_id).toBeNull();
    expect(db.prepare('SELECT invoice_id FROM expenses').get().invoice_id).toBeNull();
  });

  it('rejects re-voiding an already-void invoice', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    voidInvoice(db, r.invoice.id, { actor: admin });
    const again = voidInvoice(db, r.invoice.id, { actor: admin });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('wrong_status');
  });
});

describe('deleteDraft', () => {
  it('detaches sources, removes lines, removes invoice', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    const d = deleteDraft(db, r.invoice.id, { actor: admin });
    expect(d.ok).toBe(true);

    expect(db.prepare('SELECT id FROM invoices WHERE id = ?').get(r.invoice.id)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_lines').get().n).toBe(0);
    expect(db.prepare('SELECT invoice_id FROM time_entries').get().invoice_id).toBeNull();
  });

  it('rejects deleting a sent invoice', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    send(db, r.invoice.id, { actor: admin });
    const d = deleteDraft(db, r.invoice.id, { actor: admin });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('wrong_status');
  });
});

describe('rotatePublicToken / revokePublicLink', () => {
  let invoiceId;
  let originalToken;
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    invoiceId = r.invoice.id;
    originalToken = r.invoice.public_token;
  });

  it('rotate mints a new token and clears revoked_at', () => {
    revokePublicLink(db, invoiceId, { actor: admin });
    const r = rotatePublicToken(db, invoiceId, { actor: admin });
    expect(r.invoice.public_token).not.toBe(originalToken);
    expect(r.invoice.public_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.invoice.public_token_revoked_at).toBeNull();
    expect(getByPublicToken(db, originalToken)).toBeNull();
  });

  it('revoke sets revoked_at; getByPublicToken still finds it but flags revoked=true', () => {
    revokePublicLink(db, invoiceId, { actor: admin });
    const data = getByPublicToken(db, originalToken);
    expect(data).not.toBeNull();
    expect(data.revoked).toBe(true);
  });

  it('idempotent revoke', () => {
    const a = revokePublicLink(db, invoiceId, { actor: admin });
    const b = revokePublicLink(db, invoiceId, { actor: admin });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});

describe('list / get / RBAC', () => {
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    createDraft(db, draftPayload(), { actor: admin });
  });

  it('list returns empty for sub viewers', () => {
    expect(list(db, {}, sub)).toEqual([]);
  });

  it('list filters by status / clientId / projectId', () => {
    expect(list(db, {}, admin)).toHaveLength(1);
    expect(list(db, { status: 'draft' }, admin)).toHaveLength(1);
    expect(list(db, { status: 'paid' }, admin)).toHaveLength(0);
    expect(list(db, { projectId: otherProject.id }, admin)).toHaveLength(0);
  });

  it('get returns null for sub viewers', () => {
    const id = list(db, {}, admin)[0].id;
    expect(get(db, id, sub)).toBeNull();
    expect(get(db, id, admin)).not.toBeNull();
  });
});

describe('voidInvoice — has_payments guard', () => {
  it('rejects voiding an invoice that has payments', () => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    send(db, r.invoice.id, { actor: admin });
    createPayment(
      db,
      { invoice_id: r.invoice.id, received_date: '2026-06-01', amount_cents: 1000, method: 'check' },
      { actor: admin }
    );
    const v = voidInvoice(db, r.invoice.id, { actor: admin });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('has_payments');
  });
});

describe('setStripeLink', () => {
  let draftId;
  beforeEach(() => {
    createTimeEntry(
      db,
      { project_id: project.id, entry_date: '2026-05-04', hours: 1, description: 'Work' },
      { actor: sub }
    );
    const r = createDraft(db, draftPayload(), { actor: admin });
    draftId = r.invoice.id;
  });

  it('updates link on a draft invoice', () => {
    const r = setStripeLink(db, draftId, 'https://buy.stripe.com/test_abc', { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/test_abc');
  });

  it('updates link on a sent invoice', () => {
    send(db, draftId, { actor: admin });
    const r = setStripeLink(db, draftId, 'https://buy.stripe.com/sent_xyz', { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.status).toBe('sent');
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/sent_xyz');
  });

  it('rejects on a paid invoice', () => {
    send(db, draftId, { actor: admin });
    db.prepare("UPDATE invoices SET status = 'paid' WHERE id = ?").run(draftId);
    const r = setStripeLink(db, draftId, 'https://buy.stripe.com/x', { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_status');
  });

  it('rejects on a void invoice', () => {
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(draftId);
    const r = setStripeLink(db, draftId, 'https://buy.stripe.com/x', { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong_status');
  });

  it('rejects malformed URLs', () => {
    expect(setStripeLink(db, draftId, 'not-a-url', { actor: admin }).reason).toBe('invalid_stripe_url');
    expect(setStripeLink(db, draftId, 'ftp://x.example/y', { actor: admin }).reason).toBe('invalid_stripe_url');
  });

  it('clears the link when given null/empty', () => {
    setStripeLink(db, draftId, 'https://buy.stripe.com/a', { actor: admin });
    const r = setStripeLink(db, draftId, null, { actor: admin });
    expect(r.invoice.stripe_payment_link_url).toBeNull();
  });

  it('writes audit_changes on the update', () => {
    setStripeLink(db, draftId, 'https://buy.stripe.com/aud', { actor: admin });
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'invoice.update_stripe_link'").get();
    expect(audit).toBeTruthy();
    const changes = db.prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?').all(audit.id);
    expect(changes).toEqual([
      { field: 'stripe_payment_link_url', old_value: null, new_value: 'https://buy.stripe.com/aud' },
    ]);
  });

  it('rejects sub actor', () => {
    expect(setStripeLink(db, draftId, 'https://buy.stripe.com/x', { actor: sub }).reason).toBe('forbidden');
  });

  it('returns not_found for unknown id', () => {
    expect(setStripeLink(db, 9999, 'https://buy.stripe.com/x', { actor: admin }).reason).toBe('not_found');
  });

  it('clears stripe_payment_link_id when URL is manually overwritten (Stage 7A)', () => {
    // Simulate a previous programmatic generate() by stamping in an id.
    db.prepare(
      `UPDATE invoices
          SET stripe_payment_link_url = 'https://buy.stripe.com/old',
              stripe_payment_link_id  = 'plink_old'
        WHERE id = ?`
    ).run(draftId);

    const r = setStripeLink(db, draftId, 'https://buy.stripe.com/new', { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/new');
    expect(r.invoice.stripe_payment_link_id).toBeNull();

    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'invoice.update_stripe_link' ORDER BY id DESC LIMIT 1")
      .get();
    const changes = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ? ORDER BY field')
      .all(audit.id);
    expect(changes).toEqual([
      { field: 'stripe_payment_link_id', old_value: 'plink_old', new_value: null },
      { field: 'stripe_payment_link_url', old_value: 'https://buy.stripe.com/old', new_value: 'https://buy.stripe.com/new' },
    ]);
  });
});
