import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './db.js';
import { create, update, archive, unarchive, list, get } from '../server/services/clients.js';

let db;
let actorId;
beforeEach(() => {
  db = makeTestDb();
  const at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES ('admin@example.com', 'Admin', 'super_admin', ?, ?)`
    )
    .run(at, at);
  actorId = info.lastInsertRowid;
});

describe('clients.create', () => {
  it('creates a client with the required name', () => {
    const r = create(db, { name: 'Acme' }, { actorId, ip: '1.1.1.1' });
    expect(r.ok).toBe(true);
    expect(r.client.name).toBe('Acme');
    expect(r.client.payment_terms_days).toBe(14);
    expect(r.client.archived_at).toBeNull();
  });

  it('rejects empty name', () => {
    const r = create(db, { name: '   ' }, { actorId });
    expect(r).toEqual({ ok: false, reason: 'name_required' });
  });

  it('rejects invalid email', () => {
    const r = create(db, { name: 'Acme', contact_email: 'not-an-email' }, { actorId });
    expect(r).toEqual({ ok: false, reason: 'invalid_email' });
  });

  it('accepts custom payment_terms_days', () => {
    const r = create(db, { name: 'Acme', payment_terms_days: 30 }, { actorId });
    expect(r.client.payment_terms_days).toBe(30);
  });

  it('rejects out-of-range payment_terms_days', () => {
    expect(create(db, { name: 'Acme', payment_terms_days: -1 }, { actorId }).reason).toBe(
      'invalid_payment_terms'
    );
    expect(create(db, { name: 'Acme', payment_terms_days: 1000 }, { actorId }).reason).toBe(
      'invalid_payment_terms'
    );
  });

  it('writes an admin_audit row on create', () => {
    create(db, { name: 'Acme' }, { actorId, ip: '1.1.1.1' });
    const row = db.prepare("SELECT * FROM admin_audit WHERE action = 'client.create'").get();
    expect(row.summary).toContain('Acme');
    expect(row.actor_id).toBe(actorId);
    expect(row.ip).toBe('1.1.1.1');
  });
});

describe('clients.update', () => {
  it('returns not_found for missing client', () => {
    expect(update(db, 999, { name: 'x' }, { actorId }).reason).toBe('not_found');
  });

  it('persists changes and writes audit_changes diff', () => {
    const { client } = create(db, { name: 'Acme', payment_terms_days: 14 }, { actorId });
    const r = update(db, client.id, { name: 'Acme Co', payment_terms_days: 30 }, { actorId });
    expect(r.client.name).toBe('Acme Co');
    expect(r.client.payment_terms_days).toBe(30);

    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'client.update' ORDER BY id DESC")
      .get();
    const changes = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
      .all(audit.id);
    expect(changes).toEqual(
      expect.arrayContaining([
        { field: 'name', old_value: 'Acme', new_value: 'Acme Co' },
        { field: 'payment_terms_days', old_value: '14', new_value: '30' },
      ])
    );
  });

  it('is a no-op when nothing changed', () => {
    const { client } = create(db, { name: 'Acme' }, { actorId });
    const before = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'client.update'").get().n;
    update(db, client.id, { name: 'Acme' }, { actorId });
    const after = db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'client.update'").get().n;
    expect(after).toBe(before);
  });
});

describe('clients.archive / unarchive', () => {
  it('archive sets archived_at and audits', () => {
    const { client } = create(db, { name: 'Acme' }, { actorId });
    const r = archive(db, client.id, { actorId });
    expect(r.client.archived_at).not.toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'client.archive'").get().n
    ).toBe(1);
  });

  it('archived clients are excluded from list() by default', () => {
    const { client: a } = create(db, { name: 'A' }, { actorId });
    create(db, { name: 'B' }, { actorId });
    archive(db, a.id, { actorId });
    expect(list(db).map((c) => c.name)).toEqual(['B']);
    expect(list(db, { includeArchived: true }).map((c) => c.name).sort()).toEqual(['A', 'B']);
  });

  it('unarchive clears archived_at', () => {
    const { client } = create(db, { name: 'Acme' }, { actorId });
    archive(db, client.id, { actorId });
    const r = unarchive(db, client.id, { actorId });
    expect(r.client.archived_at).toBeNull();
  });
});

describe('clients.get', () => {
  it('returns null for missing id', () => {
    expect(get(db, 999)).toBeNull();
  });
});
