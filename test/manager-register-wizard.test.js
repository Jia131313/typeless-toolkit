'use strict';
/**
 * 注册向导：操作指引（含 1101 提示）要一直可见，不能被每 4 秒的自动检测刷新冲掉。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localizedContext, sourcePage } = require('./helpers/i18n');

const html = sourcePage(fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8'));

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  assert.ok(match, `${name}() must exist`);
  const start = html.indexOf('{', match.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(match.index, i + 1);
    }
  }
  assert.fail(`${name}() body is not balanced`);
}

function wizardContext(startData) {
  const els = {};
  const document = {
    getElementById: id => (els[id] ||= { textContent: '', style: {}, disabled: false, value: '' }),
  };
  const context = vm.createContext(localizedContext({
    document,
    appConfirm: async () => true,
    apiTimed: async () => ({ status: 'OK', msg: '已解除设备限制', data: startData }),
    api: async () => ({ status: 'OK', data: { logged_in: false, msg: '尚未在注册窗口完成登录，请继续' } }),
    toast: () => {},
    openModal: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }));
  const names = ['setRegStatus', 'setRegNote', 'openRegisterWizard', 'registerWizardStart', 'registerWizardPoll'];
  vm.runInContext('var regWizardPrevId=null, regWizardTimer=null;\n' + names.map(extractFunction).join('\n'), context);
  return { context, els };
}

test('隔离浏览器注册：1101 提示在自动检测刷新后仍然可见', async () => {
  const { context, els } = wizardContext({ previous_user_id: 'u-old', browser: { name: 'Chrome' } });
  context.openRegisterWizard();
  assert.equal(els.regWizardNote.style.display, 'none');

  await context.registerWizardStart();
  assert.match(els.regWizardNote.textContent, /1101/);
  assert.equal(els.regWizardNote.style.display, '');
  assert.doesNotMatch(els.regWizardStatus.textContent, /1101/);

  await context.registerWizardPoll(true);
  assert.equal(els.regWizardStatus.textContent, '尚未在注册窗口完成登录，请继续');
  assert.match(els.regWizardNote.textContent, /1101/);
});

test('没有可用浏览器时指引改为在 Typeless 里登录，且不带开头空行', async () => {
  const { context, els } = wizardContext({ previous_user_id: '', browser: null });
  context.openRegisterWizard();
  await context.registerWizardStart();
  assert.match(els.regWizardNote.textContent, /^请在 Typeless 中注册或登录/);
  assert.doesNotMatch(els.regWizardNote.textContent, /1101/);
});
