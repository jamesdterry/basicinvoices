import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

let db;
let app;
let requireProjectMember;
let auth;

beforeAll(async () => {
  // Importing server/index.js runs migrations against the shared connection.
  await import('../server/index.js');
  ({ db } = await import('../server/db/connection.js'));
  ({ requireProjectMember } = await import('../server/middleware/requireProjectMember.js'));
  auth = await import('../server/services/auth.js');

  // Build a tiny harness app that uses requireProjectMember directly.
  app = express();
  app.use(express.json());
  // Stub session loading: read X-Test-Session-Id and load via auth.loadSession.
  app.use((req, _res, next) => {
    const sid = req.get('x-test-session-id');
    if (sid) {
      const loaded = auth.loadSession(db, sid);
      if (loaded) {
        req.user = loaded.user;
        req.session = loaded.session;
      }
    }
    next();
  });
  app.get('/p/:id', requireProjectMember, (req, res) => {
    res.json({ id: req.project.id, client_name: req.project.client_name });
  });
});

afterAll(() => {
  try { db?.close(); } catch {}
});

function nowIso() {
  return new Date().toISOString();
}

function makeUser(role, email) {
  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, email.split('@')[0], role, at, at);
  return info.lastInsertRowid;
}

function makeSession(userId) {
  const id = crypto.randomBytes(16).toString('hex');
  const at = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, userId, at, at);
  return id;
}

beforeEach(() => {
  db.exec('DELETE FROM project_members; DELETE FROM projects; DELETE FROM clients; DELETE FROM sessions; DELETE FROM users;');
});

describe('requireProjectMember', () => {
  it('returns 401 when no session', async () => {
    const res = await request(app).get('/p/1');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 404 for unknown project', async () => {
    const adminId = makeUser('super_admin', 'admin@example.com');
    const sid = makeSession(adminId);
    const res = await request(app).get('/p/999').set('x-test-session-id', sid);
    expect(res.status).toBe(404);
  });

  it('lets super-admin through unconditionally', async () => {
    const adminId = makeUser('super_admin', 'admin@example.com');
    const sid = makeSession(adminId);
    const at = nowIso();
    const c = db.prepare(`INSERT INTO clients (name, created_at, updated_at) VALUES ('Acme', ?, ?)`).run(at, at);
    const p = db
      .prepare(`INSERT INTO projects (client_id, name, created_at, updated_at) VALUES (?, 'Web', ?, ?)`)
      .run(c.lastInsertRowid, at, at);
    const res = await request(app).get(`/p/${p.lastInsertRowid}`).set('x-test-session-id', sid);
    expect(res.status).toBe(200);
    expect(res.body.client_name).toBe('Acme');
  });

  it('returns 403 for sub who is not a member', async () => {
    const adminId = makeUser('super_admin', 'admin@example.com');
    const subId = makeUser('subcontractor', 'sub@example.com');
    const subSid = makeSession(subId);
    const at = nowIso();
    const c = db.prepare(`INSERT INTO clients (name, created_at, updated_at) VALUES ('Acme', ?, ?)`).run(at, at);
    const p = db
      .prepare(`INSERT INTO projects (client_id, name, created_at, updated_at) VALUES (?, 'Web', ?, ?)`)
      .run(c.lastInsertRowid, at, at);
    void adminId;
    const res = await request(app).get(`/p/${p.lastInsertRowid}`).set('x-test-session-id', subSid);
    expect(res.status).toBe(403);
  });

  it('returns 200 for sub who is an active member', async () => {
    const adminId = makeUser('super_admin', 'admin@example.com');
    const subId = makeUser('subcontractor', 'sub@example.com');
    const subSid = makeSession(subId);
    const at = nowIso();
    const c = db.prepare(`INSERT INTO clients (name, created_at, updated_at) VALUES ('Acme', ?, ?)`).run(at, at);
    const p = db
      .prepare(`INSERT INTO projects (client_id, name, created_at, updated_at) VALUES (?, 'Web', ?, ?)`)
      .run(c.lastInsertRowid, at, at);
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, bill_rate_cents, added_at, added_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(p.lastInsertRowid, subId, 10000, at, adminId);
    const res = await request(app).get(`/p/${p.lastInsertRowid}`).set('x-test-session-id', subSid);
    expect(res.status).toBe(200);
  });

  it('returns 403 once membership is removed', async () => {
    const adminId = makeUser('super_admin', 'admin@example.com');
    const subId = makeUser('subcontractor', 'sub@example.com');
    const subSid = makeSession(subId);
    const at = nowIso();
    const c = db.prepare(`INSERT INTO clients (name, created_at, updated_at) VALUES ('Acme', ?, ?)`).run(at, at);
    const p = db
      .prepare(`INSERT INTO projects (client_id, name, created_at, updated_at) VALUES (?, 'Web', ?, ?)`)
      .run(c.lastInsertRowid, at, at);
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, bill_rate_cents, added_at, added_by, removed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(p.lastInsertRowid, subId, 10000, at, adminId, at);
    const res = await request(app).get(`/p/${p.lastInsertRowid}`).set('x-test-session-id', subSid);
    expect(res.status).toBe(403);
  });
});
