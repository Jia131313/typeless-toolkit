const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuotaConfig, parseQuota, createQuotaFetcher, createQuotaMonitor } = require('../lib/quota-monitor');

function harness(overrides = {}) {
  const calls = [], timers = [];
  let id = 'a', running = true, time = 100000;
  const accounts = ['a', 'b', 'c', 'bad'].map(user_id => ({ user_id, nickname: user_id, token: 'secret' }));
  const usage = { a: 1850, b: 100, c: 700, bad: 0 };
  const monitor = createQuotaMonitor({
    config: { enabled: true, remaining: 200 },
    readAccounts: () => accounts, readCurrent: () => ({ user_id: id }), isRunning: () => running,
    inspectSnapshot: target => ({ snapshot_ok: target !== 'bad', snapshot_mismatch: target === 'bad' }),
    fetchQuota: async account => { calls.push(account.user_id); return parseQuota({ week_word_usage_value: usage[account.user_id], week_word_usage_limit: 2000 }); },
    now: () => time,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cancelled = true; }, ...overrides,
  });
  return { monitor, calls, timers, accounts, usage, setId(value) { id = value; }, setRunning(value) { running = value; }, advance(ms) { time += ms; } };
}

test('quota config is opt-in and unknown or unlimited quota is never guessed', () => {
  assert.deepEqual(normalizeQuotaConfig(), { enabled: false, remaining: 200 });
  for (const remaining of [0, -1, 1.5, '200', Infinity]) assert.throws(() => normalizeQuotaConfig({ remaining }));
  for (const usage of [{}, { week_word_usage_value: 0 }, { week_word_usage_value: 5, week_word_usage_limit: -1 },
    { week_word_usage_value: null, week_word_usage_limit: 2000 }]) assert.throws(() => parseQuota(usage));
  assert.deepEqual(parseQuota({ week_word_usage_value: 2100, week_word_usage_limit: 2000 }), { used: 2100, limit: 2000, remaining: 0 });
});

test('fetcher performs only the usage request and rejects failures without exposing raw credentials', async () => {
  const requests = [];
  const fetch = createQuotaFetcher({ ensureAccessToken: async () => 'secret', request: async (...args) => {
    requests.push(args); return { data: { voice_transcription: { week_word_usage_value: 1800, week_word_usage_limit: 2000 } } };
  } });
  assert.equal((await fetch({})).remaining, 200);
  assert.deepEqual(requests, [['POST', '/user/usage_stats', 'secret', {}]]);
  await assert.rejects(createQuotaFetcher({ ensureAccessToken: async () => { throw new Error('secret'); } })({}), error => !error.message.includes('secret'));
  await assert.rejects(createQuotaFetcher({ ensureAccessToken: async () => 'secret', request: async () => ({ _error: 'timeout', _raw: 'secret' }) })({}));
});

test('disabled and stopped Typeless never cause upstream requests', async () => {
  const h = harness(); h.monitor.configure({ enabled: false, remaining: 200 }); h.monitor.start();
  assert.equal((await h.monitor.run()).state, 'disabled'); assert.equal(h.calls.length, 0);
  h.monitor.configure({ enabled: true, remaining: 200 }); h.setRunning(false);
  assert.equal((await h.monitor.run()).state, 'paused'); assert.equal(h.calls.length, 0);
});

test('official unsupported-client response is explicit, pauses retries, and permits manual recovery', async () => {
  let blocked = true;
  const fetchQuota = createQuotaFetcher({ ensureAccessToken: async () => 'secret', request: async () => blocked
    ? { code: 20006, status: 'FAIL', detail: 'This client is not supported. Please use the official Typeless app.', data: {} }
    : { data: { voice_transcription: { week_word_usage_value: 100, week_word_usage_limit: 2000 } } } });
  await assert.rejects(fetchQuota({}), { code: 'CLIENT_UNSUPPORTED' });
  const h = harness({ fetchQuota }); h.monitor.start();
  const state = await h.monitor.run();
  assert.equal(state.error_code, 'CLIENT_UNSUPPORTED');
  assert.match(state.message, /官方接口不支持当前客户端/);
  assert.equal(state.next_check_at, null);
  assert.equal(h.timers.filter(t => !t.cancelled).length, 0);
  assert.equal(state.candidate, null);
  blocked = false; h.monitor.check();
  assert.equal(h.timers.at(-1).ms, 0);
  const recovered = await h.monitor.run();
  assert.equal(recovered.state, 'healthy'); assert.equal(recovered.error_code, null);
  assert.equal(h.timers.at(-1).ms, 120000);
});

