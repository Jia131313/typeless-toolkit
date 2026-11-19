'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localizedContext } = require('./helpers/i18n');
const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
function extract(name) {
  const start = html.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, name);
  const body = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = body; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = ''; }
    else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name);
}

test('主词库保存对删除预览确认，未变更不发送请求', async () => {
  for (const scenario of [
    { value: 'Alpha\nBeta\nGamma', calls: 1, confirms: 0 },
    { value: 'Alpha', calls: 1, confirms: 1, deleted: 'Beta' },
    { value: 'Alpha\nGamma', calls: 1, confirms: 1, deleted: 'Beta' },
    { value: 'Alpha\nBeta', calls: 0, confirms: 0 },
    { value: 'Alpha\nBeta\nALPHA', calls: 1, confirms: 0 },
  ]) {
    const elements = { masterArea: { value: scenario.value }, masterCnt: {} };
    const calls = [], confirms = [];
    const context = vm.createContext(localizedContext({
      MASTER_ORIGINAL: ['Alpha', 'Beta'], document: { getElementById: id => elements[id] },
      appConfirm: async message => { confirms.push(message); return true; },
      api: async (url, options) => { calls.push(JSON.parse(options.body)); return { status: 'OK', data: JSON.parse(options.body).terms, merged: [] }; },
      toast() {}, refreshDictionarySyncStatus() {},
    }));
    vm.runInContext(extract('normalizeMasterInput') + '\n' + extract('saveMaster'), context);
    await context.saveMaster();
    assert.equal(calls.length, scenario.calls);
    assert.equal(confirms.length, scenario.confirms);
    if (scenario.deleted) assert.ok(confirms[0].includes(scenario.deleted));
  }
});
