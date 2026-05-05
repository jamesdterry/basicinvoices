import { h, state } from '/lib/state.js';
import { getJson, patchJson, postJson, deleteJson } from '/lib/api.js';
import { ProjectForm } from '/components/projectForm.js';
import { MemberRow } from '/components/memberRow.js';

export async function projectDetail({ id }, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const numId = Number(id);
  const isAdmin = state.currentUser?.role === 'super_admin';

  let project, members;
  let clientList = [];
  let userPicks = [];
  try {
    ({ project } = await getJson(`/api/projects/${numId}`));
    ({ members } = await getJson(`/api/projects/${numId}/members`));
    if (isAdmin) {
      ({ clients: clientList } = await getJson('/api/clients'));
      ({ users: userPicks } = await getJson('/api/users?role=subcontractor'));
    }
  } catch (err) {
    mount.replaceChildren(h('main', { class: 'wide stack' },
      h('h1', {}, 'Project'),
      h('p', { class: 'error' }, err?.body?.error || err.message || 'Failed to load'),
    ));
    return;
  }

  let editing = false;
  let addingMember = false;

  async function refreshMembers() {
    ({ members } = await getJson(`/api/projects/${numId}/members`));
  }

  function memberTable() {
    const headCells = isAdmin
      ? [h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Rate'), h('th', {}, '')]
      : [h('th', {}, 'Name'), h('th', {}, 'Email')];

    const tbody = h('tbody');
    if (!members.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: String(headCells.length), class: 'muted' }, 'No members yet.'),
      ));
    }
    for (const m of members) {
      tbody.appendChild(MemberRow({
        member: m,
        viewer: state.currentUser,
        onUpdateRate: async (member, cents) => {
          const r = await patchJson(
            `/api/projects/${numId}/members/${member.id}`,
            { bill_rate_cents: cents },
          );
          return r.member;
        },
        onRemove: async (member) => {
          await deleteJson(`/api/projects/${numId}/members/${member.id}`);
          await refreshMembers();
          render();
        },
      }));
    }

    return h('table', {}, h('thead', {}, h('tr', {}, ...headCells)), tbody);
  }

  function addMemberForm() {
    const select = h('select', { name: 'user_id' });
    select.appendChild(h('option', { value: '' }, '— pick a subcontractor —'));
    const activeIds = new Set(members.map((m) => m.user_id));
    for (const u of userPicks) {
      if (activeIds.has(u.id)) continue;
      select.appendChild(h('option', { value: String(u.id) }, `${u.display_name} (${u.email})`));
    }
    const rateInput = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '125.00' });
    const error = h('div', { class: 'error', hidden: true });
    const submit = h('button', { class: 'btn', type: 'submit' }, 'Add');
    const cancel = h('button', { class: 'btn secondary', type: 'button',
      onclick: () => { addingMember = false; render(); },
    }, 'Cancel');

    return h('form', {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          const userId = Number(select.value);
          const cents = Math.round(Number(rateInput.value) * 100);
          if (!userId) throw new Error('Pick a subcontractor');
          if (!Number.isFinite(cents) || cents < 0) throw new Error('Invalid rate');
          await postJson(`/api/projects/${numId}/members`, {
            user_id: userId,
            bill_rate_cents: cents,
          });
          addingMember = false;
          await refreshMembers();
          render();
        } catch (err) {
          error.textContent = err?.body?.error || err?.message || 'Add failed';
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
      h('h3', {}, 'Add subcontractor'),
      h('div', { class: 'field' }, h('label', {}, 'Subcontractor'), select),
      h('div', { class: 'field' }, h('label', {}, 'Bill rate ($/hr)'), rateInput),
      error,
      h('div', { class: 'row' }, submit, cancel),
    );
  }

  function render() {
    const detail = editing
      ? ProjectForm({
          project,
          clients: clientList,
          onSave: async (data) => {
            const r = await patchJson(`/api/projects/${project.id}`, data);
            project = r.project;
            editing = false;
            render();
          },
          onCancel: () => { editing = false; render(); },
        })
      : h('section', { class: 'stack' },
          h('p', {},
            h('strong', {}, 'Client: '),
            h('a', { href: `#/clients/${project.client_id}` }, project.client_name),
          ),
          project.code ? h('p', {}, h('strong', {}, 'Code: '), project.code) : null,
          isAdmin
            ? h('div', { class: 'row' },
                h('button', { class: 'btn',
                  onclick: () => { editing = true; render(); },
                }, 'Edit'),
                project.archived_at
                  ? h('button', { class: 'btn secondary',
                      onclick: async () => {
                        const r = await postJson(`/api/projects/${project.id}/unarchive`, {});
                        project = r.project; render();
                      },
                    }, 'Unarchive')
                  : h('button', { class: 'btn secondary',
                      onclick: async () => {
                        if (!window.confirm(`Archive "${project.name}"?`)) return;
                        const r = await postJson(`/api/projects/${project.id}/archive`, {});
                        project = r.project; render();
                      },
                    }, 'Archive'),
              )
            : null,
        );

    const memberHeader = h('div', { class: 'row' },
      h('h2', {}, 'Members'),
      h('span', { class: 'spacer' }),
      isAdmin && !addingMember
        ? h('button', { class: 'btn',
            onclick: () => { addingMember = true; render(); },
          }, 'Add subcontractor')
        : null,
    );

    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('p', {}, h('a', { href: '#/projects' }, '← All projects')),
        h('h1', {}, project.name,
          project.archived_at ? h('span', { class: 'tag' }, 'archived') : null,
        ),
        detail,
        memberHeader,
        addingMember ? addMemberForm() : null,
        memberTable(),
      ),
    );
  }
  render();
}
