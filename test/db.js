import Database from 'better-sqlite3';
import { runMigrations } from '../server/db/migrate.js';

export function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}
