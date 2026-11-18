'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

test('主词库接口合并重复词，并拒绝超过 500 条删除', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-master-api-'));
  process.env.TYPELESS_DATA_DIR = root;
  process.env.TYPELESS_EXE = path.join(root, 'missing-app');
  process.env.TYPELESS_MANAGER_PORT = '17915';
  const C = require('../lib/common');
  const { server, PORT } = require('../manager');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const post = body => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${server.address().port}/api/master`, {
      method: 'POST', headers: { Host: `127.0.0.1:${PORT}`, 'Content-Type': 'application/json' },
    }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', x => { text += x; }); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(text) })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const merged = await post({ terms: [' Alpha ', 'alpha', 'Ｂ', 'B'] });
  assert.equal(merged.code, 200);
  assert.deepEqual(merged.body.merged, ['alpha']);
  assert.deepEqual(new Set(merged.body.data), new Set(['Alpha', 'Ｂ', 'B']));
  C.writeMaster(Array.from({ length: 501 }, (_, i) => `fixture-${i}`));
  const before = fs.readFileSync(C.MASTER_CSV, 'utf8');
  const rejected = await post({ terms: [] });
  assert.equal(rejected.code, 400);
  assert.equal(fs.readFileSync(C.MASTER_CSV, 'utf8'), before);
});
