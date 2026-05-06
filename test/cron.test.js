// Tests for the TOTP-gated /cron/recurring-tick endpoint.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';

// We mutate config.recurringTickSecret per-test to flip the route's
// "configured / disabled" branches. mockConfig is hoisted so vi.mock can
// close over the same object we mutate.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    isTest: true,
    isProd: false,
    nodeEnv: 'test',
    port: 8080,
    baseUrl: 'http://localhost:8080',
    superAdminEmail: 'admin@example.com',
    sessionSecret: 'test-secret-do-not-use-anywhere',
    dbPath: ':memory:',
    logLevel: 'silent',
    smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
    stripeSecretKey: '',
    recurringTickSecret: 'aabbccddeeff00112233445566778899aabbccdd', // 20 bytes hex
    cookiePrefix: 'bi_',
  },
}));

vi.mock('../server/config.js', () => ({ config: mockConfig }));

import { generateTotp } from '../server/lib/totp.js';

let app;
let dbModule;
let db;
let cronMod;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = ':memory:';
  const indexMod = await import('../server/index.js');
  app = indexMod.createApp();
  dbModule = await import('../server/db/connection.js');
  db = dbModule.db;
  cronMod = await import('../server/routes/cron.js');
});

afterAll(() => {
  try { dbModule?.db.close(); } catch {}
});

beforeEach(() => {
  // Reset rate limiter so we don't carry buckets between tests.
  cronMod._tickRateLimiter._buckets.map.clear();
  // Reset the meta row so each test starts with no recent tick.
  db.exec(`
    DELETE FROM audit_changes;
    DELETE FROM admin_audit;
    DELETE FROM error_log;
    DELETE FROM payments;
    DELETE FROM invoice_lines;
    DELETE FROM invoices;
    DELETE FROM milestones;
    DELETE FROM expenses;
    DELETE FROM time_entries;
    DELETE FROM recurring_schedules;
    DELETE FROM project_members;
    DELETE FROM projects;
    DELETE FROM clients;
    DELETE FROM sessions;
    DELETE FROM magic_link_tokens;
    DELETE FROM users;
    UPDATE _recurring_meta SET last_tick_at = '1970-01-01T00:00:00.000Z' WHERE id = 1;
  `);
  mockConfig.recurringTickSecret = 'aabbccddeeff00112233445566778899aabbccdd';
});

describe('POST /cron/recurring-tick', () => {
  it('200 with valid TOTP — returns results array', async () => {
    const code = generateTotp(mockConfig.recurringTickSecret);
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', code)
      .send({});
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
  });

  it('401 with wrong code', async () => {
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', '000000')
      .send({});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_code');
  });

  it('401 with missing header', async () => {
    const r = await request(app).post('/cron/recurring-tick').send({});
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('missing_code');
  });

  it('401 with malformed code', async () => {
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', 'abcdef')
      .send({});
    expect(r.status).toBe(401);
  });

  it('503 when secret is unset', async () => {
    mockConfig.recurringTickSecret = '';
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', '123456')
      .send({});
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('tick_disabled');
  });

  it('does NOT require a session cookie or CSRF header', async () => {
    // The whole point of the TOTP route is that GitHub Actions can call it
    // without any browser-side auth. No cookie, no x-csrf-token header.
    const code = generateTotp(mockConfig.recurringTickSecret);
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', code)
      .send({});
    expect(r.status).toBe(200);
  });

  it('200 with skipped:true when the atomic claim is already held', async () => {
    // Simulate wake-on-activity having fired moments ago by stamping
    // _recurring_meta.last_tick_at to "now". The cron's maybeRunDue then
    // can't claim and returns null; the route surfaces it as 200 + skipped.
    db.prepare(
      `UPDATE _recurring_meta SET last_tick_at = ? WHERE id = 1`
    ).run(new Date().toISOString());

    const code = generateTotp(mockConfig.recurringTickSecret);
    const r = await request(app)
      .post('/cron/recurring-tick')
      .set('X-Recurring-Tick', code)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(true);
    expect(r.body.results).toEqual([]);
  });

  it('rate-limits abusive clients', async () => {
    // Bucket capacity is 6/min. Hammer with bad codes from the same IP and
    // expect 429 once the bucket empties.
    let lastStatus = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(app)
        .post('/cron/recurring-tick')
        .set('X-Recurring-Tick', '000000')
        .send({});
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
