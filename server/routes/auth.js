import { Router } from 'express';
import { db } from '../db/connection.js';
import { config } from '../config.js';
import {
  requestMagicLink,
  redeemMagicLink,
  verifyPassword,
  setPassword,
  revokeSession,
} from '../services/auth.js';
import { makeRateLimiter, clientIp } from '../middleware/rateLimit.js';
import { SESSION_COOKIE_NAME } from '../middleware/csrf.js';
import { requireUser } from '../middleware/requireUser.js';
import { logger } from '../logger.js';

const SESSION_TTL_S = 30 * 24 * 60 * 60;

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: SESSION_TTL_S * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

const magicLinkPerEmail = makeRateLimiter({ capacity: 5, refillPerSec: 5 / 3600, name: 'ml-email' });
const magicLinkPerIp = makeRateLimiter({ capacity: 20, refillPerSec: 20 / 3600, name: 'ml-ip' });
const passwordPerIp = makeRateLimiter({ capacity: 10, refillPerSec: 10 / 3600, name: 'pw-ip' });
const redeemPerIp = makeRateLimiter({ capacity: 30, refillPerSec: 30 / 3600, name: 'redeem-ip' });

export const authRouter = Router();

authRouter.post('/magic-link', async (req, res) => {
  const ip = clientIp(req);
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email_required' });

  const ipCheck = magicLinkPerIp.consume(ip);
  const emailCheck = magicLinkPerEmail.consume(email);
  if (!ipCheck.ok || !emailCheck.ok) {
    const retry = Math.max(ipCheck.retryAfterSec || 0, emailCheck.retryAfterSec || 0);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: 'rate_limited', retry_after: retry });
  }

  try {
    await requestMagicLink(db, { email, ip });
  } catch (err) {
    logger.error({ err: { message: err?.message, code: err?.code }, email }, 'magic-link request failed');
  }
  // Always 204 — never leak account existence.
  res.status(204).end();
});

authRouter.get('/redeem', (req, res) => {
  const ip = clientIp(req);
  const rl = redeemPerIp.consume(ip);
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfterSec));
    return res.redirect(302, '/login.html?err=rate_limited');
  }

  const token = String(req.query?.token || '');
  if (!token) return res.redirect(302, '/login.html?err=invalid');

  const result = redeemMagicLink(db, { token, ip, userAgent: req.get('user-agent') });
  if (!result.ok) {
    return res.redirect(302, `/login.html?err=${encodeURIComponent(result.reason)}`);
  }

  setSessionCookie(res, result.sessionId);
  res.redirect(302, '/');
});

authRouter.post('/password', async (req, res) => {
  const ip = clientIp(req);
  const rl = passwordPerIp.consume(ip);
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfterSec));
    return res.status(429).json({ error: 'rate_limited', retry_after: rl.retryAfterSec });
  }

  const email = (req.body?.email || '').trim().toLowerCase();
  const password = req.body?.password || '';
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });

  const result = await verifyPassword(db, {
    email,
    password,
    ip,
    userAgent: req.get('user-agent'),
  });
  if (!result.ok) return res.status(401).json({ error: 'invalid' });

  setSessionCookie(res, result.sessionId);
  res.json({
    ok: true,
    user: {
      id: result.user.id,
      email: result.user.email,
      display_name: result.user.display_name,
      role: result.user.role,
    },
  });
});

authRouter.post('/logout', (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) revokeSession(db, sessionId);
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.post('/set-password', requireUser, async (req, res) => {
  const password = req.body?.password || '';
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  await setPassword(db, { userId: req.user.id, newPassword: password });
  res.status(204).end();
});
