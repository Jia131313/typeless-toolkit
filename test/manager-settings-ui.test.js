const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');

function extractFunction(name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const match = signature.exec(html);
  assert.ok(match, `${name}() must exist`);
  const brace = html.indexOf('{', match.index);
  assert.notEqual(brace, -1, `${name}() must have a body`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(match.index, i + 1);
    }
  }
  assert.fail(`${name}() body is not balanced`);
}

function extractDivByClass(className) {
  const marker = `<div class="tool-group ${className}">`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `${className} group must exist`);
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    depth += /^<div\b/i.test(match[0]) ? 1 : -1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  assert.fail(`${className} group is not balanced`);
}

function buttonHandlers(fragment) {
  return [...fragment.matchAll(/<button\b[^>]*\bonclick="([^"]+)"[^>]*>/g)].map((match) => match[1]);
}

function assertUniqueId(id) {
  const matches = html.match(new RegExp(`\\bid=["']${id}["']`, 'g')) || [];
  assert.equal(matches.length, 1, `#${id} must exist exactly once`);
}

function makeElement(overrides = {}) {
  const classes = new Set();
  const attributes = new Map();
  return {
    hidden: false,
    value: '',
    checked: false,
    tabIndex: 0,
    dataset: {},
    focusCalls: 0,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    focus() { this.focusCalls += 1; },
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    ...overrides,
  };
}

test('all static HTML ids are unique and inline scripts are valid JavaScript', () => {
  const counts = new Map();
  for (const match of html.matchAll(/<[^>]+\bid=["']([^"']+)["'][^>]*>/g)) {
    const id = match[1];
    if (id.includes('${')) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const duplicates = [...counts].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, []);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'manager.html must contain an inline script');
  scripts.forEach((match, index) => assert.doesNotThrow(
    () => new vm.Script(match[1], { filename: `manager-inline-${index + 1}.js` }),
  ));
});

