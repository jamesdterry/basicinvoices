import { test, expect } from '@playwright/test';

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

const CLIENT = 'Recurring E2E Client';
const PROJECT = 'Recurring E2E Project';
const RETAINER_CENTS = 50000; // $500.00

test.describe.serial('recurring billing', () => {
  let projectId;

  test.describe('setup: client + project', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('super-admin creates client + project', async ({ request }) => {
      const headers = await csrfHeaders(request);

      const cRes = await request.post('/api/clients', {
        headers,
        data: {
          name: CLIENT,
          payment_terms_days: 14,
          contact_email: 'billing@recurring-e2e.test',
        },
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
    });
  });

  test.describe('configure + run', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('GET on a project without a schedule returns 404', async ({ request }) => {
      const r = await request.get(`/api/projects/${projectId}/recurring`);
      expect(r.status()).toBe(404);
    });

    test('PUT creates a fixed_milestone schedule', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.put(`/api/projects/${projectId}/recurring`, {
        headers,
        data: {
          mode: 'fixed_milestone',
          day_of_month: 1,
          fixed_amount_cents: RETAINER_CENTS,
          fixed_description: 'Monthly retainer',
          auto_stripe_link: false,
        },
      });
      expect(r.status()).toBe(200);
      const { schedule } = await r.json();
      expect(schedule.mode).toBe('fixed_milestone');
      expect(schedule.fixed_amount_cents).toBe(RETAINER_CENTS);
      expect(schedule.paused).toBe(false);
    });

    test('GET now returns the schedule', async ({ request }) => {
      const r = await request.get(`/api/projects/${projectId}/recurring`);
      expect(r.status()).toBe(200);
      const { schedule } = await r.json();
      expect(schedule.fixed_description).toBe('Monthly retainer');
    });

    test('POST /run-now creates a draft with the retainer line', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(`/api/projects/${projectId}/recurring/run-now`, {
        headers,
        data: {},
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.result.status).toBe('success');
      expect(body.result.invoice_id).toBeGreaterThan(0);
      expect(body.schedule.last_invoice_id).toBe(body.result.invoice_id);

      // Confirm the draft has one milestone line for $500.
      const inv = await request.get(`/api/invoices/${body.result.invoice_id}`);
      expect(inv.status()).toBe(200);
      const invBody = await inv.json();
      expect(invBody.invoice.status).toBe('draft');
      expect(invBody.invoice.total_cents).toBe(RETAINER_CENTS);
      expect(invBody.lines).toHaveLength(1);
      expect(invBody.lines[0].kind).toBe('milestone');
      expect(invBody.lines[0].amount_cents).toBe(RETAINER_CENTS);
    });

    test('pause + resume flips the paused flag', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const p = await request.post(`/api/projects/${projectId}/recurring/pause`, { headers });
      expect(p.status()).toBe(200);
      expect((await p.json()).schedule.paused).toBe(true);

      const r = await request.post(`/api/projects/${projectId}/recurring/resume`, { headers });
      expect(r.status()).toBe(200);
      expect((await r.json()).schedule.paused).toBe(false);
    });

    test('GET /api/admin/recurring lists the schedule', async ({ request }) => {
      const r = await request.get('/api/admin/recurring');
      expect(r.status()).toBe(200);
      const { schedules } = await r.json();
      const ours = schedules.find((s) => s.project_id === projectId);
      expect(ours).toBeTruthy();
    });

    test('admin run-now batch returns an array', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post('/api/admin/recurring/run-now', {
        headers,
        data: {},
      });
      expect(r.status()).toBe(200);
      expect(Array.isArray((await r.json()).results)).toBe(true);
    });
  });

  test.describe('auto-send (Stage 8.6)', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    let autoSendProjectId;

    test('configure a second project with auto_send enabled', async ({ request }) => {
      const headers = await csrfHeaders(request);

      // New client + project so we don't disturb the auto_send=false fixture above.
      const cRes = await request.post('/api/clients', {
        headers,
        data: {
          name: 'Auto-Send E2E Client',
          payment_terms_days: 14,
          contact_email: 'billing@auto-send-e2e.test',
        },
      });
      expect(cRes.status()).toBe(201);
      const { client } = await cRes.json();

      const pRes = await request.post('/api/projects', {
        headers,
        data: { client_id: client.id, name: 'Auto-Send E2E Project' },
      });
      expect(pRes.status()).toBe(201);
      autoSendProjectId = (await pRes.json()).project.id;

      const rRes = await request.put(
        `/api/projects/${autoSendProjectId}/recurring`,
        {
          headers,
          data: {
            mode: 'fixed_milestone',
            day_of_month: 1,
            fixed_amount_cents: 25000,
            fixed_description: 'Monthly retainer (auto-send)',
            auto_send: true,
            auto_stripe_link: false,
          },
        }
      );
      expect(rRes.status()).toBe(200);
      const { schedule } = await rRes.json();
      expect(schedule.auto_send).toBe(true);
    });

    test('run-now drafts AND sends — invoice ends up in sent status', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post(
        `/api/projects/${autoSendProjectId}/recurring/run-now`,
        { headers, data: {} }
      );
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.result.status).toBe('success');
      expect(body.result.send).toBe('success');
      expect(body.result.invoice_id).toBeGreaterThan(0);

      // Confirm the invoice flipped to 'sent' (not still 'draft').
      const inv = await request.get(`/api/invoices/${body.result.invoice_id}`);
      expect(inv.status()).toBe(200);
      const invBody = await inv.json();
      expect(invBody.invoice.status).toBe('sent');
      expect(invBody.invoice.sent_at).toBeTruthy();
    });
  });

  test.describe('sub cannot touch recurring', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('sub gets 403 on PUT /api/projects/:id/recurring', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.put(`/api/projects/${projectId}/recurring`, {
        headers,
        data: { mode: 'time_and_expenses', day_of_month: 1 },
      });
      expect(r.status()).toBe(403);
    });

    test('sub gets 403 on /api/admin/recurring', async ({ request }) => {
      const r = await request.get('/api/admin/recurring');
      expect(r.status()).toBe(403);
    });

    test('sub gets 403 on /api/admin/recurring/run-now', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post('/api/admin/recurring/run-now', {
        headers,
        data: {},
      });
      expect(r.status()).toBe(403);
    });
  });
});
