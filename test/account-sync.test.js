const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const {
  decryptVault,
  encryptVault,
  mergeVaults,
  portableRecords,
  createAccountSyncService,
  createWebDavProvider,
  normalizeSyncConfig,
  redactSyncConfig,
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

  const weakSalt = crypto.randomBytes(16), weakIv = crypto.randomBytes(12);
  const weakKey = crypto.scryptSync('correct horse battery staple', weakSalt, 32, { N: 1024, r: 8, p: 1 });
  const weakCipher = crypto.createCipheriv('aes-256-gcm', weakKey, weakIv);
  weakCipher.setAAD(Buffer.from('typeless-toolkit-account-vault:v1'));
  const weakContent = Buffer.concat([weakCipher.update(JSON.stringify(vault)), weakCipher.final()]);
  assert.throws(() => decryptVault(JSON.stringify({
    version: 1, cipher: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 1024, r: 8, p: 1, key_length: 32 },
    salt: weakSalt.toString('base64'), iv: weakIv.toString('base64'),
    ciphertext: weakContent.toString('base64'), tag: weakCipher.getAuthTag().toString('base64'),
  }), 'correct horse battery staple'), /密码|损坏/);
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

  const tiedActive = { user_id: 'tie', nickname: 'Active', refresh_token: refresh('tie', 1, 500), updated_at: '2026-09-05T00:00:00.000Z', deleted_at: null };
  const tiedDelete = { user_id: 'tie', updated_at: '2026-09-05T00:00:00.000Z', deleted_at: '2026-09-05T00:00:00.000Z' };
  const forward = mergeVaults([{ version: 1, accounts: [tiedActive] }, { version: 1, accounts: [tiedDelete] }]);
  const reverse = mergeVaults([{ version: 1, accounts: [tiedDelete] }, { version: 1, accounts: [tiedActive] }]);
  assert.deepEqual(forward.accounts, reverse.accounts);
  assert.equal(forward.accounts[0].deleted_at, tiedDelete.deleted_at);

  const tiedOld = { user_id: 'active-tie', nickname: 'Old', refresh_token: refresh('active-tie', 1, 500), updated_at: '2026-09-06T00:00:00.000Z', deleted_at: null };
  const tiedNew = { user_id: 'active-tie', nickname: 'New', refresh_token: refresh('active-tie', 2, 500), updated_at: '2026-09-06T00:00:00.000Z', deleted_at: null };
  const activeForward = mergeVaults([{ version: 1, accounts: [tiedOld] }, { version: 1, accounts: [tiedNew] }]);
  const activeReverse = mergeVaults([{ version: 1, accounts: [tiedNew] }, { version: 1, accounts: [tiedOld] }]);
  assert.deepEqual(activeForward.accounts, activeReverse.accounts);
  assert.equal(activeForward.accounts[0].nickname, 'New');
});

test('validates WebDAV URLs, applies the Nutstore preset, and redacts secrets', () => {
  assert.throws(() => normalizeSyncConfig({ enabled: true, provider: 'webdav', url: 'http://example.com/dav/' }), /HTTPS/);
  assert.doesNotThrow(() => normalizeSyncConfig({ enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/dav/' }));
  const config = normalizeSyncConfig({
    enabled: true, provider: 'nutstore', username: 'user@example.test', password: 'app-password', sync_password: 'vault-password',
  });
  assert.equal(config.url, 'https://dav.jianguoyun.com/dav/');
  assert.equal(config.remote_path, 'TypelessToolkit/accounts.vault.json');
  assert.deepEqual(redactSyncConfig(config), {
    enabled: true, provider: 'nutstore', url: 'https://dav.jianguoyun.com/dav/', username: 'user@example.test',
    remote_path: 'TypelessToolkit/accounts.vault.json', dictionary_remote_path: 'TypelessToolkit/dictionary.vault.json',
    sync_scope: 'accounts', password_configured: true, sync_password_configured: true,
  });
});

test('WebDAV requests never forward Basic credentials through automatic redirects', async () => {
  const provider = createWebDavProvider({
    enabled: true, provider: 'webdav', url: 'https://dav.example.test/',
    username: 'u', password: 'p', sync_password: 'vault',
  }, async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 207 });
  });
  await provider.testConnection();
});

test('WebDAV provider creates, reads, and conditionally updates an ETag vault', async t => {
  let content = null;
  let etag = null;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'MKCOL') { res.writeHead(201); return res.end(); }
    if (req.method === 'PROPFIND') { res.writeHead(207); return res.end(); }
    if (req.method === 'GET') {
      if (content === null) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { ETag: etag }); return res.end(content);
    }
    if (req.method === 'PUT') {
      if (content === null && req.headers['if-none-match'] !== '*') { res.writeHead(412); return res.end(); }
      if (content !== null && req.headers['if-match'] !== etag) { res.writeHead(412); return res.end(); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      content = Buffer.concat(chunks).toString('utf8');
      etag = `"rev-${Date.now()}"`;
      res.writeHead(201, { ETag: etag }); return res.end();
    }
    res.writeHead(405); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const provider = createWebDavProvider(normalizeSyncConfig({
    enabled: true, provider: 'webdav', url: `http://127.0.0.1:${port}/dav/`, username: 'u', password: 'p',
    sync_password: 'vault', remote_path: 'Toolkit/accounts.vault.json',
  }));

  assert.equal((await provider.testConnection()).ok, true);
  assert.deepEqual(await provider.readVault(), { exists: false, content: null, revision: null });
  const first = await provider.writeVault('one', null);
  assert.match(first.revision, /^"rev-/);
  assert.deepEqual(await provider.readVault(), { exists: true, content: 'one', revision: first.revision });
  await assert.rejects(provider.writeVault('bad', '"stale"'), error => error.code === 'WEBDAV_CONFLICT');
  const second = await provider.writeVault('two', first.revision);
  assert.notEqual(second.revision, first.revision);
});

