import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import { create as createTimeEntry } from '../server/services/timeEntries.js';
import { createDraft, send } from '../server/services/invoices.js';
import { create as createPayment } from '../server/services/payments.js';
import { paymentsReport } from '../server/services/reports.js';

let db;
let admin;
let sub;
let acmeWebsiteInvoice;     // total $500 (4h × $125)
let acmeIntranetInvoice;    // total $200 (2h × $100)
let globexAppInvoice;       // total $300 (3h × $100)

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

function setupSentInvoice(client, project, hours, rateCents) {
  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: rateCents }, { actorId: admin.id });
  createTimeEntry(
    db,
    { project_id: project.id, entry_date: '2026-04-15', hours, description: 'Work' },
    { actor: sub }
  );
  const r = createDraft(
    db,
    {
      project_id: project.id,
      through_date: '2026-04-30',
      issue_date: '2026-04-30',
      due_date: '2026-05-14',
    },
    { actor: admin }
  );
  send(db, r.invoice.id, { actor: admin });
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(r.invoice.id);
}

beforeEach(() => {
  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub Person', 'subcontractor');

  const acme = createClient(
    db,
    { name: 'Acme', payment_terms_days: 14, contact_emails: ['billing@acme.example'] },
    { actorId: admin.id }
  ).client;
  const globex = createClient(
    db,
    { name: 'globex', contact_emails: ['billing@globex.example'] },   // lowercase to test NOCASE sort
    { actorId: admin.id }
  ).client;

  const acmeWebsite = createProject(db, { client_id: acme.id, name: 'Website' }, { actorId: admin.id }).project;
  const acmeIntranet = createProject(db, { client_id: acme.id, name: 'Intranet' }, { actorId: admin.id }).project;
  const globexApp = createProject(db, { client_id: globex.id, name: 'App' }, { actorId: admin.id }).project;

  acmeWebsiteInvoice  = setupSentInvoice(acme,   acmeWebsite,  4, 12500);   // $500
  acmeIntranetInvoice = setupSentInvoice(acme,   acmeIntranet, 2, 10000);   // $200
  globexAppInvoice    = setupSentInvoice(globex, globexApp,    3, 10000);   // $300
});

function pay(invoice, receivedDate, amountCents) {
  const r = createPayment(
    db,
    { invoice_id: invoice.id, received_date: receivedDate, amount_cents: amountCents, method: 'check' },
    { actor: admin }
  );
  expect(r.ok).toBe(true);
  return r;
}

describe('paymentsReport — auth + validation', () => {
  it('rejects non-super-admin viewers', () => {
    expect(paymentsReport(db, { from: '2026-04-01', to: '2026-04-30', groupBy: 'client' }, sub).reason)
      .toBe('forbidden');
    expect(paymentsReport(db, { from: '2026-04-01', to: '2026-04-30', groupBy: 'client' }, undefined).reason)
      .toBe('forbidden');
  });

  it('validates date format on both ends', () => {
    expect(paymentsReport(db, { from: '4/1/2026', to: '2026-04-30', groupBy: 'client' }, admin).reason)
      .toBe('invalid_date');
    expect(paymentsReport(db, { from: '2026-04-01', to: '', groupBy: 'client' }, admin).reason)
      .toBe('invalid_date');
    expect(paymentsReport(db, {}, admin).reason).toBe('invalid_date');
  });

  it('rejects to < from with invalid_range', () => {
    expect(paymentsReport(db, { from: '2026-04-30', to: '2026-04-01', groupBy: 'client' }, admin).reason)
      .toBe('invalid_range');
  });

  it('rejects unknown groupBy', () => {
    expect(paymentsReport(db, { from: '2026-04-01', to: '2026-04-30', groupBy: 'user' }, admin).reason)
      .toBe('invalid_group');
  });

  it('defaults to client when groupBy is undefined', () => {
    const r = paymentsReport(db, { from: '2026-04-01', to: '2026-04-30' }, admin);
    expect(r.ok).toBe(true);
    expect(r.groupBy).toBe('client');
  });
});

