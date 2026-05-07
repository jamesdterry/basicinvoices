import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { makeTestDb } from './db.js';
import * as branding from '../server/services/branding.js';

// pdfkit's font loader reads from disk; gating via env keeps the rest of the
// vitest run fast (the rendered buffer is ~3 KB and takes ~50 ms here, but
// other suites mock the module entirely).
let prevFlag;
beforeAll(() => {
  prevFlag = process.env.BI_PDF_ENABLED;
  process.env.BI_PDF_ENABLED = '1';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.BI_PDF_ENABLED;
  else process.env.BI_PDF_ENABLED = prevFlag;
});

let invoicePdf;
beforeAll(async () => {
  invoicePdf = await import('../server/services/invoicePdf.js');
});

let db;
let admin;

beforeEach(() => {
  db = makeTestDb();
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('admin@example.com', 'Admin', 'super_admin', at, at);
  admin = { id: Number(info.lastInsertRowid), role: 'super_admin' };
  invoicePdf._cache.clear();
});

// 67-byte transparent 1×1 PNG — small valid bytes pdfkit will accept.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6300010000000500015e7e8b3a0000000049454e44ae426082',
  'hex',
);

const TINY_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>',
);

function makeData(overrides = {}) {
  return {
    invoice: {
      id: overrides.invoiceId ?? 1,
      number: '2026-0001',
      status: 'sent',
      issue_date: '2026-05-01',
      due_date: '2026-05-15',
      period_start: null,
      period_end: null,
      subtotal_cents: 10000,
      total_cents: 10000,
      amount_paid_cents: 0,
      stripe_payment_link_url: null,
      notes: null,
      updated_at: '2026-05-01T00:00:00.000Z',
      public_token: 'tok',
    },
    lines: [
      {
        kind: 'time',
        description: 'Engineering work',
        quantity: 1,
        unit_rate_cents: 10000,
        amount_cents: 10000,
      },
    ],
    client: {
      id: 1,
      name: 'Acme Corp',
      billing_address: '123 Main St',
      contact_emails: ['billing@acme.example'],
    },
    project: { id: 1, name: 'Website' },
    branding: branding.get(db),
    revoked: false,
    ...overrides.payload,
  };
}

describe('invoicePdf.renderInvoicePdfFromData', () => {
  it('returns a %PDF-prefixed buffer for the no-logo path', async () => {
    const r = await invoicePdf.renderInvoicePdfFromData(db, makeData());
    expect(r.buffer).toBeInstanceOf(Buffer);
    expect(r.buffer.length).toBeGreaterThan(500);
    expect(r.buffer.slice(0, 4).toString()).toBe('%PDF');
  });

  it('embeds a PNG logo without throwing', async () => {
    branding.setLogo(
      db,
      { filename: 'logo.png', mime: 'image/png', bytes: TINY_PNG },
      { actor: admin },
    );
    const data = makeData({ invoiceId: 2 });
    const r = await invoicePdf.renderInvoicePdfFromData(db, data);
    expect(r.buffer).toBeInstanceOf(Buffer);
    expect(r.buffer.slice(0, 4).toString()).toBe('%PDF');
  });

  it('renders an SVG logo via svg-to-pdfkit without throwing', async () => {
    branding.setLogo(
      db,
      { filename: 'logo.svg', mime: 'image/svg+xml', bytes: TINY_SVG },
      { actor: admin },
    );
    const data = makeData({ invoiceId: 3 });
    const r = await invoicePdf.renderInvoicePdfFromData(db, data);
    expect(r.buffer).toBeInstanceOf(Buffer);
    expect(r.buffer.slice(0, 4).toString()).toBe('%PDF');
  });

  it('skips an unknown mime (e.g. legacy WebP row) without crashing', async () => {
    // Inject a WebP row directly — the service rejects new WebP uploads, but
    // pre-existing rows from before that change must still produce a valid
    // PDF (logo just gets skipped).
    db.prepare(
      `UPDATE branding
          SET logo_filename = ?, logo_mime = ?, logo_bytes = ?, updated_at = ?
        WHERE id = 1`
    ).run('legacy.webp', 'image/webp', Buffer.from('not a real webp'), new Date().toISOString());

    const data = makeData({ invoiceId: 4 });
    const r = await invoicePdf.renderInvoicePdfFromData(db, data);
    expect(r.buffer).toBeInstanceOf(Buffer);
    expect(r.buffer.slice(0, 4).toString()).toBe('%PDF');
  });
});
