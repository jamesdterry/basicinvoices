// Hash router. Lifted from WEBAPP_PLAYBOOK.md §3.
// ROUTES is a list of { name, match: (parts) => params|null }.
// parseHash(hash) → { name, params, query } where query is the ?…= part as a plain object.

export const ROUTES = [
  { name: 'home', match: (parts) => (parts.length === 0 ? {} : null) },
  { name: 'clients', match: (parts) => (parts.length === 1 && parts[0] === 'clients' ? {} : null) },
  { name: 'clientDetail', match: (parts) => (parts.length === 2 && parts[0] === 'clients' ? { id: parts[1] } : null) },
  { name: 'projects', match: (parts) => (parts.length === 1 && parts[0] === 'projects' ? {} : null) },
  { name: 'projectDetail', match: (parts) => (parts.length === 2 && parts[0] === 'projects' ? { id: parts[1] } : null) },
  { name: 'timeEntries', match: (parts) => (parts.length === 1 && parts[0] === 'time-entries' ? {} : null) },
  { name: 'invoices', match: (parts) => (parts.length === 1 && parts[0] === 'invoices' ? {} : null) },
  { name: 'invoiceDetail', match: (parts) => (parts.length === 2 && parts[0] === 'invoices' ? { id: parts[1] } : null) },
  { name: 'recurring', match: (parts) => (parts.length === 1 && parts[0] === 'recurring' ? {} : null) },
  { name: 'reports', match: (parts) => (parts.length === 1 && parts[0] === 'reports' ? {} : null) },
  { name: 'branding', match: (parts) => (parts.length === 1 && parts[0] === 'branding' ? {} : null) },
  { name: 'subcontractors', match: (parts) => (parts.length === 1 && parts[0] === 'subcontractors' ? {} : null) },
  { name: 'subcontractorDetail', match: (parts) => (parts.length === 2 && parts[0] === 'subcontractors' ? { id: parts[1] } : null) },
];

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const parts = pathPart === '' ? [] : pathPart.split('/').filter(Boolean);

  const query = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  }

  for (const route of ROUTES) {
    const params = route.match(parts);
    if (params) return { name: route.name, params, query };
  }
  return { name: 'home', params: {}, query };
}

export function startRouter(handlers, mountEl) {
  const render = () => {
    const { name, params, query } = parseHash(window.location.hash);
    const handler = handlers[name] || handlers.home;
    if (handler) handler({ ...params, query }, mountEl);
  };
  window.addEventListener('hashchange', render);
  render();
  return render;
}
