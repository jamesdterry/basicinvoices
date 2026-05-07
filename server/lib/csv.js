// Tiny CSV writer (RFC 4180). Used by the payments report (Stage 9).
// We deliberately keep this in-house rather than pull a dependency — the
// spec is small and the input shape is fully controlled.

const NEEDS_QUOTING = /[",\r\n]/;

export function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  if (!NEEDS_QUOTING.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return lines.join('\r\n');
}
