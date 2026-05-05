import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SUPER = 'admin@example.com';
const SUB = 'sub@example.com';
const EMAIL_LOG = path.resolve('data/e2e-emails.log');
const SUPER_STORAGE = path.resolve('.auth/super_admin.json');
const SUB_STORAGE = path.resolve('.auth/subcontractor.json');

async function readLatestLink(toEmail) {
  if (!fs.existsSync(EMAIL_LOG)) return null;
  const lines = fs.readFileSync(EMAIL_LOG, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj?.event === 'dev-email' && obj.to === toEmail && obj.link) return obj.link;
    } catch {}
  }
  return null;
}

async function waitForLink(toEmail, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = await readLatestLink(toEmail);
    if (link) return link;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No dev-email line for ${toEmail} found in ${EMAIL_LOG}`);
}

async function captureStorage({ page, email, storagePath, expectedRole }) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });

  const res = await page.request.post('/auth/magic-link', { data: { email } });
  expect(res.status()).toBe(204);

  const link = await waitForLink(email);
  expect(link).toContain('/auth/redeem?token=');

  const url = new URL(link);
  await page.goto(`${url.pathname}${url.search}`);
  await page.waitForURL('**/');

  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.role).toBe(expectedRole);

  await page.context().storageState({ path: storagePath });
}

setup('authenticate as super-admin', async ({ page }) => {
  await captureStorage({
    page,
    email: SUPER,
    storagePath: SUPER_STORAGE,
    expectedRole: 'super_admin',
  });
});

setup('authenticate as subcontractor', async ({ page }) => {
  await captureStorage({
    page,
    email: SUB,
    storagePath: SUB_STORAGE,
    expectedRole: 'subcontractor',
  });
});
