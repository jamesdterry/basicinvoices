import { h } from '/lib/state.js';

// PaymentForm — add or edit a payment against an invoice.
// Props:
//   defaults    { received_date, amount_cents, method, reference, note }
//   submitLabel button label (default 'Save payment')
//   onSave      async (payload) => void   (caller posts/patches and refreshes)
//   onCancel    optional () => void
const METHODS = ['stripe', 'ach', 'check', 'wire', 'cash', 'other'];

export function PaymentForm({ defaults = {}, submitLabel = 'Save payment', onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });

  const dateInput = h('input', {
    type: 'date',
    name: 'received_date',
    required: true,
    value: defaults.received_date || new Date().toISOString().slice(0, 10),
  });
  const amountInput = h('input', {
    type: 'number',
    name: 'amount',
    step: '0.01',
    min: '0.01',
    required: true,
    placeholder: '500.00',
    value: defaults.amount_cents != null ? (defaults.amount_cents / 100).toFixed(2) : '',
  });

  const presetMethod =
    defaults.method && METHODS.includes(defaults.method) ? defaults.method : 'check';
  const methodSelect = h(
    'select',
    { name: 'method' },
    ...METHODS.map((m) => h('option', { value: m, selected: m === presetMethod }, m)),
  );
  const customMethod = h('input', {
    type: 'text',
    name: 'method_custom',
    placeholder: 'custom method',
    value: defaults.method && !METHODS.includes(defaults.method) ? defaults.method : '',
  });
  // If defaults had a non-preset method, surface the custom field with the
  // 'other' option pre-selected so submit picks it up.
  if (defaults.method && !METHODS.includes(defaults.method)) {
    methodSelect.value = 'other';
  }

  const referenceInput = h('input', {
    type: 'text',
    name: 'reference',
    placeholder: 'check #1234, txn id, …',
    value: defaults.reference || '',
  });
  const noteInput = h('textarea', {
    name: 'note',
    rows: 2,
    placeholder: 'Optional note',
  });
  noteInput.value = defaults.note || '';

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
        const receivedDate = dateInput.value;
        const amountCents = Math.round(Number(amountInput.value) * 100);
        let method = methodSelect.value;
        if (method === 'other' && customMethod.value.trim()) {
          method = customMethod.value.trim();
        }
        if (!receivedDate) throw new Error('Date required');
        if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('Amount must be > 0');
        if (!method) throw new Error('Method required');

        await onSave({
          received_date: receivedDate,
          amount_cents: amountCents,
          method,
          reference: referenceInput.value.trim() || null,
          note: noteInput.value.trim() || null,
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
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Method *'), methodSelect),
      h('div', { class: 'field' }, h('label', {}, 'If other'), customMethod),
    ),
    h('div', { class: 'field' }, h('label', {}, 'Reference'), referenceInput),
    h('div', { class: 'field' }, h('label', {}, 'Note'), noteInput),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
}
