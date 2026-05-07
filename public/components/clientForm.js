import { h } from '/lib/state.js';

const FIELDS = [
  { key: 'name',                label: 'Name',                 type: 'text', required: true },
  { key: 'billing_address',     label: 'Billing address',      type: 'textarea' },
  { key: 'payment_terms_days',  label: 'Payment terms (days)', type: 'number', min: 0, max: 365 },
  { key: 'notes',               label: 'Notes',                type: 'textarea' },
];

const MAX_EMAILS = 10;

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

  const emailList = h('div', { class: 'email-list stack' });
  const addBtn = h('button', {
    class: 'btn secondary small',
    type: 'button',
    onclick: () => addEmailRow(''),
  }, 'Add email');

  function refreshAddBtn() {
    addBtn.disabled = emailList.children.length >= MAX_EMAILS;
  }

  function addEmailRow(value) {
    if (emailList.children.length >= MAX_EMAILS) return;
    const input = h('input', { type: 'email', name: 'contact_emails[]' });
    if (value) input.value = value;
    const remove = h('button', {
      class: 'btn secondary small',
      type: 'button',
      onclick: () => {
        row.remove();
        refreshAddBtn();
      },
    }, 'Remove');
    const row = h('div', { class: 'row email-row' }, input, remove);
    emailList.appendChild(row);
    refreshAddBtn();
    return input;
  }

  const seedEmails = Array.isArray(client?.contact_emails) ? client.contact_emails : [];
  if (seedEmails.length === 0) {
    addEmailRow('');
  } else {
    for (const e of seedEmails) addEmailRow(e);
  }

  const emailField = h('div', { class: 'field' },
    h('label', {}, 'Contact emails'),
    emailList,
    h('div', { class: 'row' }, addBtn),
  );

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
        const emailInputs = emailList.querySelectorAll('input[type="email"]');
        const emails = [];
        for (const el of emailInputs) {
          const v = el.value.trim();
          if (v) emails.push(v);
        }
        data.contact_emails = emails;
        await onSave(data);
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    fieldEls[0],
    emailField,
    ...fieldEls.slice(1),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
  return form;
}
