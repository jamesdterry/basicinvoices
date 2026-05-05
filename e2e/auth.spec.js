import { test, expect } from '@playwright/test';

test.describe('authed', () => {
  test.use({ storageState: '.auth/super_admin.json' });

  test('home view greets the super-admin', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('h1')).toHaveText('Basic Invoices');
    await expect(page.locator('p.muted')).toContainText('admin@example.com');
    await expect(page.locator('p.muted')).toContainText('super_admin');
  });

  test('/api/me returns the user', async ({ request }) => {
    const res = await request.get('/api/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('super_admin');
  });
});

test.describe('unauthed', () => {
  test('GET / redirects to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login\.html$/);
    await expect(page.locator('h1')).toHaveText('Basic Invoices');
  });

  test('login form submits and reports success', async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('input[name=email]', 'admin@example.com');
    await page.click('#magic-link-form button[type=submit]');
    await expect(page.locator('#login-status')).toContainText(/Check your email/i);
  });
});
