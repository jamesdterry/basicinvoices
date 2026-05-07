import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import * as branding from '../server/services/branding.js';

let db;
let admin;
let sub;

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

beforeEach(() => {
  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub', 'subcontractor');
});

describe('branding.get', () => {
  it('returns the seeded singleton row with default hex and empty strings', () => {
    const b = branding.get(db);
    expect(b.companyName).toBe('');
    expect(b.businessAddress).toBe('');
    expect(b.accentColorHex).toBe('#2a6df4');
    expect(b.hasLogo).toBe(false);
    expect(b.logoFilename).toBeNull();
    expect(b.logoMime).toBeNull();
    expect(b.updatedAt).toBeTruthy();
  });
});

describe('branding.update — auth', () => {
  it('forbids non-super-admin actors', () => {
    expect(branding.update(db, { company_name: 'X' }, { actor: sub }).reason).toBe('forbidden');
    expect(branding.update(db, { company_name: 'X' }, { actor: undefined }).reason).toBe('forbidden');
  });
});

describe('branding.update — company name', () => {
  it('saves a new name and writes audit_changes', () => {
    const r = branding.update(db, { company_name: 'Acme Consulting' }, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.companyName).toBe('Acme Consulting');

    const audit = db
      .prepare(`SELECT * FROM admin_audit WHERE action = 'branding.update' ORDER BY id DESC LIMIT 1`)
      .get();
    expect(audit).toBeTruthy();
    const changes = db.prepare(`SELECT * FROM audit_changes WHERE audit_id = ?`).all(audit.id);
    expect(changes.map((c) => c.field)).toEqual(['company_name']);
    expect(changes[0].old_value).toBe('');
    expect(changes[0].new_value).toBe('Acme Consulting');
  });

  it('rejects names longer than 120 chars', () => {
    const r = branding.update(db, { company_name: 'x'.repeat(121) }, { actor: admin });
    expect(r.reason).toBe('name_too_long');
  });

  it('trims surrounding whitespace before length check', () => {
    const r = branding.update(db, { company_name: '   Acme   ' }, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.companyName).toBe('Acme');
  });
});

describe('branding.update — accent color', () => {
  it('rejects 3-char hex', () => {
    expect(branding.update(db, { accent_color_hex: '#fff' }, { actor: admin }).reason).toBe('invalid_color');
  });
  it('rejects 8-char hex', () => {
    expect(branding.update(db, { accent_color_hex: '#1234567' }, { actor: admin }).reason).toBe('invalid_color');
  });
  it('rejects non-hex characters', () => {
    expect(branding.update(db, { accent_color_hex: '#zzzzzz' }, { actor: admin }).reason).toBe('invalid_color');
  });
  it('accepts uppercase hex', () => {
    const r = branding.update(db, { accent_color_hex: '#ABCDEF' }, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.accentColorHex).toBe('#ABCDEF');
  });
});

describe('branding.update — business address', () => {
  it('rejects address longer than 500 chars after normalization', () => {
    const r = branding.update(db, { business_address: 'a'.repeat(501) }, { actor: admin });
    expect(r.reason).toBe('address_too_long');
  });

  it('normalizes CRLF → LF and strips leading/trailing blank lines', () => {
    const raw = '\r\n\r\nstreet\r\ncity\n\n';
    const r = branding.update(db, { business_address: raw }, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.businessAddress).toBe('street\ncity');

    const audit = db
      .prepare(`SELECT * FROM admin_audit WHERE action = 'branding.update' ORDER BY id DESC LIMIT 1`)
      .get();
    const change = db
      .prepare(`SELECT * FROM audit_changes WHERE audit_id = ? AND field = 'business_address'`)
      .get(audit.id);
    expect(change).toBeTruthy();
    // \n escaped to \\n in audit so the row stays scannable
    expect(change.new_value).toBe('street\\ncity');
    expect(change.new_value.includes('\n')).toBe(false);
  });

  it('preserves interior blank lines', () => {
    const r = branding.update(db, { business_address: 'street\n\ncity' }, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.businessAddress).toBe('street\n\ncity');
  });
});

