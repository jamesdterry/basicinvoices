import { db } from '../db/connection.js';
import { loadSession } from '../services/auth.js';
import { SESSION_COOKIE_NAME } from './csrf.js';

export function loadSessionFromCookie(req, _res, next) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) {
    const loaded = loadSession(db, sessionId);
    if (loaded) {
      req.user = loaded.user;
      req.session = loaded.session;
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

export function gateAppShell(req, res, next) {
  if (req.user) return next();
  res.redirect(302, '/login.html');
}
