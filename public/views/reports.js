import { h, state } from '/lib/state.js';
import { getJson, qs } from '/lib/api.js';
import { loadFilters, saveFilters, toQueryString } from '/lib/filters.js';
import { formatMoney } from '/lib/money.js';

const FEATURE = 'reports';

const PRESETS = [
  { key: 'this-month',   label: 'This month' },
  { key: 'last-month',   label: 'Last month' },
  { key: 'this-quarter', label: 'This quarter' },
  { key: 'this-year',    label: 'This year' },
  { key: 'last-year',    label: 'Last year' },
  { key: 'custom',       label: 'Custom' },
];

function isoDate(y, m /* 1-12 */, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function lastDayOfMonth(y, m /* 1-12 */) {
  return new Date(y, m, 0).getDate();   // m is 1-based; Date with day=0 → last day of prev month
}

function presetRange(key, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth() + 1;        // 1-12
  const d = today.getDate();
  switch (key) {
    case 'this-month':
      return { from: isoDate(y, m, 1), to: isoDate(y, m, d) };
    case 'last-month': {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { from: isoDate(ly, lm, 1), to: isoDate(ly, lm, lastDayOfMonth(ly, lm)) };
    }
    case 'this-quarter': {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;   // 1, 4, 7, 10
      return { from: isoDate(y, qStart, 1), to: isoDate(y, m, d) };
    }
    case 'this-year':
      return { from: isoDate(y, 1, 1), to: isoDate(y, m, d) };
    case 'last-year':
      return { from: isoDate(y - 1, 1, 1), to: isoDate(y - 1, 12, 31) };
    default:
      return null;
  }
}

function setHash(filters) {
  const target = `#/reports${toQueryString(filters)}`;
  if (window.location.hash !== target) window.location.hash = target;
}

export async function reports(params, mount) {
  const viewer = state.currentUser;
  if (!viewer) return;
  if (viewer.role !== 'super_admin') {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Reports'),
        h('p', { class: 'muted' }, 'Reports are visible to super-admins only.'),
      ),
    );
    return;
  }

  const initialPreset = 'this-month';
  const initialRange = presetRange(initialPreset);
  const defaults = {
    preset: initialPreset,
    groupBy: 'client',
    from: initialRange.from,
    to: initialRange.to,
  };
  const filters = loadFilters(FEATURE, {
    userId: viewer.id,
    scopeId: 'all',
    urlQuery: params?.query || {},
    defaults,
  });

  // If a non-custom preset is active, force the dates to match that preset.
  // This keeps "this-month" rolling forward across days without the user
  // having to clear localStorage.
  if (filters.preset && filters.preset !== 'custom') {
    const r = presetRange(filters.preset);
    if (r) {
      filters.from = r.from;
      filters.to = r.to;
    } else {
      filters.preset = 'custom';
    }
  }

  let rows = [];
  let lastError = null;

  function commit() {
    saveFilters(FEATURE, { userId: viewer.id, scopeId: 'all' }, filters);
    setHash(filters);
  }

  async function refresh() {
    lastError = null;
    try {
      const r = await getJson(
        `/api/reports/payments${qs({
          from: filters.from,
          to: filters.to,
          groupBy: filters.groupBy,
        })}`
      );
      rows = r.rows || [];
    } catch (err) {
      rows = [];
      lastError = err?.body?.error || err.message || 'Failed to load report';
    }
  }

  function presetBar() {
    return h('div', { class: 'row' },
      ...PRESETS.map((p) => {
        const active = filters.preset === p.key;
        return h('button', {
          class: active ? 'btn' : 'btn secondary',
          onclick: async () => {
            filters.preset = p.key;
            if (p.key !== 'custom') {
              const r = presetRange(p.key);
              filters.from = r.from;
              filters.to = r.to;
            }
            commit();
            await refresh();
            render();
          },
        }, p.label);
      }),
    );
  }

  function customDates() {
    if (filters.preset !== 'custom') return null;
    const fromInput = h('input', {
      type: 'date', value: filters.from || '',
      onchange: async (e) => {
        filters.from = e.target.value;
        commit(); await refresh(); render();
      },
    });
    const toInput = h('input', {
      type: 'date', value: filters.to || '',
      onchange: async (e) => {
        filters.to = e.target.value;
        commit(); await refresh(); render();
      },
    });
    return h('div', { class: 'row' },
      h('label', { class: 'field' }, h('span', {}, 'From'), fromInput),
      h('label', { class: 'field' }, h('span', {}, 'To'), toInput),
    );
  }

  function groupToggle() {
    const select = h('select', {
      onchange: async (e) => {
        filters.groupBy = e.target.value;
        commit(); await refresh(); render();
      },
    });
    select.appendChild(h('option', { value: 'client' }, 'Client'));
    select.appendChild(h('option', { value: 'project' }, 'Project'));
    select.value = filters.groupBy;
    return h('label', { class: 'field' }, h('span', {}, 'Group by'), select);
  }

  function exportLink() {
    const href = `/api/reports/payments${qs({
      from: filters.from,
      to: filters.to,
      groupBy: filters.groupBy,
      format: 'csv',
    })}`;
    return h('a', { class: 'btn secondary', href, download: '' }, 'Export CSV');
  }

  function table() {
    const tbody = h('tbody');
    let totalCents = 0;
    let totalCount = 0;
    if (!rows.length) {
      tbody.appendChild(
        h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'No payments in this range.'))
      );
    } else {
      for (const r of rows) {
        totalCents += Number(r.totalCents) || 0;
        totalCount += Number(r.count) || 0;
        tbody.appendChild(
          h('tr', {},
            h('td', {}, r.label),
            h('td', {}, String(r.count)),
            h('td', {}, formatMoney(r.totalCents)),
          )
        );
      }
    }
    const tfoot = h('tfoot', {},
      h('tr', {},
        h('th', {}, 'Total'),
        h('th', {}, String(totalCount)),
        h('th', {}, formatMoney(totalCents)),
      ),
    );
    return h('table', {},
      h('thead', {},
        h('tr', {},
          h('th', {}, filters.groupBy === 'project' ? 'Project' : 'Client'),
          h('th', {}, 'Payments'),
          h('th', {}, 'Total received'),
        ),
      ),
      tbody,
      tfoot,
    );
  }

  function render() {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Reports'),
        h('p', { class: 'muted' },
          'Payments received between the selected dates (cash basis). Dates are in your local timezone.'),
        presetBar(),
        h('div', { class: 'row' },
          groupToggle(),
          h('span', { class: 'muted' }, `${filters.from} → ${filters.to}`),
          h('span', { class: 'spacer' }),
          exportLink(),
        ),
        customDates(),
        lastError ? h('p', { class: 'error' }, lastError) : null,
        table(),
      ),
    );
  }

  mount.replaceChildren(
    h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…'))
  );
  await refresh();
  render();
}
