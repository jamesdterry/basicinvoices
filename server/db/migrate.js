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

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const insert = db.prepare('INSERT INTO _meta (name, applied_at) VALUES (?, ?)');
    const tx = db.transaction(() => {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
    });
    tx();
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
