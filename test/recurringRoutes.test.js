// Lightweight route smoke test for Stage 8 recurring endpoints. Service-level
// behavior is exhaustively covered in test/recurring.test.js — this just
// confirms each route is mounted, gated correctly, and maps reasons to HTTP.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';

let app;
let dbModule;
let db;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
  db = dbModule.db;
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

beforeEach(() => {
  db.exec(`
    DELETE FROM audit_changes;
    DELETE FROM admin_audit;
    DELETE FROM error_log;
    DELETE FROM payments;
    DELETE FROM invoice_lines;
    DELETE FROM invoices;
    DELETE FROM milestones;
    DELETE FROM expenses;
    DELETE FROM time_entries;
    DELETE FROM recurring_schedules;
    DELETE FROM project_members;
    DELETE FROM projects;
    DELETE FROM clients;
    DELETE FROM sessions;
    DELETE FROM magic_link_tokens;
    DELETE FROM users;
  `);
});

function nowIso() { return new Date().toISOString(); }

function insertUser(email, displayName, role) {
  const at = nowIso();
  const info = db.prepare(
    `INSERT INTO users (email, display_name, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(email, displayName, role, at, at);
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

function insertClient(name) {
  const at = nowIso();
  const info = db.prepare(
    `INSERT INTO clients (name, payment_terms_days, contact_emails, created_at, updated_at)
     VALUES (?, 14, '["billing@example.test"]', ?, ?)`
  ).run(name, at, at);
  return Number(info.lastInsertRowid);
}

function insertProject(clientId, name) {
  const at = nowIso();
  const info = db.prepare(
    `INSERT INTO projects (client_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(clientId, name, at, at);
  return Number(info.lastInsertRowid);
}

// Auth setup that doesn't rely on supertest's agent cookie jar — we mint a
// session and CSRF token directly and pass them on every request. CSRF
// validation is double-submit (cookie value === header value), so we just
// pick any random string for both.
function setupAuth(role) {
  const email = role === 'super_admin' ? 'admin@example.com' : 'sub@example.com';
  const display = role === 'super_admin' ? 'Admin' : 'Sub';
  const userId = insertUser(email, display, role);
  const sessionId = insertSession(userId);
  const csrf = crypto.randomBytes(16).toString('base64url');
  return {
    userId,
    sessionId,
    csrf,
    cookieHeader: `bi_session=${sessionId}; bi_csrf=${csrf}`,
  };
}

describe('recurring routes — super-admin happy path', () => {
  it('PUT then GET then PAUSE/RESUME then DELETE', async () => {
    const auth = setupAuth('super_admin');
    const cid = insertClient('Acme');
    const pid = insertProject(cid, 'Website');

    // GET 404 before configured
    const before = await request(app)
      .get(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader);
    expect(before.status).toBe(404);

    // PUT — create
    const put = await request(app)
      .put(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ mode: 'time_and_expenses', day_of_month: 15, auto_stripe_link: false });
    expect(put.status).toBe(200);
    expect(put.body.schedule.day_of_month).toBe(15);

    // GET
    const after = await request(app)
      .get(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader);
    expect(after.status).toBe(200);
    expect(after.body.schedule.mode).toBe('time_and_expenses');

    // pause
    const paused = await request(app)
      .post(`/api/projects/${pid}/recurring/pause`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(paused.status).toBe(200);
    expect(paused.body.schedule.paused).toBe(true);

    // resume
    const resumed = await request(app)
      .post(`/api/projects/${pid}/recurring/resume`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(resumed.status).toBe(200);
    expect(resumed.body.schedule.paused).toBe(false);

    // delete
    const deleted = await request(app)
      .delete(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf);
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const gone = await request(app)
      .get(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader);
    expect(gone.status).toBe(404);
  });

  it('rejects bad input with 400', async () => {
    const auth = setupAuth('super_admin');
    const cid = insertClient('Acme');
    const pid = insertProject(cid, 'Website');

    const r = await request(app)
      .put(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ mode: 'weekly', day_of_month: 15 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_mode');
  });
});

describe('recurring routes — auth gating', () => {
  it('sub gets 403 on PUT', async () => {
    insertUser('admin@example.com', 'Admin', 'super_admin');
    const cid = insertClient('Acme');
    const pid = insertProject(cid, 'Website');

    const auth = setupAuth('subcontractor');
    const r = await request(app)
      .put(`/api/projects/${pid}/recurring`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ mode: 'time_and_expenses', day_of_month: 1 });
    expect(r.status).toBe(403);
  });

  it('unauthenticated gets 401', async () => {
    const cid = insertClient('Acme');
    const pid = insertProject(cid, 'Website');
    const r = await request(app).get(`/api/projects/${pid}/recurring`);
    expect(r.status).toBe(401);
  });
});

describe('admin recurring routes', () => {
  it('GET /api/admin/recurring lists schedules for super-admin', async () => {
    const auth = setupAuth('super_admin');
    const cid = insertClient('Acme');
    const pid = insertProject(cid, 'Website');

    // Insert directly so we don't depend on the PUT route working.
    const at = nowIso();
    db.prepare(
      `INSERT INTO recurring_schedules
         (project_id, mode, cadence, day_of_month, auto_stripe_link,
          next_run_date, created_at, updated_at)
       VALUES (?, 'time_and_expenses', 'monthly', 15, 0, '2026-05-15', ?, ?)`
    ).run(pid, at, at);

    const r = await request(app)
      .get('/api/admin/recurring')
      .set('Cookie', auth.cookieHeader);
    expect(r.status).toBe(200);
    expect(r.body.schedules.length).toBe(1);
    expect(r.body.schedules[0].project_id).toBe(pid);
  });

  it('POST /api/admin/recurring/run-now returns results for super-admin', async () => {
    const auth = setupAuth('super_admin');
    const r = await request(app)
      .post('/api/admin/recurring/run-now')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
  });

  it('sub is 403 on /api/admin/recurring', async () => {
    const auth = setupAuth('subcontractor');
    const r = await request(app)
      .get('/api/admin/recurring')
      .set('Cookie', auth.cookieHeader);
    expect(r.status).toBe(403);
  });
});
