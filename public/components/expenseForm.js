import { h } from '/lib/state.js';

// ExpenseForm — add or edit a project expense.
// Props:
//   defaults    { expense_date, description, amount_cents }  (cents → dollars in field)
//   submitLabel button label (default 'Save expense')
//   onSave      async (payload) => void   (caller posts/patches and refreshes)
//   onCancel    optional () => void
export function ExpenseForm({ defaults = {}, submitLabel = 'Save expense', onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });

  const dateInput = h('input', {
    type: 'date',
    name: 'expense_date',
    required: true,
    value: defaults.expense_date || new Date().toISOString().slice(0, 10),
  });
  const amountInput = h('input', {
    type: 'number',
    name: 'amount',
    step: '0.01',
    min: '0',
    required: true,
    placeholder: '42.00',
    value: defaults.amount_cents != null ? (defaults.amount_cents / 100).toFixed(2) : '',
  });
  const descInput = h('input', {
    type: 'text',
    name: 'description',
    required: true,
    placeholder: 'Domain renewal',
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
        const expenseDate = dateInput.value;
        const amountCents = Math.round(Number(amountInput.value) * 100);
        const description = descInput.value.trim();
        if (!expenseDate) throw new Error('Date required');
        if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error('Amount must be ≥ 0');
        if (!description) throw new Error('Description required');

        await onSave({
          expense_date: expenseDate,
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
