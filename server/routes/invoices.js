import { Router } from 'express';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import { requireUser } from '../middleware/requireUser.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { clientIp } from '../middleware/rateLimit.js';
import * as invoices from '../services/invoices.js';
import * as invoiceMail from '../services/invoiceMail.js';
import { renderInvoiceHtml } from '../views/invoice.html.js';

export const invoicesRouter = Router();

invoicesRouter.use(requireUser);
invoicesRouter.use(requireSuperAdmin);

function statusFor(reason) {
  switch (reason) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
    case 'project_not_found':
    case 'line_not_found':
      return 404;
    case 'wrong_status':
    case 'locked':
    case 'no_client_email':
      return 409;
    default:
      return 400;
  }
}

invoicesRouter.get('/', (req, res) => {
  const q = req.query || {};
  const list = invoices.list(
    db,
    {
      status: q.status,
      clientId: q.client_id ?? q.clientId,
      projectId: q.project_id ?? q.projectId,
      from: q.from,
      to: q.to,
    },
    req.user
  );
  res.json({ invoices: list });
});

invoicesRouter.post('/preview', (req, res) => {
  const r = invoices.previewDraft(db, req.body || {}, req.user);
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({
    project: r.project,
    through_date: r.through_date,
    lines: r.lines,
    subtotal_cents: r.subtotal_cents,
  });
});

invoicesRouter.post('/', (req, res) => {
  const r = invoices.createDraft(db, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.status(201).json({ invoice: r.invoice, lines: r.lines });
});

invoicesRouter.get('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const result = invoices.get(db, id, req.user);
  if (!result) return res.status(404).json({ error: 'not_found' });
  res.json(result);
});

invoicesRouter.patch('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.updateDraft(db, id, req.body || {}, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ invoice: r.invoice, lines: r.lines });
});

invoicesRouter.delete('/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.deleteDraft(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.status(204).end();
});

invoicesRouter.post('/:id/send', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.send(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  let email;
  try {
    email = await invoiceMail.sendInvoiceEmail(db, id);
  } catch (err) {
    logger.error({ err, invoiceId: id }, 'invoice email dispatch threw');
    email = { ok: false, reason: 'send_failed' };
  }
  res.json({ invoice: r.invoice, email });
});

invoicesRouter.post('/:id/resend-email', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.resendEmail(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  let email;
  try {
    email = await invoiceMail.sendInvoiceEmail(db, id);
  } catch (err) {
    logger.error({ err, invoiceId: id }, 'invoice email dispatch threw');
    email = { ok: false, reason: 'send_failed' };
  }
  res.json({ invoice: r.invoice, email });
});

invoicesRouter.post('/:id/void', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.voidInvoice(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ invoice: r.invoice });
});

invoicesRouter.post('/:id/rotate-token', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.rotatePublicToken(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ invoice: r.invoice });
});

invoicesRouter.post('/:id/revoke-token', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const r = invoices.revokePublicLink(db, id, { actor: req.user, ip: clientIp(req) });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason });
  res.json({ invoice: r.invoice });
});

// Server-rendered HTML preview for the in-app right-pane iframe. Same
// template as /i/<token>; this route requires super_admin. Overrides the
// app-wide `frame-ancestors 'none'` CSP so the SPA can embed this URL in an
// iframe; CSP is otherwise unchanged.
invoicesRouter.get('/:id/preview', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const got = invoices.get(db, id, req.user);
  if (!got) return res.status(404).send('not found');
  const data = invoices.getByPublicToken(db, got.invoice.public_token);
  const payload = data || {
    invoice: got.invoice,
    lines: got.lines,
    client: { name: got.invoice.client_name },
    project: { name: got.invoice.project_name },
  };
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; " +
      "form-action 'self'; frame-ancestors 'self'"
  );
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.type('html').send(renderInvoiceHtml(payload));
});
