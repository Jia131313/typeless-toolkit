const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');

// Execute the real page functions with isolated UI/API doubles, never a live manager.
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
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(match.index, i + 1);
    }
  }
  assert.fail(`${name}() body is not balanced`);
}

function extractDiv(openingPattern) {
  const opening = openingPattern.exec(html);
  assert.ok(opening, `${openingPattern} must match a page container`);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = opening.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += /^<div\b/i.test(match[0]) ? 1 : -1;
    if (depth === 0) return html.slice(opening.index, tags.lastIndex);
  }
  assert.fail(`${openingPattern} container is not balanced`);
}

function harness({ confirmed = true, disabled = false, request = async () => ({ status: 'OK' }) } = {}) {
  const button = { disabled, innerHTML: '重置设备', textContent: '重置设备' };
  const confirmations = [];
  const requests = [];
  const notices = [];
  const refreshes = [];
  const unexpectedActions = [];
  const timers = [];
  const context = vm.createContext({
    document: {
      getElementById(id) {
        assert.equal(id, 'resetDeviceBtn', 'manual reset must use its own button');
        return button;
      },
    },
    confirm(message) {
      confirmations.push(message);
      return confirmed;
    },
    apiTimed(route, options, timeout) {
      requests.push({ route, options: JSON.parse(JSON.stringify(options)), timeout, disabled: button.disabled });
      return request();
    },
    api(...args) { unexpectedActions.push(['api', ...args]); return { status: 'FAIL' }; },
    switchTo(...args) { unexpectedActions.push(['switchTo', ...args]); },
    openRegisterWizard(...args) { unexpectedActions.push(['openRegisterWizard', ...args]); },
    registerWizardStart(...args) { unexpectedActions.push(['registerWizardStart', ...args]); },
    toast(message, type) { notices.push({ message, type }); },
    async loadAccounts() { refreshes.push('accounts'); },
    async detectCurrent() { refreshes.push('current'); },
    setTimeout(...args) { timers.push(['timeout', ...args]); },
    setInterval(...args) { timers.push(['interval', ...args]); },
  });
  vm.runInContext(extractFunction('resetDeviceOnly'), context);
  return { context, button, confirmations, requests, notices, refreshes, unexpectedActions, timers };
}

function assertSingleReset(h) {
  assert.deepEqual(h.requests, [{
    route: '/api/reset-device', options: { method: 'POST' }, timeout: 60000, disabled: true,
  }]);
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.unexpectedActions, [], 'manual reset must not switch accounts or start registration');
  assert.deepEqual(h.timers, [], 'device reset must not schedule an automatic retry');
  assert.equal(h.button.disabled, false, 'the button must be restored when the request settles');
  assert.equal(h.button.textContent, '重置设备', 'the busy label must be restored with the button');
}

