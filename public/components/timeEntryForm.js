import { h } from '/lib/state.js';

// TimeEntryForm — quick-add row.
// Props:
//   projects         array of { id, name, client_name } the caller can post against
//   showActAs        true for super-admin (offers "log as" picker for active members)
//   fetchMembers     async (projectId) => array of { user_id, user_display_name }
//                    Required when showActAs; called when project select changes.
//   viewer           { id, role, display_name }
//   defaults         { project_id, entry_date, hours, description, act_as_user_id }
//   onSave           async (payload) => void  (caller posts to API + refreshes list)
//   onCancel         optional () => void
export function TimeEntryForm({
  projects,
  showActAs = false,
  fetchMembers,
  viewer,
  defaults = {},
  onSave,
  onCancel,
}) {
  const error = h('div', { class: 'error', hidden: true });

  const projectSelect = h('select', { name: 'project_id', required: true });
  projectSelect.appendChild(h('option', { value: '' }, '— pick a project —'));
  for (const p of projects || []) {
    projectSelect.appendChild(
      h('option', { value: String(p.id) },
        p.client_name ? `${p.client_name} — ${p.name}` : p.name)
    );
  }
  if (defaults.project_id) projectSelect.value = String(defaults.project_id);

  const dateInput = h('input', {
    type: 'date',
    name: 'entry_date',
    required: true,
    value: defaults.entry_date || new Date().toISOString().slice(0, 10),
  });
  const hoursInput = h('input', {
    type: 'number',
    name: 'hours',
    step: '0.25',
    min: '0.25',
    required: true,
    placeholder: '1.5',
    value: defaults.hours != null ? String(defaults.hours) : '',
  });
  const descInput = h('input', {
    type: 'text',
    name: 'description',
    required: true,
    placeholder: 'What did you work on?',
    value: defaults.description || '',
  });

  let actAsSelect = null;
  if (showActAs) {
    actAsSelect = h('select', { name: 'act_as_user_id' });
    // Default option: log as self.
    actAsSelect.appendChild(
      h('option', { value: '' }, `${viewer.display_name || 'me'} (me)`)
    );

    async function repopulate(projectId) {
      // Keep the "me" option, drop the rest.
      while (actAsSelect.options.length > 1) actAsSelect.remove(1);
      if (!projectId || !fetchMembers) return;
      try {
        const members = await fetchMembers(projectId);
        for (const m of members || []) {
          if (m.user_id === viewer.id) continue;
          actAsSelect.appendChild(
            h('option', { value: String(m.user_id) }, m.user_display_name)
          );
        }
      } catch {
        // Silent — the user can still post as themselves.
      }
    }

    projectSelect.addEventListener('change', () => repopulate(projectSelect.value));
    if (defaults.project_id) repopulate(defaults.project_id);
    if (defaults.act_as_user_id) actAsSelect.value = String(defaults.act_as_user_id);
  }

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Log time');
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
        const projectId = Number(projectSelect.value);
        const hours = Number(hoursInput.value);
        const description = descInput.value.trim();
        const entryDate = dateInput.value;
        if (!projectId) throw new Error('Pick a project');
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('Hours must be > 0');
        if (!description) throw new Error('Description required');
        if (!entryDate) throw new Error('Date required');

        const payload = {
          project_id: projectId,
          entry_date: entryDate,
          hours,
          description,
        };
        if (showActAs && actAsSelect && actAsSelect.value) {
          payload.act_as_user_id = Number(actAsSelect.value);
        }
        await onSave(payload);
      } catch (err) {
        error.textContent = err?.body?.error || err?.message || 'Save failed';
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'field' }, h('label', {}, 'Project *'), projectSelect),
    showActAs ? h('div', { class: 'field' }, h('label', {}, 'Log as'), actAsSelect) : null,
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Date *'), dateInput),
      h('div', { class: 'field' }, h('label', {}, 'Hours *'), hoursInput),
    ),
    h('div', { class: 'field' }, h('label', {}, 'Description *'), descInput),
    error,
    h('div', { class: 'row' }, submit, cancel),
  );
}
