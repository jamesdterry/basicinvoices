import { h } from '/lib/state.js';

export function ProjectForm({ project, clients, onSave, onCancel, lockedClientId }) {
  const error = h('div', { class: 'error', hidden: true });
  const nameInput = h('input', { type: 'text', name: 'name', required: true });
  const codeInput = h('input', { type: 'text', name: 'code' });

  let clientField;
  if (lockedClientId) {
    clientField = h('input', { type: 'hidden', name: 'client_id', value: String(lockedClientId) });
  } else {
    const select = h('select', { name: 'client_id', required: true });
    select.appendChild(h('option', { value: '' }, '— pick a client —'));
    for (const c of clients || []) {
      select.appendChild(h('option', { value: String(c.id) }, c.name));
    }
    clientField = select;
  }

  if (project) {
    nameInput.value = project.name || '';
    codeInput.value = project.code || '';
    if (!lockedClientId && clientField.tagName === 'SELECT') {
      clientField.value = String(project.client_id);
    }
  }

  const submit = h('button', { class: 'btn', type: 'submit' }, project ? 'Save' : 'Create');
  const cancel = h('button', { class: 'btn secondary', type: 'button',
    onclick: () => onCancel?.(),
  }, 'Cancel');

  const fields = [
    h('div', { class: 'field' },
      h('label', {}, 'Name *'),
      nameInput,
    ),
    h('div', { class: 'field' },
      h('label', {}, 'Code (optional short prefix)'),
      codeInput,
    ),
  ];
  if (!lockedClientId) {
    fields.unshift(h('div', { class: 'field' }, h('label', {}, 'Client *'), clientField));
  } else {
    fields.unshift(clientField);
  }

  return h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        const data = {
          name: nameInput.value.trim(),
          code: codeInput.value.trim() || null,
          client_id: lockedClientId
            ? Number(lockedClientId)
            : Number(clientField.value),
        };
        await onSave(data);
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    ...fields,
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
}