describe('branding.update — combined + idempotency', () => {
  it('writes one audit row with multiple change rows when several fields change', () => {
    const r = branding.update(
      db,
      { company_name: 'Acme', accent_color_hex: '#abcdef', business_address: 'street\ncity' },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    const audit = db
      .prepare(`SELECT * FROM admin_audit WHERE action = 'branding.update' ORDER BY id DESC LIMIT 1`)
      .get();
    const changes = db.prepare(`SELECT * FROM audit_changes WHERE audit_id = ?`).all(audit.id);
    const fields = changes.map((c) => c.field).sort();
    expect(fields).toEqual(['accent_color_hex', 'business_address', 'company_name']);
  });

  it('is a no-op when no field actually changes (no audit row)', () => {
    branding.update(db, { company_name: 'Acme' }, { actor: admin });
    const before = db.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'branding.update'`).get().n;
    const r = branding.update(db, { company_name: 'Acme' }, { actor: admin });
    expect(r.ok).toBe(true);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'branding.update'`).get().n;
    expect(after).toBe(before);
  });

  it('advances updated_at on a real change', async () => {
    const before = branding.get(db).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    branding.update(db, { company_name: 'Acme' }, { actor: admin });
    const after = branding.get(db).updatedAt;
    expect(after).not.toBe(before);
  });
});

describe('branding.setLogo', () => {
  it('stores bytes + mime + filename and returns hasLogo=true', () => {
    const bytes = Buffer.from('PNGDATA');
    const r = branding.setLogo(
      db,
      { filename: 'logo.png', mime: 'image/png', bytes },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    expect(r.branding.hasLogo).toBe(true);
    expect(r.branding.logoFilename).toBe('logo.png');
    expect(r.branding.logoMime).toBe('image/png');

    const got = branding.getLogo(db);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.mime).toBe('image/png');
  });

  it('rejects bytes larger than 256 KB', () => {
    const bytes = Buffer.alloc(branding.LOGO_MAX_BYTES + 1, 0x41);
    const r = branding.setLogo(db, { filename: 'x.png', mime: 'image/png', bytes }, { actor: admin });
    expect(r.reason).toBe('logo_too_large');
  });

  it('accepts bytes exactly at 256 KB', () => {
    const bytes = Buffer.alloc(branding.LOGO_MAX_BYTES, 0x41);
    const r = branding.setLogo(db, { filename: 'x.png', mime: 'image/png', bytes }, { actor: admin });
    expect(r.ok).toBe(true);
  });

  it('rejects empty bytes with logo_required', () => {
    const r = branding.setLogo(
      db,
      { filename: 'x.png', mime: 'image/png', bytes: Buffer.alloc(0) },
      { actor: admin }
    );
    expect(r.reason).toBe('logo_required');
  });

  it('rejects unsupported mime types', () => {
    const r = branding.setLogo(
      db,
      { filename: 'x.gif', mime: 'image/gif', bytes: Buffer.from('x') },
      { actor: admin }
    );
    expect(r.reason).toBe('invalid_mime');
  });

  it('rejects WebP (no longer accepted on upload)', () => {
    const r = branding.setLogo(
      db,
      { filename: 'x.webp', mime: 'image/webp', bytes: Buffer.from('x') },
      { actor: admin }
    );
    expect(r.reason).toBe('invalid_mime');
  });

  it('accepts SVG', () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const r = branding.setLogo(
      db,
      { filename: 'logo.svg', mime: 'image/svg+xml', bytes },
      { actor: admin }
    );
    expect(r.ok).toBe(true);
    expect(r.branding.logoMime).toBe('image/svg+xml');
  });

  it('logs an audit row with byte length in meta_json (no binary)', () => {
    const bytes = Buffer.from('PNGDATA');
    branding.setLogo(db, { filename: 'logo.png', mime: 'image/png', bytes }, { actor: admin });
    const audit = db
      .prepare(`SELECT * FROM admin_audit WHERE action = 'branding.set_logo' ORDER BY id DESC LIMIT 1`)
      .get();
    expect(audit).toBeTruthy();
    const meta = JSON.parse(audit.meta_json);
    expect(meta).toEqual({ filename: 'logo.png', mime: 'image/png', bytes: bytes.length });
  });

  it('forbids subs', () => {
    const r = branding.setLogo(
      db,
      { filename: 'x.png', mime: 'image/png', bytes: Buffer.from('x') },
      { actor: sub }
    );
    expect(r.reason).toBe('forbidden');
  });
});

describe('branding.clearLogo', () => {
  it('nulls the logo columns and returns hasLogo=false', () => {
    branding.setLogo(
      db,
      { filename: 'x.png', mime: 'image/png', bytes: Buffer.from('PNG') },
      { actor: admin }
    );
    expect(branding.get(db).hasLogo).toBe(true);
    const r = branding.clearLogo(db, { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.branding.hasLogo).toBe(false);
    expect(branding.getLogo(db)).toBeNull();
  });

  it('is a silent no-op when no logo set (no audit row)', () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'branding.clear_logo'`).get().n;
    const r = branding.clearLogo(db, { actor: admin });
    expect(r.ok).toBe(true);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'branding.clear_logo'`).get().n;
    expect(after).toBe(before);
  });

  it('forbids subs', () => {
    expect(branding.clearLogo(db, { actor: sub }).reason).toBe('forbidden');
  });
});
