import { test, expect } from '@playwright/test';

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

const EM_CLIENT = 'EM E2E Client';
const EM_PROJECT = 'EM E2E Project';

test.describe.serial('expenses + milestones', () => {
  let projectId;

  test.describe('super-admin: setup, CRUD, lock-out for sub', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('creates project; adds, edits, deletes an expense and a milestone', async ({ request, page }) => {
      const headers = await csrfHeaders(request);

      const cRes = await request.post('/api/clients', {
        headers,
        data: { name: EM_CLIENT },
      });
      expect(cRes.status()).toBe(201);
      const { client } = await cRes.json();

      const pRes = await request.post('/api/projects', {
        headers,
        data: { client_id: client.id, name: EM_PROJECT },
      });
      expect(pRes.status()).toBe(201);
      const { project } = await pRes.json();
      projectId = project.id;

      // Expense: create.
      const xRes = await request.post('/api/expenses', {
        headers,
        data: {
          project_id: projectId,
          expense_date: '2026-05-04',
          description: 'Domain renewal',
          amount_cents: 4200,
        },
      });
      expect(xRes.status()).toBe(201);
      const { entry: expense } = await xRes.json();
      expect(expense.amount_cents).toBe(4200);
      expect(expense.locked).toBe(false);

      // Expense: edit.
      const xPatch = await request.patch(`/api/expenses/${expense.id}`, {
        headers,
        data: { amount_cents: 5000, description: 'Domain + email' },
      });
      expect(xPatch.status()).toBe(200);
      const { entry: expensePatched } = await xPatch.json();
      expect(expensePatched.amount_cents).toBe(5000);
      expect(expensePatched.description).toBe('Domain + email');

      // Milestone: create.
      const mRes = await request.post('/api/milestones', {
        headers,
        data: {
          project_id: projectId,
          milestone_date: '2026-05-01',
          description: 'Phase 1 deliverable',
          amount_cents: 500000,
        },
      });
      expect(mRes.status()).toBe(201);
      const { entry: milestone } = await mRes.json();
      expect(milestone.amount_cents).toBe(500000);

      // List endpoints.
      const xList = await (await request.get(`/api/expenses?project_id=${projectId}`)).json();
      expect(xList.entries).toHaveLength(1);
      const mList = await (await request.get(`/api/milestones?project_id=${projectId}`)).json();
      expect(mList.entries).toHaveLength(1);

      // UI: project detail page renders both sections with the rows.
      await page.goto(`/#/projects/${projectId}`);
      await expect(page.locator('h2', { hasText: 'Expenses' })).toBeVisible();
      await expect(page.locator('h2', { hasText: 'Milestones' })).toBeVisible();
      const text = await page.locator('main').innerText();
      expect(text).toContain('Domain + email');
      expect(text).toContain('$50.00');
      expect(text).toContain('Phase 1 deliverable');
      expect(text).toContain('$5,000.00');

      // Milestone: delete.
      const mDel = await request.delete(`/api/milestones/${milestone.id}`, { headers });
      expect(mDel.status()).toBe(200);
      const mListAfter = await (await request.get(`/api/milestones?project_id=${projectId}`)).json();
      expect(mListAfter.entries).toHaveLength(0);
    });
  });

  test.describe('subcontractor: locked out of all endpoints', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('GET/POST/PATCH/DELETE on expenses + milestones return 403', async ({ request }) => {
      const headers = await csrfHeaders(request);

      // GET list.
      expect((await request.get(`/api/expenses?project_id=${projectId}`)).status()).toBe(403);
      expect((await request.get(`/api/milestones?project_id=${projectId}`)).status()).toBe(403);

      // POST create.
      const xPost = await request.post('/api/expenses', {
        headers,
        data: {
          project_id: projectId,
          expense_date: '2026-05-04',
          description: 'Sneaky',
          amount_cents: 100,
        },
      });
      expect(xPost.status()).toBe(403);

      const mPost = await request.post('/api/milestones', {
        headers,
        data: {
          project_id: projectId,
          milestone_date: '2026-05-01',
          description: 'Sneaky',
          amount_cents: 100,
        },
      });
      expect(mPost.status()).toBe(403);

      // PATCH/DELETE on a fake id — middleware fires first, so still 403.
      expect((await request.patch('/api/expenses/1', { headers, data: { description: 'x' } })).status()).toBe(403);
      expect((await request.delete('/api/expenses/1', { headers })).status()).toBe(403);
      expect((await request.patch('/api/milestones/1', { headers, data: { description: 'x' } })).status()).toBe(403);
      expect((await request.delete('/api/milestones/1', { headers })).status()).toBe(403);
    });
  });

  // Lock-on-invoice (PATCH/DELETE → 409 once invoice_id is set) is fully
  // covered by vitest. Re-exercising it here would require a live invoice
  // flow that doesn't land until Stage 5.
});
