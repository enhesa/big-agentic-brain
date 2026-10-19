'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isOverdue, summary } = require('../src/board');

const now = new Date(2026, 9, 19, 10, 0); // Mon 19 Oct 2026, 10:00 local

test('not overdue on its due day', () => {
  assert.strictEqual(isOverdue({ due: '2026-10-19' }, now), false);
});

test('overdue the day after', () => {
  assert.strictEqual(isOverdue({ due: '2026-10-18' }, now), true);
});

test('board summary', () => {
  const tasks = [
    { due: '2026-10-18' }, { due: '2026-10-19' }, { due: '2026-10-25' },
    { due: '2026-10-26' }, { due: '2026-10-10', done: true }, {},
  ];
  assert.deepStrictEqual(summary(tasks, now), { open: 5, overdue: 1, thisWeek: 2 });
});
