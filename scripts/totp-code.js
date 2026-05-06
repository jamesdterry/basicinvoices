#!/usr/bin/env node
// Print the current 6-digit TOTP code for a given secret. Used by the
// GitHub Action at .github/workflows/recurring-tick.yml; can also be run
// locally to test the /cron/recurring-tick route by hand.
//
// Usage:
//   RECURRING_TICK_SECRET=$(openssl rand -hex 20)
//   node scripts/totp-code.js
//   # or pass on argv:
//   node scripts/totp-code.js <secret>
//
// Reuses server/lib/totp.js so the script and the server can never disagree
// on encoding, step size, or hash algorithm.

import { generateTotp } from '../server/lib/totp.js';

const secret = process.argv[2] || process.env.RECURRING_TICK_SECRET;
if (!secret) {
  process.stderr.write(
    'usage: node scripts/totp-code.js <secret> | RECURRING_TICK_SECRET=<secret> node scripts/totp-code.js\n'
  );
  process.exit(2);
}

process.stdout.write(`${generateTotp(secret)}\n`);
