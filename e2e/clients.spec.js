import { test, expect } from '@playwright/test';

// Helper that mints a fresh CSRF cookie + header for an APIRequestContext
// (Playwright's `request` fixture). The CSRF middleware sets `bi_csrf` on any
// response; we read it back and echo it as the X-CSRF-Token header.
async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

test.describe('super-admin', () => {
  test.use({ storageState: '.auth/super_admin.json' });

  test('full create-and-add flow', async ({ request }) => {
    const headers = await csrfHeaders(request);

    // Look up sub user (seeded by scripts/seed-e2e.js).
    const usersRes = await request.get('/api/users?role=subcontractor');
    expect(usersRes.status()).toBe(200);
    const { users } = await usersRes.json();
    const sub = users.find((u) => u.email === 'sub@example.com');
    expect(sub).toBeTruthy();

    // Create a client.
    const cRes = await request.post('/api/clients', {
      headers,
      data: { name: 'E2E Client', contact_email: 'billing@e2e.test' },
    });
    expect(cRes.status()).toBe(201);
    const { client } = await cRes.json();
    expect(client.name).toBe('E2E Client');

    // Create a project.
    const pRes = await request.post('/api/projects', {
      headers,
      data: { client_id: client.id, name: 'Website' },
    });
    expect(pRes.status()).toBe(201);
    const { project } = await pRes.json();

    // Add the sub at $125/hr.
    const mRes = await request.post(`/api/projects/${project.id}/members`, {
      headers,
      data: { user_id: sub.id, bill_rate_cents: 12500 },
    });
    expect(mRes.status()).toBe(201);
    const { member } = await mRes.json();
    expect(member.bill_rate_cents).toBe(12500);

    // Members JSON for super-admin includes the rate.
    const sList = await request.get(`/api/projects/${project.id}/members`);
    const sBody = await sList.json();
    expect(sBody.members[0]).toHaveProperty('bill_rate_cents', 12500);
  });

  test('UI shows new client in the table', async ({ page, request }) => {
    const headers = await csrfHeaders(request);
    const cRes = await request.post('/api/clients', {
      headers,
      data: { name: 'UI Client' },
    });
    expect(cRes.status()).toBe(201);

    await page.goto('/#/clients');
    await expect(page.locator('h1')).toHaveText('Clients');
    await expect(page.locator('table')).toContainText('UI Client');
  });
});

test.describe('subcontractor', () => {
  test.use({ storageState: '.auth/subcontractor.json' });

  test('only sees projects they are a member of, with rates stripped', async ({ request, page }) => {
    // Sub should see at most one project (the one super-admin added them to in
    // the test above) and never any rate fields.
    const projRes = await request.get('/api/projects');
    expect(projRes.status()).toBe(200);
    const { projects } = await projRes.json();
    expect(projects.length).toBeGreaterThanOrEqual(1);
    const project = projects[0];

    const memRes = await request.get(`/api/projects/${project.id}/members`);
    expect(memRes.status()).toBe(200);
    const { members } = await memRes.json();
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) {
      expect(m).not.toHaveProperty('bill_rate_cents');
      expect(m).not.toHaveProperty('bill_rate_unit');
    }

    // Sub should NOT be able to list clients.
    const cRes = await request.get('/api/clients');
    expect(cRes.status()).toBe(403);

    // UI: project detail page shows no Rate column.
    await page.goto(`/#/projects/${project.id}`);
    await expect(page.locator('h1')).toContainText(project.name);
    const headerText = await page.locator('table thead').first().innerText();
    expect(headerText.toLowerCase()).not.toContain('rate');
    const bodyText = await page.locator('main').innerText();
    expect(bodyText).not.toMatch(/\$\d+\.\d{2}\/hr/);
  });
});
