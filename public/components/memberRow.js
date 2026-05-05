import { h } from '/lib/state.js';

function formatRate(cents) {
  if (cents == null) return '';
  return `$${(Number(cents) / 100).toFixed(2)}/hr`;
}

export function MemberRow({ member, viewer, onUpdateRate, onRemove }) {
  const isAdmin = viewer?.role === 'super_admin';
  const row = h('tr');

  function renderView() {
    row.replaceChildren(
      h('td', {}, member.user_display_name || member.user_email || ''),
      h('td', { class: 'muted' }, member.user_email || ''),
      ...(isAdmin
        ? [
            h('td', {}, formatRate(member.bill_rate_cents)),
            h('td', { class: 'row' },
              h('button', {
                class: 'btn secondary',
                type: 'button',
                onclick: () => renderEdit(),
              }, 'Edit'),
              h('button', {
                class: 'btn danger',
                type: 'button',
                onclick: async () => {
                  if (!window.confirm(`Remove ${member.user_display_name} from this project?`)) return;
                  await onRemove?.(member);
                },
              }, 'Remove'),
            ),
          ]
        : []),
    );
  }

  function renderEdit() {
    const dollars = (Number(member.bill_rate_cents) / 100).toFixed(2);
    const input = h('input', { type: 'number', step: '0.01', min: '0', value: dollars });
    const error = h('span', { class: 'error', hidden: true });
    const save = h('button', { class: 'btn', type: 'button',
      onclick: async () => {
        save.disabled = true;
        error.hidden = true;
        try {
          const cents = Math.round(Number(input.value) * 100);
          if (!Number.isFinite(cents) || cents < 0) {
            error.textContent = 'Invalid rate';
            error.hidden = false;
            return;
          }
          const updated = await onUpdateRate?.(member, cents);
          if (updated) {
            member.bill_rate_cents = updated.bill_rate_cents;
            renderView();
          }
        } catch (err) {
          error.textContent = err?.body?.error || err?.message || 'Save failed';
          error.hidden = false;
        } finally {
          save.disabled = false;
        }
      },
    }, 'Save');
    const cancel = h('button', { class: 'btn secondary', type: 'button',
      onclick: () => renderView(),
    }, 'Cancel');

    row.replaceChildren(
      h('td', {}, member.user_display_name || ''),
      h('td', { class: 'muted' }, member.user_email || ''),
      h('td', { class: 'row' },
        h('span', {}, '$'),
        input,
        h('span', { class: 'muted' }, '/hr'),
      ),
      h('td', { class: 'row' }, save, cancel, error),
    );
    input.focus();
  }

  renderView();
  return row;
}
