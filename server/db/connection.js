import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

function ensureParentDir(p) {
  if (p === ':memory:') return;
  const dir = path.dirname(path.resolve(p));
  fs.mkdirSync(dir, { recursive: true });
}

ensureParentDir(config.dbPath);

export const db = new Database(config.dbPath);

if (config.dbPath !== ':memory:') {
  db.pragma('journal_mode = WAL');
}
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

export function openDatabase(dbPath) {
  const conn = new Database(dbPath);
  if (dbPath !== ':memory:') conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  return conn;
}
