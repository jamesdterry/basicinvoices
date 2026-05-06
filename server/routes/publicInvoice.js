// Public unauthenticated invoice view at GET /i/:token. Mounted in
// server/index.js BEFORE the cookie/session middleware and the static handler
// so it never touches `bi_session` / `bi_csrf`. Per Stage 5 spec:
//   - rate-limited per IP (token bucket; ~60 req capacity, ~1/sec refill)
//   - Cache-Control: private, no-store
//   - X-Robots-Tag: noindex
//   - 410 on revoked tokens (public_token_revoked_at IS NOT NULL)
//   - 404 on unknown tokens
//   - body is the same renderInvoiceHtml output the in-app preview uses

import { Router } from 'express';
import { db } from '../db/connection.js';
import { makeRateLimiter, clientIp } from '../middleware/rateLimit.js';
import * as invoices from '../services/invoices.js';
import { renderInvoiceHtml } from '../views/invoice.html.js';

const limiter = makeRateLimiter({
  capacity: 60,
  refillPerSec: 1,
  name: 'public-invoice',
});

export const publicInvoiceRouter = Router();

publicInvoiceRouter.use(limiter.middleware((req) => clientIp(req)));

publicInvoiceRouter.get('/:token', (req, res) => {
  const data = invoices.getByPublicToken(db, req.params.token);

  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.set('Referrer-Policy', 'no-referrer');

  if (!data) return res.status(404).type('html').send('<h1>Not found</h1>');
  if (data.revoked) return res.status(410).type('html').send('<h1>This link has been revoked.</h1>');

  res.type('html').send(renderInvoiceHtml(data));
});

// Test hook: lets vitest reach in and reset the bucket between cases.
export const _publicInvoiceRateLimiter = limiter;