test('keeps the home page focused on five frequent actions and exposes settings', () => {
  for (const id of ['homePage', 'settingsPage', 'settingsBtn']) assertUniqueId(id);

  const primary = buttonHandlers(extractDivByClass('primary-tools'));
  const system = buttonHandlers(extractDivByClass('system-tools'));
  assert.deepEqual(primary, ['launch()', 'loadAccounts()', 'openMaster()']);
  assert.deepEqual(system, ['openRegisterWizard()', 'addAccount()']);
  assert.match(html, /id=["']settingsBtn["'][^>]*onclick=["']openSettings\(/);
});

test('keeps current-account and maintenance status together above the account grid', () => {
  const gridIndex = html.indexOf('<div id="grid" class="grid"></div>');
  const statusIndex = html.indexOf('<div class="home-status"');
  assert.notEqual(gridIndex, -1, 'account list must exist');
  assert.notEqual(statusIndex, -1, 'maintenance status must exist');
  assert.ok(statusIndex < gridIndex, 'maintenance status should remain visible above a long account list');
  assert.match(html, /<div class="home-heading">[\s\S]*?<div class="heading-actions">[\s\S]*?<div class="home-status"/);
  assert.match(html, /<div class="home-heading">[\s\S]*?id="curPill"/);
});

test('keeps snapshot state and account actions together in the card footer', () => {
  const source = extractFunction('render');
  const headIndex = source.indexOf('class="chead"');
  const snapshotIndex = source.indexOf('class="snap ');
  const quotaIndex = source.indexOf('class="quota"');
  const footerIndex = source.indexOf('class="cfoot"');
  assert.ok(headIndex < quotaIndex && quotaIndex < footerIndex, 'footer should follow the card information');
  assert.ok(footerIndex < snapshotIndex, 'snapshot state should be shown beside account actions');
  assert.doesNotMatch(source.slice(headIndex, quotaIndex), /class="snap /, 'account identity should not duplicate snapshot state');
});

test('renders account actions from current-account, snapshot, and cloud-only state', () => {
  const grid = makeElement({ innerHTML: '' });
  const elements = {
    grid,
    q: makeElement({ value: '' }),
    sort: makeElement({ value: 'added' }),
  };
  const accounts = [
    {
      user_id: 'current-id', nickname: '当前账号', email: 'current@example.com', role: 'free',
      has_snapshot: true, snapshot_ok: true,
      live: {
        token_valid: true,
        dict_count: 12,
        credential_days_left: 336,
        personal: { total_learning_ratio: 0.42 },
        usage: { week_word_usage_value: 2000, week_word_usage_limit: 8000 },
      },
    },
    {
      user_id: 'ready-id', nickname: '可切换账号', email: 'ready@example.com', role: 'pro',
      has_snapshot: true, snapshot_ok: true,
      live: { token_valid: true, dict_count: 8, credential_days_left: 343, personal: {}, usage: {} },
    },
    {
      user_id: 'mismatch-id', nickname: '串号快照', email: 'mismatch@example.com',
      has_snapshot: true, snapshot_ok: false, snapshot_mismatch: true, snapshot_email: 'other@example.com',
      live: { token_valid: false, dict_count: 3, personal: {}, usage: {} },
    },
    {
      user_id: 'missing-id', nickname: '缺少快照', email: 'missing@example.com',
      has_snapshot: false,
      live: { token_valid: true, dict_count: 0, personal: {}, usage: {} },
    },
    {
      user_id: 'cloud-id', nickname: '云端账号', email: 'cloud@example.com', cloud_only: true,
      has_snapshot: false,
      live: { token_valid: true, dict_count: 5, personal: {}, usage: {} },
    },
  ];
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id]; } },
    ACCOUNTS: accounts,
    CUR_ID: 'current-id',
  });
  vm.runInContext([
    extractFunction('esc'),
    extractFunction('pct'),
    extractFunction('nfmt'),
    extractFunction('uiIcon'),
    extractFunction('sortAccounts'),
    extractFunction('render'),
  ].join('\n'), context);
  context.render();

  function actionButton(functionName, id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<button\\b[^>]*onclick="[^"]*${functionName}\\('${escapedId}'\\)[^"]*"[^>]*>[\\s\\S]*?<\\/button>`);
    const match = grid.innerHTML.match(pattern);
    assert.ok(match, `${functionName}(${id}) action must be rendered`);
    return match[0];
  }

  const currentButton = actionButton('switchTo', 'current-id');
  assert.doesNotMatch(currentButton, /\bdisabled\b/);
  assert.match(currentButton, /重新切换/);

  const readyButton = actionButton('switchTo', 'ready-id');
  assert.doesNotMatch(readyButton, /\bdisabled\b/);
  assert.match(readyButton, />切换<\/button>/);

  assert.match(actionButton('switchTo', 'mismatch-id'), /\bdisabled\b/);
  assert.match(actionButton('switchTo', 'missing-id'), /\bdisabled\b/);
  assert.match(actionButton('activateAccount', 'cloud-id'), /在此设备启用/);
  assert.doesNotMatch(grid.innerHTML, /switchTo\('cloud-id'\)/);

  assert.match(grid.innerHTML, /2,000 \/ 8,000/);
  assert.match(grid.innerHTML, /width:25%/);
  assert.match(grid.innerHTML, /当前账号/);
  assert.match(grid.innerHTML, /免费版/);
  assert.match(grid.innerHTML, /<div class="v">12<\/div>/);
  assert.match(grid.innerHTML, /<div class="v">42%<\/div>/);
  assert.match(grid.innerHTML, /336天/);
  assert.match(grid.innerHTML, /快照已存/);
  assert.match(grid.innerHTML, /快照串号/);
  assert.match(grid.innerHTML, /未存快照/);
  assert.match(grid.innerHTML, /云端待启用/);
  assert.match(grid.innerHTML, />失效<\/span>/);
});

test('escapes quoted account names and emails in card text and title attributes', () => {
  const grid = makeElement({ innerHTML: '' });
  const elements = {
    grid,
    q: makeElement({ value: '' }),
    sort: makeElement({ value: 'added' }),
  };
  const nickname = `备注" onmouseover="alert('nickname') & <tag>`;
  const email = `" onfocus="alert('email') & <mail>@example.com`;
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id]; } },
    ACCOUNTS: [{ user_id: 'quoted-id', nickname, email, has_snapshot: true, live: {} }],
    CUR_ID: null,
  });
  vm.runInContext([
    extractFunction('esc'),
    extractFunction('pct'),
    extractFunction('nfmt'),
    extractFunction('uiIcon'),
    extractFunction('sortAccounts'),
    extractFunction('render'),
  ].join('\n'), context);

  assert.equal(context.esc(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  context.render();
  const escapedNickname = '备注&quot; onmouseover=&quot;alert(&#39;nickname&#39;) &amp; &lt;tag&gt;';
  const escapedEmail = '&quot; onfocus=&quot;alert(&#39;email&#39;) &amp; &lt;mail&gt;@example.com';
  assert.ok(grid.innerHTML.includes(`<div class="nick" title="${escapedNickname}">${escapedNickname}</div>`));
  assert.ok(grid.innerHTML.includes(`<div class="email" title="${escapedEmail}">${escapedEmail}</div>`));
  assert.doesNotMatch(grid.innerHTML, /\bon(?:mouseover|focus)="/);
});

test('provides four settings tabs and matching panels without duplicate ids', () => {
  for (const tab of ['general', 'sync', 'maintenance', 'updates']) {
    assertUniqueId(`settings-${tab}`);
    assert.match(html, new RegExp(`selectSettingsTab\\(['"]${tab}['"]\\)`));
  }
});

