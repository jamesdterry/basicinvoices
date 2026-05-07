// Super-admin branding routes (Stage 10).
//
//   GET    /api/branding         → current settings + derived logo_url
//   PATCH  /api/branding         → update company name / address / accent
//   POST   /api/branding/logo    → multipart upload (busboy), 256 KB cap
//   DELETE /api/branding/logo    → clear logo
//
// Public asset routes (/branding/logo + /branding/style.css) live in a
// separate router, mounted before csrf so they work in the public invoice
// HTML and PDF without consulting bi_session / bi_csrf.

import { Router } from 'express';
import busboy from 'busboy';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as branding from '../services/branding.js';

export const brandingRouter = Router();

brandingRouter.use(requireUser);
brandingRouter.use(requireSuperAdmin);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'logo_too_large':
      return 413;
    default:
      return 400;
  }
}

function shapeBranding(b) {
  return { ...b, logoUrl: b.hasLogo ? '/branding/logo' : null };
}

brandingRouter.get('/', (_req, res) => {
  res.json({ branding: shapeBranding(branding.get(db)) });
});

brandingRouter.patch('/', (req, res) => {
  const r = branding.update(db, req.body || {}, {
    actor: req.user,
    ip: clientIp(req),
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ branding: shapeBranding(r.branding) });
});

brandingRouter.post('/logo', (req, res) => {
  const ctype = req.headers['content-type'] || '';
  if (!ctype.toLowerCase().includes('multipart/form-data')) {
    return res.status(400).json({ error: 'invalid_mime' });
  }

  let bb;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { fileSize: branding.LOGO_MAX_BYTES, files: 1, fields: 0 },
    });
  } catch (err) {
    logger.error({ err }, 'busboy init failed');
    return res.status(400).json({ error: 'invalid_mime' });
  }

  let handled = false;
  const chunks = [];
  let captured = null; // { filename, mime }
  let oversized = false;

  function once(fn) {
    return (...args) => {
      if (handled) return;
      handled = true;
      fn(...args);
    };
  }

  const respondError = once((status, error) => {
    req.unpipe(bb);
    res.status(status).json({ error });
  });

  bb.on('file', (fieldname, file, info) => {
    if (fieldname !== 'logo') {
      file.resume();
      return;
    }
    captured = { filename: info.filename || null, mime: info.mimeType || '' };
    file.on('data', (chunk) => {
      if (oversized) return;
      chunks.push(chunk);
    });
    file.on('limit', () => {
      oversized = true;
      respondError(413, 'logo_too_large');
    });
    file.on('end', () => {
      // finish handler resolves
    });
  });

  bb.on('error', (err) => {
    logger.error({ err }, 'busboy stream error');
    respondError(400, 'invalid_mime');
  });

  bb.on('finish', () => {
    if (handled) return;
    if (!captured) return respondError(400, 'logo_required');
    const bytes = Buffer.concat(chunks);
    const r = branding.setLogo(
      db,
      { filename: captured.filename, mime: captured.mime, bytes },
      { actor: req.user, ip: clientIp(req) }
    );
    if (!r.ok) return respondError(statusFor(r.reason), r.reason);
    handled = true;
    res.json({ branding: shapeBranding(r.branding) });
  });

  req.pipe(bb);
});

brandingRouter.delete('/logo', (req, res) => {
  const r = branding.clearLogo(db, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ branding: shapeBranding(r.branding) });
});
