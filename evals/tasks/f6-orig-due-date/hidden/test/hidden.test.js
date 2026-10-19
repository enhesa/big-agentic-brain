'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatDue, daysUntil } = require('../src/due');
test('hidden: dst and year boundaries', () => {
  assert.strictEqual(formatDue('2026-01-01'), 'Thu 01/01/2026');
  assert.strictEqual(formatDue('2026-11-01'), 'Sun 01/11/2026');
  assert.strictEqual(daysUntil('2026-03-09', new Date(2026, 2, 7, 23, 59)), 2);
  assert.strictEqual(daysUntil('2026-11-02', new Date(2026, 9, 31, 0, 1)), 2);
  assert.strictEqual(daysUntil('2026-04-06', new Date(2026, 3, 4, 12, 0)), 2);
});
