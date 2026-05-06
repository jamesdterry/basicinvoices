import { h, state } from '/lib/state.js';
import { getJson, patchJson, postJson, deleteJson } from '/lib/api.js';
import { formatMoney } from '/lib/money.js';
import { ProjectForm } from '/components/projectForm.js';
import { MemberRow } from '/components/memberRow.js';
import { ExpenseForm } from '/components/expenseForm.js';
import { MilestoneForm } from '/components/milestoneForm.js';

export async function projectDetail({ id }, mount) {
  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const numId = Number(id);
  const isAdmin = state.currentUser?.role === 'super_admin';

  let project, members;
  let clientList = [];
  let userPicks = [];
  let expenses = [];
  let milestones = [];
  try {
    ({ project } = await getJson(`/api/projects/${numId}`));
    ({ members } = await getJson(`/api/projects/${numId}/members`));
    if (isAdmin) {
      ({ clients: clientList } = await getJson('/api/clients'));
      // Subs are the common case but the super-admin can also self-bill at a
      // per-project rate (AGENTS.md domain glossary), so include both roles.
      const [subRes, adminRes, expRes, milRes] = await Promise.all([
        getJson('/api/users?role=subcontractor'),
        getJson('/api/users?role=super_admin'),
        getJson(`/api/expenses?project_id=${numId}&include_locked=1`),
        getJson(`/api/milestones?project_id=${numId}&include_locked=1`),
      ]);
      userPicks = [...(subRes.users || []), ...(adminRes.users || [])];
      expenses = expRes.entries || [];
      milestones = milRes.entries || [];
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
  let addingExpense = false;
  let editingExpenseId = null;
  let addingMilestone = false;
  let editingMilestoneId = null;
  let invoicingState = null;       // null | 'configuring' | { preview }

  async function refreshMembers() {
    ({ members } = await getJson(`/api/projects/${numId}/members`));
  }
  async function refreshExpenses() {
    const { entries } = await getJson(`/api/expenses?project_id=${numId}&include_locked=1`);
    expenses = entries || [];
  }
  async function refreshMilestones() {
    const { entries } = await getJson(`/api/milestones?project_id=${numId}&include_locked=1`);
    milestones = entries || [];
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
    select.appendChild(h('option', { value: '' }, '— pick a member —'));
    const activeIds = new Set(members.map((m) => m.user_id));
    for (const u of userPicks) {
      if (activeIds.has(u.id)) continue;
      const label = `${u.display_name} (${u.email})${u.role === 'super_admin' ? ' — admin' : ''}`;
      select.appendChild(h('option', { value: String(u.id) }, label));
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
          if (!userId) throw new Error('Pick a member');
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
      h('h3', {}, 'Add member'),
      h('div', { class: 'field' }, h('label', {}, 'Member'), select),
      h('div', { class: 'field' }, h('label', {}, 'Bill rate ($/hr)'), rateInput),
      error,
      h('div', { class: 'row' }, submit, cancel),
    );
  }

  function expensesSection() {
    const tbody = h('tbody');
    if (!expenses.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: '4', class: 'muted' }, 'No expenses yet.'),
      ));
    }
    for (const x of expenses) {
      if (editingExpenseId === x.id) {
        tbody.appendChild(h('tr', {},
          h('td', { colspan: '4' },
            ExpenseForm({
              defaults: x,
              submitLabel: 'Save',
              onSave: async (payload) => {
                await patchJson(`/api/expenses/${x.id}`, payload);
                editingExpenseId = null;
                await refreshExpenses();
                render();
              },
              onCancel: () => { editingExpenseId = null; render(); },
            }),
          ),
        ));
        continue;
      }
      const actions = h('td', {});
      if (x.locked) {
        actions.appendChild(h('span', { class: 'tag' }, 'invoiced'));
      } else {
        actions.appendChild(h('button', {
          class: 'btn secondary',
          onclick: () => { editingExpenseId = x.id; render(); },
        }, 'Edit'));
        actions.appendChild(h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!window.confirm('Delete this expense?')) return;
            try {
              await deleteJson(`/api/expenses/${x.id}`);
              await refreshExpenses();
              render();
            } catch (err) {
              window.alert(err?.body?.error || err?.message || 'Delete failed');
            }
          },
        }, 'Delete'));
      }
      tbody.appendChild(h('tr', {},
        h('td', {}, x.expense_date),
        h('td', {}, x.description || ''),
        h('td', {}, formatMoney(x.amount_cents)),
        actions,
      ));
    }

    const header = h('div', { class: 'row' },
      h('h2', {}, 'Expenses'),
      h('span', { class: 'spacer' }),
      !addingExpense
        ? h('button', { class: 'btn',
            onclick: () => { addingExpense = true; render(); },
          }, 'Add expense')
        : null,
    );

    const addForm = addingExpense
      ? ExpenseForm({
          submitLabel: 'Save expense',
          onSave: async (payload) => {
            await postJson('/api/expenses', { project_id: numId, ...payload });
            addingExpense = false;
            await refreshExpenses();
            render();
          },
          onCancel: () => { addingExpense = false; render(); },
        })
      : null;

    return h('section', { class: 'stack' },
      header,
      addForm,
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Date'),
          h('th', {}, 'Description'),
          h('th', {}, 'Amount'),
          h('th', {}, ''),
        )),
        tbody,
      ),
    );
  }

  function milestonesSection() {
    const tbody = h('tbody');
    if (!milestones.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: '4', class: 'muted' }, 'No milestones yet.'),
      ));
    }
    for (const m of milestones) {
      if (editingMilestoneId === m.id) {
        tbody.appendChild(h('tr', {},
          h('td', { colspan: '4' },
            MilestoneForm({
              defaults: m,
              submitLabel: 'Save',
              onSave: async (payload) => {
                await patchJson(`/api/milestones/${m.id}`, payload);
                editingMilestoneId = null;
                await refreshMilestones();
                render();
              },
              onCancel: () => { editingMilestoneId = null; render(); },
            }),
          ),
        ));
        continue;
      }
      const actions = h('td', {});
      if (m.locked) {
        actions.appendChild(h('span', { class: 'tag' }, 'invoiced'));
      } else {
        actions.appendChild(h('button', {
          class: 'btn secondary',
          onclick: () => { editingMilestoneId = m.id; render(); },
        }, 'Edit'));
        actions.appendChild(h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!window.confirm('Delete this milestone?')) return;
            try {
              await deleteJson(`/api/milestones/${m.id}`);
              await refreshMilestones();
              render();
            } catch (err) {
              window.alert(err?.body?.error || err?.message || 'Delete failed');
            }
          },
        }, 'Delete'));
      }
      tbody.appendChild(h('tr', {},
        h('td', {}, m.milestone_date),
        h('td', {}, m.description || ''),
        h('td', {}, formatMoney(m.amount_cents)),
        actions,
      ));
    }

    const header = h('div', { class: 'row' },
      h('h2', {}, 'Milestones'),
      h('span', { class: 'spacer' }),
      !addingMilestone
        ? h('button', { class: 'btn',
            onclick: () => { addingMilestone = true; render(); },
          }, 'Add milestone')
        : null,
    );

    const addForm = addingMilestone
      ? MilestoneForm({
          submitLabel: 'Save milestone',
          onSave: async (payload) => {
            await postJson('/api/milestones', { project_id: numId, ...payload });
            addingMilestone = false;
            await refreshMilestones();
            render();
          },
          onCancel: () => { addingMilestone = false; render(); },
        })
      : null;

    return h('section', { class: 'stack' },
      header,
      addForm,
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Date'),
          h('th', {}, 'Description'),
          h('th', {}, 'Amount'),
          h('th', {}, ''),
        )),
        tbody,
      ),
    );
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function addDays(iso, days) {
    const d = new Date(iso);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function invoiceSection() {
    if (!invoicingState) {
      return h('section', { class: 'stack' },
        h('div', { class: 'row' },
          h('h2', {}, 'Invoicing'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn',
            onclick: () => { invoicingState = 'configuring'; render(); },
          }, 'Create invoice'),
          h('a', { class: 'btn secondary', href: `#/invoices?project_id=${numId}` }, 'View all'),
        ),
        h('p', { class: 'muted' },
          'Pulls every unbilled time entry, expense, and milestone up to "Through" into a draft invoice.'
        ),
      );
    }

    if (invoicingState === 'configuring') {
      const today = todayIso();
      const through = h('input', { type: 'date', value: today });
      const issue = h('input', { type: 'date', value: today });
      // Default due = issue + client.payment_terms_days (fall back to 14 —
      // the project payload doesn't carry the client's terms, so we look them
      // up from clientList which projectDetail already loads for super-admin).
      const clientRow = clientList.find((c) => c.id === project.client_id);
      const terms = Number(clientRow?.payment_terms_days ?? 14);
      const due = h('input', { type: 'date', value: addDays(today, terms) });
      issue.addEventListener('change', () => { due.value = addDays(issue.value, terms); });
      const notes = h('textarea', { placeholder: 'Optional notes for the invoice' });
      const error = h('div', { class: 'error', hidden: true });
      const previewBtn = h('button', { class: 'btn', type: 'submit' }, 'Preview');
      const cancel = h('button', { class: 'btn secondary', type: 'button',
        onclick: () => { invoicingState = null; render(); },
      }, 'Cancel');

      return h('form', { class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          previewBtn.disabled = true;
          try {
            const r = await postJson('/api/invoices/preview', {
              project_id: numId,
              through_date: through.value,
            });
            invoicingState = {
              preview: r,
              throughDate: through.value,
              issueDate: issue.value,
              dueDate: due.value,
              notes: notes.value,
            };
            render();
          } catch (err) {
            error.textContent = err?.body?.error || err.message || 'Preview failed';
            error.hidden = false;
          } finally {
            previewBtn.disabled = false;
          }
        },
      },
        h('h2', {}, 'Create invoice'),
        h('div', { class: 'field' }, h('label', {}, 'Through (cutoff)'), through),
        h('div', { class: 'field' }, h('label', {}, 'Issue date'), issue),
        h('div', { class: 'field' }, h('label', {}, 'Due date'), due),
        h('div', { class: 'field' }, h('label', {}, 'Notes'), notes),
        error,
        h('div', { class: 'row' }, previewBtn, cancel),
      );
    }

    // Preview confirmation phase.
    const { preview, throughDate, issueDate, dueDate, notes } = invoicingState;
    const tbody = h('tbody');
    if (!preview.lines.length) {
      tbody.appendChild(h('tr', {},
        h('td', { colspan: '4', class: 'muted' }, 'Nothing unbilled in this range.'),
      ));
    }
    for (const l of preview.lines) {
      tbody.appendChild(h('tr', {},
        h('td', {}, h('span', { class: 'tag' }, l.kind)),
        h('td', {}, l.description),
        h('td', {}, l.kind === 'time' ? `${l.quantity} hr × ${formatMoney(l.unit_rate_cents)}` : ''),
        h('td', {}, formatMoney(l.amount_cents)),
      ));
    }
    const error = h('div', { class: 'error', hidden: true });
    const confirmBtn = h('button', {
      class: 'btn',
      disabled: preview.lines.length === 0,
      onclick: async () => {
        error.hidden = true;
        confirmBtn.disabled = true;
        try {
          const r = await postJson('/api/invoices', {
            project_id: numId,
            through_date: throughDate,
            issue_date: issueDate,
            due_date: dueDate,
            notes: notes || null,
          });
          invoicingState = null;
          // Refresh expenses + milestones since some are now locked.
          await Promise.all([refreshExpenses(), refreshMilestones()]);
          window.location.hash = `#/invoices/${r.invoice.id}`;
        } catch (err) {
          error.textContent = err?.body?.error || err.message || 'Create failed';
          error.hidden = false;
          confirmBtn.disabled = false;
        }
      },
    }, 'Create draft');
    const back = h('button', { class: 'btn secondary',
      onclick: () => { invoicingState = 'configuring'; render(); },
    }, 'Back');
    const cancel = h('button', { class: 'btn secondary',
      onclick: () => { invoicingState = null; render(); },
    }, 'Cancel');

    return h('section', { class: 'stack' },
      h('h2', {}, 'Confirm draft'),
      h('p', { class: 'muted' },
        `Through ${throughDate} • Issue ${issueDate} • Due ${dueDate}`),
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Kind'),
          h('th', {}, 'Description'),
          h('th', {}, 'Qty / Rate'),
          h('th', {}, 'Amount'),
        )),
        tbody,
      ),
      h('div', { class: 'row' },
        h('span', { class: 'spacer' }),
        h('strong', {}, `Subtotal: ${formatMoney(preview.subtotal_cents)}`),
      ),
      error,
      h('div', { class: 'row' }, confirmBtn, back, cancel),
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
          }, 'Add member')
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
        isAdmin ? expensesSection() : null,
        isAdmin ? milestonesSection() : null,
        isAdmin ? invoiceSection() : null,
      ),
    );
  }
  render();
}