test('healthy current account does not scan backups and near threshold increases frequency', async () => {
  const h = harness(); h.monitor.start(); h.usage.a = 1000;
  assert.equal((await h.monitor.run()).state, 'healthy');
  assert.deepEqual(h.calls, ['a']); assert.equal(h.timers.at(-1).ms, 120000);
  h.usage.a = 1650; await h.monitor.run(); assert.equal(h.timers.at(-1).ms, 30000);
});

test('low quota recommends highest remaining valid snapshot and caches backups without credentials', async () => {
  const h = harness(); const state = await h.monitor.run();
  assert.equal(state.state, 'low'); assert.equal(state.candidate.user_id, 'b');
  assert.deepEqual(h.calls, ['a', 'b', 'c']); assert.ok(!JSON.stringify(state).includes('secret'));
  const next = await h.monitor.run(); assert.equal(next.alert_id, state.alert_id);
  assert.deepEqual(h.calls, ['a', 'b', 'c', 'a']);
  h.advance(300001); await h.monitor.run(); assert.deepEqual(h.calls.slice(-3), ['a', 'b', 'c']);
});

test('errors are unknown, retried with backoff; recovering resets delay', async () => {
  let fail = true;
  const h = harness({ fetchQuota: async () => { if (fail) throw new Error('timeout'); return { used: 0, limit: 2000, remaining: 2000 }; } });
  h.monitor.start();
  assert.equal((await h.monitor.run()).state, 'error'); assert.equal(h.timers.at(-1).ms, 120000);
  await h.monitor.run(); assert.equal(h.timers.at(-1).ms, 240000);
  fail = false; assert.equal((await h.monitor.run()).state, 'healthy'); assert.equal(h.timers.at(-1).ms, 120000);
});

test('unavailable backups still yield low-quota warning, not a made-up candidate', async () => {
  const h = harness({ fetchQuota: async a => { if (a.user_id !== 'a') throw new Error('expired'); return { used: 1900, limit: 2000, remaining: 100 }; } });
  const state = await h.monitor.run(); assert.equal(state.state, 'low'); assert.equal(state.candidate, null); assert.equal(state.candidate_errors, 2);
});

test('overlapping checks share one request and discard results after account change', async () => {
  let release; let count = 0;
  const h = harness({ fetchQuota: async () => { count++; return new Promise(resolve => { release = resolve; }); } });
  const first = h.monitor.run(), second = h.monitor.run(); assert.equal(first, second);
  await Promise.resolve(); assert.equal(count, 1); h.setId('b'); release({ used: 1800, limit: 2000, remaining: 200 });
  const state = await first; assert.equal(state.candidate, null); assert.equal(state.alert_id, null); assert.equal(state.state, 'waiting');
});

test('disabling during an active query cannot publish a late warning', async () => {
  let release;
  const h = harness({ fetchQuota: () => new Promise(resolve => { release = resolve; }) });
  const first = h.monitor.run(); await Promise.resolve(); h.monitor.configure({ enabled: false, remaining: 200 });
  release({ used: 1900, limit: 2000, remaining: 100 });
  assert.equal((await first).state, 'disabled'); assert.equal(h.monitor.status().candidate, null);
});

test('explicit switch rechecks both quotas, rejects stale identities, exhausted targets and recovered current quota', async () => {
  const h = harness(); const state = await h.monitor.run();
  const guard = { current_user_id: 'a', alert_id: state.alert_id };
  assert.equal((await h.monitor.validateSwitch('b', guard)).user_id, 'b');
  assert.deepEqual(h.calls.slice(-2), ['a', 'b']);
  h.usage.b = 1999; await assert.rejects(h.monitor.validateSwitch('b', guard), /额度不足/);
  h.usage.b = 0; h.usage.a = 0; await assert.rejects(h.monitor.validateSwitch('b', guard), /额度已恢复/);
  h.setId('c'); await assert.rejects(h.monitor.validateSwitch('b', guard), /已变化/);
});

test('a reset or changed current account creates a new notification episode', async () => {
  const h = harness(); const first = await h.monitor.run(); h.usage.a = 0; await h.monitor.run();
  h.usage.a = 1900; const second = await h.monitor.run(); assert.notEqual(second.alert_id, first.alert_id);
  h.monitor.invalidate(); await assert.rejects(h.monitor.validateSwitch('b', { current_user_id: 'a', alert_id: second.alert_id }));
});
