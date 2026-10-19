'use strict';

const pad = (n) => String(n).padStart(2, '0');
const DAY = 24 * 60 * 60 * 1000;

/** "2026-03-08" -> "Sun 08/03/2026" (customer-facing format). */
function formatDue(dateStr) {
  const d = new Date(dateStr);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${wd} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Whole calendar days from `now` (a Date) until the due date; 0 on the due day. */
function daysUntil(dateStr, now) {
  const due = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / DAY);
}

function reminderText(invoice, now) {
  const n = daysUntil(invoice.due, now);
  const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  return `Invoice ${invoice.id} is due ${when} (${formatDue(invoice.due)}).`;
}

module.exports = { formatDue, daysUntil, reminderText };
