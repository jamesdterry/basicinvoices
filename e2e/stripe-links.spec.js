import { test, expect } from '@playwright/test';

// Disabled-path coverage only — `npm run start:e2e` does NOT export
// STRIPE_SECRET_KEY, so the service is in disabled mode. The "happy path"
// against a real Stripe sandbox stays a manual smoke step (DEVELOPMENT.md
// Stage 7A verification §2–4).

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const CLIENT = 'Stripe Disabled E2E Client';
const PROJECT = 'Stripe Disabled E2E Project';
const RATE = 8000;        // $80/hr
const HOURS = 3;          // → $240.00 total

test.describe.serial('stripe-links — disabled mode', () => {
  let projectId;
  let invoiceId;

  test.describe('super-admin: /api/me reports stripe_enabled:false', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('GET /api/me does not advertise stripe', async ({ request }) => {
      const r = await request.get('/api/me');
      expect(r.status()).toBe(200);
      const me = await r.json();
      expect(me.role).toBe('super_admin');
      expect(me.stripe_enabled).toBe(false);
    });
  });

  test.describe('super-admin: build a draft invoice', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('creates client + project + sub member', async ({ request }) => {
      const headers = await csrfHeaders(request);

      const subs = await (await request.get('/api/users?role=subcontractor')).json();
      const sub = subs.users.find((u) => u.email === 'sub@example.com');
      expect(sub).toBeTruthy();

      const cRes = await request.post('/api/clients', {
        headers,
        data: { name: CLIENT, payment_terms_days: 14, contact_emails: ['billing@stripe-disabled.test'] },
      });
      expect(cRes.status()).toBe(201);
      const { client } = await cRes.json();

      const pRes = await request.post('/api/projects', {
        headers,
        data: { client_id: client.id, name: PROJECT },
      });
      expect(pRes.status()).toBe(201);
      const { project } = await pRes.json();
      projectId = project.id;

      const mRes = await request.post(`/api/projects/${projectId}/members`, {
        headers,
        data: { user_id: sub.id, bill_rate_cents: RATE },
      });
      expect(mRes.status()).toBe(201);
    });
  });

  test.describe('sub logs hours', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('sub posts a 3-hour time entry', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const tRes = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectId,
          entry_date: todayIso(),
          hours: HOURS,
          description: 'Stripe disabled E2E',
        },
      });
      expect(tRes.status()).toBe(201);
    });
  });

  test.describe('super-admin: drafts and exercises Stripe-link routes', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('drafts an invoice', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      const dRes = await request.post('/api/invoices', {
        headers,
        data: {
          project_id: projectId,
          through_date: today,
          issue_date: today,
          due_date: plusDays(today, 14),
        },
      });
      expect(dRes.status()).toBe(201);
      const { invoice } = await dRes.json();
      invoiceId = invoice.id;
      expect(invoice.stripe_payment_link_url).toBeNull();
      expect(invoice.stripe_payment_link_id).toBeNull();
    });

    test('POST /api/invoices/:id/stripe-link/generate returns 503 stripe_disabled', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/invoices/${invoiceId}/stripe-link/generate`, {
        headers,
        data: {},
      });
      expect(r.status()).toBe(503);
      const body = await r.json();
      expect(body.error).toBe('stripe_disabled');
    });

    test('manual paste via PUT /api/invoices/:id/stripe-link still works', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.put(`/api/invoices/${invoiceId}/stripe-link`, {
        headers,
        data: { url: 'https://buy.stripe.com/manual_paste_xxx' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/manual_paste_xxx');
      expect(body.invoice.stripe_payment_link_id).toBeNull();
    });

    test('Generate button is absent from the rendered DOM', async ({ page }) => {
      await page.goto(`/index.html#/invoices/${invoiceId}`);
      // Wait for the detail card to settle.
      await page.waitForSelector('h1');
      const generateBtn = page.getByRole('button', { name: /Generate Stripe link|Regenerate Stripe link/ });
      await expect(generateBtn).toHaveCount(0);
      // The manual edit button should still be present.
      await expect(page.getByRole('button', { name: /Edit Stripe link/ })).toBeVisible();
    });
  });
});
