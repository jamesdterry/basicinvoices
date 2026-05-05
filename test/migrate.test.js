import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';

describe('runMigrations', () => {
  it('applies 0001_init and is idempotent', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    const first = runMigrations(db);
    expect(first.applied).toBeGreaterThan(0);
    expect(first.total).toBe(first.applied);

    const meta = db.prepare('SELECT name FROM _meta ORDER BY name').all();
    expect(meta.map((r) => r.name)).toContain('0001_init.sql');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['_health', '_meta', 'error_log']));

    const second = runMigrations(db);
    expect(second.applied).toBe(0);
    expect(second.total).toBe(first.total);

    db.close();
  });
});
