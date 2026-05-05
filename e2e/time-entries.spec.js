import { test, expect } from '@playwright/test';

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

const TIME_CLIENT = 'Time E2E Client';
const TIME_PROJECT = 'Time E2E Project';

test.describe.serial('time entries', () => {
  let projectId;
  let subId;
  let adminId;

  test.describe('super-admin setup', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('creates project + adds the sub at $100/hr', async ({ request }) => {
      const headers = await csrfHeaders(request);

      const me = await (await request.get('/api/me')).json();
      expect(me.role).toBe('super_admin');
      adminId = me.id;

      const usersRes = await request.get('/api/users?role=subcontractor');
      const { users } = await usersRes.json();
      const sub = users.find((u) => u.email === 'sub@example.com');
      expect(sub).toBeTruthy();
      subId = sub.id;

      const cRes = await request.post('/api/clients', {
        headers,
        data: { name: TIME_CLIENT },
      });
      expect(cRes.status()).toBe(201);
      const { client } = await cRes.json();

      const pRes = await request.post('/api/projects', {
        headers,
        data: { client_id: client.id, name: TIME_PROJECT },
      });
      expect(pRes.status()).toBe(201);
      const { project } = await pRes.json();
      projectId = project.id;

      const mRes = await request.post(`/api/projects/${project.id}/members`, {
        headers,
        data: { user_id: sub.id, bill_rate_cents: 10000 },
      });
      expect(mRes.status()).toBe(201);
    });
  });

  test.describe('subcontractor', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('logs 4 entries across two days and sees them via API + UI', async ({ request, page }) => {
      const headers = await csrfHeaders(request);

      const entries = [
        { entry_date: '2026-05-04', hours: 2.5, description: 'Spec writing' },
        { entry_date: '2026-05-04', hours: 1.0, description: 'Code review' },
        { entry_date: '2026-05-05', hours: 3.0, description: 'Implementation' },
        { entry_date: '2026-05-05', hours: 0.5, description: 'Standup' },
      ];

      for (const e of entries) {
        const res = await request.post('/api/time-entries', {
          headers,
          data: { project_id: projectId, ...e },
        });
        expect(res.status()).toBe(201);
        const body = await res.json();
        expect(body.entry.user_id).toBe(subId);
      }

      // API: sub sees only their own entries.
      const list = await (
        await request.get(
          `/api/time-entries?project_id=${projectId}&from=2026-05-04&to=2026-05-05`
        )
      ).json();
      expect(list.entries).toHaveLength(4);
      expect(list.entries.every((e) => e.user_id === subId)).toBe(true);

      // UI: navigate to #/time-entries.
      await page.goto('/#/time-entries');
      await expect(page.locator('h1')).toHaveText('My hours');
      const bodyText = await page.locator('main').innerText();
      expect(bodyText).toContain('Spec writing');
      expect(bodyText).toContain('Implementation');
      // Subs see no rate field anywhere on the page.
      expect(bodyText).not.toMatch(/\$\d+\.\d{2}\/hr/);
    });

    test('cannot post on a project they are not a member of', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const res = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: 999999,
          entry_date: '2026-05-04',
          hours: 1,
          description: 'Should fail',
        },
      });
      expect(res.status()).toBe(404);
    });
  });

  test.describe('super-admin views + self-bills', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test("sees the sub's entries via filters, then self-bills", async ({ request }) => {
      const headers = await csrfHeaders(request);

      const res = await request.get(
        `/api/time-entries?project_id=${projectId}&user_id=${subId}`
      );
      const body = await res.json();
      expect(body.entries.length).toBe(4);
      expect(body.entries[0].user_display_name).toBe('Sub Person');
      expect(body.entries[0].project_name).toBe(TIME_PROJECT);

      // Picker fix: super-admin can be added to the project as a member.
      const addRes = await request.post(`/api/projects/${projectId}/members`, {
        headers,
        data: { user_id: adminId, bill_rate_cents: 20000 },
      });
      expect(addRes.status()).toBe(201);
      const { member } = await addRes.json();
      expect(member.user_id).toBe(adminId);
      expect(member.bill_rate_cents).toBe(20000);

      // Super-admin posts a time entry for themselves.
      const teRes = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectId,
          entry_date: '2026-05-06',
          hours: 1.5,
          description: 'Architecture review',
        },
      });
      expect(teRes.status()).toBe(201);
      const { entry } = await teRes.json();
      expect(entry.user_id).toBe(adminId);

      // Super-admin posts on behalf of the sub via act_as_user_id.
      const onBehalfRes = await request.post('/api/time-entries', {
        headers,
        data: {
          project_id: projectId,
          entry_date: '2026-05-07',
          hours: 2,
          description: 'Recorded for sub',
          act_as_user_id: subId,
        },
      });
      expect(onBehalfRes.status()).toBe(201);
      const onBehalf = await onBehalfRes.json();
      expect(onBehalf.entry.user_id).toBe(subId);
    });

    // Lock-on-invoice (PATCH/DELETE → 409 once invoice_id is set) is fully
    // covered by vitest. Re-exercising it here would require a live invoice
    // flow that doesn't land until Stage 5.
  });
});
