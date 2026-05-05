import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeTestDb } from './db.js';
import {
  requestMagicLink,
  redeemMagicLink,
  loadSession,
  revokeSession,
  setPassword,
  verifyPassword,
  loadUserById,
} from '../server/services/auth.js';

const SUPER = 'admin@example.com';

let db;
beforeEach(() => {
  db = makeTestDb();
});

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function captureLink() {
  const link = process.env.E2E_EMAIL_LOG;
  // We don't use file-tail in unit tests; we read the token from the row.
  return link;
}

describe('requestMagicLink', () => {
  it('auto-creates super-admin on first request', async () => {
    const result = await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    expect(result.sent).toBe(true);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(SUPER);
    expect(user).toBeTruthy();
    expect(user.role).toBe('super_admin');
    expect(user.display_name).toBe('admin');
  });

  it('silently no-ops for unknown emails', async () => {
    const result = await requestMagicLink(db, { email: 'nobody@example.com', ip: '1.2.3.4' });
    expect(result.sent).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM magic_link_tokens').get().n).toBe(0);
  });

  it('stores token as SHA-256 hash, not the raw token', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const row = db.prepare('SELECT * FROM magic_link_tokens').get();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects disabled users', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    db.prepare('UPDATE users SET disabled_at = ? WHERE email = ?').run(
      new Date().toISOString(),
      SUPER
    );
    db.prepare('DELETE FROM magic_link_tokens').run();
    const result = await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    expect(result.sent).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM magic_link_tokens').get().n).toBe(0);
  });
});

describe('redeemMagicLink', () => {
  async function mintToken() {
    // Mint a real token and capture the hash + raw token by inserting it ourselves
    // so the test doesn't depend on the email transport at all.
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const row = db.prepare('SELECT * FROM magic_link_tokens ORDER BY id DESC LIMIT 1').get();
    return row;
  }

  it('is one-shot: a redeemed token cannot be reused', async () => {
    // We insert a known raw token directly so we can redeem it.
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare('UPDATE magic_link_tokens SET token_hash = ? WHERE id = (SELECT id FROM magic_link_tokens ORDER BY id DESC LIMIT 1)').run(sha256(raw));

    const first = redeemMagicLink(db, { token: raw, ip: '1.2.3.4', userAgent: 'test' });
    expect(first.ok).toBe(true);
    expect(first.user.role).toBe('super_admin');

    const second = redeemMagicLink(db, { token: raw, ip: '1.2.3.4', userAgent: 'test' });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('invalid');
  });

  it('rejects expired tokens', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const raw = crypto.randomBytes(32).toString('base64url');
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      'UPDATE magic_link_tokens SET token_hash = ?, expires_at = ? WHERE id = (SELECT id FROM magic_link_tokens ORDER BY id DESC LIMIT 1)'
    ).run(sha256(raw), past);

    const result = redeemMagicLink(db, { token: raw, ip: '1.2.3.4', userAgent: 'test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects garbage tokens', () => {
    const result = redeemMagicLink(db, { token: 'not-a-real-token', ip: '1.2.3.4', userAgent: 'test' });
    expect(result.ok).toBe(false);
  });

  it('rejects tokens for disabled users', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'UPDATE magic_link_tokens SET token_hash = ? WHERE id = (SELECT id FROM magic_link_tokens ORDER BY id DESC LIMIT 1)'
    ).run(sha256(raw));
    db.prepare('UPDATE users SET disabled_at = ? WHERE email = ?').run(
      new Date().toISOString(),
      SUPER
    );

    const result = redeemMagicLink(db, { token: raw, ip: '1.2.3.4', userAgent: 'test' });
    expect(result.ok).toBe(false);
  });
});

describe('sessions', () => {
  async function login() {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'UPDATE magic_link_tokens SET token_hash = ? WHERE id = (SELECT id FROM magic_link_tokens ORDER BY id DESC LIMIT 1)'
    ).run(sha256(raw));
    return redeemMagicLink(db, { token: raw, ip: '1.2.3.4', userAgent: 'test' });
  }

  it('loadSession returns the user; revokeSession invalidates it', async () => {
    const { sessionId } = await login();
    const loaded = loadSession(db, sessionId);
    expect(loaded.user.email).toBe(SUPER);
    expect(loaded.user.role).toBe('super_admin');

    revokeSession(db, sessionId);
    expect(loadSession(db, sessionId)).toBeNull();
  });

  it('returns null for unknown session ids', () => {
    expect(loadSession(db, 'nope')).toBeNull();
    expect(loadSession(db, '')).toBeNull();
    expect(loadSession(db, null)).toBeNull();
  });
});

describe('passwords', () => {
  it('verifyPassword succeeds after setPassword', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(SUPER);
    await setPassword(db, { userId: user.id, newPassword: 'correcthorsebattery' });

    const ok = await verifyPassword(db, {
      email: SUPER,
      password: 'correcthorsebattery',
      ip: '1.2.3.4',
      userAgent: 'test',
    });
    expect(ok.ok).toBe(true);
    expect(ok.user.role).toBe('super_admin');

    const wrong = await verifyPassword(db, {
      email: SUPER,
      password: 'wrong-password',
      ip: '1.2.3.4',
      userAgent: 'test',
    });
    expect(wrong.ok).toBe(false);
  });

  it('rejects users without a password set', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const result = await verifyPassword(db, {
      email: SUPER,
      password: 'anything',
      ip: '1.2.3.4',
      userAgent: 'test',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects passwords shorter than 8 characters', async () => {
    await requestMagicLink(db, { email: SUPER, ip: '1.2.3.4' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(SUPER);
    await expect(setPassword(db, { userId: user.id, newPassword: 'short' })).rejects.toThrow();
  });
});

describe('super-admin override', () => {
  it('upgrades a subcontractor row to super_admin when email matches env', async () => {
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, 'subcontractor', ?, ?)`
    ).run(SUPER, 'Admin', at, at);
    const u = loadUserById(db, db.prepare('SELECT id FROM users').get().id);
    expect(u.role).toBe('super_admin');
  });

  it('leaves non-matching subcontractors alone', async () => {
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, 'subcontractor', ?, ?)`
    ).run('sub@example.com', 'Sub', at, at);
    const u = loadUserById(db, db.prepare('SELECT id FROM users').get().id);
    expect(u.role).toBe('subcontractor');
  });
});

// Suppress unused-import lint
captureLink;
