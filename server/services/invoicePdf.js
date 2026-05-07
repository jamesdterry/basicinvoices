// Invoice PDF rendering. One Puppeteer browser per process, lazy-launched
// on first request, closed on SIGTERM. The same renderInvoiceHtml() that
// drives the public /i/<token> view is piped through Chromium to keep web
// view and PDF visually identical (Stage 6 spec — single source of truth).
//
// Skipped under NODE_ENV=test unless BI_PDF_ENABLED=1 (the e2e suite sets
// the override so /i/<token>.pdf returns a real PDF; vitest does not).

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { renderInvoiceHtml } from '../views/invoice.html.js';
import * as invoices from './invoices.js';

const CACHE_MAX = 32;
const cache = new Map();

let browserPromise = null;

const INVOICE_CSS = (() => {
  try {
    return fs.readFileSync(path.resolve('public/invoice.css'), 'utf8');
  } catch (err) {
    logger.warn({ err }, 'invoice.css not found; PDFs will be unstyled');
    return '';
  }
})();

function pdfEnabled() {
  if (process.env.BI_PDF_ENABLED === '1') return true;
  return !config.isTest;
}

// Resolution order for the Chromium binary:
//   1. PUPPETEER_EXECUTABLE_PATH — explicit override (CI knobs, custom paths).
//   2. Common system Chrome on darwin — keeps `npm run e2e` working out of
//      the box on a developer Mac without extra setup. @sparticuz/chromium
//      ships a Linux-only binary, so on macOS its executablePath() resolves
//      to a non-existent path and puppeteer.launch throws ENOENT.
//   3. @sparticuz/chromium — the production path on Linux/Docker. The
//      Dockerfile installs the Debian libs that this binary depends on.
async function resolveExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return {
      path: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return { path: p, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
      }
    }
  }
  const chromiumMod = await import('@sparticuz/chromium');
  const chromium = chromiumMod.default ?? chromiumMod;
  return { path: await chromium.executablePath(), args: chromium.args };
}

async function launchBrowser() {
  const puppeteer = (await import('puppeteer-core')).default;
  const { path: executablePath, args } = await resolveExecutable();
  return puppeteer.launch({ executablePath, args, headless: true });
}

async function getBrowser() {
  if (!pdfEnabled()) return null;
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function shutdownPdfRenderer() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    if (browser) await browser.close();
  } catch (err) {
    logger.warn({ err }, 'pdf renderer shutdown error');
  } finally {
    browserPromise = null;
    cache.clear();
  }
}

function inlineCss(html) {
  if (!INVOICE_CSS) return html;
  return html.replace(
    /<link\s+rel="stylesheet"\s+href="\/invoice\.css"\s*\/?>/,
    `<style>${INVOICE_CSS}</style>`
  );
}

function cacheKey(data) {
  const brandStamp = data?.branding?.updatedAt || '';
  return `${data.invoice.id}:${data.invoice.updated_at}:${brandStamp}`;
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const buf = cache.get(key);
  // Refresh recency: re-insert to move to the end.
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

async function renderBuffer(data) {
  const browser = await getBrowser();
  if (!browser) {
    return { unavailable: true };
  }
  const html = inlineCss(renderInvoiceHtml(data));
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    // puppeteer-core 23+ returns a Uint8Array; coerce to Buffer so Express's
    // res.send() takes the binary path (otherwise it JSON-stringifies).
    const raw = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
    });
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return { buffer };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function renderInvoicePdfFromData(data) {
  if (!data) return null;
  if (data.revoked) return { revoked: true };
  const key = cacheKey(data);
  const cached = cacheGet(key);
  if (cached) return { buffer: cached };
  const result = await renderBuffer(data);
  if (result.buffer) cacheSet(key, result.buffer);
  return result;
}

export async function renderInvoicePdf(db, token) {
  const data = invoices.getByPublicToken(db, token);
  if (!data) return null;
  return renderInvoicePdfFromData(data);
}

// Test hook: lets vitest reset the LRU between cases without re-importing.
export const _cache = cache;
