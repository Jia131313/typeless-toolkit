const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');

// Exercise the page's real functions without starting the manager or touching user data.
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

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    style: {},
    dataset: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name);
        else classes.delete(name);
        return enabled;
      },
    },
  };
}

function contextFor(functions, overrides = {}) {
  const elements = new Map();
  const context = vm.createContext({
    TOOLKIT_UPDATE: null,
    OFFICIAL_UPDATE: null,
    OFFICIAL_UPDATE_BUSY: false,
    OFFICIAL_UPDATE_CHECKED_AT: 0,
    TOOLKIT_UPDATE_NOTIFIED: false,
    TOOLKIT_UPDATE_SHARED_BACKEND: false,
    ENV_INFO: { platform: 'macos' },
    document: {
      getElementById(id) {
        assert.match(html, new RegExp(`\\bid=["']${id}["']`), `#${id} must exist in the page`);
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
    ...overrides,
  });
  vm.runInContext(functions.map(extractFunction).join('\n'), context);
  return { context, node: id => context.document.getElementById(id) };
}

const toolkitUpdate = { available: true, version: '1.7.1', current_version: '1.7.0', state: 'available', running: false };
const officialUpdate = { supported: true, available: true, current: { version: '2.3.1' }, pending: { version: '2.3.2', fileName: 'Typeless-2.3.2-arm64.zip' } };
const plain = value => JSON.parse(JSON.stringify(value));

test('available update targets distinguish toolkit, local official packages, and platform support', () => {
  const cases = [
    { name: 'no update', toolkit: null, official: null, expected: [] },
    { name: 'toolkit only', toolkit: toolkitUpdate, official: null, expected: [{ kind: 'toolkit', version: '1.7.1' }] },
    { name: 'official only', toolkit: null, official: officialUpdate, expected: [{ kind: 'official', version: '2.3.2' }] },
    { name: 'both', toolkit: toolkitUpdate, official: officialUpdate, expected: [{ kind: 'toolkit', version: '1.7.1' }, { kind: 'official', version: '2.3.2' }] },
    { name: 'Windows hides official', toolkit: toolkitUpdate, official: officialUpdate, platform: 'windows', expected: [{ kind: 'toolkit', version: '1.7.1' }] },
    { name: 'unsupported official', official: { ...officialUpdate, supported: false }, expected: [] },
    { name: 'official package is not newer', official: { ...officialUpdate, available: false }, expected: [] },
    { name: 'official package has no version', official: { ...officialUpdate, pending: {} }, expected: [] },
    { name: 'toolkit is current', toolkit: { ...toolkitUpdate, available: false }, expected: [] },
  ];
  for (const scenario of cases) {
    const { context } = contextFor(['getAvailableUpdates'], {
      TOOLKIT_UPDATE: scenario.toolkit || null,
      OFFICIAL_UPDATE: scenario.official || null,
      ENV_INFO: { platform: scenario.platform || 'macos' },
    });
    assert.deepEqual(plain(context.getAvailableUpdates()), scenario.expected, scenario.name);
  }
});

test('update indicators and target buttons follow both sources and clear when no update remains', () => {
  const { context, node } = contextFor(['getAvailableUpdates', 'renderUpdateIndicators']);
  context.renderUpdateIndicators();
  assert.equal(node('homeUpdateNotice').hidden, true);
  assert.equal(node('settingsUpdateBadge').hidden, true);
  assert.equal(node('availableToolkitBtn').hidden, true);
  assert.equal(node('availableOfficialBtn').hidden, true);

  context.TOOLKIT_UPDATE = toolkitUpdate;
  context.renderUpdateIndicators();
  assert.equal(node('homeUpdateNotice').hidden, false);
  assert.equal(node('settingsUpdateBadge').hidden, false);
  assert.equal(node('availableToolkitBtn').hidden, false);
  assert.equal(node('availableOfficialBtn').hidden, true);
  assert.match(node('homeUpdateLabel').textContent, /工具集|1\.7\.1/);
  assert.match(node('homeUpdateNotice').getAttribute('aria-label'), /工具集/);
  assert.match(node('homeUpdateNotice').title, /1\.7\.1/);

  context.OFFICIAL_UPDATE = officialUpdate;
  context.renderUpdateIndicators();
  assert.equal(node('availableOfficialBtn').hidden, false);
  assert.match(node('availableToolkitBtn').textContent, /1\.7\.1/);
  assert.match(node('availableOfficialBtn').textContent, /2\.3\.2/);
  assert.equal(String(node('settingsUpdateCount').textContent), '2');
  assert.match(node('settingsTabUpdates').getAttribute('aria-label'), /2|工具集|Typeless/);

  context.ENV_INFO = { platform: 'windows' };
  context.renderUpdateIndicators();
  assert.equal(node('availableOfficialBtn').hidden, true);
  assert.equal(String(node('settingsUpdateCount').textContent), '1');

  context.TOOLKIT_UPDATE = null;
  context.OFFICIAL_UPDATE = null;
  context.renderUpdateIndicators();
  assert.equal(node('homeUpdateNotice').hidden, true);
  assert.equal(node('settingsUpdateBadge').hidden, true);
  assert.equal(node('availableToolkitBtn').hidden, true);
  assert.equal(node('availableOfficialBtn').hidden, true);
  assert.doesNotMatch(node('settingsTabUpdates').getAttribute('aria-label') || '', /1\.7\.1|2\.3\.2/);
});

test('clicking an update notice routes to the matching window without downloading or installing', async () => {
  const cases = [
    { updates: [], expected: ['settings', 'updates'] },
    { updates: [{ kind: 'toolkit', version: '1.7.1' }], expected: ['toolkit'] },
    { updates: [{ kind: 'official', version: '2.3.2' }], expected: ['official'] },
    { updates: [{ kind: 'toolkit', version: '1.7.1' }, { kind: 'official', version: '2.3.2' }], expected: ['modal', 'availableUpdatesMask'] },
  ];
  for (const scenario of cases) {
    const calls = [];
    const { context } = contextFor(['openAvailableUpdate'], {
      getAvailableUpdates: () => scenario.updates,
      renderUpdateIndicators() {},
      openSettings(tab) { calls.push(['settings', tab]); },
      openToolkitUpdate() { calls.push(['toolkit']); },
      openOfficialUpdate() { calls.push(['official']); },
      openModal(id) { calls.push(['modal', id]); },
      api() { assert.fail('opening a notice must not write through the API'); },
    });
    await context.openAvailableUpdate();
    assert.deepEqual(calls, [scenario.expected]);
  }
});

test('opening the official update window shows the dialog before checking local state', async () => {
  const calls = [];
  const { context } = contextFor(['openOfficialUpdate'], {
    openModal(id) { calls.push(['modal', id]); },
    async refreshOfficialUpdate() { calls.push(['check']); },
    renderOfficialUpdate() {},
    api() { assert.fail('opening the official update window must not start installation'); },
  });
  await context.openOfficialUpdate();
  assert.deepEqual(calls, [['modal', 'officialUpdateMask'], ['check']]);
});

test('background toolkit checks preserve in-progress and downloaded stages', async () => {
  for (const stage of [
    { state: 'checking', running: true },
    { state: 'downloading', running: true },
    { state: 'downloading', running: false },
    { state: 'downloaded', running: false },
    { state: 'installing', running: true },
    { state: 'installing', running: false },
  ]) {
    let renders = 0;
    const current = { ...toolkitUpdate, ...stage, download_path: '/mock/verified-update.dmg' };
    const { context } = contextFor(['refreshToolkitUpdate'], {
      TOOLKIT_UPDATE: current,
      renderToolkitUpdate() { renders += 1; },
      apiTimed() { assert.fail(`must not recheck release during ${stage.state}`); },
      toast() { assert.fail('preserving a download must not show a new release notification'); },
    });
    const result = await context.refreshToolkitUpdate(true);
    assert.equal(result, current);
    assert.equal(context.TOOLKIT_UPDATE, current);
    assert.equal(result.state, stage.state);
    assert.equal(result.download_path, '/mock/verified-update.dmg');
    assert.equal(renders, 1);
  }
});

test('an ordinary toolkit check reads release metadata and renders its result', async () => {
  const requests = [];
  let renders = 0;
  const { context } = contextFor(['refreshToolkitUpdate'], {
    async apiTimed(route, options = {}) {
      requests.push({ route, method: options.method || 'GET' });
      return { status: 'OK', data: toolkitUpdate };
    },
    renderToolkitUpdate() { renders += 1; },
    toast() {},
  });
  const result = await context.refreshToolkitUpdate();
  assert.deepEqual(requests, [{ route: '/api/toolkit-update', method: 'GET' }]);
  assert.equal(result, toolkitUpdate);
  assert.equal(renders, 1);
});

test('toolkit rendering refreshes shared update indicators', () => {
  let indicators = 0;
  const { context } = contextFor(['renderToolkitUpdate'], {
    renderUpdateIndicators() { indicators += 1; },
  });
  context.renderToolkitUpdate();
  assert.equal(indicators, 1);
});

test('official status refresh only reads local metadata and updates shared indicators', async () => {
  const requests = [];
  let indicators = 0;
  const { context } = contextFor(['renderOfficialUpdate', 'refreshOfficialUpdate'], {
    async api(route, options = {}) {
      requests.push({ route, method: options.method || 'GET' });
      return { status: 'OK', data: officialUpdate };
    },
    renderUpdateIndicators() { indicators += 1; },
  });
  await context.refreshOfficialUpdate();
  assert.deepEqual(requests, [{ route: '/api/official-update', method: 'GET' }]);
  assert.deepEqual(plain(context.OFFICIAL_UPDATE), officialUpdate);
  assert.equal(indicators, 1);
});

test('official update installation keeps its busy UI and skips background metadata refresh', async () => {
  let renders = 0;
  const { context } = contextFor(['refreshOfficialUpdate'], {
    OFFICIAL_UPDATE: officialUpdate,
    OFFICIAL_UPDATE_BUSY: true,
    api() { assert.fail('must not check local package metadata during installation'); },
    renderOfficialUpdate() { renders += 1; },
  });
  const result = await context.refreshOfficialUpdate();
  assert.equal(result, officialUpdate);
  assert.equal(context.OFFICIAL_UPDATE, officialUpdate);
  assert.equal(renders, 0);
});

test('failed official status checks clear stale update indicators and expose a readable error', async () => {
  const { context, node } = contextFor([
    'getAvailableUpdates', 'renderUpdateIndicators', 'renderOfficialUpdate', 'refreshOfficialUpdate',
  ], {
    OFFICIAL_UPDATE: officialUpdate,
    async api() { return { status: 'FAIL', msg: '缓存信息无法读取' }; },
  });
  context.renderOfficialUpdate();
  assert.equal(node('homeUpdateNotice').hidden, false);
  await context.refreshOfficialUpdate();
  assert.equal(context.OFFICIAL_UPDATE.available, false);
  assert.equal(node('homeUpdateNotice').hidden, true);
  assert.equal(node('officialUpdateActionBtn').hidden, true);
  assert.match(node('officialUpdateSummary').textContent, /缓存信息无法读取/);
});

test('official installation ignores a second click while an installation is busy', async () => {
  const { context } = contextFor(['installOfficialUpdate'], {
    OFFICIAL_UPDATE: officialUpdate,
    OFFICIAL_UPDATE_BUSY: true,
    refreshOfficialUpdate() { assert.fail('a busy installation must not refresh metadata'); },
    requestMacAppManagement() { assert.fail('a busy installation must not request permission again'); },
    performOfficialUpdate() { assert.fail('a busy installation must not start another installation'); },
    closeModal() { assert.fail('a busy installation must not change the current dialog'); },
    toast() { assert.fail('a repeated busy click must not show a new notice'); },
  });
  await context.installOfficialUpdate();
});

test('official installation stops when the local package disappears or changes after the dialog is shown', async () => {
  const scenarios = [
    { name: 'no result', result: null, message: /没有可安装/ },
    { name: 'unsupported platform', result: { supported: false, available: false, reason: '当前平台不支持' }, message: /当前平台不支持/ },
    { name: 'package is no longer newer', result: { ...officialUpdate, available: false, reason: '当前版本不低于已下载更新包' }, message: /当前版本不低于/ },
    { name: 'failed metadata read', result: { supported: true, available: false, error: '缓存信息无法读取' }, message: /缓存信息无法读取/ },
    { name: 'different package version', result: { ...officialUpdate, pending: { version: '2.3.3', fileName: 'Typeless-2.3.3-arm64.zip' } }, message: /更新包已变化/ },
  ];
  for (const scenario of scenarios) {
    let checks = 0;
    const notices = [];
    const { context } = contextFor(['installOfficialUpdate'], {
      OFFICIAL_UPDATE: officialUpdate,
      async refreshOfficialUpdate() { checks += 1; return scenario.result; },
      toast(message) { notices.push(message); },
      requestMacAppManagement() { assert.fail(`${scenario.name}: permission must not be requested`); },
      performOfficialUpdate() { assert.fail(`${scenario.name}: installation must not begin`); },
      closeModal() { assert.fail(`${scenario.name}: keep the update explanation visible`); },
    });
    await context.installOfficialUpdate();
    assert.equal(checks, 1, scenario.name);
    assert.equal(notices.length, 1, scenario.name);
    assert.match(notices[0], scenario.message, scenario.name);
  }
});

test('official installation only proceeds after permission succeeds and uses the freshly checked package', async () => {
  for (const permissionGranted of [false, true]) {
    const calls = [];
    let pendingAction;
    const refreshed = { ...officialUpdate, pending: { ...officialUpdate.pending, packagePath: '/mock/local-update.zip' } };
    const { context } = contextFor(['installOfficialUpdate'], {
      OFFICIAL_UPDATE: officialUpdate,
      async refreshOfficialUpdate() { calls.push('check'); return refreshed; },
      closeModal(id) { calls.push(['close', id]); },
      async requestMacAppManagement(action) {
        calls.push('permission');
        pendingAction = action;
        return permissionGranted;
      },
      async performOfficialUpdate(status) {
        assert.equal(status, refreshed, 'install the exact status validated after the user clicked');
        calls.push(['install', status.pending.version, status.pending.packagePath]);
      },
      confirm() { assert.fail('the explanatory modal replaces the old native confirmation'); },
      api() { assert.fail('this action must delegate installation, not issue its own API write'); },
      toast() { assert.fail('the unchanged valid package should not produce a stale-package notice'); },
    });
    await context.installOfficialUpdate();
    assert.equal(typeof pendingAction, 'function', 'permission handling receives the resumable install action');
    const expected = ['check', ['close', 'officialUpdateMask'], 'permission'];
    if (permissionGranted) expected.push(['install', '2.3.2', '/mock/local-update.zip']);
    assert.deepEqual(calls, expected, `permission granted: ${permissionGranted}`);
  }
});
