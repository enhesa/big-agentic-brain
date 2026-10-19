'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isOverdue, dueThisWeek } = require('../src/board');
test('hidden: late evening and early morning', () => {
  assert.strictEqual(isOverdue({ due: '2026-10-19' }, new Date(2026, 9, 19, 23, 59)), false);
  assert.strictEqual(isOverdue({ due: '2026-10-19' }, new Date(2026, 9, 20, 0, 1)), true);
  assert.strictEqual(dueThisWeek([{ due: '2026-10-19' }, { due: '2026-10-26' }], new Date(2026, 9, 19, 0, 5)).length, 1);
});
