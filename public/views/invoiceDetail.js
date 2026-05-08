import { h, state } from '/lib/state.js';
import { getJson, patchJson, postJson, putJson, deleteJson } from '/lib/api.js';
import { formatMoney } from '/lib/money.js';
import { PaymentForm } from '/components/paymentForm.js';

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

  let invoice, lines, payments;
  try {
    ({ invoice, lines } = await getJson(`/api/invoices/${numId}`));
    ({ payments } = await getJson(`/api/invoices/${numId}/payments`));
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
  let editStripeLink = false;
  // Per-line draft state — { [lineId]: { description, sort_order } }
  let lineDrafts = {};
  // Payment form state. null = closed; 'new' = adding; number = editing that id.
  let paymentFormState = null;

  async function refresh() {
    const r = await getJson(`/api/invoices/${numId}`);
    invoice = r.invoice;
    lines = r.lines;
    const pr = await getJson(`/api/invoices/${numId}/payments`);
    payments = pr.payments;
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
      stripeLinkRow(),
      invoice.notes
        ? h('div', { class: 'stack' }, h('h3', {}, 'Notes'), h('p', {}, invoice.notes))
        : null,
    );
  }

  function stripeLinkRow() {
    const canEdit = invoice.status === 'draft' || invoice.status === 'sent';
    if (editStripeLink && canEdit) {
      const input = h('input', {
        type: 'url', value: invoice.stripe_payment_link_url || '',
        placeholder: 'https://buy.stripe.com/...', style: 'flex:1',
      });
      const error = h('div', { class: 'error', hidden: true });
      const save = h('button', { class: 'btn', type: 'submit' }, 'Save');
      return h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          save.disabled = true;
          try {
            await putJson(`/api/invoices/${numId}/stripe-link`, { url: input.value || null });
            editStripeLink = false;
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
        h('div', { class: 'row' },
          h('label', {}, 'Stripe link'),
          input,
          save,
          h('button', { class: 'btn secondary', type: 'button',
            onclick: () => { editStripeLink = false; render(); } }, 'Cancel'),
        ),
        error,
      );
    }
    if (!invoice.stripe_payment_link_url && !canEdit) return null;

    const stripeEnabled = state.currentUser?.stripe_enabled === true;
    const stripeError = h('div', { class: 'error', hidden: true, style: 'margin-top:.25rem' });
    const isRegenerate = !!invoice.stripe_payment_link_id;
    const generateBtn = canEdit && stripeEnabled && !editing
      ? h('button', {
          class: 'btn secondary', style: 'margin-left:.5rem',
          onclick: async (e) => {
            e.preventDefault();
            if (isRegenerate && !window.confirm('Replace existing Stripe link?')) return;
            stripeError.hidden = true;
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await postJson(
                `/api/invoices/${numId}/stripe-link/generate`,
                isRegenerate ? { force: true } : {},
              );
              await refresh();
              render();
            } catch (err) {
              const reason = err?.body?.error || err.message || 'Generate failed';
              stripeError.textContent =
                reason === 'stripe_disabled'
                  ? 'Stripe is not configured'
                  : reason === 'stripe_failure'
                    ? 'Stripe API error — see error log'
                    : reason;
              stripeError.hidden = false;
            } finally {
              btn.disabled = false;
            }
          },
        }, isRegenerate ? 'Regenerate Stripe link' : 'Generate Stripe link')
      : null;

    return h('div', { class: 'stack' },
      h('p', { class: 'muted', style: 'margin:0' },
        'Stripe link: ',
        invoice.stripe_payment_link_url
          ? h('span', {}, invoice.stripe_payment_link_url)
          : h('em', {}, 'none set'),
        canEdit && !editing
          ? h('button', { class: 'btn secondary', style: 'margin-left:.5rem',
              onclick: () => { editStripeLink = true; render(); } },
              invoice.stripe_payment_link_url ? 'Edit Stripe link' : 'Add Stripe link')
          : null,
        generateBtn,
      ),
      stripeError,
    );
  }

  function paymentsSection() {
    const canAddPayment = invoice.status === 'sent' || invoice.status === 'paid';

    const tbody = h('tbody');
    if (!payments.length) {
      tbody.appendChild(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No payments yet.')));
    }
    for (const pmt of payments) {
      const isEditingThis = paymentFormState === pmt.id;
      if (isEditingThis) {
        tbody.appendChild(h('tr', {}, h('td', { colspan: 6 },
          PaymentForm({
            defaults: {
              received_date: pmt.received_date,
              amount_cents: pmt.amount_cents,
              method: pmt.method,
              reference: pmt.reference,
              note: pmt.note,
            },
            submitLabel: 'Save changes',
            onSave: async (payload) => {
              await patchJson(`/api/payments/${pmt.id}`, payload);
              paymentFormState = null;
              await refresh();
              render();
            },
            onCancel: () => { paymentFormState = null; render(); },
          }),
        )));
        continue;
      }
      tbody.appendChild(h('tr', {},
        h('td', {}, pmt.received_date),
        h('td', {}, formatMoney(pmt.amount_cents)),
        h('td', {}, pmt.method),
        h('td', {}, pmt.reference || ''),
        h('td', {}, pmt.note || ''),
        h('td', {},
          h('button', {
            class: 'btn secondary',
            onclick: () => { paymentFormState = pmt.id; render(); },
          }, 'Edit'),
          ' ',
          h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!window.confirm('Delete this payment? Status will not auto-revert from paid.')) return;
              await deleteJson(`/api/payments/${pmt.id}`);
              await refresh();
              render();
            },
          }, 'Delete'),
        ),
      ));
    }

    const balance = (invoice.total_cents || 0) - (invoice.amount_paid_cents || 0);
    const addForm = paymentFormState === 'new'
      ? h('div', { class: 'stack' },
          PaymentForm({
            submitLabel: 'Record payment',
            onSave: async (payload) => {
              await postJson(`/api/invoices/${numId}/payments`, payload);
              paymentFormState = null;
              await refresh();
              render();
            },
            onCancel: () => { paymentFormState = null; render(); },
          }),
        )
      : null;

    const addBtn = canAddPayment && paymentFormState !== 'new'
      ? h('button', {
          class: 'btn',
          onclick: () => { paymentFormState = 'new'; render(); },
        }, 'Add payment')
      : !canAddPayment
        ? h('span', { class: 'muted' },
            invoice.status === 'draft'
              ? 'Send the invoice before recording payments.'
              : 'Cannot record payments on a voided invoice.')
        : null;

    return h('section', { class: 'stack' },
      h('div', { class: 'row' },
        h('h2', {}, 'Payments'),
        h('span', { class: 'spacer' }),
        addBtn,
      ),
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Date'),
          h('th', {}, 'Amount'),
          h('th', {}, 'Method'),
          h('th', {}, 'Reference'),
          h('th', {}, 'Note'),
          h('th', {}, ''),
        )),
        tbody,
      ),
      h('p', { class: 'muted' },
        `Total received: ${formatMoney(invoice.amount_paid_cents || 0)} • Balance due: ${formatMoney(balance)}`,
      ),
      addForm,
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

  let lastEmailNote = '';

  function emailNote(email) {
    if (!email) return '';
    if (email.ok) return email.dev ? 'Logged (dev mode)' : 'Sent';
    if (email.reason === 'no_client_email') return 'Skipped — client has no email on file';
    return `Email failed (${email.reason || 'unknown'})`;
  }

  function actionsRow() {
    const buttons = [];
    const link = publicLink(invoice.public_token);

    if (invoice.status === 'draft') {
      buttons.push(h('button', {
        class: 'btn',
        onclick: async () => {
          if (!window.confirm(`Send invoice ${invoice.number}?`)) return;
          try {
            const { email } = await postJson(`/api/invoices/${numId}/send`, {});
            lastEmailNote = emailNote(email);
          } catch (err) {
            lastEmailNote = `Send failed (${err?.body?.error || err.message || 'error'})`;
          }
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

    if (invoice.status === 'sent' || invoice.status === 'paid') {
      buttons.push(h('button', {
        class: 'btn secondary',
        onclick: async () => {
          if (!window.confirm(`Resend email for invoice ${invoice.number}?`)) return;
          try {
            const { email } = await postJson(`/api/invoices/${numId}/resend-email`, {});
            lastEmailNote = emailNote(email);
          } catch (err) {
            lastEmailNote = `Resend failed (${err?.body?.error || err.message || 'error'})`;
          }
          await refresh();
          render();
        },
      }, 'Resend email'));
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
      lastEmailNote ? h('p', { class: 'muted' }, lastEmailNote) : null,
    );
  }

  function previewPane() {
    return h('section', { class: 'stack' },
      h('h3', {}, 'Preview'),
      h('iframe', {
        src: `/api/invoices/${numId}/preview`,
        style: 'width:100%; height:90vh; border:1px solid var(--border); border-radius: var(--radius);',
        sandbox: 'allow-same-origin',
        title: `Invoice ${invoice.number} preview`,
        onload: (e) => {
          try {
            const doc = e.target.contentDocument;
            if (!doc) return;
            const contentHeight = doc.documentElement.scrollHeight;
            if (contentHeight > 0) e.target.style.height = `${contentHeight}px`;
          } catch {
            // leave the 90vh fallback in place
          }
        },
      }),
    );
  }

  function render() {
    mount.replaceChildren(
      h('main', { class: 'wide stack' },
        h('p', {}, h('a', { href: '#/invoices' }, '← All invoices')),
        detailsCard(),
        actionsRow(),
        paymentsSection(),
        linesSection(),
        previewPane(),
      ),
    );
  }
  render();
}
