'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatDue, daysUntil, reminderText } = require('../src/due');

test('formats the due date as stored', () => {
  assert.strictEqual(formatDue('2026-03-10'), 'Tue 10/03/2026');
});

test('days until due, local calendar', () => {
  const now = new Date(2026, 2, 8, 9, 30); // 8 March, 09:30 local
  assert.strictEqual(daysUntil('2026-03-10', now), 2);
  assert.strictEqual(daysUntil('2026-03-08', now), 0);
});

test('reminder text (support ticket: dates shown one day off)', () => {
  const now = new Date(2026, 5, 1, 18, 0);
  assert.strictEqual(reminderText({ id: 'INV-7', due: '2026-06-02' }, now),
    'Invoice INV-7 is due tomorrow (Tue 02/06/2026).');
});
