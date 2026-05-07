import { h } from '/lib/state.js';
import { getJson, postJson } from '/lib/api.js';
import { ClientForm } from '/components/clientForm.js';

function formatEmails(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return '';
  if (emails.length === 1) return emails[0];
  return `${emails[0]} +${emails.length - 1}`;
}

export async function clients(_params, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));

  let { clients: rows } = await getJson('/api/clients?include_archived=1');

  function render() {
    const tbody = h('tbody');
    for (const c of rows) {
      tbody.appendChild(
        h('tr',
          { class: c.archived_at ? 'archived' : '' },
          h('td', {},
            h('a', { href: `#/clients/${c.id}` }, c.name),
            c.archived_at ? h('span', { class: 'tag' }, 'archived') : null,
          ),
          h('td', {}, formatEmails(c.contact_emails)),
          h('td', {}, String(c.payment_terms_days)),
        ),
      );
    }
    if (!rows.length) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'No clients yet.')));
    }

    const newBtn = h('button', { class: 'btn',
      onclick: () => showForm(),
    }, 'New client');
    const formSlot = h('div');

    function showForm() {
      formSlot.replaceChildren(
        h('section', { class: 'stack' },
          h('h2', {}, 'New client'),
          ClientForm({
            onSave: async (data) => {
              const { client } = await postJson('/api/clients', data);
              rows = [client, ...rows];
              formSlot.replaceChildren();
              render();
            },
            onCancel: () => formSlot.replaceChildren(),
          }),
        ),
      );
    }

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('div', { class: 'row' },
          h('h1', {}, 'Clients'),
          h('span', { class: 'spacer' }),
          newBtn,
        ),
        formSlot,
        h('table', {},
          h('thead', {},
            h('tr', {},
              h('th', {}, 'Name'),
              h('th', {}, 'Contact email'),
              h('th', {}, 'Payment terms (days)'),
            ),
          ),
          tbody,
        ),
      ),
    );
  }
  render();
}
