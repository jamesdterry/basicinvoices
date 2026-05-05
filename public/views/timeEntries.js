import { h, state } from '/lib/state.js';
import { getJson, postJson, deleteJson, patchJson, qs } from '/lib/api.js';
import { loadFilters, saveFilters, toQueryString } from '/lib/filters.js';
import { TimeEntryForm } from '/components/timeEntryForm.js';

const FEATURE = 'timeEntries';

function startOfWeek(d = new Date()) {
  const day = d.getDay();           // 0 = Sun
  const diff = (day + 6) % 7;       // shift so Mon = 0
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  return monday.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function setHash(filters) {
  const target = `#/time-entries${toQueryString(filters)}`;
  if (window.location.hash !== target) window.location.hash = target;
}

export async function timeEntries(params, mount) {
  const viewer = state.currentUser;
  if (!viewer) return;
  const isAdmin = viewer.role === 'super_admin';

  mount.replaceChildren(
    h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…'))
  );

  // Initial filter values: URL query > localStorage > defaults.
  const defaults = {
    from: startOfWeek(),
    to: todayIso(),
    project_id: '',
    user_id: '',
    include_locked: '',
  };
  let filters = loadFilters(FEATURE, {
    userId: viewer.id,
    scopeId: 'all',
    urlQuery: params?.query || {},
    defaults,
  });

  // Project list — backs the filter project picker AND the quick-add form.
  let projectList = [];
  // Members cache for super-admin act_as picker.
  const membersCache = new Map();

  async function fetchMembers(projectId) {
    const key = String(projectId);
    if (membersCache.has(key)) return membersCache.get(key);
    const { members } = await getJson(`/api/projects/${projectId}/members`);
    membersCache.set(key, members);
    return members;
  }

  // For super-admin user filter picker.
  let userPicks = [];

  async function loadStaticData() {
    const { projects } = await getJson('/api/projects');
    projectList = projects || [];
    if (isAdmin) {
      // Both billable roles for the user filter (we don't know who's logged time).
      const [a, b] = await Promise.all([
        getJson('/api/users?role=subcontractor'),
        getJson('/api/users?role=super_admin'),
      ]);
      userPicks = [...(a.users || []), ...(b.users || [])];
    }
  }

  let entries = [];
  async function refresh() {
    const query = {
      from: filters.from || undefined,
      to: filters.to || undefined,
      project_id: filters.project_id || undefined,
      include_locked: filters.include_locked === '1' ? '1' : undefined,
    };
    if (isAdmin && filters.user_id) query.user_id = filters.user_id;
    const { entries: rows } = await getJson(`/api/time-entries${qs(query)}`);
    entries = rows;
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

    const projectSelect = h('select', {
      onchange: async (e) => {
        filters.project_id = e.target.value;
        commit();
        await refresh();
        render();
      },
    });
    projectSelect.appendChild(h('option', { value: '' }, 'All projects'));
    for (const p of projectList) {
      projectSelect.appendChild(h('option', { value: String(p.id) },
        p.client_name ? `${p.client_name} — ${p.name}` : p.name));
    }
    if (filters.project_id) projectSelect.value = String(filters.project_id);

    const fields = [
      h('div', { class: 'field' }, h('label', {}, 'From'), fromInput),
      h('div', { class: 'field' }, h('label', {}, 'To'),   toInput),
      h('div', { class: 'field' }, h('label', {}, 'Project'), projectSelect),
    ];

    if (isAdmin) {
      const userSelect = h('select', {
        onchange: async (e) => {
          filters.user_id = e.target.value;
          commit();
          await refresh();
          render();
        },
      });
      userSelect.appendChild(h('option', { value: '' }, 'Anyone'));
      for (const u of userPicks) {
        userSelect.appendChild(
          h('option', { value: String(u.id) }, `${u.display_name} (${u.role})`)
        );
      }
      if (filters.user_id) userSelect.value = String(filters.user_id);
      fields.push(h('div', { class: 'field' }, h('label', {}, 'User'), userSelect));

      const lockedToggle = h('label', { class: 'row' },
        h('input', {
          type: 'checkbox',
          checked: filters.include_locked === '1',
          onchange: async (e) => {
            filters.include_locked = e.target.checked ? '1' : '';
            commit();
            await refresh();
            render();
          },
        }),
        h('span', { class: 'muted' }, 'Include locked (invoiced)'),
      );
      fields.push(lockedToggle);
    }

    return h('section', { class: 'row' }, ...fields);
  }

  function entriesTable() {
    const headCells = [h('th', {}, 'Date')];
    if (isAdmin) headCells.push(h('th', {}, 'User'));
    headCells.push(h('th', {}, 'Project'), h('th', {}, 'Hours'), h('th', {}, 'Description'), h('th', {}, ''));

    const tbody = h('tbody');
    if (!entries.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: String(headCells.length), class: 'muted' }, 'No entries.')));
    }
    for (const e of entries) {
      const projectLabel = e.client_name ? `${e.client_name} — ${e.project_name}` : e.project_name;
      const cells = [h('td', {}, e.entry_date)];
      if (isAdmin) cells.push(h('td', {}, e.user_display_name || ''));
      cells.push(
        h('td', {}, projectLabel),
        h('td', {}, String(e.hours)),
        h('td', {}, e.description || ''),
      );
      const actions = h('td', {});
      if (e.locked) {
        actions.appendChild(h('span', { class: 'tag' }, 'invoiced'));
      } else {
        actions.appendChild(h('button', {
          class: 'btn secondary',
          onclick: async () => {
            const newHours = window.prompt('New hours', String(e.hours));
            if (newHours == null) return;
            const num = Number(newHours);
            if (!Number.isFinite(num) || num <= 0) {
              window.alert('Hours must be > 0');
              return;
            }
            try {
              await patchJson(`/api/time-entries/${e.id}`, { hours: num });
              await refresh();
              render();
            } catch (err) {
              window.alert(err?.body?.error || err?.message || 'Edit failed');
            }
          },
        }, 'Edit'));
        actions.appendChild(h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!window.confirm('Delete this time entry?')) return;
            try {
              await deleteJson(`/api/time-entries/${e.id}`);
              await refresh();
              render();
            } catch (err) {
              window.alert(err?.body?.error || err?.message || 'Delete failed');
            }
          },
        }, 'Delete'));
      }
      cells.push(actions);
      tbody.appendChild(h('tr', {}, ...cells));
    }
    return h('table', {}, h('thead', {}, h('tr', {}, ...headCells)), tbody);
  }

  function render() {
    const heading = isAdmin ? 'Time' : 'My hours';
    const formProjects = projectList.filter((p) => !p.archived_at);

    const quickAdd = formProjects.length
      ? h('section', { class: 'stack' },
          h('h3', {}, 'Log time'),
          TimeEntryForm({
            projects: formProjects,
            showActAs: isAdmin,
            fetchMembers: isAdmin ? fetchMembers : undefined,
            viewer,
            defaults: { project_id: filters.project_id || undefined },
            onSave: async (payload) => {
              await postJson('/api/time-entries', payload);
              await refresh();
              render();
            },
          }),
        )
      : h('p', { class: 'muted' },
          isAdmin
            ? 'No projects yet — create one from Projects.'
            : 'You aren’t a member of any projects yet.');

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, heading),
        filterBar(),
        quickAdd,
        entriesTable(),
      ),
    );
  }

  try {
    await loadStaticData();
    await refresh();
    render();
  } catch (err) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, isAdmin ? 'Time' : 'My hours'),
        h('p', { class: 'error' }, err?.body?.error || err?.message || 'Failed to load'),
      ));
  }
}
