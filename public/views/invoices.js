import { h, state } from '/lib/state.js';
import { getJson, qs } from '/lib/api.js';
import { loadFilters, saveFilters, toQueryString } from '/lib/filters.js';
import { formatMoney } from '/lib/money.js';

const FEATURE = 'invoices';

function setHash(filters) {
  const target = `#/invoices${toQueryString(filters)}`;
  if (window.location.hash !== target) window.location.hash = target;
}

export async function invoices(params, mount) {
  const viewer = state.currentUser;
  if (!viewer) return;
  if (viewer.role !== 'super_admin') {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Invoices'),
        h('p', { class: 'muted' }, 'Invoices are visible to super-admins only.'),
      ),
    );
    return;
  }

  mount.replaceChildren(
    h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…'))
  );

  const defaults = { status: '', client_id: '', project_id: '', from: '', to: '' };
  let filters = loadFilters(FEATURE, {
    userId: viewer.id,
    scopeId: 'all',
    urlQuery: params?.query || {},
    defaults,
  });

  let clientList = [];
  let projectList = [];
  let rows = [];

  async function loadStaticData() {
    const [c, p] = await Promise.all([
      getJson('/api/clients?include_archived=1'),
      getJson('/api/projects?include_archived=1'),
    ]);
    clientList = c.clients || [];
    projectList = p.projects || [];
  }

  async function refresh() {
    const query = {
      status: filters.status || undefined,
      client_id: filters.client_id || undefined,
      project_id: filters.project_id || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    };
    const r = await getJson(`/api/invoices${qs(query)}`);
    rows = r.invoices || [];
  }

  function commit() {
    saveFilters(FEATURE, { userId: viewer.id, scopeId: 'all' }, filters);
    setHash(filters);
  }

  function filterBar() {
    const fromInput = h('input', {
      type: 'date', value: filters.from || '',
      onchange: async (e) => { filters.from = e.target.value; commit(); await refresh(); render(); },
    });
    const toInput = h('input', {
      type: 'date', value: filters.to || '',
      onchange: async (e) => { filters.to = e.target.value; commit(); await refresh(); render(); },
    });
    const statusSelect = h('select', {
      onchange: async (e) => { filters.status = e.target.value; commit(); await refresh(); render(); },
    });
    statusSelect.appendChild(h('option', { value: '' }, 'All statuses'));
    for (const s of ['draft', 'sent', 'paid', 'void']) {
      statusSelect.appendChild(h('option', { value: s }, s));
    }
    if (filters.status) statusSelect.value = filters.status;

    const clientSelect = h('select', {
      onchange: async (e) => { filters.client_id = e.target.value; commit(); await refresh(); render(); },
    });
    clientSelect.appendChild(h('option', { value: '' }, 'All clients'));
    for (const c of clientList) {
      clientSelect.appendChild(h('option', { value: String(c.id) }, c.name));
    }
    if (filters.client_id) clientSelect.value = String(filters.client_id);

    const projectSelect = h('select', {
      onchange: async (e) => { filters.project_id = e.target.value; commit(); await refresh(); render(); },
    });
    projectSelect.appendChild(h('option', { value: '' }, 'All projects'));
    for (const p of projectList) {
      projectSelect.appendChild(
        h('option', { value: String(p.id) }, p.client_name ? `${p.client_name} — ${p.name}` : p.name)
      );
    }
    if (filters.project_id) projectSelect.value = String(filters.project_id);

    return h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', {}, 'From'), fromInput),
      h('label', { class: 'field' }, h('span', {}, 'To'), toInput),
      h('label', { class: 'field' }, h('span', {}, 'Status'), statusSelect),
      h('label', { class: 'field' }, h('span', {}, 'Client'), clientSelect),
      h('label', { class: 'field' }, h('span', {}, 'Project'), projectSelect),
    );
  }

  function table() {
    const tbody = h('tbody');
    if (!rows.length) {
      tbody.appendChild(
        h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No invoices match these filters.'))
      );
    }
    for (const r of rows) {
      tbody.appendChild(
        h('tr', {},
          h('td', {}, h('a', { href: `#/invoices/${r.id}` }, r.number)),
          h('td', {}, r.client_name || ''),
          h('td', {}, r.project_name || ''),
          h('td', {}, h('span', { class: `tag status-${r.status}` }, r.status)),
          h('td', {}, r.issue_date),
          h('td', {}, r.due_date),
          h('td', {}, formatMoney(r.total_cents)),
        )
      );
    }
    return h('table', {},
      h('thead', {},
        h('tr', {},
          h('th', {}, 'Number'),
          h('th', {}, 'Client'),
          h('th', {}, 'Project'),
          h('th', {}, 'Status'),
          h('th', {}, 'Issued'),
          h('th', {}, 'Due'),
          h('th', {}, 'Total'),
        ),
      ),
      tbody,
    );
  }

  function render() {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Invoices'),
        filterBar(),
        h('p', { class: 'muted' },
          'Create new invoices from a project — open the project and click ',
          h('em', {}, 'Create invoice'),
          '.'),
        table(),
      ),
    );
  }

  try {
    await loadStaticData();
    await refresh();
  } catch (err) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Invoices'),
        h('p', { class: 'error' }, err?.body?.error || err.message || 'Failed to load'),
      ),
    );
    return;
  }
  render();
}
