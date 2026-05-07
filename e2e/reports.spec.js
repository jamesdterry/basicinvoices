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

function firstOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function lastOfMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

const CLIENT_A = 'Reports E2E Alpha';
const CLIENT_B = 'reports e2e bravo';
const PROJECT_A = 'Alpha Site';
const PROJECT_B = 'Bravo App';
const RATE = 10000;        // $100/hr
const HOURS_A = 3;         // → $300.00 paid in full
const HOURS_B = 2;         // → $200.00 paid in full

test.describe.serial('reports', () => {
  let projectA;
  let projectB;
  let invoiceA;
  let invoiceB;
  let from;
  let to;

  test.describe('seed: two clients, two projects, two paid invoices', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('builds the data the report aggregates over', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      from = firstOfMonth(today);
      to = lastOfMonth(today);

      const subs = await (await request.get('/api/users?role=subcontractor')).json();
      const sub = subs.users.find((u) => u.email === 'sub@example.com');
      expect(sub).toBeTruthy();

      async function buildSentInvoice(clientName, projectName, hours) {
        const cRes = await request.post('/api/clients', {
          headers,
          data: {
            name: clientName,
            payment_terms_days: 14,
            contact_emails: [`billing+${projectName.replace(/\s+/g, '-').toLowerCase()}@reports-e2e.test`],
          },
        });
        expect(cRes.status()).toBe(201);
        const { client } = await cRes.json();

        const pRes = await request.post('/api/projects', {
          headers,
          data: { client_id: client.id, name: projectName },
        });
        expect(pRes.status()).toBe(201);
        const { project } = await pRes.json();

        const mRes = await request.post(`/api/projects/${project.id}/members`, {
          headers,
          data: { user_id: sub.id, bill_rate_cents: RATE },
        });
        expect(mRes.status()).toBe(201);
        return { client, project };
      }

      const a = await buildSentInvoice(CLIENT_A, PROJECT_A, HOURS_A);
      const b = await buildSentInvoice(CLIENT_B, PROJECT_B, HOURS_B);
      projectA = a.project;
      projectB = b.project;
    });
  });

  test.describe('sub logs hours on both projects', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('sub posts time on each project', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      const t1 = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectA.id,
          entry_date: today,
          hours: HOURS_A,
          description: 'Alpha work',
        },
      });
      expect(t1.status()).toBe(201);
      const t2 = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectB.id,
          entry_date: today,
          hours: HOURS_B,
          description: 'Bravo work',
        },
      });
      expect(t2.status()).toBe(201);
    });
  });

  test.describe('super-admin drafts, sends, and pays both invoices', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('drafts + sends invoice A', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      const dRes = await request.post('/api/invoices', {
        headers,
        data: {
          project_id: projectA.id,
          through_date: today,
          issue_date: today,
          due_date: plusDays(today, 14),
        },
      });
      expect(dRes.status()).toBe(201);
      invoiceA = (await dRes.json()).invoice;
      const sRes = await request.post(`/api/invoices/${invoiceA.id}/send`, { headers });
      expect(sRes.status()).toBe(200);
    });

    test('drafts + sends invoice B', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      const dRes = await request.post('/api/invoices', {
        headers,
        data: {
          project_id: projectB.id,
          through_date: today,
          issue_date: today,
          due_date: plusDays(today, 14),
        },
      });
      expect(dRes.status()).toBe(201);
      invoiceB = (await dRes.json()).invoice;
      const sRes = await request.post(`/api/invoices/${invoiceB.id}/send`, { headers });
      expect(sRes.status()).toBe(200);
    });

    test('records full payment on each invoice', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const today = todayIso();
      const pA = await request.post(`/api/invoices/${invoiceA.id}/payments`, {
        headers,
        data: { received_date: today, amount_cents: HOURS_A * RATE, method: 'check' },
      });
      expect(pA.status()).toBe(201);
      expect((await pA.json()).invoice.status).toBe('paid');

      const pB = await request.post(`/api/invoices/${invoiceB.id}/payments`, {
        headers,
        data: { received_date: today, amount_cents: HOURS_B * RATE, method: 'wire' },
      });
      expect(pB.status()).toBe(201);
      expect((await pB.json()).invoice.status).toBe('paid');
    });
  });

  test.describe('super-admin pulls the report', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('JSON groupBy=client returns one row per seeded client with correct totals', async ({ request }) => {
      const r = await request.get(`/api/reports/payments?from=${from}&to=${to}&groupBy=client`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.from).toBe(from);
      expect(body.to).toBe(to);
      expect(body.groupBy).toBe('client');
      const labels = body.rows.map((row) => row.label);
      expect(labels).toContain(CLIENT_A);
      expect(labels).toContain(CLIENT_B);
      const a = body.rows.find((row) => row.label === CLIENT_A);
      const b = body.rows.find((row) => row.label === CLIENT_B);
      expect(a.totalCents).toBeGreaterThanOrEqual(HOURS_A * RATE);   // ≥ in case other suites seeded payments in-window
      expect(a.count).toBeGreaterThanOrEqual(1);
      expect(b.totalCents).toBeGreaterThanOrEqual(HOURS_B * RATE);
    });

    test('JSON groupBy=project labels rows as "Client — Project"', async ({ request }) => {
      const r = await request.get(`/api/reports/payments?from=${from}&to=${to}&groupBy=project`);
      expect(r.status()).toBe(200);
      const body = await r.json();
      const labels = body.rows.map((row) => row.label);
      expect(labels).toContain(`${CLIENT_A} — ${PROJECT_A}`);
      expect(labels).toContain(`${CLIENT_B} — ${PROJECT_B}`);
    });

    test('CSV download has the right headers and content', async ({ request }) => {
      const r = await request.get(
        `/api/reports/payments?from=${from}&to=${to}&groupBy=client&format=csv`
      );
      expect(r.status()).toBe(200);
      expect(r.headers()['content-type']).toContain('text/csv');
      expect(r.headers()['content-disposition']).toContain(
        `attachment; filename="payments-client-${from}-${to}.csv"`
      );
      const body = await r.text();
      expect(body.startsWith('key,label,total_cents,total_dollars,payment_count\r\n')).toBe(true);
      expect(body).toContain(CLIENT_A);
      expect(body).toContain(CLIENT_B);
      // Each line is CRLF-terminated except the last.
      expect(body.split('\r\n').length).toBeGreaterThanOrEqual(3);   // header + ≥ 2 data lines
    });

    test('rejects invalid_range with 400', async ({ request }) => {
      const r = await request.get(
        `/api/reports/payments?from=${to}&to=${from}&groupBy=client`
      );
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toBe('invalid_range');
    });
  });

  test.describe('sub cannot read the report', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('GET /api/reports/payments returns 403 for sub', async ({ request }) => {
      const r = await request.get(
        `/api/reports/payments?from=${from}&to=${to}&groupBy=client`
      );
      expect(r.status()).toBe(403);
    });

    test('CSV download is also 403 for sub', async ({ request }) => {
      const r = await request.get(
        `/api/reports/payments?from=${from}&to=${to}&groupBy=client&format=csv`
      );
      expect(r.status()).toBe(403);
    });
  });
});
