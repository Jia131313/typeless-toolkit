const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  readManagerPort,
  preferredManagerPort,
  fallbackPortCandidates,
  probeToolkit,
  selectManagerEndpoint,
} = require('../lib/desktop-host');

function listenFixture(t, payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => server.close(done)));
      resolve(server.address().port);
    });
  });
}

test('desktop host reads a valid configured port and falls back for invalid config', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-host-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');

  fs.writeFileSync(config, JSON.stringify({ manager_port: 8123 }));
  assert.equal(readManagerPort(config), 8123);
  assert.equal(preferredManagerPort(config, '18123'), 18123);
  assert.equal(preferredManagerPort(config, 'invalid'), 8123);
  fs.writeFileSync(config, JSON.stringify({ manager_port: 99999 }));
  assert.equal(readManagerPort(config), 7788);
  fs.writeFileSync(config, '{broken');
  assert.equal(readManagerPort(config), 7788);
});

test('desktop host reuses only a verified toolkit service', async () => {
  const endpoint = await selectManagerEndpoint(7788, {
    probeToolkit: async port => port === 7788,
    canListen: async () => { throw new Error('must not bind when toolkit is verified'); },
  });
  assert.deepEqual(endpoint, { port: 7788, reuseExisting: true, reason: 'existing-toolkit' });
});

test('toolkit probe verifies the /api/env service identity', async t => {
  const toolkitPort = await listenFixture(t, {
    status: 'OK', data: { service: 'typeless-toolkit' },
  });
  const foreignPort = await listenFixture(t, {
    status: 'OK', data: { service: 'something-else' },
  });
  assert.equal(await probeToolkit(toolkitPort), true);
  assert.equal(await probeToolkit(foreignPort), false);
});

test('desktop host skips an occupied foreign service and picks a bindable fallback', async () => {
  const endpoint = await selectManagerEndpoint(7788, {
    probeToolkit: async () => false,
    canListen: async port => port === 7790,
  });
  assert.deepEqual(endpoint, { port: 7790, reuseExisting: false, reason: 'fallback' });
});

test('fallback ports match the Windows host search order without duplicates', () => {
  const ports = fallbackPortCandidates(17888);
  assert.deepEqual(ports.slice(0, 3), [17889, 17890, 17891]);
  assert.equal(new Set(ports).size, ports.length);
  assert.ok(ports.includes(17888));
  assert.ok(ports.includes(17988));
});
