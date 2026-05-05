#!/usr/bin/env node
// Resets the e2e database file and email log so the next `npm run start:e2e`
// boots into a clean state. Schema is created by runMigrations on server boot.
// Also seeds the subcontractor user — Stage 2 has no admin UI for user creation,
// and the magic-link flow only auto-bootstraps the super-admin email.

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dbPath = path.join(root, 'data', 'e2e.sqlite');
const emailLog = path.join(root, 'data', 'e2e-emails.log');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

for (const f of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`, emailLog]) {
  try {
    fs.rmSync(f, { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Apply migrations and seed the subcontractor row directly.
const { default: Database } = await import('better-sqlite3');
const { runMigrations } = await import('../server/db/migrate.js');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
runMigrations(db);

const at = new Date().toISOString();
db.prepare(
  `INSERT INTO users (email, display_name, role, created_at, updated_at)
   VALUES ('sub@example.com', 'Sub Person', 'subcontractor', ?, ?)`
).run(at, at);
db.close();

console.log('[seed-e2e] reset', dbPath, '+', emailLog, '— sub@example.com seeded');
