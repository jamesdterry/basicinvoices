// Runs once before the webServer boots. Wipes the e2e DB + email log so each
// run starts from a clean schema. Migrations re-create the tables on boot.

import { execSync } from 'node:child_process';

export default async function globalSetup() {
  execSync('node scripts/seed-e2e.js', { stdio: 'inherit' });
}
