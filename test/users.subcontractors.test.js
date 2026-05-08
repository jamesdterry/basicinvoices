// Subcontractor admin: service unit tests + route tests (super-admin gating,
// invite email side-effect, disable -> session cleared).

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { makeTestDb } from './db.js';
import {
  listAll,
  getById,
  createSubcontractor,
  updateSubcontractor,
  setDisabled,
} from '../server/services/users.js';
import { loadSession } from '../server/services/auth.js';

function nowIso() { return new Date().toISOString(); }

function insertUser(db, email, role) {
  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, email.split('@')[0], role, at, at);
  return Number(info.lastInsertRowid);
}

describe('users service — subcontractor admin', () => {
  let db;
  let actor;
  beforeEach(() => {
    db = makeTestDb();
    const id = insertUser(db, 'admin@example.com', 'super_admin');
    actor = { id, email: 'admin@example.com', role: 'super_admin' };
  });

  describe('createSubcontractor', () => {
    it('creates a sub with role=subcontractor and audits user.create', () => {
      const r = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor, ip: '1.1.1.1' }
      );
      expect(r.ok).toBe(true);
      expect(r.user.email).toBe('sue@x.test');
      expect(r.user.role).toBe('subcontractor');
      expect(r.user.disabled_at).toBeNull();

      const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'user.create'").get();
      expect(audit.summary).toContain('sue@x.test');
      expect(audit.actor_id).toBe(actor.id);
      expect(audit.ip).toBe('1.1.1.1');
    });

    it('rejects empty email', () => {
      expect(createSubcontractor(db, { display_name: 'x' }, { actor }).reason)
        .toBe('email_required');
    });

    it('rejects malformed email', () => {
      expect(createSubcontractor(db, { email: 'not-an-email', display_name: 'x' }, { actor }).reason)
        .toBe('invalid_email');
    });

    it('rejects empty display_name', () => {
      expect(createSubcontractor(db, { email: 'a@x.test', display_name: '   ' }, { actor }).reason)
        .toBe('name_required');
    });

    it('rejects display_name > 120 chars', () => {
      const long = 'x'.repeat(121);
      expect(createSubcontractor(db, { email: 'a@x.test', display_name: long }, { actor }).reason)
        .toBe('name_too_long');
    });

    it('rejects duplicate email case-insensitively', () => {
      createSubcontractor(db, { email: 'sue@x.test', display_name: 'Sue' }, { actor });
      const r = createSubcontractor(
        db,
        { email: 'SUE@x.test', display_name: 'Other' },
        { actor }
      );
      expect(r).toEqual({ ok: false, reason: 'email_taken' });
    });

    it('rejects duplicate against existing super-admin email', () => {
      const r = createSubcontractor(
        db,
        { email: 'admin@example.com', display_name: 'Imposter' },
        { actor }
      );
      expect(r.reason).toBe('email_taken');
    });

    it('forbids non-super-admin actors', () => {
      const subId = insertUser(db, 'sub@x.test', 'subcontractor');
      const r = createSubcontractor(
        db,
        { email: 'new@x.test', display_name: 'New' },
        { actor: { id: subId, role: 'subcontractor' } }
      );
      expect(r.reason).toBe('forbidden');
    });
  });

  describe('updateSubcontractor', () => {
    it('renames and writes audit_changes diff', () => {
      const { user } = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor }
      );
      const r = updateSubcontractor(db, user.id, { display_name: 'Susan' }, { actor });
      expect(r.user.display_name).toBe('Susan');

      const audit = db
        .prepare("SELECT * FROM admin_audit WHERE action = 'user.update' ORDER BY id DESC")
        .get();
      const changes = db
        .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
        .all(audit.id);
      expect(changes).toEqual([
        { field: 'display_name', old_value: 'Sue', new_value: 'Susan' },
      ]);
    });

    it('is a no-op when nothing changed', () => {
      const { user } = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor }
      );
      updateSubcontractor(db, user.id, { display_name: 'Sue' }, { actor });
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'user.update'")
        .get().n;
      expect(count).toBe(0);
    });

    it('returns not_found for unknown id', () => {
      expect(updateSubcontractor(db, 9999, { display_name: 'x' }, { actor }).reason)
        .toBe('not_found');
    });

    it('refuses to act on a super-admin id', () => {
      // The service's getById restricts to role=subcontractor, so super-admins
      // are not addressable from this code path.
      expect(updateSubcontractor(db, actor.id, { display_name: 'New' }, { actor }).reason)
        .toBe('not_found');
    });
  });

  describe('setDisabled', () => {
    it('disables, drops sessions, blocks loadSession', () => {
      const { user } = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor }
      );
      const sessionId = crypto.randomBytes(16).toString('base64url');
      const at = nowIso();
      db.prepare(
        `INSERT INTO sessions (id, user_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?)`
      ).run(sessionId, user.id, at, at);

      // Sanity: session loads while active.
      expect(loadSession(db, sessionId)?.user.id).toBe(user.id);

      const r = setDisabled(db, user.id, true, { actor });
      expect(r.ok).toBe(true);
      expect(r.user.disabled_at).toBeTruthy();

      // Session was deleted, and loadSession would also reject a disabled user.
      expect(loadSession(db, sessionId)).toBeNull();

      const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'user.disable'").get();
      expect(audit).toBeTruthy();
    });

    it('enable clears disabled_at and audits user.enable', () => {
      const { user } = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor }
      );
      setDisabled(db, user.id, true, { actor });
      const r = setDisabled(db, user.id, false, { actor });
      expect(r.user.disabled_at).toBeNull();

      const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'user.enable'").get();
      expect(audit).toBeTruthy();
    });

    it('re-disabling is a noop and does not write a second audit row', () => {
      const { user } = createSubcontractor(
        db,
        { email: 'sue@x.test', display_name: 'Sue' },
        { actor }
      );
      setDisabled(db, user.id, true, { actor });
      const r = setDisabled(db, user.id, true, { actor });
      expect(r.noop).toBe(true);
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'user.disable'")
        .get().n;
      expect(count).toBe(1);
    });

    it('forbids non-super-admin actors', () => {
      const subId = insertUser(db, 'someone@x.test', 'subcontractor');
      const r = setDisabled(db, subId, true, { actor: { id: 999, role: 'subcontractor' } });
      expect(r.reason).toBe('forbidden');
    });
  });

  describe('listAll / getById', () => {
    it('lists active subs first, disabled last', () => {
      const { user: a } = createSubcontractor(db, { email: 'a@x.test', display_name: 'Anne' }, { actor });
      const { user: b } = createSubcontractor(db, { email: 'b@x.test', display_name: 'Bob' }, { actor });
      setDisabled(db, a.id, true, { actor });

      const rows = listAll(db);
      expect(rows.map((r) => r.email)).toEqual(['b@x.test', 'a@x.test']);
    });

    it('getById ignores super-admin rows', () => {
      expect(getById(db, actor.id)).toBeNull();
    });
  });
});

