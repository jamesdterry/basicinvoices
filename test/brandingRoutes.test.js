// Stage 10 branding routes — multipart upload, public asset routes, ETag
// handling, role gating.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

let app;
let dbModule;
let db;
let _brandingPublicRateLimiter;
let _resetBrandingMemos;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
  db = dbModule.db;
  const pubMod = await import('../server/routes/brandingPublic.js');
  _brandingPublicRateLimiter = pubMod._brandingPublicRateLimiter;
  _resetBrandingMemos = pubMod._resetBrandingMemos;
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

beforeEach(() => {
  db.exec(`
    DELETE FROM audit_changes;
    DELETE FROM admin_audit;
    DELETE FROM sessions;
    DELETE FROM users;
    UPDATE branding
       SET company_name='', business_address='', accent_color_hex='#2a6df4',
           logo_filename=NULL, logo_mime=NULL, logo_bytes=NULL,
           updated_at='1970-01-01T00:00:00.000Z'
     WHERE id=1;
  `);
  _brandingPublicRateLimiter._buckets.map.clear();
  _resetBrandingMemos();
});

function nowIso() { return new Date().toISOString(); }

function insertUser(email, role) {
  const at = nowIso();
  const info = db.prepare(
    `INSERT INTO users (email, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(email, role, role, at, at);
  return Number(info.lastInsertRowid);
}

function insertSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const at = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, '', '')`
  ).run(id, userId, at, at);
  return id;
}

function setupAuth(role) {
  const email = role === 'super_admin' ? 'admin@example.com' : 'sub@example.com';
  const userId = insertUser(email, role);
  const sessionId = insertSession(userId);
  const csrf = crypto.randomBytes(16).toString('base64url');
  return {
    userId,
    csrf,
    cookieHeader: `bi_session=${sessionId}; bi_csrf=${csrf}`,
  };
}

// 1×1 PNG (smallest valid one).
const TINY_PNG = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000100000500010DBC2A1F0000000049454E44AE426082',
  'hex'
);

