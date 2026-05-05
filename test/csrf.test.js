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

function getCsrfCookie(res) {
  const setCookie = res.headers['set-cookie'] || [];
  for (const c of setCookie) {
    const m = c.match(/bi_csrf=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

describe('csrf middleware', () => {
  it('mints a bi_csrf cookie on the first response', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    const token = getCsrfCookie(res);
    expect(token).toBeTruthy();
    expect(token.length).toBeGreaterThan(20);
  });

  it('does not require csrf for GETs', async () => {
    const res = await request(app).get('/api/me');
    // unauth → 401 (not 403)
    expect(res.status).toBe(401);
  });

  it('exempts /auth/* from csrf checks', async () => {
    const res = await request(app)
      .post('/auth/magic-link')
      .send({ email: 'admin@example.com' });
    // Either 204 or 429 — but never 403/csrf
    expect([204, 429]).toContain(res.status);
  });

  it('rejects /api/* mutations with a session cookie but no header', async () => {
    // We don't have a real session, but mounting a mutating /api/ endpoint
    // for the test would balloon scope. Simulate by sending a fake bi_session
    // cookie + mismatched X-CSRF-Token to the only mutating /api/* route we
    // have access to via supertest: there aren't any in Stage 1 yet, so use
    // a plain POST against /api/me (router only registers GET) to hit the
    // CSRF gate before the 404 handler.
    const agent = request.agent(app);
    await agent.get('/healthz'); // mints csrf cookie
    const res = await agent
      .post('/api/me')
      .set('Cookie', 'bi_session=fake-session-id; bi_csrf=tampered')
      .set('X-CSRF-Token', 'wrong-value')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf');
  });
});
