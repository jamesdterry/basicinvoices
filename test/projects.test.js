import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import {
  create,
  update,
  archive,
  unarchive,
  listForUser,
  get,
} from '../server/services/projects.js';

let db;
let admin;
let sub;
let clientId;
beforeEach(() => {
  db = makeTestDb();
  const at = new Date().toISOString();
  const a = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('admin@example.com', 'Admin', 'super_admin', ?, ?)`
    )
    .run(at, at);
  admin = { id: a.lastInsertRowid, role: 'super_admin', email: 'admin@example.com' };
  const s = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('sub@example.com', 'Sub', 'subcontractor', ?, ?)`
    )
    .run(at, at);
  sub = { id: s.lastInsertRowid, role: 'subcontractor', email: 'sub@example.com' };

  const c = createClient(db, { name: 'Acme' }, { actorId: admin.id });
  clientId = c.client.id;
});

function addMember(projectId, userId, rate = 12500) {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_members
       (project_id, user_id, bill_rate_cents, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)`
  ).run(projectId, userId, rate, at, admin.id);
}

describe('projects.create', () => {
  it('creates a project under an existing client', () => {
    const r = create(db, { client_id: clientId, name: 'Website' }, { actorId: admin.id });
    expect(r.ok).toBe(true);
    expect(r.project.name).toBe('Website');
    expect(r.project.client_name).toBe('Acme');
  });

  it('rejects missing client', () => {
    const r = create(db, { name: 'Website' }, { actorId: admin.id });
    expect(r).toEqual({ ok: false, reason: 'client_required' });
  });

  it('rejects unknown client', () => {
    const r = create(db, { client_id: 999, name: 'Website' }, { actorId: admin.id });
    expect(r.reason).toBe('client_not_found');
  });

  it('rejects creation under archived client', () => {
    db.prepare('UPDATE clients SET archived_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      clientId
    );
    const r = create(db, { client_id: clientId, name: 'Website' }, { actorId: admin.id });
    expect(r.reason).toBe('client_archived');
  });

  it('rejects empty name', () => {
    const r = create(db, { client_id: clientId, name: '' }, { actorId: admin.id });
    expect(r.reason).toBe('name_required');
  });

  it('UNIQUE(client_id, name) — duplicate caught with friendly reason', () => {
    create(db, { client_id: clientId, name: 'Website' }, { actorId: admin.id });
    const r = create(db, { client_id: clientId, name: 'Website' }, { actorId: admin.id });
    expect(r.reason).toBe('duplicate');
  });

  it('audits create', () => {
    create(db, { client_id: clientId, name: 'Website' }, { actorId: admin.id });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'project.create'").get();
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
  });
});

describe('projects.update', () => {
  it('detects duplicate names within the same client', () => {
    create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    const b = create(db, { client_id: clientId, name: 'B' }, { actorId: admin.id });
    const r = update(db, b.project.id, { name: 'A' }, { actorId: admin.id });
    expect(r.reason).toBe('duplicate');
  });

  it('writes audit_changes diff for renamed project', () => {
    const c = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    update(db, c.project.id, { name: 'B' }, { actorId: admin.id });
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'project.update'").get();
    const change = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
      .get(audit.id);
    expect(change).toEqual({ field: 'name', old_value: 'A', new_value: 'B' });
  });
});

describe('projects.listForUser', () => {
  it('super-admin sees every project', () => {
    create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    create(db, { client_id: clientId, name: 'B' }, { actorId: admin.id });
    expect(listForUser(db, admin).map((p) => p.name).sort()).toEqual(['A', 'B']);
  });

  it('sub sees only projects they belong to', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    create(db, { client_id: clientId, name: 'B' }, { actorId: admin.id });
    addMember(a.project.id, sub.id);
    expect(listForUser(db, sub).map((p) => p.name)).toEqual(['A']);
  });

  it('removed memberships do not grant visibility', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    addMember(a.project.id, sub.id);
    db.prepare('UPDATE project_members SET removed_at = ?').run(new Date().toISOString());
    expect(listForUser(db, sub)).toEqual([]);
  });

  it('archived projects are hidden by default but visible with includeArchived', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    archive(db, a.project.id, { actorId: admin.id });
    expect(listForUser(db, admin)).toEqual([]);
    expect(listForUser(db, admin, { includeArchived: true })).toHaveLength(1);
  });
});

describe('projects.get', () => {
  it('returns the project for super-admin', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    expect(get(db, a.project.id, admin)?.name).toBe('A');
  });

  it('returns null for sub who is not a member', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    expect(get(db, a.project.id, sub)).toBeNull();
  });

  it('returns the project for sub who is a member', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    addMember(a.project.id, sub.id);
    expect(get(db, a.project.id, sub)?.name).toBe('A');
  });

  it('returns null for unknown id', () => {
    expect(get(db, 999, admin)).toBeNull();
  });
});

describe('projects.archive', () => {
  it('archive then unarchive round-trips', () => {
    const a = create(db, { client_id: clientId, name: 'A' }, { actorId: admin.id });
    archive(db, a.project.id, { actorId: admin.id });
    expect(get(db, a.project.id, admin).archived_at).not.toBeNull();
    unarchive(db, a.project.id, { actorId: admin.id });
    expect(get(db, a.project.id, admin).archived_at).toBeNull();
  });
});