test('sync service retries ETag conflicts, merges remote accounts, and remains single-flight', async () => {
  const localToken = refresh('u1', 10, 1000);
  const remoteToken = refresh('u2', 20, 1000);
  let local = [{ user_id: 'u1', nickname: 'One', refresh_token: localToken, token: 'local-access', updated_at: '2026-09-01T00:00:00.000Z' }];
  let tombstones = [];
  let remote = encryptVault({ version: 1, updated_at: '2026-09-01T00:00:00.000Z', accounts: [
    { user_id: 'u2', nickname: 'Two', email: 'two@example.test', client_user_id: 'c2', refresh_token: remoteToken, updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
  ] }, 'vault-password');
  let reads = 0;
  let writes = 0;
  const provider = {
    async readVault() { reads++; return { exists: true, content: remote, revision: `"${reads}"` }; },
    async writeVault(next) {
      writes++;
      if (writes === 1) { const error = new Error('conflict'); error.code = 'WEBDAV_CONFLICT'; throw error; }
      remote = next; return { revision: '"done"' };
    },
  };
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/dav/', sync_password: 'vault-password' }),
    readAccountsFn: () => local,
    writeAccountsFn: next => { local = next; },
    readTombstonesFn: () => tombstones,
    writeTombstonesFn: next => { tombstones = next; },
    providerFactory: () => provider,
    nowFn: () => new Date('2026-09-02T00:00:00.000Z'),
  });

  const [a, b] = await Promise.all([service.sync('manual'), service.sync('duplicate')]);
  assert.deepEqual(a, b);
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.deepEqual(local.map(x => x.user_id), ['u1', 'u2']);
  assert.equal(local[0].token, 'local-access');
  assert.equal(local[1].token, null);
  assert.equal(local[1].cloud_only, true);
  assert.equal(service.status().state, 'success');
});

test('two devices converge additions and deletions through one encrypted WebDAV vault', async () => {
  let remoteContent = null;
  let revision = 0;
  const providerFactory = () => ({
    async readVault() {
      return remoteContent === null
        ? { exists: false, content: null, revision: null }
        : { exists: true, content: remoteContent, revision: `"${revision}"` };
    },
    async writeVault(content, expectedRevision) {
      const expected = remoteContent === null ? null : `"${revision}"`;
      if (expectedRevision !== expected) {
        const error = new Error('conflict'); error.code = 'WEBDAV_CONFLICT'; throw error;
      }
      remoteContent = content; revision++;
      return { revision: `"${revision}"` };
    },
  });
  const config = () => ({
    enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/dav/',
    username: 'u', password: 'p', sync_password: 'shared-password',
  });
  let accountsA = [{ user_id: 'a', nickname: 'A', refresh_token: refresh('a', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' }];
  let accountsB = [{ user_id: 'b', nickname: 'B', refresh_token: refresh('b', 1, 500), updated_at: '2026-09-02T00:00:00.000Z' }];
  let tombstonesA = [], tombstonesB = [];
  const service = (readAccounts, writeAccounts, readTombstones, writeTombstones, now) => createAccountSyncService({
    readConfigFn: config, readAccountsFn: readAccounts, writeAccountsFn: writeAccounts,
    readTombstonesFn: readTombstones, writeTombstonesFn: writeTombstones,
    providerFactory, nowFn: () => new Date(now),
  });
  const a1 = service(() => accountsA, next => { accountsA = next; }, () => tombstonesA, next => { tombstonesA = next; }, '2026-09-03T00:00:00.000Z');
  const b1 = service(() => accountsB, next => { accountsB = next; }, () => tombstonesB, next => { tombstonesB = next; }, '2026-09-04T00:00:00.000Z');
  await a1.sync('device-a');
  await b1.sync('device-b');
  await a1.sync('device-a-pull');
  assert.deepEqual(accountsA.map(item => item.user_id), ['a', 'b']);
  assert.deepEqual(accountsB.map(item => item.user_id), ['a', 'b']);

  accountsA = accountsA.filter(item => item.user_id !== 'a');
  tombstonesA = [{ user_id: 'a', deleted_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z' }];
  const a2 = service(() => accountsA, next => { accountsA = next; }, () => tombstonesA, next => { tombstonesA = next; }, '2026-09-05T00:00:00.000Z');
  const b2 = service(() => accountsB, next => { accountsB = next; }, () => tombstonesB, next => { tombstonesB = next; }, '2026-09-06T00:00:00.000Z');
  await a2.sync('delete-a');
  await b2.sync('pull-delete');
  assert.deepEqual(accountsB.map(item => item.user_id), ['b']);
  assert.deepEqual(tombstonesB.map(item => item.user_id), ['a']);
});
