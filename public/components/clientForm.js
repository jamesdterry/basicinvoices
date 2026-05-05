import { h } from '/lib/state.js';

const FIELDS = [
  { key: 'name',                label: 'Name',                 type: 'text', required: true },
  { key: 'contact_email',       label: 'Contact email',        type: 'email' },
  { key: 'billing_address',     label: 'Billing address',      type: 'textarea' },
  { key: 'payment_terms_days',  label: 'Payment terms (days)', type: 'number', min: 0, max: 365 },
  { key: 'notes',               label: 'Notes',                type: 'textarea' },
];

export function ClientForm({ client, onSave, onCancel }) {
  const error = h('div', { class: 'error', hidden: true });
  const inputs = {};

  const fieldEls = FIELDS.map((f) => {
    let input;
    if (f.type === 'textarea') {
      input = h('textarea', { name: f.key });
    } else {
      input = h('input', { type: f.type, name: f.key });
      if (f.min != null) input.min = String(f.min);
      if (f.max != null) input.max = String(f.max);
    }
    if (client && client[f.key] != null) input.value = String(client[f.key]);
    if (f.key === 'payment_terms_days' && !client) input.value = '14';
    inputs[f.key] = input;
    return h('div', { class: 'field' },
      h('label', {}, f.label + (f.required ? ' *' : '')),
      input,
    );
  });

  const submit = h('button', { class: 'btn', type: 'submit' }, client ? 'Save' : 'Create');
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
        const data = {};
        for (const f of FIELDS) {
          const v = inputs[f.key].value.trim();
          data[f.key] = v === '' ? null : v;
        }
        if (data.payment_terms_days != null) data.payment_terms_days = Number(data.payment_terms_days);
        await onSave(data);
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    ...fieldEls,
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
  return form;
}
