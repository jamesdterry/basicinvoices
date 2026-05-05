import { test, expect } from '@playwright/test';

test('healthz returns ok', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.bumped_at).toBe('string');
});

test('login.html loads', async ({ page }) => {
  await page.goto('/login.html');
  await expect(page).toHaveTitle(/Basic Invoices/);
  await expect(page.locator('h1')).toHaveText('Basic Invoices');
});
