// Invoice PDF rendering. Pure-JS via pdfkit — no headless browser, no native
// libs beyond what better-sqlite3 already needs. Output mirrors the public
// /i/<token> HTML view in content (numbers, lines, totals are identical),
// though the layout is hand-drawn rather than CSS-rendered.
//
// Skipped under NODE_ENV=test unless BI_PDF_ENABLED=1 (the e2e suite sets
// the override; vitest mocks this module).

import SVGtoPDF from 'svg-to-pdfkit';
import { logger } from '../logger.js';
import { config } from '../config.js';
import * as invoices from './invoices.js';
import * as branding from './branding.js';

const CACHE_MAX = 32;
const cache = new Map();

function pdfEnabled() {
  if (process.env.BI_PDF_ENABLED === '1') return true;
  return !config.isTest;
}

function cacheKey(data) {
  const brandStamp = data?.branding?.updatedAt || '';
  return `${data.invoice.id}:${data.invoice.updated_at}:${brandStamp}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const buf = cache.get(key);
  cache.delete(key);
  cache.set(key, buf);
  return buf;
}

function cacheSet(key, buf) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, buf);
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

function formatHours(hours) {
  return Number(hours).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function lineQty(line) {
  if (line.kind === 'time') return `${formatHours(line.quantity)} hr`;
  return Number(line.quantity) === 1 ? '' : String(line.quantity);
}

function lineRate(line) {
  return line.kind === 'time' ? formatMoney(line.unit_rate_cents) : '';
}

function groupLines(lines) {
  const groups = { time: [], expense: [], milestone: [] };
  for (const l of lines || []) groups[l.kind].push(l);
  const sections = [];
  if (groups.time.length)      sections.push({ title: 'Time',       lines: groups.time });
  if (groups.expense.length)   sections.push({ title: 'Expenses',   lines: groups.expense });
  if (groups.milestone.length) sections.push({ title: 'Milestones', lines: groups.milestone });
  return sections;
}

// pdfkit can embed PNG and JPEG natively. SVG goes through svg-to-pdfkit,
// which writes vector ops directly into the document — best fidelity for a
// logo. Anything else (e.g. an existing WebP row from before WebP uploads
// were dropped) is skipped with a warn; the /branding/logo HTML route still
// serves all stored formats unchanged.
const LOGO_BOX_W = 140;
const LOGO_BOX_H = 56;
const LOGO_ADVANCE = 64;

function drawLogo(doc, x, y, logoBuffer, logoMime) {
  if (!logoBuffer) return false;
  if (logoMime === 'image/png' || logoMime === 'image/jpeg') {
    doc.image(logoBuffer, x, y, { fit: [LOGO_BOX_W, LOGO_BOX_H] });
    return true;
  }
  if (logoMime === 'image/svg+xml') {
    const svg = Buffer.isBuffer(logoBuffer) ? logoBuffer.toString('utf8') : String(logoBuffer);
    SVGtoPDF(doc, svg, x, y, {
      width: LOGO_BOX_W,
      height: LOGO_BOX_H,
      preserveAspectRatio: 'xMinYMin meet',
      assumePt: true,
    });
    return true;
  }
  logger.warn({ mime: logoMime }, 'pdf: logo mime not embeddable, skipping');
  return false;
}

async function buildPdf(data, logoBuffer, logoMime) {
  // Lazy-import so the module pulls cleanly even if pdfkit isn't installed
  // (e.g. running just the unit tests, which mock this module entirely).
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 36,                                // 0.5"
      info: {
        Title: `Invoice ${data.invoice.number}`,
        Author: data.branding?.companyName || '',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawInvoice(doc, data, logoBuffer, logoMime);
    doc.end();
  });
}

function drawInvoice(doc, data, logoBuffer, logoMime) {
  const { invoice, lines, client, project, branding: brand } = data;
  const accent = (brand?.accentColorHex && /^#[0-9A-Fa-f]{6}$/.test(brand.accentColorHex))
    ? brand.accentColorHex
    : '#2a6df4';
  const muted = '#666666';
  const ink = '#222222';
  const ruleColor = '#dddddd';

  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const contentWidth = pageRight - pageLeft;

  // ── Header ─────────────────────────────────────────────────────────────
  const headerTop = doc.y;
  const leftColW = contentWidth * 0.55;
  const rightColX = pageLeft + leftColW;
  const rightColW = contentWidth - leftColW;

  // Left: logo + company name + business address
  let leftY = headerTop;
  if (logoBuffer) {
    try {
      if (drawLogo(doc, pageLeft, leftY, logoBuffer, logoMime)) {
        leftY += LOGO_ADVANCE;
      }
    } catch (err) {
      logger.warn({ err, mime: logoMime }, 'pdf: logo embed failed; skipping');
    }
  }
  if (brand?.companyName) {
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(14)
       .text(brand.companyName, pageLeft, leftY, { width: leftColW });
    leftY = doc.y + 2;
  }
  if (brand?.businessAddress) {
    doc.fillColor(muted).font('Helvetica').fontSize(9)
       .text(brand.businessAddress, pageLeft, leftY, { width: leftColW });
    leftY = doc.y;
  }

  // Right: "INVOICE", number, status, dates
  let rightY = headerTop;
  doc.fillColor(accent).font('Helvetica-Bold').fontSize(26)
     .text('INVOICE', rightColX, rightY, { width: rightColW, align: 'right' });
  rightY = doc.y;
  doc.fillColor(ink).font('Helvetica').fontSize(11)
     .text(`# ${invoice.number}`, rightColX, rightY, { width: rightColW, align: 'right' });
  rightY = doc.y + 4;

  // Status pill — small filled rect right-aligned
  const statusText = String(invoice.status).toUpperCase();
  doc.font('Helvetica-Bold').fontSize(9);
  const pillW = doc.widthOfString(statusText) + 14;
  const pillH = 14;
  const pillX = pageRight - pillW;
  doc.roundedRect(pillX, rightY, pillW, pillH, 3).fillAndStroke(accent, accent);
  doc.fillColor('#ffffff').text(statusText, pillX, rightY + 3, { width: pillW, align: 'center' });
  rightY += pillH + 8;

  // Dates block
  doc.font('Helvetica').fontSize(10).fillColor(ink);
  const drawMetaRow = (label, value) => {
    if (!value) return;
    doc.fillColor(muted).text(label, rightColX, rightY, { width: rightColW * 0.55, align: 'right' });
    doc.fillColor(ink).text(value, rightColX + rightColW * 0.55, rightY, { width: rightColW * 0.45, align: 'right' });
    rightY += 14;
  };
  drawMetaRow('Issue date', invoice.issue_date);
  drawMetaRow('Due date',   invoice.due_date);
  if (invoice.period_start || invoice.period_end) {
    drawMetaRow('Period', `${invoice.period_start || ''} – ${invoice.period_end || ''}`);
  }

  const headerBottom = Math.max(leftY, rightY) + 12;

  // Separator rule
  doc.moveTo(pageLeft, headerBottom).lineTo(pageRight, headerBottom)
     .strokeColor(ruleColor).lineWidth(1).stroke();

  // ── Bill to / Project ──────────────────────────────────────────────────
  let y = headerBottom + 14;
  const billW = contentWidth * 0.55;
  const projX = pageLeft + billW + 12;
  const projW = contentWidth - billW - 12;

  doc.fillColor(muted).font('Helvetica-Bold').fontSize(9)
     .text('BILL TO', pageLeft, y);
  doc.fillColor(muted).text('PROJECT', projX, y);
  y += 14;

  const billStartY = y;
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(12)
     .text(client.name || '', pageLeft, y, { width: billW });
  let billY = doc.y + 2;
  if (client.billing_address) {
    doc.font('Helvetica').fontSize(10).fillColor(ink)
       .text(client.billing_address, pageLeft, billY, { width: billW });
    billY = doc.y;
  }
  if (Array.isArray(client.contact_emails) && client.contact_emails.length) {
    doc.font('Helvetica').fontSize(10).fillColor(muted)
       .text(client.contact_emails.join(', '), pageLeft, billY, { width: billW });
    billY = doc.y;
  }

  doc.fillColor(ink).font('Helvetica').fontSize(11)
     .text(project.name || '', projX, billStartY, { width: projW });
  const projY = doc.y;

  y = Math.max(billY, projY) + 18;

  // ── Line items ─────────────────────────────────────────────────────────
  const colDescX = pageLeft;
  const colQtyX = pageLeft + contentWidth * 0.62;
  const colRateX = pageLeft + contentWidth * 0.74;
  const colAmtX = pageLeft + contentWidth * 0.88;
  const colDescW = contentWidth * 0.62 - 4;
  const colQtyW = contentWidth * 0.12 - 4;
  const colRateW = contentWidth * 0.14 - 4;
  const colAmtW = contentWidth * 0.12;

  const sections = groupLines(lines);
  for (const section of sections) {
    y = ensureSpace(doc, y, 60);

    // Section title
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(11)
       .text(section.title, pageLeft, y);
    y = doc.y + 4;

    // Column headers
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(9);
    doc.text('DESCRIPTION', colDescX, y, { width: colDescW });
    doc.text('QTY',         colQtyX,  y, { width: colQtyW,  align: 'right' });
    doc.text('RATE',        colRateX, y, { width: colRateW, align: 'right' });
    doc.text('AMOUNT',      colAmtX,  y, { width: colAmtW,  align: 'right' });
    y += 14;
    doc.moveTo(pageLeft, y - 2).lineTo(pageRight, y - 2)
       .strokeColor(ruleColor).lineWidth(0.5).stroke();

    // Rows
    doc.fillColor(ink).font('Helvetica').fontSize(10);
    for (const line of section.lines) {
      y = ensureSpace(doc, y, 20);
      const startY = y;
      doc.text(line.description || '', colDescX, y, { width: colDescW });
      const descBottom = doc.y;
      doc.text(lineQty(line),  colQtyX,  startY, { width: colQtyW,  align: 'right' });
      doc.text(lineRate(line), colRateX, startY, { width: colRateW, align: 'right' });
      doc.text(formatMoney(line.amount_cents), colAmtX, startY, { width: colAmtW, align: 'right' });
      y = descBottom + 4;
    }
    y += 6;
  }

  // ── Totals ─────────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 80);
  const totalsX = pageLeft + contentWidth * 0.6;
  const totalsW = contentWidth - contentWidth * 0.6;
  const labelW = totalsW * 0.55;
  const amtW = totalsW * 0.45;

  doc.moveTo(totalsX, y).lineTo(pageRight, y)
     .strokeColor(ruleColor).lineWidth(0.5).stroke();
  y += 6;

  const drawTotalRow = (label, value, opts = {}) => {
    const font = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = opts.large ? 12 : 10;
    const color = opts.color || ink;
    doc.font(font).fontSize(size).fillColor(opts.muted ? muted : color);
    doc.text(label, totalsX, y, { width: labelW, align: 'left' });
    doc.text(value, totalsX + labelW, y, { width: amtW, align: 'right' });
    y += size + 6;
  };

  drawTotalRow('Subtotal', formatMoney(invoice.subtotal_cents), { muted: true });
  drawTotalRow('Total',    formatMoney(invoice.total_cents),    { bold: true, large: true });
  if (invoice.amount_paid_cents) {
    drawTotalRow('Paid', `−${formatMoney(invoice.amount_paid_cents)}`, { muted: true });
    const balance = (invoice.total_cents ?? 0) - (invoice.amount_paid_cents ?? 0);
    drawTotalRow('Balance due', formatMoney(balance), { bold: true, color: accent });
  }

  // ── Pay link ───────────────────────────────────────────────────────────
  if (invoice.stripe_payment_link_url) {
    y = ensureSpace(doc, y, 40) + 8;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(11)
       .text('Pay online: ', pageLeft, y, { continued: true })
       .fillColor(accent).font('Helvetica').fontSize(11)
       .text(invoice.stripe_payment_link_url, {
         link: invoice.stripe_payment_link_url,
         underline: true,
       });
    y = doc.y + 4;
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  if (invoice.notes) {
    y = ensureSpace(doc, y, 60) + 8;
    doc.fillColor(muted).font('Helvetica-Bold').fontSize(9)
       .text('NOTES', pageLeft, y);
    y = doc.y + 4;
    doc.fillColor(ink).font('Helvetica').fontSize(10)
       .text(invoice.notes, pageLeft, y, { width: contentWidth });
    y = doc.y + 4;
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const footerY = doc.page.height - doc.page.margins.bottom - 14;
  doc.fillColor(muted).font('Helvetica-Oblique').fontSize(9)
     .text('Thank you for your business.', pageLeft, footerY, {
       width: contentWidth,
       align: 'center',
     });
}

// If the next block won't fit on this page, start a new one and reset y.
function ensureSpace(doc, y, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (y + needed > bottom) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

export async function renderInvoicePdfFromData(db, data) {
  if (!data) return null;
  if (data.revoked) return { revoked: true };
  if (!pdfEnabled()) return { unavailable: true };

  const key = cacheKey(data);
  const cached = cacheGet(key);
  if (cached) return { buffer: cached };

  let logoBuffer = null;
  let logoMime = null;
  if (data.branding?.hasLogo && db) {
    const logo = branding.getLogo(db);
    if (logo && logo.bytes) {
      logoBuffer = logo.bytes;
      logoMime = logo.mime;
    }
  }

  try {
    const buffer = await buildPdf(data, logoBuffer, logoMime);
    cacheSet(key, buffer);
    return { buffer };
  } catch (err) {
    logger.error({ err, invoiceId: data.invoice?.id }, 'pdf render failed');
    return { unavailable: true };
  }
}

export async function renderInvoicePdf(db, token) {
  const data = invoices.getByPublicToken(db, token);
  if (!data) return null;
  return renderInvoicePdfFromData(db, data);
}

// No browser to tear down; kept as a no-op so the SIGTERM handler in
// server/index.js still has something to await.
export async function shutdownPdfRenderer() {
  cache.clear();
}

// Test hook: lets vitest reset the LRU between cases without re-importing.
export const _cache = cache;
