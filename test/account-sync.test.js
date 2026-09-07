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
  encryptPayload, decryptPayload, mergeDictionaryVaults,
  dictionaryRecords,
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

test('dictionary payloads are independently encrypted and merge normalized tombstones', () => {
  const payload = { version: 1, terms: [{ term: 'Hello', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null }] };
  const encrypted = encryptPayload(payload, 'pw', 'dictionary');
  assert.deepEqual(decryptPayload(encrypted, 'pw', 'dictionary', 'terms'), payload);
  assert.throws(() => decryptPayload(encrypted, 'pw', 'account', 'terms'), /密码|损坏/);
  const merged = mergeDictionaryVaults([{ terms: [
    { term: 'Hello', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
    { term: 'hello', updated_at: '2026-09-02T00:00:00.000Z', deleted_at: '2026-09-02T00:00:00.000Z' },
  ] }]);
  assert.equal(merged.terms.length, 1);
  assert.equal(merged.terms[0].deleted_at, '2026-09-02T00:00:00.000Z');
});

test('dictionary records preserve local timestamps and newer re-add beats deletion', () => {
  const old = '2026-09-01T00:00:00.000Z';
  const records = dictionaryRecords(['Word'], { active: { word: { term: 'Word', updated_at: old } }, tombstones: {} }, '2026-09-10T00:00:00.000Z');
  assert.equal(records[0].updated_at, old);
  const merged = mergeDictionaryVaults([
    { terms: [{ term: 'Word', updated_at: '2026-09-03T00:00:00.000Z', deleted_at: '2026-09-03T00:00:00.000Z' }] },
    { terms: [{ term: 'word', updated_at: '2026-09-04T00:00:00.000Z', deleted_at: null }] },
  ]);
  assert.equal(merged.terms[0].deleted_at, null);
});

test('sync scopes isolate account and dictionary providers', async () => {
  const calls = [];
  const provider = path => ({ async readVault() { calls.push(`read:${path}`); return { exists: false, content: null, revision: null }; }, async writeVault() { calls.push(`write:${path}`); return { revision: null }; } });
  const run = scope => createAccountSyncService({ readConfigFn: () => ({ enabled: true, provider: 'webdav', sync_scope: scope, url: 'http://127.0.0.1:1/', username: 'u', password: 'p', sync_password: 'pw' }), readAccountsFn: () => [], writeAccountsFn: () => {}, readTombstonesFn: () => [], writeTombstonesFn: () => {}, readDictionaryFn: () => ['x'], writeDictionaryFn: () => {}, providerFactory: (_c, _f, path) => provider(path || 'accounts') });
  await run('dictionary').sync();
  assert.deepEqual(calls, ['read:TypelessToolkit/dictionary.vault.json', 'write:TypelessToolkit/dictionary.vault.json']);
  calls.length = 0;
  await run('accounts').sync();
  assert.deepEqual(calls, ['read:accounts', 'write:accounts']);
});

test('unchanged account and dictionary vaults are read without another PUT', async () => {
  const contents = new Map();
  const revisions = new Map();
  const writes = new Map();
  const providerFactory = (_config, _fetch, remotePath = 'accounts') => ({
    async readVault() {
      return contents.has(remotePath)
        ? { exists: true, content: contents.get(remotePath), revision: revisions.get(remotePath) }
        : { exists: false, content: null, revision: null };
    },
    async writeVault(content, expectedRevision) {
      assert.equal(expectedRevision, revisions.get(remotePath) || null);
      contents.set(remotePath, content);
      const revision = `"${(writes.get(remotePath) || 0) + 1}"`;
      revisions.set(remotePath, revision);
      writes.set(remotePath, (writes.get(remotePath) || 0) + 1);
      return { revision };
    },
  });
  let accounts = [{ user_id: 'u1', nickname: 'One', refresh_token: refresh('u1', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' }];
  let accountTombstones = [];
  let terms = ['Alpha'];
  let dictionaryMeta = { active: { alpha: { term: 'Alpha', updated_at: '2026-09-01T00:00:00.000Z' } }, tombstones: {} };
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', sync_scope: 'all', url: 'http://127.0.0.1:9999/', sync_password: 'pw' }),
    readAccountsFn: () => accounts, writeAccountsFn: next => { accounts = next; },
    readTombstonesFn: () => accountTombstones, writeTombstonesFn: next => { accountTombstones = next; },
    readDictionaryFn: () => terms, writeDictionaryFn: next => { terms = next; },
    readDictionaryTombstonesFn: () => dictionaryMeta,
    writeDictionaryTombstonesFn: next => { dictionaryMeta = { ...dictionaryMeta, tombstones: next }; },
    providerFactory, nowFn: () => new Date('2026-09-02T00:00:00.000Z'),
  });

  await service.sync('first');
  await service.sync('unchanged');
  assert.equal(writes.get('accounts'), 1);
  assert.equal(writes.get('TypelessToolkit/dictionary.vault.json'), 1);
});

test('an empty device pulls existing account and dictionary vaults without PUT', async () => {
  const remoteAccount = encryptVault({ version: 1, updated_at: '2026-09-01T00:00:00.000Z', accounts: [
    { user_id: 'u1', nickname: 'One', email: '', client_user_id: null, refresh_token: refresh('u1', 1, 500), updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
  ] }, 'pw');
  const remoteDictionary = encryptPayload({ version: 1, updated_at: '2026-09-01T00:00:00.000Z', terms: [
    { term: 'Alpha', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null },
  ] }, 'pw', 'dictionary');
  let writes = 0;
  const providerFactory = (_config, _fetch, remotePath = 'accounts') => ({
    async readVault() {
      return { exists: true, content: remotePath === 'accounts' ? remoteAccount : remoteDictionary, revision: '"remote"' };
    },
    async writeVault() { writes++; throw new Error('empty pull must not write'); },
  });
  let accounts = [], accountTombstones = [], terms = [], dictionaryTombstones = {};
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', sync_scope: 'all', url: 'http://127.0.0.1:9999/', sync_password: 'pw' }),
    readAccountsFn: () => accounts, writeAccountsFn: next => { accounts = next; },
    readTombstonesFn: () => accountTombstones, writeTombstonesFn: next => { accountTombstones = next; },
    readDictionaryFn: () => terms, writeDictionaryFn: next => { terms = next; },
    readDictionaryTombstonesFn: () => ({ active: {}, tombstones: dictionaryTombstones }),
    writeDictionaryTombstonesFn: next => { dictionaryTombstones = next; },
    providerFactory, nowFn: () => new Date('2026-09-02T00:00:00.000Z'),
  });

  await service.sync('empty-pull');
  assert.equal(writes, 0);
  assert.deepEqual(accounts.map(item => item.user_id), ['u1']);
  assert.deepEqual(terms, ['Alpha']);
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

  accountsB.push({ user_id: 'a', nickname: 'A again', refresh_token: refresh('a', 2, 600), updated_at: '2026-09-07T00:00:00.000Z' });
  tombstonesB = [];
  const b3 = service(() => accountsB, next => { accountsB = next; }, () => tombstonesB, next => { tombstonesB = next; }, '2026-09-07T00:00:00.000Z');
  const a3 = service(() => accountsA, next => { accountsA = next; }, () => tombstonesA, next => { tombstonesA = next; }, '2026-09-08T00:00:00.000Z');
  await b3.sync('explicit-readd');
  await a3.sync('pull-readd');
  assert.deepEqual(accountsA.map(item => item.user_id), ['a', 'b']);
  assert.deepEqual(accountsB.map(item => item.user_id), ['a', 'b']);
  assert.deepEqual(tombstonesA, []);
  assert.deepEqual(tombstonesB, []);
});

test('two devices merge disjoint account sets without replacing either side', async () => {
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
      remoteContent = content;
      revision++;
      return { revision: `"${revision}"` };
    },
  });
  const config = () => ({
    enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/dav/',
    username: 'u', password: 'p', sync_password: 'shared-password',
  });
  const makeAccounts = ids => ids.map((id, index) => ({
    user_id: id, nickname: id, refresh_token: refresh(id, index + 1, 500),
    updated_at: `2026-09-0${index + 1}T00:00:00.000Z`,
  }));
  let accountsA = makeAccounts(['1', '2', '3']);
  let accountsB = makeAccounts(['7', '8', '9']);
  const service = (readAccounts, writeAccounts, now) => createAccountSyncService({
    readConfigFn: config, readAccountsFn: readAccounts, writeAccountsFn: writeAccounts,
    readTombstonesFn: () => [], writeTombstonesFn: () => {}, providerFactory,
    nowFn: () => new Date(now),
  });

  await service(() => accountsA, next => { accountsA = next; }, '2026-09-10T00:00:00.000Z').sync('device-a');
  await service(() => accountsB, next => { accountsB = next; }, '2026-09-11T00:00:00.000Z').sync('device-b');
  await service(() => accountsA, next => { accountsA = next; }, '2026-09-12T00:00:00.000Z').sync('device-a-pull');

  assert.deepEqual(accountsA.map(item => item.user_id), ['1', '2', '3', '7', '8', '9']);
  assert.deepEqual(accountsB.map(item => item.user_id), ['1', '2', '3', '7', '8', '9']);
  assert.deepEqual(decryptVault(remoteContent, 'shared-password').accounts.map(item => item.user_id), ['1', '2', '3', '7', '8', '9']);
});

