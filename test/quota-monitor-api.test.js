const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('quota HTTP settings persist; guarded switch rejects stale suggestions and switches only after explicit POST', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-quota-api-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  process.env.TYPELESS_DATA_DIR = root;
  process.env.TYPELESS_MANAGER_PORT = String(port);
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify([
    { user_id: 'a', nickname: 'Current', token: 'private-a' }, { user_id: 'b', nickname: 'Backup', token: 'private-b' },
  ]));
  const C = require('../lib/common');
  let current = 'a', kills = 0, launches = 0, requests = 0, targetUsed = 0;
  Object.assign(C, {
    detectCurrentAccountFromFile: () => ({ found: true, user_id: current }),
    isTypelessRunning: () => true,
    inspectSnapshot: () => ({ has_snapshot: true, snapshot_ok: true }),
    ensureAccountAccessToken: async a => a.token,
    curlApi: async (method, route, token) => {
      assert.equal(route, '/user/usage_stats'); requests++;
      return { data: { voice_transcription: { week_word_usage_value: token === 'private-a' ? 1900 : targetUsed, week_word_usage_limit: 2000 } } };
    },
    envInfo: () => ({ service: 'typeless-toolkit' }),
    killTypeless: () => { kills++; }, launchTypeless: async () => { launches++; },
    saveSnapshot: () => {}, restoreSnapshot: id => { current = id; },
    applyOnboardingCompleteToLiveFiles: () => {}, healOnboardingAfterRestore: () => ({ healed: false }), sleep: async () => {},
  });
  const { server, quotaMonitor } = require('../manager');
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); // 不启动自动维护。
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (url, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, body === undefined ? { headers } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { code: response.status, body: await response.json() };
  };
  assert.equal((await call('/api/env')).body.data.service, 'typeless-toolkit');
  assert.equal((await call('/api/current')).body.data.user_id, 'a');
  assert.equal((await call('/api/quota-monitor/status')).body.data.config.enabled, false);
  assert.equal(requests, 0);
  assert.equal((await call('/api/quota-monitor/config', { enabled: true, remaining: -1 })).code, 400);
  assert.equal((await call('/api/quota-monitor/config', { enabled: true, remaining: 200 }, { Origin: 'https://example.test' })).code, 403);
  assert.equal((await call('/api/quota-monitor/config', { enabled: true, remaining: 200 })).code, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'quota-monitor.json'))),
    { enabled: true, remaining: 200, auto_switch: false, strategy: 'quota', order: [] });
  const state = await quotaMonitor.run();
  assert.equal(state.candidate.user_id, 'b'); assert.equal(kills, 0); assert.equal(launches, 0);
  const status = await call('/api/quota-monitor/status'); assert.ok(!JSON.stringify(status).includes('private-'));
  const notice = await fetch(`http://127.0.0.1:${port}/api/quota-monitor/notification`).then(r => r.text());
  assert.equal(notice, state.alert_id);
  targetUsed = 1950;
  const failed = await call('/api/accounts/b/switch', { quota_guard: { current_user_id: 'a', alert_id: state.alert_id } });
  assert.equal(failed.code, 409); assert.equal(kills, 0);
  targetUsed = 0; quotaMonitor.check(); const fresh = await quotaMonitor.run();
  const success = await call('/api/accounts/b/switch', { quota_guard: { current_user_id: 'a', alert_id: fresh.alert_id } });
  assert.equal(success.code, 200); assert.equal(kills, 1); assert.equal(launches, 1);
  assert.equal((await call('/api/current')).body.data.user_id, 'b');
  const stale = await call('/api/accounts/b/switch', { quota_guard: { current_user_id: 'a', alert_id: fresh.alert_id } });
  assert.equal(stale.code, 409); assert.equal(kills, 1);
});
