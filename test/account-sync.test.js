const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decryptVault,
  encryptVault,
  mergeVaults,
  portableRecords,
} = require('../lib/account-sync');

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fixture`;
}

function refresh(userId, iat, exp) {
  return jwt({ type: 'refresh', iat, exp, subject: { user_id: userId } });
}

test('encrypted vault round trips with randomized authenticated envelopes', () => {
  const vault = { version: 1, updated_at: '2026-09-01T00:00:00.000Z', accounts: [] };
  const one = encryptVault(vault, 'correct horse battery staple');
  const two = encryptVault(vault, 'correct horse battery staple');
  assert.notEqual(one, two);
  assert.deepEqual(decryptVault(one, 'correct horse battery staple'), vault);
  assert.throws(() => decryptVault(one, 'wrong password'), /密码|损坏/);

  const envelope = JSON.parse(one);
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  assert.throws(() => decryptVault(JSON.stringify(envelope), 'correct horse battery staple'), /密码|损坏/);
});

test('portable records exclude access tokens, snapshots, paths, and device data', () => {
  const token = refresh('u1', 10, 1000);
  assert.deepEqual(portableRecords([{
    user_id: 'u1', nickname: 'One', email: 'one@example.test', client_user_id: 'c1',
    refresh_token: token, token: 'access-secret', profile: 'snapshot', path: 'C:\\private',
    device_id: 'device-secret', updated_at: '2026-09-01T00:00:00.000Z',
  }], []), [{
    user_id: 'u1', nickname: 'One', email: 'one@example.test', client_user_id: 'c1',
    refresh_token: token, updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null,
  }]);

  assert.deepEqual(portableRecords([{ user_id: 'u2', refresh_token: refresh('other', 1, 2) }], []), []);
});

test('deterministically merges additions, metadata, credentials, and tombstones', () => {
  const oldToken = refresh('u1', 10, 1000);
  const newToken = refresh('u1', 20, 900);
  const merged = mergeVaults([
    { version: 1, accounts: [
      { user_id: 'u1', nickname: 'Old', email: 'one@example.test', refresh_token: oldToken, updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
      { user_id: 'u2', nickname: 'Two', refresh_token: refresh('u2', 5, 500), updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
    ] },
    { version: 1, accounts: [
      { user_id: 'u1', nickname: 'New', email: 'one@example.test', refresh_token: newToken, updated_at: '2026-09-02T00:00:00.000Z', deleted_at: null },
      { user_id: 'u2', updated_at: '2026-09-03T00:00:00.000Z', deleted_at: '2026-09-03T00:00:00.000Z' },
      { user_id: 'u3', nickname: 'Three', refresh_token: refresh('u3', 1, 500), updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
    ] },
  ], '2026-09-04T00:00:00.000Z');

  assert.deepEqual(merged.accounts.map(x => x.user_id), ['u1', 'u2', 'u3']);
  assert.equal(merged.accounts[0].nickname, 'New');
  assert.equal(merged.accounts[0].refresh_token, newToken);
  assert.equal(merged.accounts[1].deleted_at, '2026-09-03T00:00:00.000Z');
  assert.equal(merged.updated_at, '2026-09-04T00:00:00.000Z');
});
