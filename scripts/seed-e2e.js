#!/usr/bin/env node
// Resets the e2e database file and email log so the next `npm run start:e2e`
// boots into a clean state. Schema is created by runMigrations on server boot.

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

console.log('[seed-e2e] reset', dbPath, '+', emailLog);
