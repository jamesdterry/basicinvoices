// Invoice email orchestration. Pulls invoice + client + project via the same
// `getByPublicToken` shape that drives the public /i/<token> view (so the
// recipient sees the same numbers in their email and on the web), renders a
// PDF attachment, and dispatches through services/email.js (which falls back
// to a stdout `dev-email` line when SMTP_HOST is unset).

import { config } from '../config.js';
import { logger } from '../logger.js';
import * as invoices from './invoices.js';
import * as invoicePdf from './invoicePdf.js';
import { sendEmail } from './email.js';
import {
  renderInvoiceEmailHtml,
  renderInvoiceEmailText,
} from '../views/emailInvoice.html.js';

function publicLinkFor(token) {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  return `${base}/i/${token}`;
}

export async function sendInvoiceEmail(db, invoiceId) {
  const row = db
    .prepare(
      `SELECT i.public_token
         FROM invoices i
        WHERE i.id = ?`
    )
    .get(invoiceId);
  if (!row) return { ok: false, reason: 'not_found' };

  const data = invoices.getByPublicToken(db, row.public_token);
  if (!data) return { ok: false, reason: 'not_found' };

  const to = Array.isArray(data.client?.contact_emails) ? data.client.contact_emails : [];
  if (to.length === 0) return { ok: false, reason: 'no_client_email' };

  const link = publicLinkFor(data.invoice.public_token);
  const subject = `Invoice ${data.invoice.number} — ${data.client.name}`;
  const html = renderInvoiceEmailHtml({
    invoice: data.invoice,
    client: data.client,
    project: data.project,
    publicLink: link,
  });
  const text = renderInvoiceEmailText({
    invoice: data.invoice,
    client: data.client,
    project: data.project,
    publicLink: link,
  });

  const pdfResult = await invoicePdf.renderInvoicePdfFromData(data);
  const attachments = pdfResult?.buffer
    ? [
        {
          filename: `Invoice-${data.invoice.number}.pdf`,
          content: pdfResult.buffer,
          contentType: 'application/pdf',
        },
      ]
    : [];

  try {
    const r = await sendEmail({ to, subject, html, text, link, attachments });
    return { ok: true, dev: !!r?.dev, attachment: !!attachments.length };
  } catch (err) {
    logger.error({ err, invoiceId }, 'invoice email send failed');
    return { ok: false, reason: 'send_failed' };
  }
}
