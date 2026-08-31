const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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
    remote_path: 'TypelessToolkit/accounts.vault.json', password_configured: true, sync_password_configured: true,
  });
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
