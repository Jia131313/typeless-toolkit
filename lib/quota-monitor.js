'use strict';

const NORMAL_INTERVAL = 120_000;
const NEAR_INTERVAL = 30_000;
const CACHE_TTL = 5 * 60_000;
const MAX_RETRY_INTERVAL = 15 * 60_000;

function normalizeQuotaConfig(value = {}) {
  const enabled = value.enabled ?? false;
  const remaining = value.remaining ?? 200;
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(remaining) || remaining < 1) {
    throw new Error('提醒开关必须为布尔值，剩余额度阈值必须为正整数');
  }
  return { enabled, remaining };
}

function parseQuota(usage) {
  const used = usage?.week_word_usage_value;
  const limit = usage?.week_word_usage_limit;
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('额度未知：接口未返回有效的已用字数和上限');
  }
  return { used, limit, remaining: Math.max(0, limit - used) };
}

function createQuotaFetcher({ ensureAccessToken, request }) {
  return async account => {
    let token;
    try { token = await ensureAccessToken(account); }
    catch { throw new Error('无法续签登录凭证，请检查网络或重新收录该账号'); }
    const response = await request('POST', '/user/usage_stats', token, {});
    if (Number(response?.code) === 20006) {
      const error = new Error('官方接口不支持当前客户端，无法查询额度。自动重试已暂停，请在 Typeless 官方应用中查看额度；可点击“立即检查”重新尝试。');
      error.code = 'CLIENT_UNSUPPORTED';
      throw error;
    }
    // 不透传上游原始响应，避免错误信息携带凭证或其他账号数据。
    if (response?._error || response?.detail || response?.success === false) {
      throw new Error('额度查询失败，请检查网络和登录凭证；稍后自动重试');
    }
    return parseQuota(response?.data?.voice_transcription);
  };
}