test('an offline stale device cannot revive a deletion, but a newer explicit re-add can', async () => {
  const deletedAt = '2026-09-05T00:00:00.000Z';
  const stale = { user_id: 'u1', nickname: 'Old', refresh_token: refresh('u1', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' };
  const deletion = { user_id: 'u1', updated_at: deletedAt, deleted_at: deletedAt };
  const afterStaleSync = mergeVaults([{ accounts: [deletion] }, { accounts: [stale] }]);
  assert.equal(afterStaleSync.accounts[0].deleted_at, deletedAt);

  const readded = { user_id: 'u1', nickname: 'Back', refresh_token: refresh('u1', 2, 600), updated_at: '2026-09-06T00:00:00.000Z' };
  const afterReadd = mergeVaults([afterStaleSync, { accounts: [readded] }]);
  assert.equal(afterReadd.accounts[0].deleted_at, null);
  assert.equal(afterReadd.accounts[0].nickname, 'Back');
});

test('a 412 retry re-reads and preserves a competing device addition', async () => {
  let local = [{ user_id: 'a', nickname: 'A', refresh_token: refresh('a', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' }];
  let tombstones = [];
  let remoteVault = { version: 1, accounts: [{ user_id: 'b', nickname: 'B', refresh_token: refresh('b', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' }] };
  let revision = 1;
  let writes = 0;
  const provider = {
    async readVault() { return { exists: true, content: encryptVault(remoteVault, 'pw'), revision: `"${revision}"` }; },
    async writeVault(content, expectedRevision) {
      writes++;
      if (writes === 1) {
        remoteVault = mergeVaults([remoteVault, { accounts: [{ user_id: 'c', nickname: 'C', refresh_token: refresh('c', 1, 500), updated_at: '2026-09-02T00:00:00.000Z' }] }]);
        revision++;
        const error = new Error('conflict'); error.code = 'WEBDAV_CONFLICT'; throw error;
      }
      assert.equal(expectedRevision, `"${revision}"`);
      remoteVault = decryptVault(content, 'pw');
      revision++;
      return { revision: `"${revision}"` };
    },
  };
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/', sync_password: 'pw' }),
    readAccountsFn: () => local, writeAccountsFn: next => { local = next; },
    readTombstonesFn: () => tombstones, writeTombstonesFn: next => { tombstones = next; },
    providerFactory: () => provider, nowFn: () => new Date('2026-09-03T00:00:00.000Z'),
  });

  await service.sync('conflict');
  assert.deepEqual(local.map(item => item.user_id), ['a', 'b', 'c']);
  assert.deepEqual(remoteVault.accounts.map(item => item.user_id), ['a', 'b', 'c']);
});

test('local additions and deletions made during a WebDAV write are included before sync completes', async () => {
  let local = [
    { user_id: 'keep', nickname: 'Keep', refresh_token: refresh('keep', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' },
    { user_id: 'remove', nickname: 'Remove', refresh_token: refresh('remove', 1, 500), updated_at: '2026-09-01T00:00:00.000Z' },
  ];
  let tombstones = [];
  let remoteContent = null;
  let revision = 0;
  let writes = 0;
  const provider = {
    async readVault() {
      return remoteContent === null
        ? { exists: false, content: null, revision: null }
        : { exists: true, content: remoteContent, revision: `"${revision}"` };
    },
    async writeVault(content, expectedRevision) {
      const expected = remoteContent === null ? null : `"${revision}"`;
      assert.equal(expectedRevision, expected);
      remoteContent = content;
      revision++;
      writes++;
      if (writes === 1) {
        local = local.filter(item => item.user_id !== 'remove');
        local.push({ user_id: 'added', nickname: 'Added', refresh_token: refresh('added', 2, 600), updated_at: '2026-09-04T00:00:00.000Z' });
        tombstones = [{ user_id: 'remove', updated_at: '2026-09-04T00:00:00.000Z', deleted_at: '2026-09-04T00:00:00.000Z' }];
      }
      return { revision: `"${revision}"` };
    },
  };
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', url: 'http://127.0.0.1:9999/', sync_password: 'pw' }),
    readAccountsFn: () => local, writeAccountsFn: next => { local = next; },
    readTombstonesFn: () => tombstones, writeTombstonesFn: next => { tombstones = next; },
    providerFactory: () => provider, nowFn: () => new Date('2026-09-04T00:00:00.000Z'),
  });

  await service.sync('local-mutation');
  assert.equal(writes, 2);
  assert.deepEqual(local.map(item => item.user_id), ['added', 'keep']);
  assert.deepEqual(tombstones.map(item => item.user_id), ['remove']);
  const remote = decryptVault(remoteContent, 'pw');
  assert.deepEqual(remote.accounts.map(item => [item.user_id, !!item.deleted_at]), [['added', false], ['keep', false], ['remove', true]]);
});

test('dictionary additions and deletions made during a WebDAV write are included before sync completes', async () => {
  let terms = ['Keep', 'Remove'];
  let meta = { active: {
    keep: { term: 'Keep', updated_at: '2026-09-01T00:00:00.000Z' },
    remove: { term: 'Remove', updated_at: '2026-09-01T00:00:00.000Z' },
  }, tombstones: {} };
  let remoteContent = null;
  let revision = 0;
  let writes = 0;
  const provider = {
    async readVault() {
      return remoteContent === null
        ? { exists: false, content: null, revision: null }
        : { exists: true, content: remoteContent, revision: `"${revision}"` };
    },
    async writeVault(content, expectedRevision) {
      assert.equal(expectedRevision, remoteContent === null ? null : `"${revision}"`);
      remoteContent = content;
      revision++;
      writes++;
      if (writes === 1) {
        terms = ['Keep', 'Added'];
        meta = { active: {
          keep: meta.active.keep,
          added: { term: 'Added', updated_at: '2026-09-04T00:00:00.000Z' },
        }, tombstones: {
          remove: { term: 'Remove', updated_at: '2026-09-04T00:00:00.000Z', deleted_at: '2026-09-04T00:00:00.000Z' },
        } };
      }
      return { revision: `"${revision}"` };
    },
  };
  const service = createAccountSyncService({
    readConfigFn: () => ({ enabled: true, provider: 'webdav', sync_scope: 'dictionary', url: 'http://127.0.0.1:9999/', sync_password: 'pw' }),
    readAccountsFn: () => [], writeAccountsFn: () => {}, readTombstonesFn: () => [], writeTombstonesFn: () => {},
    readDictionaryFn: () => terms, writeDictionaryFn: next => { terms = next; },
    readDictionaryTombstonesFn: () => meta,
    writeDictionaryTombstonesFn: next => { meta = { ...meta, tombstones: next }; },
    providerFactory: () => provider, nowFn: () => new Date('2026-09-04T00:00:00.000Z'),
  });

  await service.sync('dictionary-local-mutation');
  assert.equal(writes, 2);
  assert.deepEqual(terms, ['Added', 'Keep']);
  assert.deepEqual(Object.keys(meta.tombstones), ['remove']);
  const remote = decryptPayload(remoteContent, 'pw', 'dictionary', 'terms');
  assert.deepEqual(remote.terms.map(item => [item.term, !!item.deleted_at]), [['Added', false], ['Keep', false], ['Remove', true]]);
});
