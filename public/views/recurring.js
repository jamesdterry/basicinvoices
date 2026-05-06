import { h, state } from '/lib/state.js';
import { getJson, postJson } from '/lib/api.js';
import { formatMoney } from '/lib/money.js';

// Top-level recurring dashboard. Super-admin only — lists every project that
// has a schedule, plus a "Run all due" trigger for ops. Editing happens on
// the per-project page (#/projects/:id), which embeds the same RecurringForm.

export async function recurring(_params, mount) {
  const isAdmin = state.currentUser?.role === 'super_admin';
  if (!isAdmin) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Recurring'),
        h('p', { class: 'error' }, 'Super-admin only.'),
      ),
    );
    return;
  }

  mount.replaceChildren(
    h('main', { class: 'wide stack' },
      h('p', { class: 'muted' }, 'Loading…'),
    ),
  );

  let schedules = [];
  try {
    ({ schedules } = await getJson('/api/admin/recurring'));
  } catch (err) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Recurring'),
        h('p', { class: 'error' }, err?.body?.error || err?.message || 'Failed to load'),
      ),
    );
    return;
  }

  const runError = h('div', { class: 'error', hidden: true });
  const runResult = h('p', { class: 'muted', hidden: true });

  function render() {
    const tbody = h('tbody');
    if (!schedules.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: '6', class: 'muted' },
          'No recurring schedules yet. Configure one from a project page.'),
      ));
    }
    for (const s of schedules) {
      const modeLabel = s.mode === 'fixed_milestone' ? 'Fixed milestone' : 'Time + expenses';
      const amountCell = s.mode === 'fixed_milestone' && s.fixed_amount_cents
        ? formatMoney(s.fixed_amount_cents)
        : '';
      const lastCell = s.last_invoice_id
        ? h('a', { href: `#/invoices/${s.last_invoice_id}` },
            s.last_run_date || 'view')
        : h('span', { class: 'muted' }, '—');

      tbody.appendChild(h('tr', {},
        h('td', {},
          h('a', { href: `#/projects/${s.project_id}` },
            `${s.client_name} — ${s.project_name}`),
        ),
        h('td', {}, modeLabel),
        h('td', {}, `Day ${s.day_of_month}`),
        h('td', {},
          s.paused
            ? h('span', { class: 'tag' }, 'paused')
            : h('span', {}, s.next_run_date),
        ),
        h('td', {}, lastCell),
        h('td', {}, amountCell),
      ));
    }

    const runAll = h('button', {
      class: 'btn',
      onclick: async () => {
        runError.hidden = true;
        runResult.hidden = true;
        runAll.disabled = true;
        try {
          const r = await postJson('/api/admin/recurring/run-now', {});
          const items = r.results || [];
          if (items.length === 0) {
            runResult.textContent = 'No schedules were due.';
          } else {
            const parts = items.map((it) =>
              `project ${it.project_id}: ${it.status}${it.invoice_id ? ` → invoice ${it.invoice_id}` : ''}`
            );
            runResult.textContent = `Ran ${items.length}. ${parts.join('; ')}`;
          }
          runResult.hidden = false;
          // Refresh the list to pick up bumped next_run_date / last_run_date.
          ({ schedules } = await getJson('/api/admin/recurring'));
          render();
        } catch (err) {
          runError.textContent = err?.body?.error || err?.message || 'Run failed';
          runError.hidden = false;
        } finally {
          runAll.disabled = false;
        }
      },
    }, 'Run all due now');

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('div', { class: 'row' },
          h('h1', {}, 'Recurring schedules'),
          h('span', { class: 'spacer' }),
          runAll,
        ),
        h('p', { class: 'muted' },
          'Drafts (never sent) drop on the day of month set per project. Click a row to edit a schedule.'),
        runError,
        runResult,
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Project'),
            h('th', {}, 'Mode'),
            h('th', {}, 'Day'),
            h('th', {}, 'Next'),
            h('th', {}, 'Last'),
            h('th', {}, 'Amount'),
          )),
          tbody,
        ),
      ),
    );
  }

  render();
}
