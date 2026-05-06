import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

let transport = null;

function getTransport() {
  if (!config.smtp.host) return null;
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

function appendE2eLog(payload) {
  const path = process.env.E2E_EMAIL_LOG;
  if (!path) return;
  try {
    fs.appendFileSync(path, JSON.stringify(payload) + '\n');
  } catch (err) {
    logger.warn({ err, path }, 'E2E_EMAIL_LOG append failed');
  }
}

export async function sendEmail({ to, subject, text, html, link, attachments }) {
  const t = getTransport();
  if (!t) {
    const payload = {
      event: 'dev-email',
      to,
      subject,
      link,
      text,
      attachments: Array.isArray(attachments)
        ? attachments.map((a) => ({
            filename: a.filename,
            bytes: a.content?.length ?? 0,
            contentType: a.contentType,
          }))
        : undefined,
    };
    logger.info(payload, 'dev-email');
    appendE2eLog(payload);
    return { dev: true };
  }
  return t.sendMail({
    from: config.smtp.from || `Basic Invoices <noreply@${new URL(config.baseUrl).host}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
}
