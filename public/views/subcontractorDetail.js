import { h } from '/lib/state.js';
import { getJson, patchJson, postJson } from '/lib/api.js';

function statusPill(user) {
  if (user.disabled_at) return h('span', { class: 'tag' }, 'Disabled');
  return h('span', { class: 'tag' }, 'Active');
}

function EditForm({ user, onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });
  const nameIn = h('input', { type: 'text', name: 'display_name', required: true });
  nameIn.value = user.display_name || '';
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save');
  const cancel = h('button', { class: 'btn secondary', type: 'button',
    onclick: () => onCancel?.(),
  }, 'Cancel');

  return h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        await onSave({ display_name: nameIn.value.trim() });
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'field' }, h('label', {}, 'Display name *'), nameIn),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
}

export async function subcontractorDetail({ id }, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const numId = Number(id);

  let user;
  try {
    ({ user } = await getJson(`/api/subcontractors/${numId}`));
  } catch (err) {
    mount.replaceChildren(h('main', { class: 'wide stack' },
      h('h1', {}, 'Subcontractor'),
      h('p', { class: 'error' }, err?.body?.error || err.message || 'Failed to load'),
    ));
    return;
  }

  let editing = false;
  let toast = '';

  function flash(msg) {
    toast = msg;
    render();
    setTimeout(() => { toast = ''; render(); }, 5000);
  }

  async function action(label, fn) {
    try {
      const r = await fn();
      user = r.user;
      flash(label);
    } catch (err) {
      flash(err?.body?.error || err?.message || 'Action failed');
    }
  }

  function render() {
    const detail = editing
      ? EditForm({
          user,
          onSave: async (data) => {
            const r = await patchJson(`/api/subcontractors/${user.id}`, data);
            user = r.user;
            editing = false;
            render();
          },
          onCancel: () => { editing = false; render(); },
        })
      : h('section', { class: 'stack' },
          h('p', {}, h('strong', {}, 'Email: '), user.email),
          h('p', {}, h('strong', {}, 'Last seen: '),
            user.last_seen_at ? new Date(user.last_seen_at).toLocaleString() : '—',
          ),
          h('p', {}, h('strong', {}, 'Created: '),
            new Date(user.created_at).toLocaleDateString(),
          ),
          h('div', { class: 'row' },
            h('button', { class: 'btn',
              onclick: () => { editing = true; render(); },
            }, 'Edit name'),
            user.disabled_at
              ? h('button', { class: 'btn secondary',
                  onclick: () => action(`Enabled ${user.email}`,
                    () => postJson(`/api/subcontractors/${user.id}/enable`, {})),
                }, 'Enable')
              : h('button', { class: 'btn secondary',
                  onclick: () => action(`Invite link sent to ${user.email}`,
                    () => postJson(`/api/subcontractors/${user.id}/resend-invite`, {})),
                }, 'Resend invite link'),
            user.disabled_at
              ? null
              : h('button', { class: 'btn secondary',
                  onclick: () => {
                    if (!window.confirm(`Disable ${user.email}? They will be signed out.`)) return;
                    action(`Disabled ${user.email}`,
                      () => postJson(`/api/subcontractors/${user.id}/disable`, {}));
                  },
                }, 'Disable'),
          ),
        );

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('p', {}, h('a', { href: '#/subcontractors' }, '← All subcontractors')),
        h('h1', {}, user.display_name, ' ', statusPill(user)),
        toast ? h('p', { class: 'muted' }, toast) : null,
        detail,
      ),
    );
  }
  render();
}