test('settings navigation switches between the home and settings pages', () => {
  const homeTopbar = makeElement();
  const homePage = makeElement();
  const settingsPage = makeElement({ hidden: true });
  const settingsBtn = makeElement();
  const settingsHeading = makeElement();
  const tabs = ['general', 'sync', 'maintenance', 'updates'].map((tab) => makeElement({ dataset: { settingsTab: tab } }));
  const panels = Object.fromEntries(tabs.map(({ dataset }) => {
    const id = `settings-${dataset.settingsTab}`;
    return [id, makeElement({ id })];
  }));
  const elements = { homeTopbar, homePage, settingsPage, settingsBtn, settingsHeading, ...panels };
  const document = {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(selector) {
      if (selector === '[data-settings-tab]') return tabs;
      if (selector === '.settings-panel') return Object.values(panels);
      return [];
    },
  };
  const scrollCalls = [];
  let syncLoads = 0;
  let syncRefreshes = 0;
  let updateRefreshes = 0;
  const context = vm.createContext({
    document,
    window: {
      scrollY: 184,
      scrollTo(x, y) { scrollCalls.push([x, y]); },
    },
    HOME_SCROLL: 0,
    SETTINGS_TAB: 'general',
    ACCOUNT_SYNC_LOADED: false,
    loadAccountSyncConfig() { syncLoads += 1; },
    refreshAccountSyncStatus() { syncRefreshes += 1; },
    refreshOfficialUpdate() { updateRefreshes += 1; },
  });
  vm.runInContext(`${extractFunction('selectSettingsTab')}\n${extractFunction('openSettings')}\n${extractFunction('closeSettings')}`, context);

  for (const selectedTab of ['general', 'sync', 'maintenance', 'updates']) {
    context.openSettings(selectedTab);
    assert.equal(homeTopbar.hidden, true, 'settings must not repeat the home header');
    assert.equal(homePage.hidden, true);
    assert.equal(settingsPage.hidden, false);
    assert.equal(settingsBtn.getAttribute('aria-pressed'), 'true');
    for (const panel of Object.values(panels)) {
      assert.equal(panel.hidden, panel.id !== `settings-${selectedTab}`);
    }
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === selectedTab;
      assert.equal(tab.getAttribute('aria-selected'), String(selected));
      assert.equal(tab.tabIndex, selected ? 0 : -1);
    }
  }
  assert.equal(syncLoads, 1);
  assert.equal(updateRefreshes, 1, 'opening updates should refresh the local Typeless cache');
  assert.equal(syncRefreshes, 0);
  assert.ok(settingsHeading.focusCalls >= 1);
  assert.deepEqual(scrollCalls[0], [0, 0]);

  context.closeSettings();
  assert.equal(homeTopbar.hidden, false);
  assert.equal(homePage.hidden, false);
  assert.equal(settingsPage.hidden, true);
  assert.equal(settingsBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(settingsBtn.focusCalls, 1);
  assert.deepEqual(scrollCalls.at(-1), [0, 184]);
});

