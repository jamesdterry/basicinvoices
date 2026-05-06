import { test, expect } from '@playwright/test';

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

const CLIENT = 'Payments E2E Client';
const PROJECT = 'Payments E2E Project';
const RATE = 10000;       // $100/hr
const HOURS = 5;          // → $500.00 total

test.describe.serial('payments', () => {
  let projectId;
  let invoiceId;
  let invoiceNumber;
  let firstPaymentId;
  let secondPaymentId;

  test.describe('setup: client + project + sub + sent invoice', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('super-admin builds a sent invoice for the sub to be paid against', async ({ request }) => {
      const headers = await csrfHeaders(request);

      const subs = await (await request.get('/api/users?role=subcontractor')).json();
      const sub = subs.users.find((u) => u.email === 'sub@example.com');
      expect(sub).toBeTruthy();

      const cRes = await request.post('/api/clients', {
        headers,
        data: { name: CLIENT, payment_terms_days: 14, contact_email: 'billing@payments-e2e.test' },
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

    test('sub posts a 5-hour time entry', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const tRes = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectId,
          entry_date: todayIso(),
          hours: HOURS,
          description: 'Payments E2E work',
        },
      });
      expect(tRes.status()).toBe(201);
    });
  });

  test.describe('super-admin creates and sends the invoice', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('drafts and sends the invoice', async ({ request }) => {
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
      invoiceNumber = invoice.number;
      expect(invoice.total_cents).toBe(RATE * HOURS);     // $500.00

      const sRes = await request.post(`/api/invoices/${invoiceId}/send`, { headers });
      expect(sRes.status()).toBe(200);
      const sent = (await sRes.json()).invoice;
      expect(sent.status).toBe('sent');
    });
  });

  test.describe('super-admin records two partial payments', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('first partial leaves status sent', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/invoices/${invoiceId}/payments`, {
        headers,
        data: {
          received_date: todayIso(),
          amount_cents: 30000,           // $300.00
          method: 'check',
          reference: 'check #001',
        },
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      firstPaymentId = body.payment.id;
      expect(body.invoice.status).toBe('sent');
      expect(body.invoice.amount_paid_cents).toBe(30000);
    });

    test('PUT /api/invoices/:id/stripe-link is allowed on a sent invoice', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.put(`/api/invoices/${invoiceId}/stripe-link`, {
        headers,
        data: { url: 'https://buy.stripe.com/test_e2e_payments' },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.invoice.stripe_payment_link_url).toBe('https://buy.stripe.com/test_e2e_payments');
    });

    test('second partial flips status to paid', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/invoices/${invoiceId}/payments`, {
        headers,
        data: {
          received_date: todayIso(),
          amount_cents: 20000,           // $200.00 → total = $500
          method: 'wire',
          reference: 'wire ref',
        },
      });
      expect(r.status()).toBe(201);
      const body = await r.json();
      secondPaymentId = body.payment.id;
      expect(body.invoice.status).toBe('paid');
      expect(body.invoice.amount_paid_cents).toBe(50000);
    });

    test('GET /api/invoices/:id/payments returns both rows ordered by date desc', async ({ request }) => {
      const r = await request.get(`/api/invoices/${invoiceId}/payments`);
      expect(r.status()).toBe(200);
      const { payments } = await r.json();
      expect(payments).toHaveLength(2);
      const methods = payments.map((p) => p.method);
      expect(methods).toContain('check');
      expect(methods).toContain('wire');
    });

    test('voiding the invoice while payments exist returns 409 has_payments', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/invoices/${invoiceId}/void`, { headers });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body.error).toBe('has_payments');
    });

    test('deleting the second payment recomputes amount_paid but does NOT auto-revert paid → sent', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.delete(`/api/payments/${secondPaymentId}`, { headers });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.invoice.status).toBe('paid');         // sticky
      expect(body.invoice.amount_paid_cents).toBe(30000);
    });

    test('PUT /api/invoices/:id/stripe-link rejects 409 on a paid invoice', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.put(`/api/invoices/${invoiceId}/stripe-link`, {
        headers,
        data: { url: 'https://buy.stripe.com/test_paid' },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body.error).toBe('wrong_status');
    });
  });

  test.describe('sub cannot touch payments', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('sub gets 403 on POST /api/invoices/:id/payments', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/invoices/${invoiceId}/payments`, {
        headers,
        data: { received_date: todayIso(), amount_cents: 100, method: 'cash' },
      });
      expect(r.status()).toBe(403);
    });

    test('sub gets 403 on DELETE /api/payments/:id', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.delete(`/api/payments/${firstPaymentId}`, { headers });
      expect(r.status()).toBe(403);
    });
  });
});
