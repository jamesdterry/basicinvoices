import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stub the PDF renderer so this suite never spins up Chromium. The shape
// matches services/invoicePdf.js#renderInvoicePdfFromData (returns { buffer }
// or { unavailable: true } / { revoked: true } / null).
vi.mock('../server/services/invoicePdf.js', () => ({
  renderInvoicePdfFromData: vi.fn(async (data) => {
    if (!data) return null;
    if (data.revoked) return { revoked: true };
    return { buffer: Buffer.from('%PDF-fake', 'utf8') };
  }),
  renderInvoicePdf: vi.fn(),
  shutdownPdfRenderer: vi.fn(),
  _cache: new Map(),
}));

import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import { create as createTimeEntry } from '../server/services/timeEntries.js';
import { createDraft, send } from '../server/services/invoices.js';
import { sendInvoiceEmail } from '../server/services/invoiceMail.js';

let db;
let admin;
let sub;
let project;
let logPath;

function insertUser(db, email, displayName, role) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, displayName, role, at, at);
  return { id: Number(info.lastInsertRowid), email, display_name: displayName, role };
}

function readLog() {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(() => {
  // sendEmail() falls back to dev-mode when SMTP_HOST is unset.
  delete process.env.SMTP_HOST;
});

beforeEach(() => {
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

  logPath = path.join(os.tmpdir(), `invoice-mail-${process.pid}-${Date.now()}.log`);
  process.env.E2E_EMAIL_LOG = logPath;
});

afterEach(() => {
  delete process.env.E2E_EMAIL_LOG;
  try { fs.unlinkSync(logPath); } catch {}
});

function makeSentInvoice() {
  createTimeEntry(
    db,
    { project_id: project.id, entry_date: '2026-05-04', hours: 2, description: 'Work' },
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
  send(db, r.invoice.id, { actor: admin });
  return r.invoice;
}

describe('sendInvoiceEmail', () => {
  it('logs a dev-email payload with subject + link + PDF attachment metadata', async () => {
    const invoice = makeSentInvoice();
    const out = await sendInvoiceEmail(db, invoice.id);

    expect(out).toMatchObject({ ok: true, dev: true, attachment: true });

    const lines = readLog();
    expect(lines).toHaveLength(1);
    const payload = lines[0];
    expect(payload.event).toBe('dev-email');
    expect(payload.to).toBe('billing@acme.example');
    expect(payload.subject).toContain(invoice.number);
    expect(payload.subject).toContain('Acme');
    expect(payload.link).toMatch(new RegExp(`/i/${invoice.public_token}$`));
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]).toMatchObject({
      filename: `Invoice-${invoice.number}.pdf`,
      contentType: 'application/pdf',
    });
    expect(payload.attachments[0].bytes).toBeGreaterThan(0);
  });

  it('returns no_client_email when the client has no contact_email', async () => {
    const invoice = makeSentInvoice();
    db.prepare('UPDATE clients SET contact_email = NULL').run();
    const out = await sendInvoiceEmail(db, invoice.id);
    expect(out).toEqual({ ok: false, reason: 'no_client_email' });
  });

  it('returns not_found when the invoice id is unknown', async () => {
    const out = await sendInvoiceEmail(db, 99999);
    expect(out).toEqual({ ok: false, reason: 'not_found' });
  });
});
