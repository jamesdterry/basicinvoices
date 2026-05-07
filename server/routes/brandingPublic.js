// Public branding asset routes (Stage 10). Mounted BEFORE csrf +
// loadSessionFromCookie so they're reachable from the public invoice HTML
// and PDF (rendered with no session) and work in browsers with no
// relationship to the app.
//
//   GET /branding/logo       → serves the uploaded logo bytes (404 if none)
//   GET /branding/style.css  → :root { --accent: #....; }
//
// Both are rate-limited and emit a strong ETag keyed on branding.updated_at.
// /style.css overrides the existing --accent declared in /invoice.css; the
// cascade does the work, so no edits to invoice.css's existing rules.

import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { makeRateLimiter, clientIp } from '../middleware/rateLimit.js';
import * as branding from '../services/branding.js';

const HEX_RX = /^#[0-9A-Fa-f]{6}$/;
const FALLBACK_HEX = '#2a6df4';

const limiter = makeRateLimiter({
  capacity: 120,
  refillPerSec: 2,
  name: 'branding-public',
});

export const brandingPublicRouter = Router();

brandingPublicRouter.use(limiter.middleware((req) => clientIp(req)));

// Memoize ETag computations keyed on updated_at so we don't sha256 the
// blob on every request. Two slots: one for /logo, one for /style.css.
let logoEtagMemo = { key: null, etag: null };
let cssEtagMemo = { key: null, etag: null };

function strongEtag(buf) {
  return `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}"`;
}

brandingPublicRouter.get('/logo', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');

  const row = branding.getLogo(db);
  if (!row) return res.status(404).type('text').send('Not found');

  if (logoEtagMemo.key !== row.updated_at) {
    logoEtagMemo = { key: row.updated_at, etag: strongEtag(row.bytes) };
  }
  const etag = logoEtagMemo.etag;

  res.set('Cache-Control', 'public, max-age=300, must-revalidate');
  res.set('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.type(row.mime).send(row.bytes);
});

brandingPublicRouter.get('/style.css', (req, res) => {
  res.set('Referrer-Policy', 'no-referrer');

  const b = branding.get(db);
  const hex = HEX_RX.test(b.accentColorHex) ? b.accentColorHex : FALLBACK_HEX;
  if (hex !== b.accentColorHex) {
    logger.warn(
      { stored: b.accentColorHex },
      'branding accent_color_hex failed regex; falling back to default'
    );
  }

  const body = `:root { --accent: ${hex}; }\n`;

  if (cssEtagMemo.key !== b.updatedAt) {
    cssEtagMemo = { key: b.updatedAt, etag: strongEtag(Buffer.from(body)) };
  }
  const etag = cssEtagMemo.etag;

  res.set('Cache-Control', 'public, max-age=300, must-revalidate');
  res.set('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.type('text/css').send(body);
});

// Test hook: lets vitest reset the rate-limit bucket and ETag memos.
export const _brandingPublicRateLimiter = limiter;
export function _resetBrandingMemos() {
  logoEtagMemo = { key: null, etag: null };
  cssEtagMemo = { key: null, etag: null };
}
