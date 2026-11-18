'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
const match = html.match(/function summarizeQuota\(accounts\)\s*\{[\s\S]*?\n\}/);

test('额度余量按账号分别截断，未知额度不参与计算', () => {
  assert.ok(match, 'summarizeQuota is present');
  const context = vm.createContext({});
  vm.runInContext(match[0], context);
  const account = (used, limit) => ({ live: { usage: { week_word_usage_value: used, week_word_usage_limit: limit } } });
  for (const [accounts, expected] of [
    [[account(100, 200), account(300, 500)], [400, 700, 300, 2]],
    [[account(1090, 2000), account(2404, 2000)], [3494, 4000, 910, 2]],
    [[account(2500, 2000), account(3000, 2000)], [5500, 4000, 0, 2]],
    [[account(100, 200), account(undefined, 200), {}], [100, 200, 100, 1]],
  ]) {
    const result = context.summarizeQuota(accounts);
    assert.deepEqual([result.used, result.limit, result.remaining, result.known], expected);
  }
});