test('manual reset has one settings-only button and leaves the five home actions unchanged', () => {
  assert.equal([...html.matchAll(/\bid=["']resetDeviceBtn["']/g)].length, 1);
  const buttons = [...html.matchAll(/<button\b[^>]*\bonclick=["']resetDeviceOnly\(\)["'][^>]*>/g)];
  assert.equal(buttons.length, 1, 'manual reset must have only one entry point');
  assert.match(buttons[0][0], /\bid=["']resetDeviceBtn["']/);
  assert.match(buttons[0][0], /\baria-describedby=["']resetDeviceDescription["']/);

  const maintenance = extractDiv(/<div\b[^>]*\bid=["']settings-maintenance["'][^>]*>/);
  assert.ok(maintenance.includes(buttons[0][0]), 'reset belongs to Settings > Permissions and Maintenance');
  assert.match(maintenance, /\bid=["']resetDeviceDescription["']/);
  const toolbar = extractDiv(/<div\b[^>]*\bclass=["']toolbar["'][^>]*>/);
  const handlers = [...toolbar.matchAll(/<button\b[^>]*\bonclick="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.deepEqual(handlers, ['launch()', 'loadAccounts()', 'openMaster()', 'openRegisterWizard()', 'addAccount()']);
  assert.doesNotMatch(toolbar, /resetDeviceOnly|resetDeviceBtn/);
});

test('cancelled reset explains its effects and preserves all state without an API request', async () => {
  const h = harness({ confirmed: false });
  await h.context.resetDeviceOnly();
  assert.equal(h.confirmations.length, 1);
  const message = h.confirmations[0];
  assert.match(message, /清[除理][^\n。]*当前[^\n。]*登录(?:状)?态/);
  assert.match(message, /重启[^\n。]*登录页/);
  assert.match(message, /(?:保留[^\n。]*账号|账号[^\n。]*(?:保留|不会删除))/);
  assert.match(message, /(?:保留[^\n。]*快照|快照[^\n。]*(?:保留|不会删除))/);
  assert.match(message, /(?:保留[^\n。]*词库|词库[^\n。]*(?:保留|不会删除))/);
  assert.match(message, /(?:无需|不需要|不必)[^\n。]*注册新(?:账号|号)/);
  assert.match(message, /登录已有账号/);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.unexpectedActions, []);
  assert.deepEqual(h.timers, []);
  assert.equal(h.button.disabled, false);
});

test('successful manual reset posts once, refreshes accounts and current state, and releases the button', async () => {
  const h = harness({ request: async () => ({ status: 'OK', msg: '设备已重置，可注册新账号' }) });
  await h.context.resetDeviceOnly();
  assertSingleReset(h);
  assert.deepEqual(h.refreshes, ['accounts', 'current']);
  const success = h.notices.filter(notice => notice.type === 'ok');
  assert.equal(success.length, 1);
  assert.match(success[0].message, /设备重置/);
  assert.match(success[0].message, /登录页/);
  assert.doesNotMatch(success[0].message, /注册新(?:账号|号)/, 'manual reset must not reuse the old registration-oriented API message');
  assert.equal(h.notices.filter(notice => notice.type === 'err').length, 0);
});

test('failed reset reports the server error without refreshing or retrying and releases the button', async () => {
  const h = harness({ request: async () => ({ status: 'FAIL', msg: '设备凭据清理失败' }) });
  await h.context.resetDeviceOnly();
  assertSingleReset(h);
  assert.deepEqual(h.refreshes, []);
  assert.ok(h.notices.some(notice => notice.type === 'err' && notice.message === '设备凭据清理失败'));
  assert.equal(h.notices.filter(notice => notice.type === 'ok').length, 0);
});

test('failed reset without a server message still shows a readable failure', async () => {
  const h = harness({ request: async () => ({ status: 'FAIL' }) });
  await h.context.resetDeviceOnly();
  assertSingleReset(h);
  assert.deepEqual(h.refreshes, []);
  assert.ok(h.notices.some(notice => notice.type === 'err' && /重置失败/.test(notice.message)));
});

for (const message of ['连接意外中断', '请求超时（60000ms）']) {
  test(`reset exception (${message}) is reported without an automatic retry and releases the button`, async () => {
    const h = harness({ request: async () => { throw new Error(message); } });
    await assert.doesNotReject(() => h.context.resetDeviceOnly());
    assertSingleReset(h);
    assert.deepEqual(h.refreshes, []);
    assert.ok(h.notices.some(notice => notice.type === 'err' && notice.message.includes(message)));
    assert.equal(h.notices.filter(notice => notice.type === 'ok').length, 0);
  });
}

test('an already disabled reset button returns before confirmation or any other side effect', async () => {
  const h = harness({ disabled: true });
  await h.context.resetDeviceOnly();
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.unexpectedActions, []);
  assert.deepEqual(h.timers, []);
  assert.equal(h.button.disabled, true, 'a repeated invocation must not release another operation\'s lock');
});

test('a second click while reset is pending cannot confirm or send another request', async () => {
  let resolveRequest;
  const pending = new Promise(resolve => { resolveRequest = resolve; });
  const h = harness({ request: () => pending });
  const first = h.context.resetDeviceOnly();
  assert.equal(h.button.disabled, true);
  assert.equal(h.requests.length, 1);
  await h.context.resetDeviceOnly();
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.refreshes, []);
  assert.equal(h.button.disabled, true);
  resolveRequest({ status: 'OK' });
  await first;
  assertSingleReset(h);
  assert.deepEqual(h.refreshes, ['accounts', 'current']);
});

test('ordinary account switching uses only the switch API, never the manual reset path', async () => {
  const requests = [];
  const timers = [];
  const refreshes = [];
  const unexpectedActions = [];
  const context = vm.createContext({
    ACCOUNTS: [{ user_id: 'saved-account', nickname: '已有账号', snapshot_ok: true }],
    confirm: () => true,
    toast() {},
    async api(route, options) {
      requests.push({ route, options: JSON.parse(JSON.stringify(options)) });
      return { status: 'OK' };
    },
    async apiTimed(...args) { unexpectedActions.push(['apiTimed', ...args]); return { status: 'FAIL' }; },
    resetDeviceOnly(...args) { unexpectedActions.push(['resetDeviceOnly', ...args]); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); },
    async loadAccounts() { refreshes.push('accounts'); },
    async detectCurrent() { refreshes.push('current'); },
    async refreshOnboardingStatus() { refreshes.push('onboarding'); },
  });
  vm.runInContext(extractFunction('switchTo'), context);
  await context.switchTo('saved-account');
  assert.deepEqual(requests, [{ route: '/api/accounts/saved-account/switch', options: { method: 'POST' } }]);
  assert.equal(timers.length, 1);
  timers[0].callback();
  assert.deepEqual(refreshes, ['accounts', 'current', 'onboarding']);
  assert.deepEqual(unexpectedActions, []);
  assert.equal(requests.length, 1, 'the delayed state refresh must not reset the device either');
  assert.doesNotMatch(extractFunction('switchTo'), /resetDeviceOnly|\/api\/reset-device/);
});
