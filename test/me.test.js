import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

let app;
let dbModule;
let db;

beforeAll(async () => {
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
  db = dbModule.db;
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
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
  const tag = crypto.randomBytes(4).toString('hex');
  const email = role === 'super_admin'
    ? `admin-patch-${tag}@example.com`
    : `sub-patch-${tag}@example.com`;
  const userId = insertUser(email, role);
  const sessionId = insertSession(userId);
  const csrf = crypto.randomBytes(16).toString('base64url');
  return {
    userId,
    csrf,
    cookieHeader: `bi_session=${sessionId}; bi_csrf=${csrf}`,
  };
}

function extractCookie(res, name) {
  const setCookie = res.headers['set-cookie'] || [];
  for (const c of setCookie) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

describe('GET /api/me', () => {
  it('returns 401 without a session', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('returns the authed user after a magic-link login', async () => {
    const agent = request.agent(app);

    // Request the magic link (auto-bootstraps the super-admin row).
    const linkRes = await agent
      .post('/auth/magic-link')
      .send({ email: 'admin@example.com' });
    expect(linkRes.status).toBe(204);

    // Pull the raw token out of the email log appended by services/email.js
    // when SMTP is unset. We don't rely on E2E_EMAIL_LOG here — instead, we
    // override the token hash in the DB to a known value, simulating what
    // arrived in the email.
    const crypto = await import('node:crypto');
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    dbModule.db
      .prepare(
        'UPDATE magic_link_tokens SET token_hash = ? WHERE id = (SELECT id FROM magic_link_tokens ORDER BY id DESC LIMIT 1)'
      )
      .run(hash);

    const redeemRes = await agent.get(`/auth/redeem?token=${encodeURIComponent(raw)}`);
    expect(redeemRes.status).toBe(302);
    expect(redeemRes.headers.location).toBe('/');
    expect(extractCookie(redeemRes, 'bi_session')).toBeTruthy();

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe('admin@example.com');
    expect(meRes.body.role).toBe('super_admin');
    expect(meRes.body.display_name).toBe('admin');
  });

  it('redirects unauthed browsers to /login.html for / and /index.html', async () => {
    const r1 = await request(app).get('/');
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe('/login.html');

    const r2 = await request(app).get('/index.html');
    expect(r2.status).toBe(302);
    expect(r2.headers.location).toBe('/login.html');

    // /login.html itself must remain reachable
    const r3 = await request(app).get('/login.html');
    expect(r3.status).toBe(200);
  });
});

describe('PATCH /api/me', () => {
  it('updates display_name and persists to users.display_name', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: 'Jane Q. Consultant' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Jane Q. Consultant');
    expect(res.body.email).toMatch(/^admin-patch-[0-9a-f]{8}@example\.com$/);

    const row = db
      .prepare('SELECT display_name FROM users WHERE id = ?')
      .get(auth.userId);
    expect(row.display_name).toBe('Jane Q. Consultant');
  });

  it('trims whitespace before saving', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: '   Spaced Out   ' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Spaced Out');
  });

  it('returns 400 name_required for empty/whitespace input', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_required');
  });

  it('returns 400 name_too_long for >120 chars', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: 'x'.repeat(121) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_too_long');
  });

  it('subs can edit their own display_name too', async () => {
    const auth = setupAuth('subcontractor');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: 'Sub Name' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Sub Name');
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(app)
      .patch('/api/me')
      .send({ display_name: 'X' });
    expect(res.status).toBe(401);
  });

  it('rejects requests missing the CSRF token with 403', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .send({ display_name: 'X' });
    expect(res.status).toBe(403);
  });

  it('writes an audit row with the field change', async () => {
    const auth = setupAuth('super_admin');
    await request(app)
      .patch('/api/me')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ display_name: 'Audited Name' });

    const audit = db.prepare(
      `SELECT id, action, target_kind, target_id, actor_id
         FROM admin_audit
        WHERE action = 'user.update_profile' AND actor_id = ?
        ORDER BY id DESC LIMIT 1`
    ).get(auth.userId);
    expect(audit).toBeTruthy();
    expect(audit.target_kind).toBe('user');
    expect(audit.target_id).toBe(auth.userId);

    const change = db.prepare(
      `SELECT field, old_value, new_value
         FROM audit_changes WHERE audit_id = ?`
    ).get(audit.id);
    expect(change.field).toBe('display_name');
    expect(change.new_value).toBe('Audited Name');
  });
});
