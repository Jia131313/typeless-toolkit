const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TYPELESS_MANAGER_PORT = '17888';
const {
  PORT,
  accountDeleteId,
  accountForClient,
  isTrustedLocalHost,
  isTrustedLocalOrigin,
  mergeAccountSyncConfig,
  shouldReconnectCurrent,
} = require('../manager');

function request(headers = {}) { return { headers }; }

test('only accepts the configured loopback Host header', () => {
  assert.equal(isTrustedLocalHost(request({ host: `127.0.0.1:${PORT}` })), true);
  assert.equal(isTrustedLocalHost(request({ host: `localhost:${PORT}` })), true);
  assert.equal(isTrustedLocalHost(request({ host: `attacker.example:${PORT}` })), false);
  assert.equal(isTrustedLocalHost(request({})), false);
});

test('rejects cross-origin browser requests while allowing local CLI calls', () => {
  assert.equal(isTrustedLocalOrigin(request({ origin: `http://127.0.0.1:${PORT}` })), true);
  assert.equal(isTrustedLocalOrigin(request({ origin: `http://localhost:${PORT}` })), true);
  assert.equal(isTrustedLocalOrigin(request({ origin: 'https://attacker.example' })), false);
  assert.equal(isTrustedLocalOrigin(request({})), true);
});

test('never exposes bearer tokens in account list responses', () => {
  assert.deepEqual(accountForClient({
    user_id: 'u1',
    email: 'user@example.com',
    token: 'secret-token',
    refresh_token: 'secret-refresh-token',
  }, { token_valid: true }, true), {
    user_id: 'u1',
    email: 'user@example.com',
    live: { token_valid: true },
    has_snapshot: true,
  });
});

test('keeps saved sync secrets when the settings form submits blank placeholders', () => {
  const merged = mergeAccountSyncConfig({
    enabled: true,
    provider: 'webdav',
    url: 'https://dav.example.test/',
    username: 'alice',
    password: 'webdav-secret',
    sync_password: 'vault-secret',
    remote_path: 'TypelessToolkit/accounts.vault.json',
  }, {
    enabled: true,
    provider: 'webdav',
    url: 'https://dav.example.test/',
    username: 'alice',
    password: '',
    sync_password: '',
    remote_path: 'TypelessToolkit/accounts.vault.json',
  });
  assert.equal(merged.password, 'webdav-secret');
  assert.equal(merged.sync_password, 'vault-secret');
});

test('account sync settings and tombstones are ignored runtime secrets', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^account-sync\.json$/m);
  assert.match(ignore, /^account-sync-tombstones\.json$/m);
});

test('account deletion only matches the exact account resource', () => {
  assert.equal(accountDeleteId('/api/accounts/user-1'), 'user-1');
  assert.equal(accountDeleteId('/api/accounts/user%202'), 'user 2');
  assert.equal(accountDeleteId('/api/accounts/user-1/word'), null);
  assert.equal(accountDeleteId('/api/accounts/user-1/sync'), null);
});

test('provides an explicit local activation route for cloud-only accounts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'manager.js'), 'utf8');
  assert.match(source, /p\.endsWith\('\/activate'\)/);
  assert.match(source, /activateAccountOnDevice\(account\)/);
});

test('periodic current-account detection never restarts Typeless implicitly', () => {
  assert.equal(shouldReconnectCurrent(true, null), false);
  assert.equal(shouldReconnectCurrent(true, '0'), false);
  assert.equal(shouldReconnectCurrent(false, '1'), false);
  assert.equal(shouldReconnectCurrent(true, '1'), true);
});

test('manager inline browser script remains valid JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0);
  for (const [, source] of scripts) new vm.Script(source);
});
