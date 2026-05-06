// Money formatter — integer cents → '$1,234.56'. USD only in v1, no currency
// arg. Used by every view that surfaces a billable amount.
export function formatMoney(cents) {
  if (cents == null) return '';
  const n = Number(cents) / 100;
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ',')}`;
}
