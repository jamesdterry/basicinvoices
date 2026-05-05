import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import { add as addMember } from '../server/services/projectMembers.js';
import {
  create,
  update,
  remove,
  list,
  get,
} from '../server/services/timeEntries.js';

let db;
let admin;
let sub;
let sub2;
let project;
let otherProject;

function insertUser(db, email, displayName, role) {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, displayName, role, at, at);
  return { id: info.lastInsertRowid, email, display_name: displayName, role };
}

beforeEach(() => {
  db = makeTestDb();
  admin = insertUser(db, 'admin@example.com', 'Admin', 'super_admin');
  sub = insertUser(db, 'sub@example.com', 'Sub Person', 'subcontractor');
  sub2 = insertUser(db, 'sub2@example.com', 'Other Sub', 'subcontractor');

  const c = createClient(db, { name: 'Acme' }, { actorId: admin.id });
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;

  const c2 = createClient(db, { name: 'Globex' }, { actorId: admin.id });
  const p2 = createProject(db, { client_id: c2.client.id, name: 'Intranet' }, { actorId: admin.id });
  otherProject = p2.project;

  // sub is a member of project at $125/hr; admin is NOT a member by default.
  addMember(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
});

const goodEntry = (overrides = {}) => ({
  project_id: project.id,
  entry_date: '2026-05-04',
  hours: 4.5,
  description: 'Worked on auth flow',
  ...overrides,
});

describe('create', () => {
  it('lets a sub log time on a project they are a member of', () => {
    const r = create(db, goodEntry(), { actor: sub });
    expect(r.ok).toBe(true);
    expect(r.entry.user_id).toBe(sub.id);
    expect(r.entry.project_id).toBe(project.id);
    expect(r.entry.hours).toBe(4.5);
    expect(r.entry.description).toBe('Worked on auth flow');
    expect(r.entry.invoice_id).toBeNull();
    expect(r.entry.locked).toBe(false);
  });

  it('rejects a sub on a project they are not a member of', () => {
    const r = create(db, goodEntry({ project_id: otherProject.id }), { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_member');
  });

  it('rejects super_admin self-bill when not a project member', () => {
    const r = create(db, goodEntry(), { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_member');
  });

  it('allows super_admin self-bill when they are a project member', () => {
    addMember(db, project.id, { user_id: admin.id, bill_rate_cents: 20000 }, { actorId: admin.id });
    const r = create(db, goodEntry(), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.entry.user_id).toBe(admin.id);
  });

  it('lets super_admin post on behalf of a sub via act_as_user_id', () => {
    const r = create(db, goodEntry({ act_as_user_id: sub.id }), { actor: admin });
    expect(r.ok).toBe(true);
    expect(r.entry.user_id).toBe(sub.id);
  });

  it('rejects super_admin acting as a non-member', () => {
    const r = create(db, goodEntry({ act_as_user_id: sub2.id }), { actor: admin });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_member');
  });

  it('rejects a sub trying to act_as_user_id another user', () => {
    addMember(db, project.id, { user_id: sub2.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const r = create(db, goodEntry({ act_as_user_id: sub2.id }), { actor: sub });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('validates date format', () => {
    expect(create(db, goodEntry({ entry_date: '5/4/2026' }), { actor: sub }).reason).toBe('invalid_date');
    expect(create(db, goodEntry({ entry_date: '' }), { actor: sub }).reason).toBe('invalid_date');
  });

  it('rejects non-positive hours', () => {
    expect(create(db, goodEntry({ hours: 0 }), { actor: sub }).reason).toBe('invalid_hours');
    expect(create(db, goodEntry({ hours: -1 }), { actor: sub }).reason).toBe('invalid_hours');
    expect(create(db, goodEntry({ hours: 'abc' }), { actor: sub }).reason).toBe('invalid_hours');
  });

  it('requires a description', () => {
    expect(create(db, goodEntry({ description: '   ' }), { actor: sub }).reason).toBe('description_required');
    expect(create(db, goodEntry({ description: '' }), { actor: sub }).reason).toBe('description_required');
  });

  it('writes an audit row with display strings', () => {
    create(db, goodEntry(), { actor: sub });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'time_entry.create'").get();
    expect(row.summary).toContain('Sub Person');
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
    expect(row.summary).toContain('4.5h');
    expect(row.summary).toContain('2026-05-04');
  });
});

describe('update', () => {
  it('allows the owner to patch hours and description', () => {
    const r = create(db, goodEntry(), { actor: sub });
    const u = update(db, r.entry.id, { hours: 5, description: 'Refined' }, { actor: sub });
    expect(u.ok).toBe(true);
    expect(u.entry.hours).toBe(5);
    expect(u.entry.description).toBe('Refined');
  });

  it('writes audit_changes for changed fields', () => {
    const r = create(db, goodEntry(), { actor: sub });
    update(db, r.entry.id, { hours: 5.5 }, { actor: sub });
    const audit = db.prepare("SELECT * FROM admin_audit WHERE action = 'time_entry.update'").get();
    const changes = db.prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?').all(audit.id);
    expect(changes).toEqual([{ field: 'hours', old_value: '4.5', new_value: '5.5' }]);
  });

  it('rejects update on a locked (invoiced) row', () => {
    const r = create(db, goodEntry(), { actor: sub });
    db.prepare('UPDATE time_entries SET invoice_id = 999 WHERE id = ?').run(r.entry.id);
    const u = update(db, r.entry.id, { hours: 5 }, { actor: sub });
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('locked');
  });

  it("rejects a sub editing another user's entry", () => {
    addMember(db, project.id, { user_id: sub2.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const r = create(db, goodEntry({ act_as_user_id: sub2.id }), { actor: admin });
    const u = update(db, r.entry.id, { hours: 1 }, { actor: sub });
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('forbidden');
  });

  it('lets super_admin edit any entry', () => {
    const r = create(db, goodEntry(), { actor: sub });
    const u = update(db, r.entry.id, { hours: 6 }, { actor: admin });
    expect(u.ok).toBe(true);
    expect(u.entry.hours).toBe(6);
  });

  it('returns not_found for unknown id', () => {
    expect(update(db, 999, { hours: 1 }, { actor: admin }).reason).toBe('not_found');
  });

  it('is a no-op when nothing changes', () => {
    const r = create(db, goodEntry(), { actor: sub });
    const u = update(db, r.entry.id, {}, { actor: sub });
    expect(u.ok).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'time_entry.update'").get().n;
    expect(count).toBe(0);
  });
});

describe('remove', () => {
  it('hard-deletes an unlocked row', () => {
    const r = create(db, goodEntry(), { actor: sub });
    remove(db, r.entry.id, { actor: sub });
    expect(db.prepare('SELECT id FROM time_entries WHERE id = ?').get(r.entry.id)).toBeUndefined();
  });

  it('rejects deleting a locked row', () => {
    const r = create(db, goodEntry(), { actor: sub });
    db.prepare('UPDATE time_entries SET invoice_id = 999 WHERE id = ?').run(r.entry.id);
    expect(remove(db, r.entry.id, { actor: sub }).reason).toBe('locked');
  });

  it("rejects a sub deleting another user's entry", () => {
    addMember(db, project.id, { user_id: sub2.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const r = create(db, goodEntry({ act_as_user_id: sub2.id }), { actor: admin });
    expect(remove(db, r.entry.id, { actor: sub }).reason).toBe('forbidden');
  });

  it('writes an audit row', () => {
    const r = create(db, goodEntry(), { actor: sub });
    remove(db, r.entry.id, { actor: sub });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'time_entry.delete'").get();
    expect(row.summary).toContain('Sub Person');
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
  });
});

describe('list', () => {
  beforeEach(() => {
    addMember(db, otherProject.id, { user_id: sub2.id, bill_rate_cents: 10000 }, { actorId: admin.id });
    addMember(db, project.id, { user_id: sub2.id, bill_rate_cents: 10000 }, { actorId: admin.id });
    create(db, goodEntry({ entry_date: '2026-05-01', hours: 1 }), { actor: sub });
    create(db, goodEntry({ entry_date: '2026-05-02', hours: 2 }), { actor: sub });
    create(db, goodEntry({ project_id: otherProject.id, entry_date: '2026-05-03', hours: 3 }), { actor: sub2 });
    create(db, goodEntry({ entry_date: '2026-05-04', hours: 4, act_as_user_id: sub2.id }), { actor: admin });
  });

  it('super_admin sees all entries by default', () => {
    expect(list(db, {}, admin)).toHaveLength(4);
  });

  it('forces sub to see only their own rows even with userId override', () => {
    const rows = list(db, { userId: sub2.id }, sub);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === sub.id)).toBe(true);
  });

  it('filters by projectId for super_admin', () => {
    const rows = list(db, { projectId: otherProject.id }, admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(otherProject.id);
  });

  it('filters by userId for super_admin', () => {
    const rows = list(db, { userId: sub2.id }, admin);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === sub2.id)).toBe(true);
  });

  it('filters by date range', () => {
    const rows = list(db, { from: '2026-05-02', to: '2026-05-03' }, admin);
    expect(rows.map((r) => r.entry_date).sort()).toEqual(['2026-05-02', '2026-05-03']);
  });

  it('hides locked rows by default and reveals them with includeLocked', () => {
    const all = list(db, {}, admin);
    db.prepare('UPDATE time_entries SET invoice_id = 999 WHERE id = ?').run(all[0].id);
    expect(list(db, {}, admin)).toHaveLength(3);
    expect(list(db, { includeLocked: true }, admin)).toHaveLength(4);
  });

  it('orders entries by entry_date DESC', () => {
    const rows = list(db, {}, admin);
    const dates = rows.map((r) => r.entry_date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });
});

describe('get', () => {
  it("returns null for a sub trying to read another user's entry", () => {
    addMember(db, project.id, { user_id: sub2.id, bill_rate_cents: 10000 }, { actorId: admin.id });
    const r = create(db, goodEntry({ act_as_user_id: sub2.id }), { actor: admin });
    expect(get(db, r.entry.id, sub)).toBeNull();
    expect(get(db, r.entry.id, sub2)?.id).toBe(r.entry.id);
    expect(get(db, r.entry.id, admin)?.id).toBe(r.entry.id);
  });
});
