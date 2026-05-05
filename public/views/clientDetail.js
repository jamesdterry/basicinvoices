import { h } from '/lib/state.js';
import { getJson, patchJson, postJson } from '/lib/api.js';
import { ClientForm } from '/components/clientForm.js';
import { ProjectForm } from '/components/projectForm.js';

export async function clientDetail({ id }, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const numId = Number(id);

  let client;
  let projects;
  try {
    ({ client } = await getJson(`/api/clients/${numId}`));
    ({ projects } = await getJson(`/api/projects?include_archived=1&client_id=${numId}`));
  } catch (err) {
    mount.replaceChildren(h('main', { class: 'wide stack' },
      h('h1', {}, 'Client'),
      h('p', { class: 'error' }, err?.body?.error || err.message || 'Failed to load'),
    ));
    return;
  }

  let editing = false;
  let creatingProject = false;

  function render() {
    const detail = editing
      ? ClientForm({
          client,
          onSave: async (data) => {
            const r = await patchJson(`/api/clients/${client.id}`, data);
            client = r.client;
            editing = false;
            render();
          },
          onCancel: () => { editing = false; render(); },
        })
      : h('section', { class: 'stack' },
          h('p', {},
            h('strong', {}, 'Contact: '),
            client.contact_email || h('span', { class: 'muted' }, '—'),
          ),
          h('p', {},
            h('strong', {}, 'Payment terms: '),
            `${client.payment_terms_days} days`,
          ),
          client.billing_address
            ? h('p', {}, h('strong', {}, 'Billing address: '), client.billing_address)
            : null,
          client.notes
            ? h('p', {}, h('strong', {}, 'Notes: '), client.notes)
            : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn',
              onclick: () => { editing = true; render(); },
            }, 'Edit'),
            client.archived_at
              ? h('button', { class: 'btn secondary',
                  onclick: async () => {
                    const r = await postJson(`/api/clients/${client.id}/unarchive`, {});
                    client = r.client; render();
                  },
                }, 'Unarchive')
              : h('button', { class: 'btn secondary',
                  onclick: async () => {
                    if (!window.confirm(`Archive "${client.name}"?`)) return;
                    const r = await postJson(`/api/clients/${client.id}/archive`, {});
                    client = r.client; render();
                  },
                }, 'Archive'),
          ),
        );

    const projectRows = projects.length
      ? projects.map((p) => h('tr', { class: p.archived_at ? 'archived' : '' },
          h('td', {}, h('a', { href: `#/projects/${p.id}` }, p.name),
            p.archived_at ? h('span', { class: 'tag' }, 'archived') : null,
          ),
          h('td', { class: 'muted' }, p.code || ''),
        ))
      : [h('tr', {}, h('td', { colspan: '2', class: 'muted' }, 'No projects yet.'))];

    const formSlot = h('div');
    if (creatingProject) {
      formSlot.appendChild(h('section', { class: 'stack' },
        h('h3', {}, 'New project'),
        ProjectForm({
          lockedClientId: client.id,
          onSave: async (data) => {
            const { project } = await postJson('/api/projects', data);
            projects = [project, ...projects];
            creatingProject = false;
            render();
          },
          onCancel: () => { creatingProject = false; render(); },
        }),
      ));
    }

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('p', {}, h('a', { href: '#/clients' }, '← All clients')),
        h('h1', {}, client.name,
          client.archived_at ? h('span', { class: 'tag' }, 'archived') : null,
        ),
        detail,
        h('div', { class: 'row' },
          h('h2', {}, 'Projects'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn',
            onclick: () => { creatingProject = true; render(); },
          }, 'New project'),
        ),
        formSlot,
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Code'))),
          h('tbody', {}, ...projectRows),
        ),
      ),
    );
  }
  render();
}
