const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

test('manager uploads dictionary edits automatically and schedules downloaded words for account alignment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-webdav-manager-'));
  process.env.TYPELESS_DATA_DIR = root;
  process.env.TYPELESS_EXE = path.join(root, 'missing-app');
  process.env.TYPELESS_MANAGER_PORT = '17892';
  const C = require('../lib/common');
  let alignments = 0;
  C.syncAllAccounts = async () => { alignments++; return { results: [], account_count: 0, master_count: C.readMaster().length, all_aligned: true }; };
  const { encryptPayload, decryptPayload } = require('../lib/account-sync');
  let content = null;
  let revision = 0;
  const dav = http.createServer(async (req, res) => {
    if (req.method === 'MKCOL') { res.writeHead(201); return res.end(); }
    if (req.method === 'GET') {
      res.writeHead(content ? 200 : 404, { ETag: `"${revision}"` });
      return res.end(content || '');
    }
    if (req.method === 'PUT') {
      if ((content && req.headers['if-match'] !== `"${revision}"`) || (!content && req.headers['if-none-match'] !== '*')) {
        res.writeHead(412); return res.end();
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      content = Buffer.concat(chunks).toString();
      revision++;
      res.writeHead(201, { ETag: `"${revision}"` }); return res.end();
    }
    res.writeHead(405); res.end();
  });
  dav.listen(0, '127.0.0.1'); await once(dav, 'listening');
  fs.writeFileSync(path.join(root, 'account-sync.json'), JSON.stringify({
    enabled: true, provider: 'webdav', url: `http://127.0.0.1:${dav.address().port}/`,
    username: 'fixture', password: 'fixture', sync_password: 'fixture-secret', sync_scope: 'dictionary',
  }));
  const { server, PORT } = require('../manager');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => dav.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const api = async (route, body) => {
    const value = await new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${server.address().port}${route}`, {
        method: 'POST', headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json' },
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      request.on('error', reject);
      request.end(JSON.stringify(body || {}));
    });
    assert.equal(value.status, 'OK', value.msg);
    return value;
  };
  const until = async predicate => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'automatic synchronization timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const remoteTerms = () => content ? decryptPayload(content, 'fixture-secret', 'dictionary', 'terms').terms : [];
  await api('/api/master', { terms: ['本地词条'] });
  await until(() => remoteTerms().some(term => term.term === '本地词条' && !term.deleted_at));
  // Add a remote term, then pull through the real manager endpoint.
  content = encryptPayload({ version: 1, terms: [...remoteTerms(), {
    term: '另一台设备的词', updated_at: new Date().toISOString(), deleted_at: null,
  }] }, 'fixture-secret', 'dictionary');
  revision++;
  const before = alignments;
  await api('/api/account-sync/run');
  assert.deepEqual(new Set(C.readMaster()), new Set(['本地词条', '另一台设备的词']));
  await until(() => alignments > before);
  await api('/api/master', { terms: ['另一台设备的词'] });
  await until(() => remoteTerms().some(term => term.term === '本地词条' && term.deleted_at));
});
