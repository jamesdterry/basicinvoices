import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SUPER = 'admin@example.com';
const EMAIL_LOG = path.resolve('data/e2e-emails.log');
const STORAGE = path.resolve('.auth/super_admin.json');

async function readLatestLink() {
  if (!fs.existsSync(EMAIL_LOG)) return null;
  const lines = fs.readFileSync(EMAIL_LOG, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj?.event === 'dev-email' && obj.to === SUPER && obj.link) return obj.link;
    } catch {}
  }
  return null;
}

async function waitForLink(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const link = await readLatestLink();
    if (link) return link;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No dev-email line for ${SUPER} found in ${EMAIL_LOG}`);
}

setup('authenticate as super-admin', async ({ page }) => {
  fs.mkdirSync(path.dirname(STORAGE), { recursive: true });

  const res = await page.request.post('/auth/magic-link', { data: { email: SUPER } });
  expect(res.status()).toBe(204);

  const link = await waitForLink();
  expect(link).toContain('/auth/redeem?token=');

  // Follow the redeem URL through the browser so the session cookie sticks
  // to the page context (storage-state captures cookies bound to baseURL).
  const url = new URL(link);
  await page.goto(`${url.pathname}${url.search}`);

  await page.waitForURL('**/');
  // page.request shares the session cookie set by /auth/redeem.
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);
  const body = await me.json();
  expect(body.role).toBe('super_admin');

  await page.context().storageState({ path: STORAGE });
});
