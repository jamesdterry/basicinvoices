import crypto from 'node:crypto';
import path from 'node:path';

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const REQUIRED_IN_PROD = ['SUPER_ADMIN_EMAIL', 'SESSION_SECRET', 'BASE_URL', 'DB_PATH'];

if (isProd) {
  const missing = REQUIRED_IN_PROD.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required env vars in production: ${missing.join(', ')}`
    );
  }
}

const port = Number(env.PORT) || 8080;

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) throw new Error('[config] SESSION_SECRET required in production');
  sessionSecret = crypto.randomBytes(32).toString('hex');
  if (!isTest) {
    process.stderr.write(
      '[config] WARNING: SESSION_SECRET not set; using ephemeral random value (dev only)\n'
    );
  }
}

const dbPath =
  env.DB_PATH || (isTest ? ':memory:' : path.resolve('./data/basicinvoices.sqlite'));

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProd,
  isTest,
  port,
  baseUrl: env.BASE_URL || `http://localhost:${port}`,
  superAdminEmail: env.SUPER_ADMIN_EMAIL || '',
  sessionSecret,
  dbPath,
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '',
  },
  // Stage 7A — optional. When unset, services/stripeLinks.js#isEnabled()
  // returns false, the /api/me payload reports stripe_enabled: false, and
  // the Generate-link route returns 503 'stripe_disabled'. Manual paste of
  // a Stripe Payment Link URL keeps working regardless.
  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  // Stage 8.5 — TOTP secret (RFC 6238) for /cron/recurring-tick. When unset,
  // the route returns 503 'tick_disabled' and only the in-process timer +
  // wake-on-activity hook can fire the recurring tick. With min_machines_running = 0
  // in fly.toml, an external trigger (GitHub Action) is needed; that path
  // requires this secret. Generate with `openssl rand -hex 20`.
  recurringTickSecret: env.RECURRING_TICK_SECRET || '',
  cookiePrefix: 'bi_',
});
