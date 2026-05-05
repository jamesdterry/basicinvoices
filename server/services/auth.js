import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendEmail } from './email.js';

const MAGIC_LINK_TTL_MS = 30 * 60 * 1000;
const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const BCRYPT_COST = 12;

function nowIso() {
  return new Date().toISOString();
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function emailMatchesSuperAdmin(email) {
  const target = config.superAdminEmail;
  return !!target && !!email && email.toLowerCase() === target.toLowerCase();
}

function applySuperAdminOverride(user) {
  if (!user) return null;
  if (emailMatchesSuperAdmin(user.email)) {
    return { ...user, role: 'super_admin' };
  }
  return user;
}

function displayNameFromEmail(email) {
  const [local] = email.split('@');
  return local || email;
}

function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) || null;
}

function createUser(db, { email, role, displayName }) {
  const at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO users (email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(email, displayName, role, at, at);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function loadUserById(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return applySuperAdminOverride(u || null);
}

export async function requestMagicLink(db, { email, ip }) {
  if (!email || typeof email !== 'string') return { sent: false, reason: 'invalid_email' };
  const trimmed = email.trim();
  if (!trimmed.includes('@')) return { sent: false, reason: 'invalid_email' };

  let user = findUserByEmail(db, trimmed);

  if (!user && emailMatchesSuperAdmin(trimmed)) {
    user = createUser(db, {
      email: trimmed,
      role: 'super_admin',
      displayName: displayNameFromEmail(trimmed),
    });
    logger.info({ userId: user.id, email: trimmed }, 'super-admin auto-created');
  }

  if (!user || user.disabled_at) {
    return { sent: false, reason: 'no_user' };
  }

  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO magic_link_tokens (email, token_hash, purpose, expires_at, requested_ip, created_at)
     VALUES (?, ?, 'login', ?, ?, ?)`
  ).run(trimmed, tokenHash, expiresAt, ip || null, nowIso());

  const link = `${config.baseUrl}/auth/redeem?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: trimmed,
    subject: 'Sign in to Basic Invoices',
    text: `Click this link to sign in (valid for 30 minutes):\n\n${link}\n`,
    link,
  });

  return { sent: true };
}

export function redeemMagicLink(db, { token, ip, userAgent }) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'invalid' };
  const tokenHash = sha256(token);

  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM magic_link_tokens
         WHERE token_hash = ? AND used_at IS NULL`
      )
      .get(tokenHash);
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.expires_at < nowIso()) return { ok: false, reason: 'expired' };

    db.prepare('UPDATE magic_link_tokens SET used_at = ? WHERE id = ?').run(nowIso(), row.id);

    const user = findUserByEmail(db, row.email);
    if (!user || user.disabled_at) return { ok: false, reason: 'invalid' };

    const session = createSession(db, { userId: user.id, ip, userAgent });
    return { ok: true, sessionId: session.id, user: applySuperAdminOverride(user) };
  })();
}

export function createSession(db, { userId, ip, userAgent }) {
  const id = crypto.randomBytes(32).toString('base64url');
  const at = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, at, at, userAgent || null, ip || null);
  return { id, userId, createdAt: at };
}

export function loadSession(db, sessionId) {
  if (!sessionId) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user || user.disabled_at) return null;

  const lastSeenMs = Date.parse(session.last_seen_at);
  if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > SESSION_LAST_SEEN_THROTTLE_MS) {
    const at = nowIso();
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, session.id);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(at, user.id);
  }

  return { session, user: applySuperAdminOverride(user) };
}

export function revokeSession(db, sessionId) {
  if (!sessionId) return { revoked: 0 };
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  return { revoked: result.changes };
}

export async function setPassword(db, { userId, newPassword }) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('password_too_short');
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hash,
    nowIso(),
    userId
  );
}

export async function verifyPassword(db, { email, password, ip, userAgent }) {
  if (!email || !password) return { ok: false, reason: 'invalid' };
  const user = findUserByEmail(db, email);
  if (!user || user.disabled_at || !user.password_hash) {
    // constant-time-ish: still hash to avoid leaking existence
    await bcrypt.hash(password, BCRYPT_COST).catch(() => {});
    return { ok: false, reason: 'invalid' };
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return { ok: false, reason: 'invalid' };
  const session = createSession(db, { userId: user.id, ip, userAgent });
  return { ok: true, sessionId: session.id, user: applySuperAdminOverride(user) };
}