function multipartLogoBody(buffer, filename, mimeType) {
  const boundary = '----testboundary' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="logo"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('GET /api/branding (super-admin)', () => {
  it('returns the seeded singleton with logo_url=null when no logo set', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .get('/api/branding')
      .set('Cookie', auth.cookieHeader);
    expect(res.status).toBe(200);
    expect(res.body.branding.companyName).toBe('');
    expect(res.body.branding.accentColorHex).toBe('#2a6df4');
    expect(res.body.branding.hasLogo).toBe(false);
    expect(res.body.branding.logoUrl).toBeNull();
  });

  it('forbids subs', async () => {
    const auth = setupAuth('subcontractor');
    const res = await request(app)
      .get('/api/branding')
      .set('Cookie', auth.cookieHeader);
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await request(app).get('/api/branding');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/branding', () => {
  it('updates company name + accent color + address', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/branding')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({
        company_name: 'Acme Consulting',
        business_address: 'street\ncity',
        accent_color_hex: '#abcdef',
      });
    expect(res.status).toBe(200);
    expect(res.body.branding.companyName).toBe('Acme Consulting');
    expect(res.body.branding.businessAddress).toBe('street\ncity');
    expect(res.body.branding.accentColorHex).toBe('#abcdef');
  });

  it('returns 400 invalid_color for bad hex', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/branding')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ accent_color_hex: '#zzzzzz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_color');
  });

  it('returns 400 address_too_long for >500 chars', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/branding')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ business_address: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('address_too_long');
  });

  it('forbids subs', async () => {
    const auth = setupAuth('subcontractor');
    const res = await request(app)
      .patch('/api/branding')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ company_name: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/branding/logo (multipart)', () => {
  it('accepts a small PNG and returns hasLogo=true with logo_url', async () => {
    const auth = setupAuth('super_admin');
    const { body, contentType } = multipartLogoBody(TINY_PNG, 'logo.png', 'image/png');
    const res = await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.branding.hasLogo).toBe(true);
    expect(res.body.branding.logoMime).toBe('image/png');
    expect(res.body.branding.logoUrl).toBe('/branding/logo');
  });

  it('rejects oversized payloads with 413 logo_too_large', async () => {
    const auth = setupAuth('super_admin');
    const big = Buffer.alloc(256 * 1024 + 1024, 0x41);
    const { body, contentType } = multipartLogoBody(big, 'big.png', 'image/png');
    const res = await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('logo_too_large');

    // No logo persisted.
    const got = await request(app).get('/branding/logo');
    expect(got.status).toBe(404);
  });

  it('rejects unsupported mime', async () => {
    const auth = setupAuth('super_admin');
    const { body, contentType } = multipartLogoBody(Buffer.from('GIF'), 'x.gif', 'image/gif');
    const res = await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_mime');
  });

  it('forbids subs', async () => {
    const auth = setupAuth('subcontractor');
    const { body, contentType } = multipartLogoBody(TINY_PNG, 'x.png', 'image/png');
    const res = await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/branding/logo', () => {
  it('clears the logo', async () => {
    const auth = setupAuth('super_admin');
    const { body, contentType } = multipartLogoBody(TINY_PNG, 'x.png', 'image/png');
    await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);

    const del = await request(app)
      .delete('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf);
    expect(del.status).toBe(200);
    expect(del.body.branding.hasLogo).toBe(false);

    const got = await request(app).get('/branding/logo');
    expect(got.status).toBe(404);
  });
});

describe('GET /branding/logo (public)', () => {
  it('returns 404 when no logo is set', async () => {
    const res = await request(app).get('/branding/logo');
    expect(res.status).toBe(404);
  });

  it('returns 200 with bytes + ETag + Cache-Control after upload, and 304 with If-None-Match', async () => {
    const auth = setupAuth('super_admin');
    const { body, contentType } = multipartLogoBody(TINY_PNG, 'logo.png', 'image/png');
    const up = await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);
    expect(up.status).toBe(200);

    const r1 = await request(app).get('/branding/logo');
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toMatch(/image\/png/);
    expect(r1.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    expect(r1.headers['etag']).toBeTruthy();
    expect(r1.body.equals(TINY_PNG)).toBe(true);

    const r2 = await request(app)
      .get('/branding/logo')
      .set('If-None-Match', r1.headers['etag']);
    expect(r2.status).toBe(304);
  });

  it('is reachable without a session', async () => {
    const auth = setupAuth('super_admin');
    const { body, contentType } = multipartLogoBody(TINY_PNG, 'logo.png', 'image/png');
    await request(app)
      .post('/api/branding/logo')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', contentType)
      .send(body);

    // No cookies at all.
    const res = await request(app).get('/branding/logo');
    expect(res.status).toBe(200);
  });
});

describe('GET /branding/style.css (public)', () => {
  it('emits :root --accent with the seeded default hex when nothing is set', async () => {
    const res = await request(app).get('/branding/style.css');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/css/);
    expect(res.text).toContain('--accent: #2a6df4');
  });

  it('reflects an updated accent color after PATCH', async () => {
    const auth = setupAuth('super_admin');
    await request(app)
      .patch('/api/branding')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ accent_color_hex: '#abcdef' });

    const res = await request(app).get('/branding/style.css');
    expect(res.status).toBe(200);
    expect(res.text).toContain('--accent: #abcdef');
    expect(res.headers['etag']).toBeTruthy();
    expect(res.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
  });

  it('serves 304 when If-None-Match matches', async () => {
    const r1 = await request(app).get('/branding/style.css');
    const etag = r1.headers['etag'];
    const r2 = await request(app)
      .get('/branding/style.css')
      .set('If-None-Match', etag);
    expect(r2.status).toBe(304);
  });

  it('is reachable without a session', async () => {
    const res = await request(app).get('/branding/style.css');
    expect(res.status).toBe(200);
  });
});
