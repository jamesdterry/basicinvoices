// Cover-note body for the invoice email. Plain HTML + matching plain-text;
// the rendered invoice itself rides along as a PDF attachment and the
// `View online` link points at /i/<token>.

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}

function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}

export function renderInvoiceEmailHtml({ invoice, client, project, publicLink }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(invoice.number)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #222; line-height: 1.5;">
  <p>Hi${client.name ? ` ${esc(client.name)}` : ''},</p>
  <p>Invoice <strong>${esc(invoice.number)}</strong> for <strong>${esc(project.name)}</strong> is ready.</p>
  <table role="presentation" cellpadding="6" style="border-collapse: collapse; margin: 1rem 0;">
    <tr><td style="color:#666;">Total</td><td><strong>${formatMoney(invoice.total_cents)}</strong></td></tr>
    <tr><td style="color:#666;">Issue date</td><td>${esc(invoice.issue_date)}</td></tr>
    <tr><td style="color:#666;">Due date</td><td>${esc(invoice.due_date)}</td></tr>
  </table>
  <p>
    <a href="${esc(publicLink)}" style="display:inline-block;padding:0.5rem 1rem;background:#1769ff;color:#fff;text-decoration:none;border-radius:4px;">View online</a>
  </p>
  <p style="color:#666;">A PDF copy is attached for your records.</p>
  <p>Thank you for your business.</p>
</body>
</html>`;
}

export function renderInvoiceEmailText({ invoice, client, project, publicLink }) {
  const lines = [
    `Hi${client.name ? ` ${client.name}` : ''},`,
    '',
    `Invoice ${invoice.number} for ${project.name} is ready.`,
    '',
    `  Total:      ${formatMoney(invoice.total_cents)}`,
    `  Issue date: ${invoice.issue_date}`,
    `  Due date:   ${invoice.due_date}`,
    '',
    `View online: ${publicLink}`,
    '',
    'A PDF copy is attached for your records.',
    '',
    'Thank you for your business.',
  ];
  return lines.join('\n');
}
