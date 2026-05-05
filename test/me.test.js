import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;
let dbModule;

beforeAll(async () => {
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

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
