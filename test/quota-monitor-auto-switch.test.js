const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuotaMonitor, parseQuota } = require('../lib/quota-monitor');

const tick = () => new Promise(resolve => setImmediate(resolve));

/** 可控的听写状态替身:isIdle 读变量,事件手动派发 */
function fakeDictation(idle = true) {
  const listeners = { idle: [], recording: [] };
  return {
    isIdle: () => idle,
    setIdle(value) { idle = value; },
    emit(name) { for (const fn of listeners[name] || []) fn(); },
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); return this; },
  };
}

function harness(overrides = {}) {
  const calls = [], timers = [], switches = [];
  let id = 'a', running = true, time = 100000;
  const accounts = ['a', 'b', 'c'].map(user_id => ({ user_id, nickname: user_id, token: 'secret' }));
  // 上限 2000:a 剩余 150(低于阈值 200),b 剩余 1900,c 剩余 1300
  const usage = { a: 1850, b: 100, c: 700 };
  const dictation = overrides.dictation === undefined ? fakeDictation(true) : overrides.dictation;
  const monitor = createQuotaMonitor({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'quota' },
    readAccounts: () => accounts, readCurrent: () => ({ user_id: id }), isRunning: () => running,
    inspectSnapshot: () => ({ snapshot_ok: true }),
    fetchQuota: async account => {
      calls.push(account.user_id);
      return parseQuota({ week_word_usage_value: usage[account.user_id], week_word_usage_limit: 2000 });
    },
    now: () => time,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cancelled = true; },
    dictation,
    switchAccount: async targetId => { switches.push(targetId); },
    fetchPersonalStats: async () => 0,
    countdownSeconds: 15,
    ...overrides,
  });
  // 自动切号只在监控已启动时推进(与生产环境一致:server 监听后调用 start)
  monitor.start();
  return { monitor, calls, timers, switches, dictation, accounts, usage,
    setId(value) { id = value; }, setRunning(value) { running = value; }, advance(ms) { time += ms; } };
}

const countdown = h => h.timers.find(timer => timer.ms === 15000);

test('未开启自动切号时保持只提醒的原有行为', async () => {
  const h = harness({ config: { enabled: true, remaining: 200 } });
  const state = await h.monitor.run();
  assert.equal(state.state, 'low');
  assert.equal(state.auto, null);
  assert.equal(countdown(h), undefined);
  assert.deepEqual(h.switches, []);
});

test('缺少听写状态来源时不会自动切换,只给出候选', async () => {
  const h = harness({ dictation: null });
  const state = await h.monitor.run();
  assert.equal(state.state, 'low');
  assert.equal(state.candidate.user_id, 'b');
  assert.deepEqual(h.switches, []);
});

test('开启自动切号且当前空闲时进入倒计时,倒计时结束才切换', async () => {
  const h = harness();
  const state = await h.monitor.run();
  assert.equal(state.state, 'auto_countdown');
  assert.ok(state.countdown_end);
  assert.deepEqual(h.switches, [], '倒计时期间不应切换');
  const timer = countdown(h);
  assert.ok(timer);
  timer.fn();
  await tick();
  assert.deepEqual(h.switches, ['b'], '按剩余额度最多选中 b');
  assert.equal(h.monitor.status().state, 'auto_done');
});

test('正在听写时不弹倒计时,说完后才进入倒计时', async () => {
  const dictation = fakeDictation(false);
  const h = harness({ dictation });
  const state = await h.monitor.run();
  assert.equal(state.state, 'auto_pending');
  assert.equal(countdown(h), undefined, '不应在听写期间启动倒计时');
  assert.deepEqual(h.switches, []);
  // 说完 → 空闲
  dictation.setIdle(true);
  dictation.emit('idle');
  assert.equal(h.monitor.status().state, 'auto_countdown');
});

test('倒计时期间开始听写会取消倒计时,下一个空闲窗口直接切换不再弹窗', async () => {
  const dictation = fakeDictation(true);
  const h = harness({ dictation });
  await h.monitor.run();
  assert.equal(h.monitor.status().state, 'auto_countdown');

  dictation.setIdle(false);
  dictation.emit('recording');
  const paused = h.monitor.status();
  assert.equal(paused.state, 'auto_pending');
  assert.equal(paused.countdown_end, null);

  // 再次空闲:直接切,不再启动倒计时
  dictation.setIdle(true);
  const timersBefore = h.timers.length;
  dictation.emit('idle');
  await tick();
  assert.deepEqual(h.switches, ['b']);
  assert.equal(h.timers.length, timersBefore, '不应再弹倒计时');
});

test('用户取消后本次低额度周期内不再自动切换', async () => {
  const h = harness();
  await h.monitor.run();
  assert.equal(h.monitor.status().state, 'auto_countdown');

  const cancelled = h.monitor.cancelAutoSwitch();
  assert.equal(cancelled.state, 'low');
  assert.equal(cancelled.auto, null);

  const again = await h.monitor.run();
  assert.equal(again.state, 'low');
  // mock 的 clearTimer 只做标记,所以检查倒计时是否已被取消而不是从数组移除
  const leftover = countdown(h);
  assert.ok(!leftover || leftover.cancelled, '倒计时应已被取消');
  assert.deepEqual(h.switches, []);
});