test('keeps WebDAV fields in settings and maps checkbox scope to the existing API contract', () => {
  assert.doesNotMatch(html, /id=["']accountSyncMask["']/);
  for (const id of [
    'accountSyncProvider',
    'accountSyncUrl',
    'accountSyncUsername',
    'accountSyncPassword',
    'accountSyncPath',
    'accountSyncVaultPassword',
    'accountSyncAccounts',
    'accountSyncDictionary',
  ]) assertUniqueId(id);

  const elements = {
    accountSyncProvider: makeElement({ value: 'webdav' }),
    accountSyncUrl: makeElement({ value: ' https://dav.example.com/ ' }),
    accountSyncUsername: makeElement({ value: ' user@example.com ' }),
    accountSyncPassword: makeElement({ value: 'app-password' }),
    accountSyncPath: makeElement({ value: ' Toolkit/accounts.vault.json ' }),
    accountSyncVaultPassword: makeElement({ value: 'vault-password' }),
    accountSyncAccounts: makeElement(),
    accountSyncDictionary: makeElement(),
  };
  const document = { getElementById(id) { return elements[id]; } };
  const context = vm.createContext({ document });
  vm.runInContext(extractFunction('accountSyncPayload'), context);

  elements.accountSyncAccounts.checked = true;
  assert.equal(context.accountSyncPayload().sync_scope, 'accounts');

  elements.accountSyncAccounts.checked = false;
  elements.accountSyncDictionary.checked = true;
  assert.equal(context.accountSyncPayload().sync_scope, 'dictionary');

  elements.accountSyncAccounts.checked = true;
  assert.equal(context.accountSyncPayload().sync_scope, 'all');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.accountSyncPayload())),
    {
      enabled: true,
      provider: 'webdav',
      url: 'https://dav.example.com/',
      username: 'user@example.com',
      password: 'app-password',
      sync_password: 'vault-password',
      remote_path: 'Toolkit/accounts.vault.json',
      sync_scope: 'all',
    },
  );

  elements.accountSyncAccounts.checked = false;
  elements.accountSyncDictionary.checked = false;
  assert.throws(() => context.accountSyncPayload(), /账号|词库|同步内容/);

  elements.accountSyncProvider.value = 'disabled';
  assert.doesNotThrow(() => context.accountSyncPayload());
  assert.equal(context.accountSyncPayload().enabled, false);
});

test('loads WebDAV config once, keeps saved passwords blank, and preserves unsaved edits on tab revisit', async () => {
  const elements = {
    accountSyncStatus: makeElement({ textContent: '' }),
    accountSyncForm: makeElement({ disabled: false }),
    accountSyncReloadBtn: makeElement({ hidden: false }),
    accountSyncProvider: makeElement(),
    accountSyncAccounts: makeElement(),
    accountSyncDictionary: makeElement(),
    accountSyncUrl: makeElement(),
    accountSyncUsername: makeElement(),
    accountSyncPassword: makeElement({ value: 'must-be-cleared', placeholder: '' }),
    accountSyncVaultPassword: makeElement({ value: 'must-be-cleared', placeholder: '' }),
    accountSyncPath: makeElement(),
    accountSyncConfigured: makeElement({ textContent: '' }),
  };
  const tabs = ['general', 'sync', 'maintenance', 'updates'].map((tab) => makeElement({ dataset: { settingsTab: tab } }));
  const panels = tabs.map(({ dataset }) => makeElement({ id: `settings-${dataset.settingsTab}` }));
  let refreshes = 0;
  let loads = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll(selector) {
        if (selector === '[data-settings-tab]') return tabs;
        if (selector === '.settings-panel') return panels;
        return [];
      },
    },
    ACCOUNT_SYNC_LOADING: null,
    ACCOUNT_SYNC_LOADED: false,
    ACCOUNT_SYNC_ENABLED: false,
    SETTINGS_TAB: 'general',
    api: async (url) => {
      assert.equal(url, '/api/account-sync/config');
      loads += 1;
      return {
        status: 'OK',
        data: {
          enabled: true,
          provider: 'webdav',
          sync_scope: 'all',
          url: 'https://dav.example.com/',
          username: 'saved@example.com',
          remote_path: 'TypelessToolkit/accounts.vault.json',
          password_configured: true,
          sync_password_configured: true,
        },
      };
    },
    updateAccountSyncProvider() {},
    refreshAccountSyncStatus() { refreshes += 1; },
  });
  vm.runInContext(`${extractFunction('loadAccountSyncConfig')}\n${extractFunction('selectSettingsTab')}`, context);

  await context.loadAccountSyncConfig();
  assert.equal(loads, 1);
  assert.equal(context.ACCOUNT_SYNC_LOADED, true);
  assert.equal(elements.accountSyncForm.disabled, false);
  assert.equal(elements.accountSyncReloadBtn.hidden, true);
  assert.equal(elements.accountSyncAccounts.checked, true);
  assert.equal(elements.accountSyncDictionary.checked, true);
  assert.equal(elements.accountSyncPassword.value, '');
  assert.equal(elements.accountSyncVaultPassword.value, '');
  assert.match(elements.accountSyncPassword.placeholder, /已保存/);
  assert.match(elements.accountSyncVaultPassword.placeholder, /已保存/);

  elements.accountSyncUsername.value = 'unsaved@example.com';
  const refreshesAfterLoad = refreshes;
  context.selectSettingsTab('sync');
  assert.equal(loads, 1, 'revisiting sync settings must not reload config');
  assert.equal(refreshes, refreshesAfterLoad + 1);
  assert.equal(elements.accountSyncUsername.value, 'unsaved@example.com');
});

