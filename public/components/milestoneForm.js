import { h } from '/lib/state.js';

// MilestoneForm — add or edit a project milestone.
// Props:
//   defaults    { milestone_date, description, amount_cents }
//   submitLabel button label (default 'Save milestone')
//   onSave      async (payload) => void   (caller posts/patches and refreshes)
//   onCancel    optional () => void
export function MilestoneForm({ defaults = {}, submitLabel = 'Save milestone', onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });

  const dateInput = h('input', {
    type: 'date',
    name: 'milestone_date',
    required: true,
    value: defaults.milestone_date || new Date().toISOString().slice(0, 10),
  });
  const amountInput = h('input', {
    type: 'number',
    name: 'amount',
    step: '0.01',
    min: '0',
    required: true,
    placeholder: '5000.00',
    value: defaults.amount_cents != null ? (defaults.amount_cents / 100).toFixed(2) : '',
  });
  const descInput = h('input', {
    type: 'text',
    name: 'description',
    required: true,
    placeholder: 'Phase 1 deliverable',
    value: defaults.description || '',
  });

  const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);
  const cancel = onCancel
    ? h('button', { class: 'btn secondary', type: 'button', onclick: () => onCancel() }, 'Cancel')
    : null;

  return h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const milestoneDate = dateInput.value;
        const amountCents = Math.round(Number(amountInput.value) * 100);
        const description = descInput.value.trim();
        if (!milestoneDate) throw new Error('Date required');
        if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error('Amount must be ≥ 0');
        if (!description) throw new Error('Description required');

        await onSave({
          milestone_date: milestoneDate,
          amount_cents: amountCents,
          description,
        });
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Date *'), dateInput),
      h('div', { class: 'field' }, h('label', {}, 'Amount ($) *'), amountInput),
    ),
    h('div', { class: 'field' }, h('label', {}, 'Description *'), descInput),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
}
