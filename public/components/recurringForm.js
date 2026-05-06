import { h } from '/lib/state.js';
import { formatMoney } from '/lib/money.js';

// RecurringForm — create / edit a per-project recurring schedule.
//
// Props:
//   schedule         current schedule object (or null when nothing's set yet)
//   stripeEnabled    boolean — server-reported state.currentUser.stripe_enabled
//   onSave           async ({ mode, day_of_month, fixed_amount_cents,
//                              fixed_description, auto_stripe_link }) => void
//   onPause          async () => void
//   onResume         async () => void
//   onRunNow         async () => void   (caller confirms before invoking)
//   onDelete         async () => void   (caller confirms before invoking)
export function RecurringForm({
  schedule,
  stripeEnabled,
  onSave,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}) {
  const error = h('div', { class: 'error', hidden: true });
  const status = h('p', { class: 'muted' });

  const mode = schedule?.mode || 'time_and_expenses';
  const dayOfMonth = schedule?.day_of_month ?? 1;
  const fixedAmount =
    schedule?.fixed_amount_cents != null
      ? (schedule.fixed_amount_cents / 100).toFixed(2)
      : '';
  const fixedDescription = schedule?.fixed_description || '';
  const autoStripeLink = schedule?.auto_stripe_link === true;
  const autoSend = schedule?.auto_send === true;

  const modeTimeRadio = h('input', {
    type: 'radio',
    name: 'recurring-mode',
    value: 'time_and_expenses',
    checked: mode === 'time_and_expenses',
  });
  const modeFixedRadio = h('input', {
    type: 'radio',
    name: 'recurring-mode',
    value: 'fixed_milestone',
    checked: mode === 'fixed_milestone',
  });

  const dayInput = h('input', {
    type: 'number',
    min: '1',
    max: '28',
    step: '1',
    required: true,
    value: String(dayOfMonth),
  });

  const fixedAmountInput = h('input', {
    type: 'number',
    min: '0.01',
    step: '0.01',
    placeholder: '500.00',
    value: fixedAmount,
  });
  const fixedDescriptionInput = h('input', {
    type: 'text',
    placeholder: 'Monthly retainer',
    value: fixedDescription,
  });

  const fixedFields = h(
    'div',
    { class: 'stack', hidden: mode !== 'fixed_milestone' },
    h('div', { class: 'field' }, h('label', {}, 'Amount ($) *'), fixedAmountInput),
    h('div', { class: 'field' }, h('label', {}, 'Description *'), fixedDescriptionInput)
  );

  const autoStripeCheckbox = h('input', {
    type: 'checkbox',
    checked: autoStripeLink && stripeEnabled,
    disabled: !stripeEnabled,
  });
  const autoStripeLabel = h(
    'label',
    { class: 'row' },
    autoStripeCheckbox,
    h('span', {}, 'Auto-generate Stripe Payment Link on each draft'),
    !stripeEnabled
      ? h('span', { class: 'muted' }, ' (Stripe key not configured)')
      : null
  );

  const autoSendCheckbox = h('input', {
    type: 'checkbox',
    checked: autoSend,
  });
  const autoSendLabel = h(
    'label',
    { class: 'row' },
    autoSendCheckbox,
    h('span', {}, 'Auto-send invoice on each run')
  );
  const autoSendWarning = h(
    'p',
    { class: 'muted' },
    'Skips the draft-review step — make sure the project rates and the client’s contact email are correct before enabling. Generated drafts go straight to the client without further confirmation.'
  );

  function refreshModeVisibility() {
    const m = modeFixedRadio.checked ? 'fixed_milestone' : 'time_and_expenses';
    fixedFields.hidden = m !== 'fixed_milestone';
  }
  modeTimeRadio.addEventListener('change', refreshModeVisibility);
  modeFixedRadio.addEventListener('change', refreshModeVisibility);

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save schedule');

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          const m = modeFixedRadio.checked ? 'fixed_milestone' : 'time_and_expenses';
          const day = Number.parseInt(dayInput.value, 10);
          if (!Number.isInteger(day) || day < 1 || day > 28) {
            throw new Error('Day of month must be 1–28');
          }
          const payload = {
            mode: m,
            day_of_month: day,
            auto_stripe_link: autoStripeCheckbox.checked && stripeEnabled,
            auto_send: autoSendCheckbox.checked,
          };
          if (m === 'fixed_milestone') {
            const cents = Math.round(Number(fixedAmountInput.value) * 100);
            if (!Number.isFinite(cents) || cents <= 0) {
              throw new Error('Fixed amount must be > 0');
            }
            const desc = fixedDescriptionInput.value.trim();
            if (!desc) throw new Error('Fixed description required');
            payload.fixed_amount_cents = cents;
            payload.fixed_description = desc;
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
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'row' }, modeTimeRadio, h('span', {}, 'Time + expenses')),
      h('label', { class: 'row' }, modeFixedRadio, h('span', {}, 'Fixed milestone'))
    ),
    h('div', { class: 'field' }, h('label', {}, 'Day of month (1–28) *'), dayInput),
    fixedFields,
    h('div', { class: 'field' }, autoStripeLabel),
    h('div', { class: 'field' }, autoSendLabel, autoSendWarning),
    error,
    h('div', { class: 'row' }, submit)
  );

  const actions = h('div', { class: 'row' });
  if (schedule) {
    const runBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          if (!window.confirm('Run this schedule now? A draft invoice will be created.')) return;
          runBtn.disabled = true;
          try {
            await onRunNow();
          } finally {
            runBtn.disabled = false;
          }
        },
      },
      'Run now'
    );
    actions.appendChild(runBtn);

    if (schedule.paused) {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn secondary',
            type: 'button',
            onclick: async () => {
              await onResume();
            },
          },
          'Resume'
        )
      );
    } else {
      actions.appendChild(
        h(
          'button',
          {
            class: 'btn secondary',
            type: 'button',
            onclick: async () => {
              await onPause();
            },
          },
          'Pause'
        )
      );
    }

    actions.appendChild(
      h(
        'button',
        {
          class: 'btn secondary',
          type: 'button',
          onclick: async () => {
            if (!window.confirm('Delete this recurring schedule? Existing drafts are unaffected.')) return;
            await onDelete();
          },
        },
        'Delete schedule'
      )
    );

    const bits = [];
    if (schedule.paused) bits.push(h('span', { class: 'tag' }, 'paused'));
    bits.push(h('span', {}, `Next run: ${schedule.next_run_date}`));
    if (schedule.last_run_date) {
      bits.push(h('span', {}, ` • Last run: ${schedule.last_run_date}`));
    }
    if (schedule.last_invoice_id) {
      bits.push(
        h(
          'a',
          { href: `#/invoices/${schedule.last_invoice_id}`, class: 'muted' },
          ` (last draft)`
        )
      );
    }
    if (schedule.mode === 'fixed_milestone' && schedule.fixed_amount_cents) {
      bits.push(
        h('span', {}, ` • Amount: ${formatMoney(schedule.fixed_amount_cents)}`)
      );
    }
    status.replaceChildren(...bits);
  } else {
    status.textContent = 'No recurring schedule configured for this project.';
  }

  return h('section', { class: 'stack' }, status, form, actions);
}
