import { h, state } from '/lib/state.js';
import { getJson, patchJson, postJson, deleteJson } from '/lib/api.js';
import { formatMoney } from '/lib/money.js';

function publicLink(token) {
  return `${window.location.origin}/i/${token}`;
}

export async function invoiceDetail({ id }, mount) {
  const viewer = state.currentUser;
  if (!viewer) return;
  if (viewer.role !== 'super_admin') {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Invoice'),
        h('p', { class: 'muted' }, 'Invoices are visible to super-admins only.'),
      )
    );
    return;
  }

  mount.replaceChildren(h('main', { class: 'wide stack' }, h('p', { class: 'muted' }, 'Loading…')));
  const numId = Number(id);

  let invoice, lines;
  try {
    ({ invoice, lines } = await getJson(`/api/invoices/${numId}`));
  } catch (err) {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('h1', {}, 'Invoice'),
        h('p', { class: 'error' }, err?.body?.error || err.message || 'Failed to load'),
      )
    );
    return;
  }

  let editing = false;
  let editLines = false;
  // Per-line draft state — { [lineId]: { description, sort_order } }
  let lineDrafts = {};

  async function refresh() {
    const r = await getJson(`/api/invoices/${numId}`);
    invoice = r.invoice;
    lines = r.lines;
    lineDrafts = {};
  }

  function statusBadge() {
    return h('span', { class: `tag status-${invoice.status}` }, invoice.status);
  }

  function detailsCard() {
    if (editing) {
      const issueInput = h('input', { type: 'date', value: invoice.issue_date });
      const dueInput = h('input', { type: 'date', value: invoice.due_date });
      const stripeInput = h('input', {
        type: 'url', value: invoice.stripe_payment_link_url || '',
        placeholder: 'https://buy.stripe.com/...',
      });
      const notesInput = h('textarea', {}, invoice.notes || '');
      const error = h('div', { class: 'error', hidden: true });
      const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
      const cancel = h('button', { class: 'btn secondary', type: 'button',
        onclick: () => { editing = false; render(); },
      }, 'Cancel');

      return h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          save.disabled = true;
          try {
            await patchJson(`/api/invoices/${numId}`, {
              issue_date: issueInput.value,
              due_date: dueInput.value,
              stripe_payment_link_url: stripeInput.value || null,
              notes: notesInput.value || null,
            });
            editing = false;
            await refresh();
            render();
          } catch (err) {
            error.textContent = err?.body?.error || err.message || 'Save failed';
            error.hidden = false;
          } finally {
            save.disabled = false;
          }
        },
      },
        h('h2', {}, 'Edit invoice'),
        h('div', { class: 'field' }, h('label', {}, 'Issue date'), issueInput),
        h('div', { class: 'field' }, h('label', {}, 'Due date'), dueInput),
        h('div', { class: 'field' }, h('label', {}, 'Stripe Payment Link URL'), stripeInput),
        h('div', { class: 'field' }, h('label', {}, 'Notes'), notesInput),
        error,
        h('div', { class: 'row' }, save, cancel),
      );
    }

    return h('section', { class: 'stack' },
      h('div', { class: 'row' },
        h('h1', {}, `Invoice ${invoice.number}`),
        statusBadge(),
        h('span', { class: 'spacer' }),
        invoice.status === 'draft'
          ? h('button', { class: 'btn secondary', onclick: () => { editing = true; render(); } }, 'Edit')
          : null,
      ),
      h('p', { class: 'muted' }, `${invoice.client_name || ''} — ${invoice.project_name || ''}`),
      h('div', { class: 'row' },
        h('div', { class: 'stack' },
          h('span', { class: 'muted' }, 'Issued'),
          h('span', {}, invoice.issue_date),
        ),
        h('div', { class: 'stack' },
          h('span', { class: 'muted' }, 'Due'),
          h('span', {}, invoice.due_date),
        ),
        h('div', { class: 'stack' },
          h('span', { class: 'muted' }, 'Total'),
          h('span', {}, formatMoney(invoice.total_cents)),
        ),
        h('div', { class: 'stack' },
          h('span', { class: 'muted' }, 'Paid'),
          h('span', {}, formatMoney(invoice.amount_paid_cents || 0)),
        ),
      ),
      invoice.stripe_payment_link_url
        ? h('p', { class: 'muted' }, 'Stripe link: ', h('span', {}, invoice.stripe_payment_link_url))
        : null,
      invoice.notes
        ? h('div', { class: 'stack' }, h('h3', {}, 'Notes'), h('p', {}, invoice.notes))
        : null,
    );
  }

  function linesSection() {
    const tbody = h('tbody');
    for (const line of lines) {
      const draft = lineDrafts[line.id] || { description: line.description, sort_order: line.sort_order };
      if (editLines && invoice.status === 'draft') {
        const descInput = h('input', {
          type: 'text', value: draft.description,
          oninput: (e) => {
            lineDrafts[line.id] = { ...draft, description: e.target.value };
          },
        });
        const sortInput = h('input', {
          type: 'number', value: String(draft.sort_order), style: 'width:5rem',
          oninput: (e) => {
            const n = Number(e.target.value);
            lineDrafts[line.id] = { ...draft, sort_order: Number.isFinite(n) ? n : 0 };
          },
        });
        tbody.appendChild(h('tr', {},
          h('td', {}, h('span', { class: 'tag' }, line.kind)),
          h('td', {}, descInput),
          h('td', {}, sortInput),
          h('td', {}, formatMoney(line.amount_cents)),
        ));
      } else {
        tbody.appendChild(h('tr', {},
          h('td', {}, h('span', { class: 'tag' }, line.kind)),
          h('td', {}, line.description),
          h('td', {}, String(line.sort_order)),
          h('td', {}, formatMoney(line.amount_cents)),
        ));
      }
    }

    const error = h('div', { class: 'error', hidden: true });
    const editToggle = invoice.status === 'draft'
      ? (editLines
          ? h('div', { class: 'row' },
              h('button', {
                class: 'btn',
                onclick: async () => {
                  error.hidden = true;
                  const updates = Object.entries(lineDrafts).map(([id, v]) => ({
                    id: Number(id),
                    description: v.description,
                    sort_order: v.sort_order,
                  }));
                  if (!updates.length) {
                    editLines = false;
                    render();
                    return;
                  }
                  try {
                    await patchJson(`/api/invoices/${numId}`, { lines: updates });
                    editLines = false;
                    await refresh();
                    render();
                  } catch (err) {
                    error.textContent = err?.body?.error || err.message || 'Save failed';
                    error.hidden = false;
                  }
                },
              }, 'Save lines'),
              h('button', {
                class: 'btn secondary',
                onclick: () => { editLines = false; lineDrafts = {}; render(); },
              }, 'Cancel'),
            )
          : h('button', {
              class: 'btn secondary',
              onclick: () => { editLines = true; render(); },
            }, 'Edit lines'))
      : null;

    return h('section', { class: 'stack' },
      h('div', { class: 'row' },
        h('h2', {}, 'Lines'),
        h('span', { class: 'spacer' }),
        editToggle,
      ),
      error,
      h('table', {},
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Kind'),
            h('th', {}, 'Description'),
            h('th', {}, 'Sort'),
            h('th', {}, 'Amount'),
          ),
        ),
        tbody,
      ),
      h('div', { class: 'row' },
        h('span', { class: 'spacer' }),
        h('strong', {}, `Total: ${formatMoney(invoice.total_cents)}`),
      ),
    );
  }

  function actionsRow() {
    const buttons = [];
    const link = publicLink(invoice.public_token);

    if (invoice.status === 'draft') {
      buttons.push(h('button', {
        class: 'btn',
        onclick: async () => {
          if (!window.confirm(`Send invoice ${invoice.number}?`)) return;
          await postJson(`/api/invoices/${numId}/send`, {});
          await refresh();
          render();
        },
      }, 'Send'));
      buttons.push(h('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!window.confirm('Delete this draft? Source rows will be unlocked.')) return;
          await deleteJson(`/api/invoices/${numId}`);
          window.location.hash = '#/invoices';
        },
      }, 'Delete draft'));
    }

    if (invoice.status !== 'void') {
      buttons.push(h('button', {
        class: 'btn secondary',
        onclick: async () => {
          if (!window.confirm(`Void invoice ${invoice.number}? Source rows will be unlocked.`)) return;
          await postJson(`/api/invoices/${numId}/void`, {});
          await refresh();
          render();
        },
      }, 'Void'));
    }

    buttons.push(h('button', {
      class: 'btn secondary',
      onclick: async () => {
        await postJson(`/api/invoices/${numId}/rotate-token`, {});
        await refresh();
        render();
      },
    }, 'Rotate link'));

    if (!invoice.public_token_revoked_at) {
      buttons.push(h('button', {
        class: 'btn secondary',
        onclick: async () => {
          if (!window.confirm('Revoke the public link? Anyone with the URL will see "revoked".')) return;
          await postJson(`/api/invoices/${numId}/revoke-token`, {});
          await refresh();
          render();
        },
      }, 'Revoke link'));
    }

    return h('section', { class: 'stack' },
      h('h3', {}, 'Public link'),
      h('div', { class: 'row' },
        h('input', { class: 'input', readOnly: true, value: link, style: 'flex:1' }),
        h('button', {
          class: 'btn secondary',
          onclick: async () => {
            try { await navigator.clipboard.writeText(link); } catch {}
          },
        }, 'Copy'),
        invoice.public_token_revoked_at
          ? h('span', { class: 'tag' }, 'revoked')
          : null,
      ),
      h('div', { class: 'row' }, ...buttons),
    );
  }

  function previewPane() {
    return h('section', { class: 'stack' },
      h('h3', {}, 'Preview'),
      h('iframe', {
        src: `/api/invoices/${numId}/preview`,
        style: 'width:100%; height:48rem; border:1px solid var(--border); border-radius: var(--radius);',
        sandbox: 'allow-same-origin',
        title: `Invoice ${invoice.number} preview`,
      }),
    );
  }

  function render() {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('p', {}, h('a', { href: '#/invoices' }, '← All invoices')),
        detailsCard(),
        actionsRow(),
        linesSection(),
        previewPane(),
      ),
    );
  }
  render();
}
