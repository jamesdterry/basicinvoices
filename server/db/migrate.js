import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function runMigrations(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS _meta (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  ).run();

  const applied = new Set(
    db.prepare('SELECT name FROM _meta').all().map((r) => r.name)
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insert = db.prepare('INSERT INTO _meta (name, applied_at) VALUES (?, ?)');

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    // PRAGMA foreign_keys = OFF/ON is a no-op inside an open transaction, so
    // toggle around the wrapper. Required by the table-rebuild dance in
    // 0006_invoices.sql (and any future schema rebuilds). foreign_key_check
    // runs inside the txn before commit so any violations surface as a
    // throw and roll the migration back.
    const fkOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check');
        if (violations.length > 0) {
          throw new Error(
            `migration ${file} produced FK violations: ${JSON.stringify(violations)}`
          );
        }
        insert.run(file, new Date().toISOString());
      })();
    } finally {
      if (fkOn) db.pragma('foreign_keys = ON');
    }
    log(`applied ${file}`);
    count += 1;
  }
  return { applied: count, total: files.length };
}

const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const { db } = await import('./connection.js');
  const result = runMigrations(db, { log: (m) => console.log(`[migrate] ${m}`) });
  console.log(`[migrate] ${result.applied} new, ${result.total} total`);
  db.close();
}
