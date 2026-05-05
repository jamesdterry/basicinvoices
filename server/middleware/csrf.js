import crypto from 'node:crypto';
import { config } from '../config.js';

const CSRF_COOKIE = 'bi_csrf';
const SESSION_COOKIE = 'bi_session';
const CSRF_TTL_S = 30 * 24 * 60 * 60;
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function ensureCsrfCookie(req, res) {
  if (req.cookies?.[CSRF_COOKIE]) return req.cookies[CSRF_COOKIE];
  const token = mintToken();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: config.isProd,
    sameSite: 'lax',
    maxAge: CSRF_TTL_S * 1000,
    path: '/',
  });
  if (!req.cookies) req.cookies = {};
  req.cookies[CSRF_COOKIE] = token;
  return token;
}

export function csrf(req, res, next) {
  ensureCsrfCookie(req, res);

  if (!MUTATING.has(req.method)) return next();
  if (req.path.startsWith('/auth/')) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (!req.cookies?.[SESSION_COOKIE]) return next();

  const cookieVal = req.cookies[CSRF_COOKIE];
  const headerVal = req.get('x-csrf-token');
  if (!cookieVal || !headerVal || cookieVal !== headerVal) {
    return res.status(403).json({ error: 'csrf' });
  }
  next();
}

export const CSRF_COOKIE_NAME = CSRF_COOKIE;
export const SESSION_COOKIE_NAME = SESSION_COOKIE;