// 仅观察和推荐；模块不持有启动、停止或切换 Typeless 的能力。
function createQuotaMonitor({ readAccounts, readCurrent, isRunning, inspectSnapshot, fetchQuota,
  config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let settings = normalizeQuotaConfig(config);
  let timer = null, inFlight = null, started = false, generation = 0, failures = 0;
  let episode = null, sequence = 0;
  const cache = new Map();
  let state = { state: settings.enabled ? 'waiting' : 'disabled', message: settings.enabled ? '等待检查' : '额度提醒已关闭',
    current: null, candidate: null, alert_id: null, checked_at: null, next_check_at: null, candidate_errors: 0 };
  const status = () => ({ ...state, config: { ...settings } });
  const snapshotOK = id => {
    const snap = inspectSnapshot(id);
    return !!snap.snapshot_ok && !snap.snapshot_mismatch;
  };
  const accountSummary = (account, quota) => ({ user_id: account.user_id,
    name: account.nickname || account.email || account.user_id, ...quota });
  const currentId = () => readCurrent()?.user_id || null;
  const valid = (revision, id) => revision === generation && settings.enabled && isRunning() && currentId() === id;

  function schedule(delay) {
    if (timer) clearTimer(timer);
    timer = null;
    state.next_check_at = null;
    if (!started || !settings.enabled || delay === null) return;
    state.next_check_at = new Date(now() + delay).toISOString();
    timer = setTimer(() => { timer = null; run(); }, delay);
    timer?.unref?.();
  }

  async function query(account, fresh = false) {
    const item = cache.get(account.user_id);
    if (!fresh && item && now() - item.at < CACHE_TTL) {
      if (item.error) throw new Error(item.error);
      return item.quota;
    }
    try {
      const quota = await fetchQuota(account);
      cache.set(account.user_id, { quota, at: now() });
      return quota;
    } catch (error) {
      cache.set(account.user_id, { error: error.message, at: now() });
      throw error;
    }
  }

  function run() {
    if (inFlight) return inFlight;
    if (!settings.enabled) return Promise.resolve(status());
    if (timer) clearTimer(timer);
    timer = null;
    const revision = generation;
    let delay = NORMAL_INTERVAL;
    state = { ...state, state: 'checking', message: '正在检查额度', current: null, candidate: null,
      alert_id: null, next_check_at: null, candidate_errors: 0, error_code: null };
    inFlight = Promise.resolve().then(async () => {
      if (revision !== generation) return;
      if (!isRunning()) {
        state.state = 'paused'; state.message = 'Typeless 未运行，等待启动'; return;
      }
      const id = currentId();
      const accounts = readAccounts();
      const account = accounts.find(item => item.user_id === id);
      if (!account) {
        state.state = 'waiting'; state.message = '请登录并收录当前账号'; return;
      }
      const quota = await query(account, true);
      if (!valid(revision, id)) return;
      state.current = accountSummary(account, quota);
      state.checked_at = new Date(now()).toISOString();
      failures = 0;
      delay = quota.remaining <= settings.remaining * 2 ? NEAR_INTERVAL : NORMAL_INTERVAL;
      if (quota.remaining > settings.remaining) {
        episode = null;
        state.state = 'healthy'; state.message = `当前账号剩余 ${quota.remaining} 字`; return;
      }
      if (!episode || episode.id !== id) episode = { id, key: `${now()}-${++sequence}` };
      // 先发布额度不足提醒，备用账号较多或网络慢时不延迟通知。
      state = { ...state, state: 'low', alert_id: episode.key,
        message: `当前账号剩余 ${quota.remaining} 字，正在检查备用账号` };
      let candidate = null, errors = 0;
      const eligible = accounts.filter(item => item.user_id !== id && snapshotOK(item.user_id));
      // 当前账号接近耗尽时才检查备用号；逐个请求，五分钟内复用成功或失败结果。
      for (const other of eligible) {
        if (!valid(revision, id)) return;
        try {
          const otherQuota = await query(other);
          if (otherQuota.remaining > settings.remaining && (!candidate || otherQuota.remaining > candidate.remaining)) {
            candidate = accountSummary(other, otherQuota);
          }
        } catch { errors++; }
      }
      if (!valid(revision, id)) return;
      // 扫描期间账号可能被删除或快照更新。
      if (candidate && (!readAccounts().some(a => a.user_id === candidate.user_id) || !snapshotOK(candidate.user_id))) candidate = null;
      state = { ...state, state: 'low', candidate, candidate_errors: errors, alert_id: episode.key,
        message: candidate ? `当前账号剩余 ${quota.remaining} 字，备用账号已就绪`
          : `当前账号剩余 ${quota.remaining} 字；${errors ? '部分备用账号查询失败，暂未找到可用账号' : '暂无额度充足且快照有效的备用账号'}` };
    }).catch(error => {
      if (revision !== generation) return;
      failures++;
      delay = Math.min(NORMAL_INTERVAL * (2 ** Math.min(failures - 1, 3)), MAX_RETRY_INTERVAL);
      const unsupported = error.code === 'CLIENT_UNSUPPORTED';
      if (unsupported) delay = null;
      state = { ...state, state: 'error', current: null, candidate: null, alert_id: null,
        error_code: unsupported ? 'CLIENT_UNSUPPORTED' : 'QUOTA_UNAVAILABLE',
        message: unsupported
          ? '官方接口不支持当前客户端，无法查询额度。自动重试已暂停，请在 Typeless 官方应用中查看额度；可点击“立即检查”重新尝试。'
          : '额度查询失败或数据未知，请检查网络与账号凭证；稍后自动重试' };
    }).finally(() => {
      inFlight = null;
      if (revision === generation) {
        // 当前身份改变、程序退出时，废弃本轮结果，而不是发布旧推荐。
        if (state.state === 'checking' || (state.current && (!isRunning() || currentId() !== state.current.user_id))) {
          state = { ...state, state: 'waiting', message: '当前账号已变化，等待重新检查', current: null, candidate: null, alert_id: null };
          delay = NEAR_INTERVAL;
        }
        schedule(delay);
      } else schedule(0);
    }).then(status);
    return inFlight;
  }

  function invalidate() {
    generation++;
    episode = null;
    state = { ...state, state: settings.enabled ? 'waiting' : 'disabled', current: null, candidate: null,
      alert_id: null, checked_at: null, candidate_errors: 0, error_code: null, message: settings.enabled ? '等待检查' : '额度提醒已关闭' };
    schedule(0);
    return status();
  }

  async function validateSwitch(targetId, guard) {
    const revision = generation;
    const id = guard?.current_user_id;
    if (!settings.enabled || !id || !guard.alert_id || guard.alert_id !== episode?.key || episode?.id !== id ||
      !valid(revision, id) || id === targetId) throw new Error('当前账号或提醒已变化，请刷新后重新选择');
    const accounts = readAccounts();
    const target = accounts.find(a => a.user_id === targetId);
    const current = accounts.find(a => a.user_id === id);
    if (!target || !current || !snapshotOK(targetId)) throw new Error('备用账号已移除或快照无效，请重新检查');
    const currentQuota = await query(current, true);
    const quota = await query(target, true);
    if (!valid(revision, id) || !readAccounts().some(a => a.user_id === targetId) || !snapshotOK(targetId)) {
      throw new Error('检查期间账号状态已变化，请重新检查');
    }
    if (currentQuota.remaining > settings.remaining) throw new Error('当前账号额度已恢复，无需按此提醒切换');
    if (quota.remaining <= settings.remaining) throw new Error('备用账号额度不足，请重新检查其他账号');
    return target;
  }

  return { status, run, validateSwitch, invalidate,
    configure(value) { settings = normalizeQuotaConfig(value); cache.clear(); return invalidate(); },
    start() { if (!started) { started = true; schedule(0); } },
    stop() { started = false; generation++; if (timer) clearTimer(timer); timer = null; state.next_check_at = null; },
    check() { cache.clear(); schedule(0); return status(); },
  };
}

module.exports = { normalizeQuotaConfig, parseQuota, createQuotaFetcher, createQuotaMonitor };
