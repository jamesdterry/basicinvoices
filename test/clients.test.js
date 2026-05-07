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

  it('defaults to an empty contact_emails list', () => {
    const r = create(db, { name: 'Acme' }, { actorId });
    expect(r.client.contact_emails).toEqual([]);
  });

  it('accepts a single valid contact email', () => {
    const r = create(db, { name: 'Acme', contact_emails: ['billing@acme.example'] }, { actorId });
    expect(r.client.contact_emails).toEqual(['billing@acme.example']);
  });

  it('accepts multiple valid contact emails in insertion order', () => {
    const r = create(
      db,
      { name: 'Acme', contact_emails: ['a@x.test', 'b@y.test', 'c@z.test'] },
      { actorId }
    );
    expect(r.client.contact_emails).toEqual(['a@x.test', 'b@y.test', 'c@z.test']);
  });

  it('rejects invalid email in the list', () => {
    const r = create(db, { name: 'Acme', contact_emails: ['not-an-email'] }, { actorId });
    expect(r).toEqual({ ok: false, reason: 'invalid_email' });
  });

  it('dedupes case-insensitively, preserving first-occurrence casing', () => {
    const r = create(
      db,
      { name: 'Acme', contact_emails: ['Foo@x.test', 'foo@x.test', 'Bar@y.test'] },
      { actorId }
    );
    expect(r.client.contact_emails).toEqual(['Foo@x.test', 'Bar@y.test']);
  });

  it('rejects more than 10 emails as too_many_emails', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@x.test`);
    const r = create(db, { name: 'Acme', contact_emails: eleven }, { actorId });
    expect(r).toEqual({ ok: false, reason: 'too_many_emails' });
  });

  it('rejects a non-array contact_emails input', () => {
    const r = create(db, { name: 'Acme', contact_emails: 'a@b.test' }, { actorId });
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

  it('records contact_emails change as JSON-stringified old/new', () => {
    const { client } = create(
      db,
      { name: 'Acme', contact_emails: ['a@x.test'] },
      { actorId }
    );
    update(db, client.id, { contact_emails: ['a@x.test', 'b@y.test'] }, { actorId });
    const audit = db
      .prepare("SELECT * FROM admin_audit WHERE action = 'client.update' ORDER BY id DESC")
      .get();
    const changes = db
      .prepare('SELECT field, old_value, new_value FROM audit_changes WHERE audit_id = ?')
      .all(audit.id);
    expect(changes).toEqual([
      {
        field: 'contact_emails',
        old_value: '["a@x.test"]',
        new_value: '["a@x.test","b@y.test"]',
      },
    ]);
  });

  it('treats contact_emails update as a no-op when the list is unchanged', () => {
    const { client } = create(
      db,
      { name: 'Acme', contact_emails: ['a@x.test'] },
      { actorId }
    );
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'client.update'")
      .get().n;
    update(db, client.id, { contact_emails: ['a@x.test'] }, { actorId });
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'client.update'")
      .get().n;
    expect(after).toBe(before);
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
