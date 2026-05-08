import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL_LOG = path.resolve('data/e2e-emails.log');

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

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
  throw new Error(`No dev-email link for ${toEmail} in ${EMAIL_LOG}`);
}

test.describe('subcontractors admin (super-admin)', () => {
  test.use({ storageState: '.auth/super_admin.json' });

  test('invite, redeem, then disable cuts off access', async ({ request, page, browser }) => {
    const headers = await csrfHeaders(request);
    const newEmail = `invite-${Date.now()}@e2e.test`;

    // 1. Create the sub via the API.
    const createRes = await request.post('/api/subcontractors', {
      headers,
      data: { email: newEmail, display_name: 'Invite Person' },
    });
    expect(createRes.status()).toBe(201);
    const { user } = await createRes.json();
    expect(user.role).toBe('subcontractor');
    expect(user.disabled_at).toBeNull();

    // 2. UI lists the new sub on #/subcontractors.
    await page.goto('/#/subcontractors');
    await expect(page.locator('h1')).toHaveText('Subcontractors');
    await expect(page.locator('table')).toContainText(newEmail);

    // 3. Pull the magic link the server emitted, redeem in a fresh context.
    const link = await waitForLink(newEmail);
    expect(link).toContain('/auth/redeem?token=');
    const url = new URL(link);

    const subContext = await browser.newContext();
    const subPage = await subContext.newPage();
    await subPage.goto(`${url.pathname}${url.search}`);
    await subPage.waitForURL('**/');

    const meRes = await subPage.request.get('/api/me');
    expect(meRes.status()).toBe(200);
    const me = await meRes.json();
    expect(me.email).toBe(newEmail);
    expect(me.role).toBe('subcontractor');

    // 4. As super-admin, disable the sub.
    const disRes = await request.post(`/api/subcontractors/${user.id}/disable`, {
      headers,
      data: {},
    });
    expect(disRes.status()).toBe(200);
    const { user: disabled } = await disRes.json();
    expect(disabled.disabled_at).toBeTruthy();

    // 5. The disabled sub's prior session is gone — /api/me returns 401.
    const meAfter = await subPage.request.get('/api/me');
    expect(meAfter.status()).toBe(401);

    // 6. A fresh magic-link request also rejects disabled users (no link issued).
    const before = await readLatestLink(newEmail);
    const mlRes = await subPage.request.post('/auth/magic-link', {
      data: { email: newEmail },
    });
    expect(mlRes.status()).toBe(204);
    // Wait long enough that any new link would have landed.
    await new Promise((r) => setTimeout(r, 300));
    const after = await readLatestLink(newEmail);
    expect(after).toBe(before);

    await subContext.close();
  });

  test('duplicate email returns 409', async ({ request }) => {
    const headers = await csrfHeaders(request);
    const email = `dup-${Date.now()}@e2e.test`;
    const first = await request.post('/api/subcontractors', {
      headers,
      data: { email, display_name: 'First' },
    });
    expect(first.status()).toBe(201);

    const second = await request.post('/api/subcontractors', {
      headers,
      data: { email: email.toUpperCase(), display_name: 'Second' },
    });
    expect(second.status()).toBe(409);
    expect((await second.json()).error).toBe('email_taken');
  });
});

test.describe('subcontractors admin (subcontractor)', () => {
  test.use({ storageState: '.auth/subcontractor.json' });

  test('subs cannot list or create subcontractors', async ({ request }) => {
    const headers = await csrfHeaders(request);
    const list = await request.get('/api/subcontractors');
    expect(list.status()).toBe(403);

    const create = await request.post('/api/subcontractors', {
      headers,
      data: { email: 'nope@e2e.test', display_name: 'Nope' },
    });
    expect(create.status()).toBe(403);
  });
});
