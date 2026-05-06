import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

let app;
let dbModule;
let db;
let _publicInvoiceRateLimiter;

function insertUser(db, email, displayName, role) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, displayName, role, at, at);
  return Number(info.lastInsertRowid);
}

function insertClient(db, name) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO clients (name, payment_terms_days, created_at, updated_at)
       VALUES (?, 14, ?, ?)`
    )
    .run(name, at, at);
  return Number(info.lastInsertRowid);
}

function insertProject(db, clientId, name) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO projects (client_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(clientId, name, at, at);
  return Number(info.lastInsertRowid);
}

function insertInvoice(db, { clientId, projectId, createdBy, status = 'sent', token, revokedAt = null }) {
  const at = new Date().toISOString();
  const tk = token ?? crypto.randomBytes(24).toString('base64url');
  const info = db
    .prepare(
      `INSERT INTO invoices
         (number, client_id, project_id, status, issue_date, due_date,
          subtotal_cents, total_cents, public_token, public_token_revoked_at,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-05-31', '2026-06-14', 50000, 50000, ?, ?, ?, ?, ?)`
    )
    .run(`2026-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`, clientId, projectId, status, tk, revokedAt, createdBy, at, at);
  return { id: Number(info.lastInsertRowid), token: tk };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
  db = dbModule.db;
  const pubMod = await import('../server/routes/publicInvoice.js');
  _publicInvoiceRateLimiter = pubMod._publicInvoiceRateLimiter;
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

beforeEach(() => {
  // Drain test data and reset the rate limiter between cases.
  db.exec('DELETE FROM invoices; DELETE FROM projects; DELETE FROM clients; DELETE FROM users;');
  _publicInvoiceRateLimiter._buckets.map.clear();
});

describe('GET /i/:token', () => {
  it('returns 200 + invoice HTML for a valid token, with caching headers', async () => {
    const userId = insertUser(db, 'a@example.com', 'A', 'super_admin');
    const clientId = insertClient(db, 'Acme');
    const projectId = insertProject(db, clientId, 'Website');
    const inv = insertInvoice(db, { clientId, projectId, createdBy: userId });

    const res = await request(app).get(`/i/${inv.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Invoice');
    expect(res.text).toContain('Acme');
  });

  it('does not set or require a session cookie', async () => {
    const userId = insertUser(db, 'a@example.com', 'A', 'super_admin');
    const clientId = insertClient(db, 'Acme');
    const projectId = insertProject(db, clientId, 'Website');
    const inv = insertInvoice(db, { clientId, projectId, createdBy: userId });

    const res = await request(app).get(`/i/${inv.token}`);
    const setCookie = res.headers['set-cookie'] || [];
    const cookies = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
    expect(cookies).not.toMatch(/bi_session/);
    expect(cookies).not.toMatch(/bi_csrf/);
  });

  it('returns 410 for a revoked token', async () => {
    const userId = insertUser(db, 'a@example.com', 'A', 'super_admin');
    const clientId = insertClient(db, 'Acme');
    const projectId = insertProject(db, clientId, 'Website');
    const inv = insertInvoice(db, {
      clientId,
      projectId,
      createdBy: userId,
      revokedAt: new Date().toISOString(),
    });

    const res = await request(app).get(`/i/${inv.token}`);
    expect(res.status).toBe(410);
    expect(res.text).toMatch(/revoked/i);
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request(app).get('/i/bogusbogusbogusbogusbogusbogusbo');
    expect(res.status).toBe(404);
  });

  it('rate-limits after capacity is exhausted', async () => {
    const userId = insertUser(db, 'a@example.com', 'A', 'super_admin');
    const clientId = insertClient(db, 'Acme');
    const projectId = insertProject(db, clientId, 'Website');
    const inv = insertInvoice(db, { clientId, projectId, createdBy: userId });

    // Token bucket capacity is 60. Hit it 60 times; the 61st should 429.
    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await request(app).get(`/i/${inv.token}`);
      expect(ok.status).toBe(200);
    }
    const tripped = await request(app).get(`/i/${inv.token}`);
    expect(tripped.status).toBe(429);
    expect(tripped.headers['retry-after']).toBeTruthy();
  });
});
