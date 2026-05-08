import { h } from '/lib/state.js';
import { getJson, postJson } from '/lib/api.js';

function formatLastSeen(iso) {
  if (!iso) return h('span', { class: 'muted' }, '—');
  return new Date(iso).toLocaleDateString();
}

function statusPill(sub) {
  if (sub.disabled_at) return h('span', { class: 'tag' }, 'Disabled');
  return h('span', { class: 'tag' }, 'Active');
}

function NewSubForm({ onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });
  const emailIn = h('input', { type: 'email', name: 'email', required: true, autofocus: true });
  const nameIn = h('input', { type: 'text', name: 'display_name', required: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Create & send invite');
  const cancel = h('button', { class: 'btn secondary', type: 'button',
    onclick: () => onCancel?.(),
  }, 'Cancel');

  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const data = {
          email: emailIn.value.trim(),
          display_name: nameIn.value.trim(),
        };
        await onSave(data);
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'field' }, h('label', {}, 'Email *'), emailIn),
    h('div', { class: 'field' }, h('label', {}, 'Display name *'), nameIn),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
  return form;
}

export async function subcontractors(_params, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));

  let { subcontractors: rows } = await getJson('/api/subcontractors');
  let creating = false;
  let toast = '';

  function render() {
    const tbody = h('tbody');
    for (const s of rows) {
      tbody.appendChild(
        h('tr', { class: s.disabled_at ? 'archived' : '' },
          h('td', {},
            h('a', { href: `#/subcontractors/${s.id}` }, s.display_name),
          ),
          h('td', {}, s.email),
          h('td', {}, formatLastSeen(s.last_seen_at)),
          h('td', {}, statusPill(s)),
        ),
      );
    }
    if (!rows.length) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'No subcontractors yet.')));
    }

    const newBtn = h('button', { class: 'btn',
      onclick: () => { creating = true; render(); },
    }, 'New subcontractor');

    const formSlot = h('div');
    if (creating) {
      formSlot.appendChild(h('section', { class: 'stack' },
        h('h2', {}, 'Invite subcontractor'),
        NewSubForm({
          onSave: async (data) => {
            const { user } = await postJson('/api/subcontractors', data);
            rows = [user, ...rows];
            creating = false;
            toast = `Invite link sent to ${user.email}`;
            render();
            setTimeout(() => { toast = ''; render(); }, 5000);
          },
          onCancel: () => { creating = false; render(); },
        }),
      ));
    }

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('div', { class: 'row' },
          h('h1', {}, 'Subcontractors'),
          h('span', { class: 'spacer' }),
          newBtn,
        ),
        toast ? h('p', { class: 'muted' }, toast) : null,
        formSlot,
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', {}, 'Name'),
            h('th', {}, 'Email'),
            h('th', {}, 'Last seen'),
            h('th', {}, 'Status'),
          )),
          tbody,
        ),
      ),
    );
  }
  render();
}