test('个性化策略按学习率挑选,而不是按额度', async () => {
  const ratios = { b: 0.02, c: 0.08 };
  const h = harness({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'personalized' },
    fetchPersonalStats: async userId => ratios[userId],
  });
  await h.monitor.run();
  countdown(h).fn();
  await tick();
  assert.deepEqual(h.switches, ['c'], 'c 的学习率更高');
});

test('个性化数据取不到时排到最后而不是中断切换', async () => {
  const h = harness({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'personalized' },
    fetchPersonalStats: async userId => { if (userId === 'c') throw new Error('boom'); return 0.02; },
  });
  await h.monitor.run();
  countdown(h).fn();
  await tick();
  assert.deepEqual(h.switches, ['b'], '取数失败的候选排在最后');
});

test('自定义顺序按用户指定次序挑选', async () => {
  const h = harness({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'custom', order: ['c', 'b'] },
  });
  await h.monitor.run();
  countdown(h).fn();
  await tick();
  assert.deepEqual(h.switches, ['c'], 'c 排在自定义顺序前面');
});

test('自定义顺序里没有可用账号时不切换', async () => {
  const h = harness({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'custom', order: ['b'] },
  });
  h.usage.b = 1990; // b 剩余 10,不满足额度门槛
  const state = await h.monitor.run();
  assert.equal(state.state, 'low');
  assert.equal(state.candidate, null);
  assert.deepEqual(h.switches, []);
});

test('没有额度充足的备用账号时只提醒', async () => {
  const h = harness();
  h.usage.b = 1950; h.usage.c = 1980; // 剩余 50 / 20,均不高于阈值
  const state = await h.monitor.run();
  assert.equal(state.state, 'low');
  assert.equal(state.candidate, null);
  assert.equal(countdown(h), undefined);
  assert.deepEqual(h.switches, []);
});

test('切换失败时不重试并给出说明', async () => {
  const h = harness({ switchAccount: async () => { throw new Error('快照损坏'); } });
  await h.monitor.run();
  countdown(h).fn();
  await tick();
  const state = h.monitor.status();
  assert.equal(state.state, 'error');
  assert.equal(state.error_code, 'AUTO_SWITCH_FAILED');
  assert.match(state.message, /快照损坏/);
  assert.match(state.message, /不会自动重试/);
});

test('倒计时结束时若已重新开始听写则退回等待,不执行切换', async () => {
  const dictation = fakeDictation(true);
  const h = harness({ dictation });
  await h.monitor.run();
  const timer = countdown(h);
  // 倒计时到点的同时用户又开始说话
  dictation.setIdle(false);
  timer.fn();
  await tick();
  assert.deepEqual(h.switches, []);
  assert.equal(h.monitor.status().state, 'auto_pending');
});

test('静默模式:不弹倒计时,空闲即切', async () => {
  const dictation = fakeDictation(true);
  const h = harness({ dictation, config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'quota', silent: true } });
  await h.monitor.run();
  await tick();
  // 静默模式不该出现倒计时窗口,也不该安排倒计时定时器
  assert.equal(h.monitor.status().state, 'auto_done');
  assert.equal(countdown(h), undefined, '静默模式不应启动倒计时');
  assert.deepEqual(h.switches, ['b']);
});

test('静默模式:正在听写时等待,说完直接切', async () => {
  const dictation = fakeDictation(false);
  const h = harness({ dictation, config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'quota', silent: true } });
  await h.monitor.run();
  assert.equal(h.monitor.status().state, 'auto_pending');
  assert.deepEqual(h.switches, []);
  dictation.setIdle(true);
  dictation.emit('idle');
  await tick();
  assert.equal(h.monitor.status().state, 'auto_done');
  assert.deepEqual(h.switches, ['b']);
});

test('开启自动切号时不再单独发额度不足提醒,只保留切换那一刻的提示', async () => {
  const dictation = fakeDictation(false);
  const h = harness({ dictation, config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'quota' } });
  const state = await h.monitor.run();
  assert.equal(state.state, 'auto_pending');
  // 自动流程已接管,alert_id 应为空(不发“额度不足”那条)
  assert.equal(state.alert_id, null);
});

test('未开启自动切号时仍按原样发额度不足提醒', async () => {
  const h = harness({ config: { enabled: true, remaining: 200 } });
  const state = await h.monitor.run();
  assert.equal(state.state, 'low');
  assert.ok(state.alert_id, '未开自动切号时应保留 alert_id');
});

test('静默模式下切换失败仍给出提示', async () => {
  const h = harness({
    config: { enabled: true, remaining: 200, auto_switch: true, strategy: 'quota', silent: true },
    switchAccount: async () => { throw new Error('快照损坏'); },
  });
  await h.monitor.run();
  await tick();
  const state = h.monitor.status();
  assert.equal(state.state, 'error');
  assert.equal(state.error_code, 'AUTO_SWITCH_FAILED');
  assert.ok(state.alert_id, '失败必须留下提示标识');
});
