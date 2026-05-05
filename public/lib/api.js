// JSON fetch wrappers + CSRF double-submit. Lifted from WEBAPP_PLAYBOOK.md §3.
// Cookie prefix is bi_ (bi_csrf cookie + X-CSRF-Token header).

const CSRF_COOKIE = 'bi_csrf';

function readCookie(name) {
  const target = `${name}=`;
  for (const part of (document.cookie || '').split('; ')) {
    if (part.startsWith(target)) return decodeURIComponent(part.slice(target.length));
  }
  return '';
}

async function handle(res) {
  if (res.status === 401) {
    if (!window.location.pathname.endsWith('/login.html')) {
      window.location.assign('/login.html');
    }
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(typeof body === 'string' ? body : body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then(handle);
}

export async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': readCookie(CSRF_COOKIE),
    },
    body: JSON.stringify(body ?? {}),
  }).then(handle);
}

export async function patchJson(url, body) {
  return fetch(url, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': readCookie(CSRF_COOKIE),
    },
    body: JSON.stringify(body ?? {}),
  }).then(handle);
}

export async function deleteJson(url) {
  return fetch(url, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': readCookie(CSRF_COOKIE) },
  }).then(handle);
}

export function qs(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
