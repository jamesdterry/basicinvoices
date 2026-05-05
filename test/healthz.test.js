import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app;
let dbModule;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

describe('GET /healthz', () => {
  it('returns 200 with bumped_at and CSP header', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.bumped_at).toBe('string');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).not.toMatch(/'unsafe-inline'/);
    expect(csp).toMatch(/default-src 'self'/);
  });

  it('advances bumped_at across calls', async () => {
    const a = await request(app).get('/healthz');
    await new Promise((r) => setTimeout(r, 5));
    const b = await request(app).get('/healthz');
    expect(b.body.bumped_at >= a.body.bumped_at).toBe(true);
    expect(b.body.bumped_at).not.toBe('1970-01-01T00:00:00.000Z');
  });
});