describe('paymentsReport — empty / no payments', () => {
  it('returns empty rows when no payments fall in range', () => {
    pay(acmeWebsiteInvoice, '2026-05-15', 50000);
    const r = paymentsReport(db, { from: '2026-06-01', to: '2026-06-30', groupBy: 'client' }, admin);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.from).toBe('2026-06-01');
    expect(r.to).toBe('2026-06-30');
  });
});

describe('paymentsReport — groupBy: client', () => {
  it('aggregates payments per client and sorts case-insensitively', () => {
    // Acme: $250 on Website (5/01) + $200 on Intranet (5/15) = $450 across 2 payments
    pay(acmeWebsiteInvoice,  '2026-05-01', 25000);
    pay(acmeIntranetInvoice, '2026-05-15', 20000);
    // globex: $300 on App (5/10) = $300, 1 payment
    pay(globexAppInvoice, '2026-05-10', 30000);

    const r = paymentsReport(db, { from: '2026-05-01', to: '2026-05-31', groupBy: 'client' }, admin);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(2);
    // NOCASE sort: 'Acme' before 'globex'
    expect(r.rows[0].label).toBe('Acme');
    expect(r.rows[0].totalCents).toBe(45000);
    expect(r.rows[0].count).toBe(2);
    expect(r.rows[1].label).toBe('globex');
    expect(r.rows[1].totalCents).toBe(30000);
    expect(r.rows[1].count).toBe(1);
  });
});

describe('paymentsReport — groupBy: project', () => {
  it('aggregates per project and labels as "Client — Project"', () => {
    pay(acmeWebsiteInvoice,  '2026-05-01', 25000);
    pay(acmeIntranetInvoice, '2026-05-15', 20000);
    pay(globexAppInvoice,    '2026-05-10', 30000);

    const r = paymentsReport(db, { from: '2026-05-01', to: '2026-05-31', groupBy: 'project' }, admin);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(3);
    const labels = r.rows.map((row) => row.label);
    expect(labels).toContain('Acme — Website');
    expect(labels).toContain('Acme — Intranet');
    expect(labels).toContain('globex — App');
    const website = r.rows.find((row) => row.label === 'Acme — Website');
    expect(website.totalCents).toBe(25000);
    expect(website.count).toBe(1);
  });
});

describe('paymentsReport — date range bounds', () => {
  it('includes payments on the from and to boundaries (inclusive range)', () => {
    pay(acmeWebsiteInvoice,  '2026-05-01', 10000);   // exactly on `from`
    pay(acmeIntranetInvoice, '2026-05-31', 20000);   // exactly on `to`

    const r = paymentsReport(db, { from: '2026-05-01', to: '2026-05-31', groupBy: 'client' }, admin);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].label).toBe('Acme');
    expect(r.rows[0].totalCents).toBe(30000);
    expect(r.rows[0].count).toBe(2);
  });

  it('excludes payments outside the range by a single day', () => {
    pay(acmeWebsiteInvoice, '2026-04-30', 10000);   // day before `from`
    pay(acmeWebsiteInvoice, '2026-06-01', 20000);   // day after `to`
    pay(acmeWebsiteInvoice, '2026-05-15', 50000);   // inside

    const r = paymentsReport(db, { from: '2026-05-01', to: '2026-05-31', groupBy: 'client' }, admin);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].totalCents).toBe(50000);
    expect(r.rows[0].count).toBe(1);
  });
});

describe('paymentsReport — multiple payments on the same invoice', () => {
  it('counts each payment row separately and sums their amounts', () => {
    pay(acmeWebsiteInvoice, '2026-05-05', 10000);
    pay(acmeWebsiteInvoice, '2026-05-10', 20000);
    pay(acmeWebsiteInvoice, '2026-05-20', 20000);

    const r = paymentsReport(db, { from: '2026-05-01', to: '2026-05-31', groupBy: 'project' }, admin);
    const website = r.rows.find((row) => row.label === 'Acme — Website');
    expect(website.totalCents).toBe(50000);
    expect(website.count).toBe(3);
  });
});
