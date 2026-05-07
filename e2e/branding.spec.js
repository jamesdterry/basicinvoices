import { test, expect } from '@playwright/test';

async function csrfHeaders(request) {
  await request.get('/healthz');
  const cookies = await request.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'bi_csrf')?.value;
  return csrf ? { 'x-csrf-token': csrf } : {};
}

// Inline 1×1 PNG so the spec doesn't have to read fixture files.
const TINY_PNG_HEX =
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A4944415478DA63000100000500010DBC2A1F0000000049454E44AE426082';
const TINY_PNG = Buffer.from(TINY_PNG_HEX, 'hex');

const COMPANY_NAME = 'Acme Branding E2E';
const ACCENT = '#7a3fbf';
const ADDRESS = '123 Main St\nAnytown, CA 90210\nUSA';

test.describe.serial('branding', () => {
  test.describe('super-admin updates branding', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('PATCH name + address + accent and read it back', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.patch('/api/branding', {
        headers,
        data: {
          company_name: COMPANY_NAME,
          business_address: ADDRESS,
          accent_color_hex: ACCENT,
        },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.branding.companyName).toBe(COMPANY_NAME);
      expect(body.branding.businessAddress).toBe(ADDRESS);
      expect(body.branding.accentColorHex).toBe(ACCENT);

      const got = await request.get('/api/branding');
      expect(got.status()).toBe(200);
      const gb = (await got.json()).branding;
      expect(gb.companyName).toBe(COMPANY_NAME);
      expect(gb.businessAddress).toBe(ADDRESS);
      expect(gb.accentColorHex).toBe(ACCENT);
    });

    test('upload a tiny PNG and confirm /branding/logo serves it', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post('/api/branding/logo', {
        headers,
        multipart: {
          logo: { name: 'logo.png', mimeType: 'image/png', buffer: TINY_PNG },
        },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.branding.hasLogo).toBe(true);
      expect(body.branding.logoUrl).toBe('/branding/logo');

      const logo = await request.get('/branding/logo');
      expect(logo.status()).toBe(200);
      expect(logo.headers()['content-type']).toContain('image/png');
      expect(logo.headers()['cache-control']).toContain('max-age=300');
      expect(logo.headers()['etag']).toBeTruthy();
    });

    test('/branding/style.css reflects the configured accent', async ({ request }) => {
      const r = await request.get('/branding/style.css');
      expect(r.status()).toBe(200);
      expect(r.headers()['content-type']).toContain('text/css');
      const body = await r.text();
      expect(body).toContain(`--accent: ${ACCENT}`);
    });

    test('public /i/<token> renders branding header with logo + name + address lines', async ({ request }) => {
      const list = await request.get('/api/invoices');
      expect(list.status()).toBe(200);
      const invoices = (await list.json()).invoices || [];
      // The reports/payments/invoices specs all seed sent invoices that share
      // the e2e DB; pick the most recent so this test is order-independent.
      const inv = invoices[0];
      test.skip(!inv, 'no invoices seeded — run after invoices.spec.js or payments.spec.js');

      const detail = await request.get(`/api/invoices/${inv.id}`);
      expect(detail.status()).toBe(200);
      const token = (await detail.json()).invoice.public_token;

      const pub = await request.get(`/i/${token}`);
      expect(pub.status()).toBe(200);
      const html = await pub.text();
      expect(html).toContain(COMPANY_NAME);
      expect(html).toContain('123 Main St');
      expect(html).toContain('Anytown, CA 90210');
      expect(html).toContain('USA');
      expect(html).toMatch(/<img class="logo" src="\/branding\/logo"/);
      expect(html).toContain('href="/branding/style.css');
    });
  });

  test.describe('subcontractor cannot mutate branding', () => {
    test.use({ storageState: '.auth/subcontractor.json' });

    test('GET /api/branding → 403', async ({ request }) => {
      const r = await request.get('/api/branding');
      expect(r.status()).toBe(403);
    });

    test('PATCH /api/branding → 403', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.patch('/api/branding', {
        headers,
        data: { company_name: 'should not work' },
      });
      expect(r.status()).toBe(403);
    });

    test('POST /api/branding/logo → 403', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const r = await request.post('/api/branding/logo', {
        headers,
        multipart: {
          logo: { name: 'x.png', mimeType: 'image/png', buffer: TINY_PNG },
        },
      });
      expect(r.status()).toBe(403);
    });

    test('public /branding/style.css and /branding/logo are still reachable', async ({ request }) => {
      const css = await request.get('/branding/style.css');
      expect(css.status()).toBe(200);
      const logo = await request.get('/branding/logo');
      expect([200, 404]).toContain(logo.status());   // depends on prior super-admin step
    });
  });

  test.describe('cleanup: clear logo so subsequent specs see a clean state', () => {
    test.use({ storageState: '.auth/super_admin.json' });

    test('DELETE /api/branding/logo and reset branding to defaults', async ({ request }) => {
      const headers = await csrfHeaders(request);
      const del = await request.delete('/api/branding/logo', { headers });
      expect([200, 404]).toContain(del.status());

      const reset = await request.patch('/api/branding', {
        headers,
        data: {
          company_name: '',
          business_address: '',
          accent_color_hex: '#2a6df4',
        },
      });
      expect(reset.status()).toBe(200);
    });
  });
});
