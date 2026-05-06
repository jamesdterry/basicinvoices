import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { runMigrations } from '../server/db/migrate.js';

export function makeTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

// Inserts a minimal `invoices` row directly via SQL and returns its id. Used
// by Stage 3 + Stage 4 tests that need a *real* invoice id to flip the
// invoice_id lock on time_entries / expenses / milestones — Stage 5 added the
// real FK so the previous "UPDATE … SET invoice_id = 999" trick no longer
// works.
export function insertStubInvoice(db, projectId, { number = '2026-9999' } = {}) {
  const at = new Date().toISOString();
  const clientId = db
    .prepare('SELECT client_id FROM projects WHERE id = ?')
    .get(projectId)?.client_id;
  if (!clientId) throw new Error(`insertStubInvoice: project ${projectId} not found`);
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db
    .prepare(
      `INSERT INTO invoices
         (number, client_id, project_id, status, issue_date, due_date,
          subtotal_cents, total_cents, public_token, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', '2026-01-01', '2026-01-15', 0, 0, ?, ?, ?)`
    )
    .run(number, clientId, projectId, token, at, at);
  return Number(info.lastInsertRowid);
}
