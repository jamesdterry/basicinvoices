import { h, state } from '/lib/state.js';
import { getJson, postJson } from '/lib/api.js';
import { ProjectForm } from '/components/projectForm.js';

export async function projects(_params, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const isAdmin = state.currentUser?.role === 'super_admin';

  let { projects: rows } = await getJson('/api/projects?include_archived=1');
  let clientList = [];
  if (isAdmin) {
    ({ clients: clientList } = await getJson('/api/clients'));
  }
  let creating = false;

  function render() {
    const headRow = isAdmin
      ? h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Project'), h('th', {}, 'Code'))
      : h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Project'));

    const tbody = h('tbody');
    for (const p of rows) {
      const cells = [
        h('td', {}, p.client_name || ''),
        h('td', {},
          h('a', { href: `#/projects/${p.id}` }, p.name),
          p.archived_at ? h('span', { class: 'tag' }, 'archived') : null,
        ),
      ];
      if (isAdmin) cells.push(h('td', { class: 'muted' }, p.code || ''));
      tbody.appendChild(h('tr', { class: p.archived_at ? 'archived' : '' }, ...cells));
    }
    if (!rows.length) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: isAdmin ? '3' : '2', class: 'muted' },
        isAdmin ? 'No projects yet.' : 'You aren’t a member of any projects yet.',
      )));
    }

    const formSlot = h('div');
    if (creating && isAdmin) {
      formSlot.appendChild(h('section', { class: 'stack' },
        h('h3', {}, 'New project'),
        ProjectForm({
          clients: clientList,
          onSave: async (data) => {
            const { project } = await postJson('/api/projects', data);
            rows = [project, ...rows];
            creating = false;
            render();
          },
          onCancel: () => { creating = false; render(); },
        }),
      ));
    }

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('div', { class: 'row' },
          h('h1', {}, 'Projects'),
          h('span', { class: 'spacer' }),
          isAdmin
            ? h('button', { class: 'btn', onclick: () => { creating = true; render(); } }, 'New project')
            : null,
        ),
        formSlot,
        h('table', {}, h('thead', {}, headRow), tbody),
      ),
    );
  }
  render();
}
