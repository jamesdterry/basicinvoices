// Hash router. Lifted from WEBAPP_PLAYBOOK.md §3.
// ROUTES is a list of { name, match: (parts) => params|null }.
// parseHash(hash) → { name, params, query } where query is the ?…= part as a plain object.

export const ROUTES = [
  { name: 'home', match: (parts) => (parts.length === 0 ? {} : null) },
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
