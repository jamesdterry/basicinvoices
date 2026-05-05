import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create as createClient } from '../server/services/clients.js';
import { create as createProject } from '../server/services/projects.js';
import {
  add,
  updateRate,
  remove,
  list,
  stripRates,
} from '../server/services/projectMembers.js';

let db;
let admin;
let sub;
let project;
beforeEach(() => {
  db = makeTestDb();
  const at = new Date().toISOString();
  const a = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('admin@example.com', 'Admin', 'super_admin', ?, ?)`
    )
    .run(at, at);
  admin = { id: a.lastInsertRowid, role: 'super_admin' };
  const s = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('sub@example.com', 'Sub Person', 'subcontractor', ?, ?)`
    )
    .run(at, at);
  sub = { id: s.lastInsertRowid, role: 'subcontractor' };

  const c = createClient(db, { name: 'Acme' }, { actorId: admin.id });
  const p = createProject(db, { client_id: c.client.id, name: 'Website' }, { actorId: admin.id });
  project = p.project;
});

describe('stripRates', () => {
  it('removes bill_rate_cents from sub-viewer payloads', () => {
    const row = { id: 1, user_id: 2, bill_rate_cents: 12500, bill_rate_unit: 'hour' };
    const stripped = stripRates(row, sub);
    expect(stripped).not.toHaveProperty('bill_rate_cents');
    expect(stripped).not.toHaveProperty('bill_rate_unit');
    expect(stripped.user_id).toBe(2);
  });

  it('passes super-admin payloads through unchanged', () => {
    const row = { id: 1, user_id: 2, bill_rate_cents: 12500, bill_rate_unit: 'hour' };
    expect(stripRates(row, admin)).toEqual(row);
  });

  it('handles arrays', () => {
    const rows = [
      { id: 1, bill_rate_cents: 100 },
      { id: 2, bill_rate_cents: 200 },
    ];
    const stripped = stripRates(rows, sub);
    expect(stripped.every((r) => !('bill_rate_cents' in r))).toBe(true);
  });
});

describe('add', () => {
  it('creates an active membership', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    expect(r.ok).toBe(true);
    expect(r.member.bill_rate_cents).toBe(12500);
    expect(r.member.user_email).toBe('sub@example.com');
  });

  it('rejects unknown user', () => {
    const r = add(db, project.id, { user_id: 999, bill_rate_cents: 100 }, { actorId: admin.id });
    expect(r.reason).toBe('unknown_user');
  });

  it('rejects unknown project', () => {
    const r = add(db, 999, { user_id: sub.id, bill_rate_cents: 100 }, { actorId: admin.id });
    expect(r.reason).toBe('project_not_found');
  });

  it('rejects negative or non-integer rate', () => {
    expect(add(db, project.id, { user_id: sub.id, bill_rate_cents: -1 }, {}).reason).toBe(
      'invalid_rate'
    );
    expect(add(db, project.id, { user_id: sub.id }, {}).reason).toBe('invalid_rate');
  });

  it('rejects a second active add for the same user', () => {
    add(db, project.id, { user_id: sub.id, bill_rate_cents: 100 }, { actorId: admin.id });
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 200 }, { actorId: admin.id });
    expect(r.reason).toBe('already_member');
  });

  it('audits add with project + sub display names and the rate in dollars', () => {
    add(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'project_member.add'").get();
    expect(row.summary).toContain('Sub Person');
    expect(row.summary).toContain('Acme');
    expect(row.summary).toContain('Website');
    expect(row.summary).toContain('$125.00/hr');
  });
});

describe('updateRate', () => {
  it('writes audit_changes with USD-formatted old/new', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 10000 }, { actorId: admin.id });
    updateRate(db, r.member.id, { bill_rate_cents: 12500 }, { actorId: admin.id });

    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'project_member.rate_change'")
      .get();
    const change = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
      .get(audit.id);
    expect(change).toEqual({
      field: 'bill_rate_cents',
      old_value: '$100.00/hr',
      new_value: '$125.00/hr',
    });
    expect(audit.summary).toContain('from $100.00/hr to $125.00/hr');
  });

  it('is a no-op when rate is unchanged', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    updateRate(db, r.member.id, { bill_rate_cents: 12500 }, { actorId: admin.id });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'project_member.rate_change'").get().n
    ).toBe(0);
  });

  it('rejects unknown member', () => {
    expect(updateRate(db, 999, { bill_rate_cents: 100 }, { actorId: admin.id }).reason).toBe(
      'not_found'
    );
  });
});

describe('remove', () => {
  it('soft-deletes (sets removed_at)', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 100 }, { actorId: admin.id });
    remove(db, r.member.id, { actorId: admin.id });
    const after = db.prepare('SELECT removed_at FROM project_members WHERE id = ?').get(r.member.id);
    expect(after.removed_at).not.toBeNull();
  });

  it('allows re-adding after removal', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 100 }, { actorId: admin.id });
    remove(db, r.member.id, { actorId: admin.id });
    const r2 = add(db, project.id, { user_id: sub.id, bill_rate_cents: 200 }, { actorId: admin.id });
    expect(r2.ok).toBe(true);
  });
});

describe('list', () => {
  it('returns members for super-admin with rates intact', () => {
    add(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const rows = list(db, project.id, admin);
    expect(rows).toHaveLength(1);
    expect(rows[0].bill_rate_cents).toBe(12500);
  });

  it('returns members for sub viewer with rates stripped', () => {
    add(db, project.id, { user_id: sub.id, bill_rate_cents: 12500 }, { actorId: admin.id });
    const rows = list(db, project.id, sub);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('bill_rate_cents');
    expect(rows[0]).not.toHaveProperty('bill_rate_unit');
  });

  it('omits removed members', () => {
    const r = add(db, project.id, { user_id: sub.id, bill_rate_cents: 100 }, { actorId: admin.id });
    remove(db, r.member.id, { actorId: admin.id });
    expect(list(db, project.id, admin)).toEqual([]);
  });
});