test('keeps WebDAV passwords blank when saving and exposes retry after config load failure', async () => {
  const saveElements = {
    accountSyncStatus: makeElement({ textContent: '' }),
    accountSyncProvider: makeElement({ value: 'webdav' }),
    accountSyncUrl: makeElement({ value: 'https://dav.example.com/' }),
    accountSyncUsername: makeElement({ value: 'user@example.com' }),
    accountSyncPassword: makeElement({ value: '', placeholder: '已保存；留空保持不变' }),
    accountSyncVaultPassword: makeElement({ value: '', placeholder: '已保存；留空保持不变' }),
    accountSyncPath: makeElement({ value: 'TypelessToolkit/accounts.vault.json' }),
    accountSyncAccounts: makeElement({ checked: true }),
    accountSyncDictionary: makeElement({ checked: true }),
    accountSyncConfigured: makeElement({ textContent: '' }),
  };
  let request;
  const saveContext = vm.createContext({
    document: { getElementById(id) { return saveElements[id]; } },
    ACCOUNT_SYNC_ENABLED: false,
    api: async (url, options) => {
      request = { url, options };
      return { status: 'OK', msg: '配置已保存' };
    },
    refreshAccountSyncStatus() {},
    toast() {},
  });
  vm.runInContext(`${extractFunction('accountSyncPayload')}\n${extractFunction('saveAccountSync')}`, saveContext);

  assert.equal(await saveContext.saveAccountSync(), true);
  assert.equal(request.url, '/api/account-sync/config');
  assert.equal(request.options.method, 'POST');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.password, '');
  assert.equal(payload.sync_password, '');
  assert.equal(payload.sync_scope, 'all');
  assert.equal(saveElements.accountSyncPassword.value, '');
  assert.equal(saveElements.accountSyncVaultPassword.value, '');

  const failureElements = {
    accountSyncStatus: makeElement({ textContent: '' }),
    accountSyncForm: makeElement({ disabled: false }),
    accountSyncReloadBtn: makeElement({ hidden: true }),
  };
  const failureContext = vm.createContext({
    document: { getElementById(id) { return failureElements[id]; } },
    ACCOUNT_SYNC_LOADING: null,
    ACCOUNT_SYNC_LOADED: false,
    api: async () => ({ status: 'FAIL', msg: '读取配置失败' }),
  });
  vm.runInContext(extractFunction('loadAccountSyncConfig'), failureContext);
  await failureContext.loadAccountSyncConfig();
  assert.equal(failureElements.accountSyncForm.disabled, true);
  assert.equal(failureElements.accountSyncReloadBtn.hidden, false);
  assert.match(failureElements.accountSyncStatus.textContent, /读取失败/);
  assert.equal(failureContext.ACCOUNT_SYNC_LOADED, false);
});

test('theme preference stores explicit themes and resolves system mode before applying it', () => {
  const calls = [];
  const stored = new Map();
  const localStorage = {
    setItem(key, value) { stored.set(key, value); },
    removeItem(key) { stored.delete(key); },
  };
  const context = vm.createContext({
    localStorage,
    matchMedia() { return { matches: true }; },
    applyTheme(theme) { calls.push(theme); },
  });
  vm.runInContext(extractFunction('setThemePreference'), context);

  context.setThemePreference('light');
  assert.equal(stored.get('tl_theme'), 'light');
  assert.equal(calls.at(-1), 'light');

  context.setThemePreference('dark');
  assert.equal(stored.get('tl_theme'), 'dark');
  assert.equal(calls.at(-1), 'dark');

  context.setThemePreference('system');
  assert.equal(stored.has('tl_theme'), false);
  assert.equal(calls.at(-1), 'dark');
});