// -----------------------------------------------------------------------------
// Route tests
// -----------------------------------------------------------------------------

describe('subcontractors routes', () => {
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
      DELETE FROM sessions;
      DELETE FROM magic_link_tokens;
      DELETE FROM users;
    `);
  });

  function setupAuth(role) {
    const email = role === 'super_admin' ? 'admin@example.com' : 'sub@example.com';
    const userId = insertUser(db, email, role);
    const sessionId = crypto.randomBytes(16).toString('base64url');
    const csrf = crypto.randomBytes(16).toString('base64url');
    const at = nowIso();
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)`
    ).run(sessionId, userId, at, at);
    return {
      userId,
      csrf,
      cookieHeader: `bi_session=${sessionId}; bi_csrf=${csrf}`,
    };
  }

  it('GET /api/subcontractors — super-admin gets list', async () => {
    const auth = setupAuth('super_admin');
    insertUser(db, 'sue@x.test', 'subcontractor');
    const res = await request(app)
      .get('/api/subcontractors')
      .set('Cookie', auth.cookieHeader);
    expect(res.status).toBe(200);
    expect(res.body.subcontractors).toHaveLength(1);
    expect(res.body.subcontractors[0].email).toBe('sue@x.test');
  });

  it('GET /api/subcontractors — sub gets 403', async () => {
    const auth = setupAuth('subcontractor');
    const res = await request(app)
      .get('/api/subcontractors')
      .set('Cookie', auth.cookieHeader);
    expect(res.status).toBe(403);
  });

  it('POST /api/subcontractors — creates and triggers magic-link', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .post('/api/subcontractors')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ email: 'sue@x.test', display_name: 'Sue' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('sue@x.test');

    // The invite is fire-and-forget. Drain the queued microtask, then assert
    // that requestMagicLink reached the DB by inserting a magic_link_tokens
    // row for the new sub.
    await new Promise((r) => setImmediate(r));
    const token = db
      .prepare("SELECT * FROM magic_link_tokens WHERE email = 'sue@x.test'")
      .get();
    expect(token).toBeTruthy();
    expect(token.purpose).toBe('login');
  });

  it('POST /api/subcontractors — duplicate email returns 409', async () => {
    const auth = setupAuth('super_admin');
    insertUser(db, 'sue@x.test', 'subcontractor');
    const res = await request(app)
      .post('/api/subcontractors')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ email: 'Sue@x.test', display_name: 'Sue' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_taken');
  });

  it('POST /api/subcontractors — invalid email returns 400', async () => {
    const auth = setupAuth('super_admin');
    const res = await request(app)
      .post('/api/subcontractors')
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({ email: 'not-an-email', display_name: 'Sue' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
  });

  it('POST /api/subcontractors/:id/disable — drops session for that user', async () => {
    const auth = setupAuth('super_admin');
    const subId = insertUser(db, 'sue@x.test', 'subcontractor');
    const subSession = crypto.randomBytes(16).toString('base64url');
    const at = nowIso();
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)`
    ).run(subSession, subId, at, at);

    const res = await request(app)
      .post(`/api/subcontractors/${subId}/disable`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(200);

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(subId).n;
    expect(remaining).toBe(0);
  });

  it('POST /api/subcontractors/:id/resend-invite — refused on disabled user', async () => {
    const auth = setupAuth('super_admin');
    const subId = insertUser(db, 'sue@x.test', 'subcontractor');
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(nowIso(), subId);

    const res = await request(app)
      .post(`/api/subcontractors/${subId}/resend-invite`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('disabled');
  });

  it('POST /api/subcontractors/:id/resend-invite — fires magic-link and audits', async () => {
    const auth = setupAuth('super_admin');
    const subId = insertUser(db, 'sue@x.test', 'subcontractor');

    const res = await request(app)
      .post(`/api/subcontractors/${subId}/resend-invite`)
      .set('Cookie', auth.cookieHeader)
      .set('X-CSRF-Token', auth.csrf)
      .send({});
    expect(res.status).toBe(202);

    await new Promise((r) => setImmediate(r));
    const token = db
      .prepare("SELECT * FROM magic_link_tokens WHERE email = 'sue@x.test'")
      .get();
    expect(token).toBeTruthy();

    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'user.resend_invite'").get();
    expect(audit).toBeTruthy();
  });
});
