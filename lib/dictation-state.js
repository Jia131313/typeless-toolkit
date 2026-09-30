'use strict';
// ---------- Typeless 听写状态检测 ----------
// 自动切号必须在用户没在听写时执行,否则会在写入中途重启 Typeless。
//
// 官方没有提供任何查询录音状态的 IPC 或日志(主进程的 saveLog 是空实现),
// 但它在开始录音的瞬间会往 typeless.db 的 history_v2 插一行占位记录,
// 录音结束时该行被 finalize(status 变为 completed / dismissed / error)。
// 因此只读轮询这张表,就能判断"是否正在听写"以及"是否已经说完"。
//
// 数据库以 delete 模式写入且无 WAL,所以每次查询用短连接,避免长时间持有句柄。

const fs = require('fs');
const path = require('path');

/** 排除历史遗留的未完成会话:库中存在若干条陈旧的 status IS NULL 记录 */
const RECORDING_LOOKBACK_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 3000;
/** 说完话后连续静默多久才算进入空闲窗口(官方 finalize 约需数秒) */
const DEFAULT_IDLE_MS = 5000;

/** node:sqlite 在 Node 23.4+ 免 flag;更早的版本 require 会抛错 */
function loadSqlite() {
  try { return require('node:sqlite'); } catch (e) { return null; }
}

/** 当前运行时是否具备读取听写状态的能力 */
function sqliteAvailable() { return !!loadSqlite(); }

function dictationResult(recording, error, recordingId = null, ambiguous = false) {
  const result = { recording, error };
  Object.defineProperty(result, 'recording_id', { value: recordingId, enumerable: false });
  Object.defineProperty(result, 'ambiguous', { value: ambiguous, enumerable: false });
  return result;
}

/**
 * Verify that the running Typeless database can actually be opened and has
 * the table used by the watcher. Loading node:sqlite alone is not enough:
 * Lite installations may have a compatible Node runtime while Typeless is
 * not installed yet, is using another user-data directory, or has changed
 * its schema.
 */
function probeDictationDb(dbPath) {
  const sqlite = loadSqlite();
  if (!sqlite) return { ok: false, error: 'no-sqlite' };
  if (!dbPath || !fs.existsSync(dbPath)) return { ok: false, error: 'no-db' };
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT id FROM history_v2 LIMIT 0').all();
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: 'query-failed:' + e.message };
  } finally {
    try { if (db) db.close(); } catch (e) { /* 连接已失效,忽略 */ }
  }
}

/** Typeless 主数据库位置(Windows 为 %APPDATA%\Typeless.exe\typeless.db) */
function dictationDbPath(userDataDir) {
  return userDataDir ? path.join(userDataDir, 'typeless.db') : '';
}

/**
 * 查询一次听写状态。
 * @returns {{recording:boolean, error:string|null}}
 *   error 为 'no-sqlite' / 'no-db' / 'query-failed' 等,调用方据此决定降级策略。
 */
function readDictationState(dbPath, now = Date.now, activeId = null) {
  const sqlite = loadSqlite();
  if (!sqlite) return dictationResult(false, 'no-sqlite');
  if (!dbPath || !fs.existsSync(dbPath)) return dictationResult(false, 'no-db');
  let db = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const since = new Date(now() - RECORDING_LOOKBACK_MS).toISOString();
    const row = activeId
      ? db.prepare(
        'SELECT id FROM history_v2 WHERE status IS NULL AND (id = ? OR created_at > ?) ORDER BY created_at DESC LIMIT 1'
      ).get(activeId, since)
      : db.prepare(
        'SELECT id FROM history_v2 WHERE status IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1'
      ).get(since);
    // A pre-existing NULL row may be either an abandoned historical record or
    // a recording that started before this watcher. It cannot be classified
    // safely after a restart, so refuse to call the machine idle.
    if (!activeId && !row) {
      const stale = db.prepare('SELECT id FROM history_v2 WHERE status IS NULL LIMIT 1').get();
      if (stale) return dictationResult(false, null, null, true);
    }
    return dictationResult(!!row, null, row ? row.id : null);
  } catch (e) {
    return dictationResult(false, 'query-failed:' + e.message);
  } finally {
    try { if (db) db.close(); } catch (e) { /* 连接已失效,忽略 */ }
  }
}

/**
 * 轮询听写状态并派发事件。
 * 事件:
 *   recording —— 检测到正在听写(边沿触发)
 *   idle      —— 进入空闲窗口(从未录音,或说完后静默超过 idleMs)
 *   error     —— 状态读取失败(仅在错误内容变化时触发一次)
 * 空闲窗口每次进入只派发一次;一旦重新开始录音即重置。
 */
function createDictationWatcher({
  dbPath,
  pollMs = DEFAULT_POLL_MS,
  idleMs = DEFAULT_IDLE_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = true;
  let recording = false;
  let seenRecording = false;
  let lastRecordingEndAt = 0;
  let idleNotified = false;
  let lastError = null;
  let known = false;
  let activeRecordingId = null;
  const listeners = { recording: [], idle: [], error: [], ready: [] };

  const emit = (name, payload) => {
    for (const fn of listeners[name]) { try { fn(payload); } catch (e) { /* 监听器异常不影响轮询 */ } }
  };

  /** 是否处于空闲窗口:未在录音,且(从未录音过 或 已静默足够久) */
  function isIdle() {
    if (!known) return false;
    if (recording) return false;
    if (!seenRecording) return true;
    return now() - lastRecordingEndAt >= idleMs;
  }

  function poll() {
    const state = readDictationState(dbPath, now, activeRecordingId);
    if (state.error || state.ambiguous) {
      known = false;
      const error = state.error || 'stale-record';
      if (error !== lastError) { lastError = error; emit('error', error); }
      return;
    }
    const wasKnown = known;
    known = true;
    if (!wasKnown) emit('ready');
    lastError = null;
    if (state.recording) {
      recording = true;
      activeRecordingId = state.recording_id;
      seenRecording = true;
      idleNotified = false;
      emit('recording');
      return;
    }
    if (recording) {
      // 刚刚说完,从这一刻起计算静默时长
      recording = false;
      activeRecordingId = null;
      lastRecordingEndAt = now();
      idleNotified = false;
      return;
    }
    if (isIdle() && !idleNotified) {
      idleNotified = true;
      emit('idle');
    }
    return state;
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    const tick = () => {
      if (stopped) return;
      poll();
      timer = setTimer(tick, pollMs);
      timer?.unref?.();
    };
    tick();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    lastError = null;
    known = false;
  }

  return {
    start,
    stop,
    isIdle,
    refresh: poll,
    isActive: () => !stopped,
    isKnown: () => known,
    probe: () => probeDictationDb(dbPath),
    isRecording: () => recording,
    lastError: () => lastError,
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); return this; },
  };
}

module.exports = {
  RECORDING_LOOKBACK_MS,
  DEFAULT_POLL_MS,
  DEFAULT_IDLE_MS,
  sqliteAvailable,
  probeDictationDb,
  dictationDbPath,
  readDictationState,
  createDictationWatcher,
};
