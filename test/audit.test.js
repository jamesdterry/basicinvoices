import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { logAction } from '../server/services/audit.js';

let db;
beforeEach(() => {
  db = makeTestDb();
});

function seedActor() {
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('admin@example.com', 'Admin', 'super_admin', ?, ?)`
    )
    .run(at, at);
  return info.lastInsertRowid;
}

describe('logAction', () => {
  it('writes a parent row with no changes', () => {
    const actorId = seedActor();
    const id = logAction(db, {
      actorId,
      action: 'client.create',
      targetKind: 'client',
      targetId: 1,
      summary: 'Created client Acme',
      ip: '1.2.3.4',
    });
    expect(Number.isInteger(id)).toBe(true);
    const row = db.prepare('SELECT * FROM admin_audit WHERE id = ?').get(id);
    expect(row.action).toBe('client.create');
    expect(row.summary).toBe('Created client Acme');
    expect(row.actor_id).toBe(actorId);
    expect(row.ip).toBe('1.2.3.4');
    expect(row.meta_json).toBeNull();
    const kids = db.prepare('SELECT * FROM audit_changes WHERE audit_id = ?').all(id);
    expect(kids).toHaveLength(0);
  });

  it('writes parent + change children atomically', () => {
    const actorId = seedActor();
    const id = logAction(db, {
      actorId,
      action: 'project_member.rate_change',
      targetKind: 'project_member',
      targetId: 7,
      summary: 'Changed rate for Sub on Acme — Website from $100.00/hr to $125.00/hr',
      ip: '1.2.3.4',
      changes: [{ field: 'bill_rate_cents', oldValue: '$100.00/hr', newValue: '$125.00/hr' }],
    });
    const kids = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
      .all(id);
    expect(kids).toEqual([
      { field: 'bill_rate_cents', old_value: '$100.00/hr', new_value: '$125.00/hr' },
    ]);
  });

  it('serializes meta to JSON', () => {
    const id = logAction(db, {
      action: 'client.update',
      targetKind: 'client',
      targetId: 1,
      summary: 's',
      meta: { reason: 'ops' },
    });
    const row = db.prepare('SELECT meta_json FROM admin_audit WHERE id = ?').get(id);
    expect(JSON.parse(row.meta_json)).toEqual({ reason: 'ops' });
  });

  it('throws when required fields are missing', () => {
    expect(() => logAction(db, { summary: 's' })).toThrow();
    expect(() => logAction(db, { action: 'a' })).toThrow();
  });

  it('accepts a null actorId (system actions)', () => {
    const id = logAction(db, {
      actorId: null,
      action: 'recurring.run',
      summary: 'tick',
    });
    const row = db.prepare('SELECT actor_id FROM admin_audit WHERE id = ?').get(id);
    expect(row.actor_id).toBeNull();
  });
});
