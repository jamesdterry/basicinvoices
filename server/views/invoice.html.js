// Single source of truth for the rendered invoice — public web view (Stage 5)
// and PDF (Stage 6) both pipe through renderInvoiceHtml. Plain template
// literal, no engine, CSP-safe (no inline event handlers, no external assets,
// styles loaded via <link> to /invoice.css served from public/).

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

function formatHours(hours) {
  return Number(hours).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function statusBadge(status) {
  return `<span class="status status-${esc(status)}">${esc(status)}</span>`;
}

function lineRow(line) {
  const qty =
    line.kind === 'time'
      ? `${formatHours(line.quantity)} hr`
      : Number(line.quantity) === 1
      ? ''
      : String(line.quantity);
  const rate = line.kind === 'time' ? formatMoney(line.unit_rate_cents) : '';
  return `
    <tr class="line line-${esc(line.kind)}">
      <td class="desc">${esc(line.description)}</td>
      <td class="qty">${esc(qty)}</td>
      <td class="rate">${rate}</td>
      <td class="amount">${formatMoney(line.amount_cents)}</td>
    </tr>`;
}

function groupLines(lines) {
  const groups = { time: [], expense: [], milestone: [] };
  for (const l of lines) groups[l.kind].push(l);
  const sections = [];
  if (groups.time.length) {
    sections.push({ title: 'Time', lines: groups.time });
  }
  if (groups.expense.length) {
    sections.push({ title: 'Expenses', lines: groups.expense });
  }
  if (groups.milestone.length) {
    sections.push({ title: 'Milestones', lines: groups.milestone });
  }
  return sections;
}

export function renderInvoiceHtml({ invoice, lines, client, project }) {
  const sections = groupLines(lines || []);
  const balance = (invoice.total_cents ?? 0) - (invoice.amount_paid_cents ?? 0);

  const sectionHtml = sections
    .map(
      (s) => `
        <section class="section">
          <h3>${esc(s.title)}</h3>
          <table class="lines">
            <thead>
              <tr>
                <th class="desc">Description</th>
                <th class="qty">Qty</th>
                <th class="rate">Rate</th>
                <th class="amount">Amount</th>
              </tr>
            </thead>
            <tbody>${s.lines.map(lineRow).join('')}</tbody>
          </table>
        </section>`
    )
    .join('');

  const stripeButton = invoice.stripe_payment_link_url
    ? `<p class="pay-online">
         <a class="pay-btn" href="${esc(invoice.stripe_payment_link_url)}" rel="nofollow noopener">Pay online</a>
       </p>`
    : '';

  const notesBlock = invoice.notes
    ? `<section class="notes"><h3>Notes</h3><p>${esc(invoice.notes)}</p></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Invoice ${esc(invoice.number)}</title>
  <link rel="stylesheet" href="/invoice.css" />
</head>
<body class="invoice-page">
  <main class="invoice">
    <header class="invoice-header">
      <div class="brand">
        <h1>Invoice</h1>
        <p class="number">${esc(invoice.number)}</p>
        ${statusBadge(invoice.status)}
      </div>
      <dl class="meta">
        <dt>Issue date</dt><dd>${esc(invoice.issue_date)}</dd>
        <dt>Due date</dt><dd>${esc(invoice.due_date)}</dd>
        ${
          invoice.period_start || invoice.period_end
            ? `<dt>Period</dt><dd>${esc(invoice.period_start || '')} – ${esc(invoice.period_end || '')}</dd>`
            : ''
        }
      </dl>
    </header>

    <section class="parties">
      <div class="bill-to">
        <h3>Bill to</h3>
        <p class="client-name">${esc(client.name)}</p>
        ${client.billing_address ? `<p class="address">${esc(client.billing_address).replace(/\n/g, '<br />')}</p>` : ''}
        ${client.contact_email ? `<p class="email">${esc(client.contact_email)}</p>` : ''}
      </div>
      <div class="project">
        <h3>Project</h3>
        <p>${esc(project.name)}</p>
      </div>
    </section>

    ${sectionHtml}

    <section class="totals">
      <table>
        <tr><th>Subtotal</th><td>${formatMoney(invoice.subtotal_cents)}</td></tr>
        <tr class="total-row"><th>Total</th><td>${formatMoney(invoice.total_cents)}</td></tr>
        ${
          invoice.amount_paid_cents
            ? `<tr><th>Paid</th><td>−${formatMoney(invoice.amount_paid_cents)}</td></tr>
               <tr class="balance-row"><th>Balance due</th><td>${formatMoney(balance)}</td></tr>`
            : ''
        }
      </table>
    </section>

    ${stripeButton}

    ${notesBlock}

    <footer class="invoice-footer">
      <p class="thanks">Thank you for your business.</p>
    </footer>
  </main>
</body>
</html>`;
}
