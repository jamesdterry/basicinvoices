// List-view filter persistence — URL ↔ localStorage round-trip.
// Per AGENTS.md: keys are namespaced `basicinvoices.<feature>.${userId}.${scopeId}`.
// Used by the time-entries view (Stage 3); future stages will reuse for invoices,
// payments, and reports.
//
// Priority on read: URL query > localStorage > defaults.
// Caller updates location.hash with toQueryString(values) when filters change.

function storageKey(feature, userId, scopeId) {
  return `basicinvoices.${feature}.${userId}.${scopeId}`;
}

export function loadFilters(feature, { userId, scopeId = 'all', urlQuery = {}, defaults = {} }) {
  let stored = {};
  try {
    const raw = localStorage.getItem(storageKey(feature, userId, scopeId));
    if (raw) stored = JSON.parse(raw) || {};
  } catch {}
  const cleanUrl = {};
  for (const [k, v] of Object.entries(urlQuery || {})) {
    if (v != null && v !== '') cleanUrl[k] = v;
  }
  return { ...defaults, ...stored, ...cleanUrl };
}

export function saveFilters(feature, { userId, scopeId = 'all' }, values) {
  try {
    localStorage.setItem(
      storageKey(feature, userId, scopeId),
      JSON.stringify(values || {})
    );
  } catch {}
}

export function toQueryString(values) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values || {})) {
    if (v == null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}
