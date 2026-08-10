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
  }, { token_valid: true }, true), {
    user_id: 'u1',
    email: 'user@example.com',
    live: { token_valid: true },
    has_snapshot: true,
  });
});

test('account deletion only matches the exact account resource', () => {
  assert.equal(accountDeleteId('/api/accounts/user-1'), 'user-1');
  assert.equal(accountDeleteId('/api/accounts/user%202'), 'user 2');
  assert.equal(accountDeleteId('/api/accounts/user-1/word'), null);
  assert.equal(accountDeleteId('/api/accounts/user-1/sync'), null);
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
