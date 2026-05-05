#!/usr/bin/env node
import { db } from '../server/db/connection.js';
import { runMigrations } from '../server/db/migrate.js';

const result = runMigrations(db, { log: (m) => console.log(`[migrate] ${m}`) });
console.log(`[migrate] ${result.applied} new, ${result.total} total`);
db.close();
