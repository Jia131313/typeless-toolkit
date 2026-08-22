#!/usr/bin/env node
/**
 * Typeless 多账号管理器 —— 本地后端服务
 * 提供 HTTP API 供前端 (manager.html) 调用;复用 CDP 抓 token + curl 调 Typeless API。
 * 数据:accounts.json (账号+token,明文) + Typeless词库主清单.csv (主词库)
 *
 * 共享逻辑已抽到 ./lib/common.js,本文件只保留 HTTP 路由层。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const C = require('./lib/common');
const { installOfficialUpdate, officialUpdateStatus } = require('./lib/official-update');
const {
  config, ROOT, TYPELESS_EXE, USERDATA_DIR, ASAR_PATH, IS_MAC,
  readAccounts, writeAccounts, readCurrentUser,
  saveSnapshot, restoreSnapshot, hasSnapshot, hasValidSnapshot, inspectSnapshot,
  killTypeless, launchTypeless, isTypelessRunning, resetDevice,
  createTypelessAppBackup, restoreTypelessAppBackup, verifyTypelessAppSignature,
  toolkitAppManagementState, markToolkitAppManagementAuthorized,
  readMaster, replaceMasterTerms,
  recordDictionaryDeletions, clearDictionaryDeletions,
  curlApi, captureTokenCDP,
  fetchAllWords, dictToText, backupData, envInfo,
  liveStatus, syncAccount, syncAllAccounts,
  paywallStatus, patchPaywall,
  skipOnboarding, checkOnboardingStatus, detectCurrentAccountFromFile,
  applyOnboardingCompleteToLiveFiles, healOnboardingAfterRestore,
  finishNewAccountWizard,
  getFeatureShortcuts, setFeatureShortcuts,
  log, sleep,
} = C;

const PORT = config.manager_port;
const ACCOUNT_STATUS_CONCURRENCY = 3;
const TYPELESS_APP = TYPELESS_EXE ? String(TYPELESS_EXE).split('/Contents/')[0] : '';
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const AUTO_SYNC_STARTUP_DELAY_MS = 6000;
const AUTO_SYNC_DEBOUNCE_MS = 1200;
const PAYWALL_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const PAYWALL_MAINTENANCE_STARTUP_DELAY_MS = 2500;

function createDictionarySyncController(syncFn, opts = {}) {
  const intervalMs = opts.intervalMs || AUTO_SYNC_INTERVAL_MS;
  const startupDelayMs = opts.startupDelayMs ?? AUTO_SYNC_STARTUP_DELAY_MS;
  const debounceMs = opts.debounceMs ?? AUTO_SYNC_DEBOUNCE_MS;
  const now = opts.now || (() => Date.now());
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const pendingReasons = new Set();
  let debounceTimer = null;
  let intervalTimer = null;
  let inFlight = null;
  let started = false;
  let state = {
    state: 'waiting',
    running: false,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    next_check_at: null,
    reasons: [],
    summary: null,
    error: null,
    msg: '等待首次自动检查',
  };

  const iso = value => new Date(value).toISOString();
  const unref = timer => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };
  const snapshot = () => ({ ...state, reasons: [...state.reasons] });

  const schedule = (reason = 'change', delayMs = debounceMs) => {
    pendingReasons.add(reason);
    if (inFlight) return snapshot();
    if (debounceTimer) clearTimeoutFn(debounceTimer);
    const runAt = now() + Math.max(0, delayMs);
    state = { ...state, next_check_at: iso(runAt), reasons: [...pendingReasons] };
    debounceTimer = unref(setTimeoutFn(() => {
      debounceTimer = null;
      run().catch(error => log('[dict-sync] 自动同步失败:', error.message));
    }, Math.max(0, delayMs)));
    return snapshot();
  };

  const run = async (reason) => {
    if (inFlight) return inFlight;
    if (reason) pendingReasons.add(reason);
    if (debounceTimer) {
      clearTimeoutFn(debounceTimer);
      debounceTimer = null;
    }
    const reasons = [...pendingReasons];
    pendingReasons.clear();
    state = {
      ...state,
      state: 'checking',
      running: true,
      last_started_at: iso(now()),
      next_check_at: null,
      reasons,
      error: null,
      msg: '正在检查并对齐词库',
    };
    inFlight = (async () => {
      try {
        const result = await syncFn();
        const finishedAt = iso(now());
        const empty = result.account_count === 0;
        const ok = empty || result.all_aligned;
        state = {
          ...state,
          state: empty ? 'waiting' : (ok ? 'aligned' : 'partial'),
          running: false,
          last_finished_at: finishedAt,
          last_success_at: ok ? finishedAt : state.last_success_at,
          summary: {
            master_count: result.master_count,
            account_count: result.account_count,
            aligned_count: result.aligned_count,
            failed_count: result.failed_count,
            all_aligned: result.all_aligned,
          },
          error: null,
          msg: empty ? '尚无账号，添加后会自动对齐' : result.msg,
        };
        return { ok, result, status: snapshot() };
      } catch (error) {
        state = {
          ...state,
          state: 'error',
          running: false,
          last_finished_at: iso(now()),
          error: error.message || String(error),
          msg: '自动对齐失败，将在下次检查时重试',
        };
        return { ok: false, error: state.error, status: snapshot() };
      } finally {
        inFlight = null;
        if (pendingReasons.size) schedule('queued-change', debounceMs);
      }
    })();
    return inFlight;
  };

  const start = () => {
    if (started) return snapshot();
    started = true;
    schedule('startup', startupDelayMs);
    state = { ...state, next_check_at: iso(now() + startupDelayMs) };
    intervalTimer = unref(setIntervalFn(() => {
      schedule('periodic', 0);
    }, intervalMs));
    return snapshot();
  };

  const stop = () => {
    started = false;
    if (debounceTimer) clearTimeoutFn(debounceTimer);
    if (intervalTimer) clearIntervalFn(intervalTimer);
    debounceTimer = null;
    intervalTimer = null;
  };

  return { schedule, run, start, stop, status: snapshot };
}

const dictionarySync = createDictionarySyncController(syncAllAccounts);

function createPaywallMaintenanceController(statusFn, repairFn, runningFn, opts = {}) {
  const intervalMs = opts.intervalMs || PAYWALL_MAINTENANCE_INTERVAL_MS;
  const startupDelayMs = opts.startupDelayMs ?? PAYWALL_MAINTENANCE_STARTUP_DELAY_MS;
  const automaticEnabled = opts.automaticEnabled !== false;
  const now = opts.now || (() => Date.now());
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const fingerprintFn = opts.fingerprintFn || null;
  let startupTimer = null;
  let intervalTimer = null;
  let inFlight = null;
  let started = false;
  let lastFingerprint = null;
  let state = {
    state: automaticEnabled ? 'waiting' : 'manual',
    running: false,
    automatic_enabled: automaticEnabled,
    reason: null,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    next_check_at: null,
    error: null,
    permission: null,
    result: null,
    msg: automaticEnabled ? '等待自动检查弹窗状态' : '当前运行方式仅支持手动解除弹窗',
  };

  const iso = value => new Date(value).toISOString();
  const unref = timer => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };
  const snapshot = () => ({ ...state, permission: state.permission ? { ...state.permission } : null });

  const run = async (reason = 'manual') => {
    if (inFlight) return inFlight;
    let fingerprint = null;
    try { fingerprint = fingerprintFn ? fingerprintFn() : null; } catch (error) {}
    if (reason === 'periodic' && fingerprint && lastFingerprint === fingerprint && state.state === 'patched') {
      state = {
        ...state,
        running: false,
        reason,
        last_finished_at: iso(now()),
        next_check_at: null,
        msg: 'Typeless 程序文件未变化，弹窗补丁状态正常',
      };
      return { ok: true, skipped: true, code: 'ARTIFACT_UNCHANGED', status: snapshot() };
    }
    state = {
      ...state,
      state: 'checking',
      running: true,
      reason,
      last_started_at: iso(now()),
      next_check_at: null,
      error: null,
      permission: null,
      msg: '正在检查弹窗补丁状态',
    };
    const task = (async () => {
      try {
        const current = statusFn();
        if (fingerprint) lastFingerprint = fingerprint;
        if (current.patched) {
          const finishedAt = iso(now());
          state = {
            ...state,
            state: 'patched',
            running: false,
            last_finished_at: finishedAt,
            last_success_at: finishedAt,
            result: { already: true },
            msg: '弹窗补丁状态正常',
          };
          return { ok: true, skipped: true, result: { already: true }, status: snapshot() };
        }
        if (!current.exists || current.error) {
          state = {
            ...state,
            state: 'unsupported',
            running: false,
            last_finished_at: iso(now()),
            error: current.error || '未找到 Typeless app.asar',
            msg: '当前 Typeless 版本暂时无法自动解除弹窗',
          };
          return { ok: false, skipped: true, code: 'PAYWALL_UNSUPPORTED', error: state.error, status: snapshot() };
        }
        if (reason === 'periodic' && runningFn()) {
          state = {
            ...state,
            state: 'deferred',
            running: false,
            last_finished_at: iso(now()),
            msg: '检测到补丁失效，将在下次受控重启时自动修复',
          };
          return { ok: false, skipped: true, code: 'TYPELESS_BUSY', status: snapshot() };
        }

        state = { ...state, msg: '检测到弹窗补丁失效，正在自动修复' };
        const result = await repairFn({ reason });
        try { if (fingerprintFn) lastFingerprint = fingerprintFn(); } catch (error) {}
        const finishedAt = iso(now());
        state = {
          ...state,
          state: 'patched',
          running: false,
          last_finished_at: finishedAt,
          last_success_at: finishedAt,
          error: null,
          permission: null,
          result,
          msg: result.already ? '弹窗补丁状态正常' : '弹窗已自动解除',
        };
        return { ok: true, result, status: snapshot() };
      } catch (error) {
        const permissionRequired = error.code === 'APP_MANAGEMENT_REQUIRED';
        state = {
          ...state,
          state: permissionRequired ? 'permission-required' : 'error',
          running: false,
          last_finished_at: iso(now()),
          error: error.message || String(error),
          permission: error.permission || null,
          msg: permissionRequired
            ? '需要开启 Typeless 工具集的“App 管理”权限，允许后会自动继续'
            : '自动解除弹窗失败，可点击状态按钮重试',
        };
        return {
          ok: false,
          code: error.code || 'PAYWALL_PATCH_FAILED',
          error: state.error,
          permission: state.permission,
          data: error.data || null,
          status: snapshot(),
        };
      }
    })();
    inFlight = task;
    try {
      return await task;
    } finally {
      if (inFlight === task) inFlight = null;
    }
  };

  const schedule = (reason = 'change', delayMs = 800) => {
    if (!automaticEnabled) return snapshot();
    if (startupTimer) clearTimeoutFn(startupTimer);
    const runAt = now() + Math.max(0, delayMs);
    state = { ...state, next_check_at: iso(runAt), reason };
    startupTimer = unref(setTimeoutFn(() => {
      startupTimer = null;
      run(reason).catch(error => log('[paywall] 自动维护失败:', error.message));
    }, Math.max(0, delayMs)));
    return snapshot();
  };

  const start = () => {
    if (started || !automaticEnabled) return snapshot();
    started = true;
    schedule('startup', startupDelayMs);
    intervalTimer = unref(setIntervalFn(() => {
      run('periodic').catch(error => log('[paywall] 定期检查失败:', error.message));
    }, intervalMs));
    return snapshot();
  };

  const stop = () => {
    started = false;
    if (startupTimer) clearTimeoutFn(startupTimer);
    if (intervalTimer) clearIntervalFn(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
  };

  return { run, schedule, start, stop, status: snapshot };
}

function isTrustedLocalOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

function isTrustedLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function accountForClient(account, live, hasSnapshotValue, snap) {
  const { token, ...safe } = account || {};
  const out = { ...safe, live, has_snapshot: hasSnapshotValue };
  if (snap) {
    out.snapshot_ok = snap.snapshot_ok;
    out.snapshot_mismatch = snap.snapshot_mismatch;
    out.snapshot_email = snap.snapshot_email;
  }
  return out;
}

function accountDeleteId(pathname) {
  const match = String(pathname || '').match(/^\/api\/accounts\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function shouldReconnectCurrent(isMac, mode) {
  return !!isMac && mode === '1';
}

async function waitForTypelessRunning(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isTypelessRunning()) return true;
    await sleep(250);
  }
  return false;
}

function writeDiagnosticLog(prefix, details) {
  const logDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(logDir, 0o700); } catch (error) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(logDir, `${prefix}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(details, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (error) {}
  return file;
}

let paywallPatchInFlight = null;

function isMacAppManagementError(error) {
  if (!IS_MAC || !error) return false;
  if (['EPERM', 'EACCES', 'APP_MANAGEMENT_REQUIRED'].includes(error.code)) return true;
  return /operation not permitted|permission denied|app management|App 管理|没有写入.+权限/i.test(error.message || '');
}

async function runPaywallPatchTransaction({ reason = 'manual' } = {}) {
  if (paywallPatchInFlight) return paywallPatchInFlight;
  paywallPatchInFlight = (async () => {
    const currentStatus = paywallStatus();
    if (currentStatus.patched) {
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }
    if (!currentStatus.exists || currentStatus.error) {
      const error = new Error(currentStatus.error || '未找到 Typeless app.asar');
      error.code = 'PAYWALL_UNSUPPORTED';
      throw error;
    }

    killTypeless(); await sleep(1500);
    // Windows 延续当前版本的文件级回滚；macOS 在 .app 外创建完整 Bundle 备份，
    // 避免签名时把 rollback 文件纳入资源封印，也确保能恢复 _CodeSignature 与嵌套组件。
    const rollbackAsar = IS_MAC ? null : ASAR_PATH + '.toolkit-rollback';
    const rollbackExe = IS_MAC ? null : TYPELESS_EXE + '.toolkit-rollback';
    let appBackup = null;
    let result = null;
    let operationError = null;
    let operationPhase = '关闭 Typeless';
    let rollbackError = null;
    let restartError = null;
    try {
      operationPhase = '创建补丁前备份';
      if (IS_MAC) {
        appBackup = createTypelessAppBackup('paywall-patch');
      } else {
        fs.copyFileSync(ASAR_PATH, rollbackAsar);
        fs.copyFileSync(TYPELESS_EXE, rollbackExe);
      }
      operationPhase = '修改付费墙与 Electron 完整性配置';
      result = await patchPaywall();
      operationPhase = '验证 macOS 代码签名';
      if (IS_MAC) verifyTypelessAppSignature();
      operationPhase = '启动补丁版 Typeless';
      await launchTypeless();
      operationPhase = '确认补丁版 Typeless 存活';
      if (!(await waitForTypelessRunning())) throw new Error('Typeless 补丁后未能正常启动');
    } catch (error) {
      operationError = error;
      try {
        killTypeless(); await sleep(500);
        if (IS_MAC) {
          if (appBackup) restoreTypelessAppBackup(appBackup);
        } else {
          if (rollbackAsar && fs.existsSync(rollbackAsar)) fs.copyFileSync(rollbackAsar, ASAR_PATH);
          if (rollbackExe && fs.existsSync(rollbackExe)) fs.copyFileSync(rollbackExe, TYPELESS_EXE);
        }
      } catch (restoreError) {
        rollbackError = restoreError;
      }

      if (!rollbackError) {
        try {
          await launchTypeless();
          if (!(await waitForTypelessRunning())) throw new Error('恢复后 Typeless 未能正常启动');
        } catch (launchError) { restartError = launchError; }
      }
    } finally {
      if (!IS_MAC) {
        try { if (rollbackAsar) fs.unlinkSync(rollbackAsar); } catch (error) {}
        try { if (rollbackExe) fs.unlinkSync(rollbackExe); } catch (error) {}
      }
    }

    if (operationError) {
      const diagnosticLog = writeDiagnosticLog('paywall-patch-failure', {
        timestamp: new Date().toISOString(),
        platform: IS_MAC ? 'macos' : 'windows',
        phase: operationPhase,
        error: operationError.message,
        rollback_error: rollbackError ? rollbackError.message : null,
        restart_error: restartError ? restartError.message : null,
        backup: appBackup && appBackup.app ? appBackup.app : null,
      });
      const details = [
        `打补丁失败（${operationPhase}）:` + operationError.message,
        rollbackError ? '完整回滚失败:' + rollbackError.message : '已恢复补丁前版本',
        restartError ? '恢复后自动启动失败:' + restartError.message : null,
        appBackup && appBackup.app ? '完整备份:' + appBackup.app : null,
        '诊断日志:' + diagnosticLog,
      ].filter(Boolean).join(';');
      const error = new Error(details);
      error.code = isMacAppManagementError(operationError)
        ? 'APP_MANAGEMENT_REQUIRED'
        : (operationError.code || 'PAYWALL_PATCH_FAILED');
      error.permission = error.code === 'APP_MANAGEMENT_REQUIRED'
        ? { ...toolkitAppManagementState(), regrant_required: true }
        : (operationError.permission || null);
      error.data = { phase: operationPhase, diagnostic_log: diagnosticLog };
      throw error;
    }
    if (appBackup && appBackup.app) result.backup = appBackup.app;
    if (IS_MAC) markToolkitAppManagementAuthorized();
    return result;
  })();

  try {
    return await paywallPatchInFlight;
  } finally {
    paywallPatchInFlight = null;
  }
}

const paywallMaintenance = createPaywallMaintenanceController(
  paywallStatus,
  runPaywallPatchTransaction,
  isTypelessRunning,
  // macOS 源码模式由 Terminal/Node 承担 TCC 身份，不能替打包后的工具集申请 App 管理。
  {
    automaticEnabled: !IS_MAC || !!process.versions.electron,
    // 定期检查先比较元数据；Typeless 程序未变化时不复制和解析整个 app.asar。
    fingerprintFn: () => {
      const stat = fs.statSync(ASAR_PATH);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    },
  }
);

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
// 文本文件下载(词库导出用)
function sendDownload(res, filename, text) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
  });
  res.end('﻿' + text); // 带 BOM,Excel/记事本不乱码
}
function readBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname; const m = req.method;
  try {
    if (!isTrustedLocalHost(req)) {
      return send(res, 403, { status: 'FAIL', msg: '拒绝无效的本地 Host' });
    }
    if (req.headers.origin && !isTrustedLocalOrigin(req)) {
      return send(res, 403, { status: 'FAIL', msg: '拒绝来自外部网页的请求' });
    }
    // 图标资源
    if (m === 'GET' && (p === '/icon.png' || p === '/favicon.ico')) {
      try {
        var iconPath = path.join(C.CODE_DIR, 'assets', 'icon-rounded.png');
        if (!fs.existsSync(iconPath)) iconPath = path.join(C.CODE_DIR, 'icon', 'icon-rounded.png');
        if (!fs.existsSync(iconPath)) iconPath = path.join(C.CODE_DIR, 'icon.png');
        if (!fs.existsSync(iconPath)) iconPath = path.join(path.dirname(C.CODE_DIR), 'icon.png');
        if (!fs.existsSync(iconPath)) iconPath = path.join(C.CODE_DIR, 'icon', 'icon.png');
        if (fs.existsSync(iconPath)) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          });
          return res.end(fs.readFileSync(iconPath));
        }
      } catch (e) {}
      res.writeHead(404); return res.end('not found');
    }

    // 前端首页
    if (m === 'GET' && (p === '/' || p === '/index.html' || p === '/manager.html')) {
      const html = fs.readFileSync(path.join(C.CODE_DIR, 'manager.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // 账号列表(含实时状态)
    if (m === 'GET' && p === '/api/accounts') {
      const accs = readAccounts();
      // 上游 c5f784f:限制状态查询并发，避免账号多时瞬间启动大量 curl。
      const live = new Array(accs.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < accs.length) {
          const i = cursor++;
          live[i] = await liveStatus(accs[i]).catch(e => ({ token_valid: false, _err: e.message }));
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(ACCOUNT_STATUS_CONCURRENCY, accs.length) },
        () => worker()
      ));
      const data = accs.map((a, i) => {
        const snap = inspectSnapshot(a.user_id);
        return accountForClient(a, live[i], snap.has_snapshot, snap);
      });
      return send(res, 200, { status: 'OK', data });
    }
    // 当前账号只读 app-storage.json；页面每 20 秒轮询也绝不能因此重启 Typeless。
    // 仅显式 ?reconnect=1 才允许 macOS 进入 CDP 自愈，日常 UI 不使用该模式。
    if (m === 'GET' && p === '/api/current') {
      const info = detectCurrentAccountFromFile();
      if (info.found) {
        return send(res, 200, {
          status: 'OK',
          data: { user_id: info.user_id, email: info.email, roles: info.roles, source: 'local-storage' },
        });
      }
      const local = readCurrentUser();
      if (local) return send(res, 200, { status: 'OK', data: local });
      const reconnectMode = u.searchParams.get('reconnect');
      if (shouldReconnectCurrent(IS_MAC, reconnectMode)) {
        try { const c = await captureTokenCDP(null, true); return send(res, 200, { status: 'OK', data: c }); }
        catch (e) { return send(res, 200, { status: 'FAIL', msg: e.message }); }
      }
      return send(res, 200, { status: 'FAIL', msg: info.error || '无法探测当前账号' });
    }
    // 抓取当前账号(准备添加)
    if (m === 'POST' && p === '/api/capture') {
      try { const c = await captureTokenCDP(); return send(res, 200, { status: 'OK', data: c }); }
      catch (e) { return send(res, 500, { status: 'FAIL', msg: e.message }); }
    }
    // 保存账号(写入前尽量固化新手引导完成状态,再存快照)
    if (m === 'POST' && p === '/api/accounts') {
      const b = await readBody(req);
      const accs = readAccounts();
      const idx = accs.findIndex(x => x.user_id === b.user_id);
      const rec = {
        user_id: b.user_id,
        nickname: b.nickname || b.email || (b.user_id || '').slice(0, 8),
        email: b.email, role: b.role, token: b.token, captured_at: b.captured_at,
        added_at: idx >= 0 ? accs[idx].added_at : new Date().toISOString(),
      };
      if (idx >= 0) accs[idx] = rec; else accs.push(rec);
      writeAccounts(accs);
      // 不杀进程地补写引导完成,再快照,避免「添加时教程未完成」写进 profiles
      try { applyOnboardingCompleteToLiveFiles(); } catch (e) { log('[accounts] onboarding patch:', e.message); }
      try {
        saveSnapshot(b.user_id);
      } catch (e) {
        return send(res, 400, {
          status: 'FAIL',
          msg: `账号已记录,但快照未写入: ${e.message}`,
          data: rec,
        });
      }
      const snap = inspectSnapshot(rec.user_id);
      dictionarySync.schedule(idx >= 0 ? 'account-updated' : 'account-added');
      paywallMaintenance.schedule(idx >= 0 ? 'account-updated' : 'account-added', 1200);
      return send(res, 200, { status: 'OK', data: accountForClient(rec, null, snap.has_snapshot, snap) });
    }
    // 手动更新当前账号快照(当前 Typeless 登录态 -> 该账号)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/snapshot')) {
      const id = decodeURIComponent(p.split('/')[3]);
      try {
        try { applyOnboardingCompleteToLiveFiles(); } catch (e) {}
        saveSnapshot(id);
        const snap = inspectSnapshot(id);
        return send(res, 200, {
          status: 'OK',
          msg: '快照已保存',
          has_snapshot: snap.has_snapshot,
          snapshot_ok: snap.snapshot_ok,
        });
      } catch (e) {
        return send(res, 400, { status: 'FAIL', msg: e.message });
      }
    }
    // 切换到此账号(还原快照 + 若教程未完成则现场治愈 + 重启)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/switch')) {
      const id = decodeURIComponent(p.split('/')[3]);
      {
        // 先校验目标快照身份,避免「点 A 却还原成 B」
        const snap = inspectSnapshot(id);
        if (!snap.has_snapshot) {
          return send(res, 400, { status: 'FAIL', msg: '该账号无快照,请先在 Typeless 登录该号后点「更新快照」' });
        }
        if (snap.snapshot_mismatch) {
          const who = snap.snapshot_email || snap.snapshot_user_id;
          return send(res, 400, {
            status: 'FAIL',
            msg: `该账号快照已串号(内容实际是 ${who})。请先在 Typeless 登录正确账号,再点「更新快照」覆盖。`,
          });
        }
        if (!snap.snapshot_ok) {
          return send(res, 400, { status: 'FAIL', msg: '该账号快照无效,请重新登录该号后更新快照' });
        }
      }
      // 切换前:若当前号在跑,先把当前状态存回(尽量不丢);身份不匹配时跳过,绝不串写
      try {
        const cur = detectCurrentAccountFromFile();
        if (cur.found && cur.user_id && cur.user_id !== id) {
          try { applyOnboardingCompleteToLiveFiles(); } catch (e) {}
          try { saveSnapshot(cur.user_id); }
          catch (e) { log('[switch] 保存当前号快照跳过:', e.message); }
        }
      } catch (e) {}
      killTypeless(); await sleep(1500);
      try {
        restoreSnapshot(id);
        const heal = healOnboardingAfterRestore(id);
        await launchTypeless();
        paywallMaintenance.schedule('account-switch', 1200);
        return send(res, 200, {
          status: 'OK',
          msg: heal.healed
            ? '已切换并补写新手引导完成标记,Typeless 已重启'
            : '已切换并重启 Typeless',
          data: heal,
        });
      } catch (e) {
        return send(res, 500, { status: 'FAIL', msg: e.message || '切换失败' });
      }
    }
    // 解除设备限制(重置设备 ID,准备注册新账号)
    if (m === 'POST' && p === '/api/reset-device') {
      // 重置前尽量保存当前号快照
      try {
        const cur = detectCurrentAccountFromFile();
        if (cur.found && cur.user_id) {
          try { applyOnboardingCompleteToLiveFiles(); } catch (e) {}
          saveSnapshot(cur.user_id);
        }
      } catch (e) {}
      await resetDevice();
      return send(res, 200, { status: 'OK', msg: '设备已重置,Typeless 已以新设备 ID 启动(登录页),可注册新账号' });
    }
    // 注册并添加新账号·开始:保存当前快照 → 解除设备 → 启动登录页
    if (m === 'POST' && p === '/api/register-wizard/start') {
      const prev = detectCurrentAccountFromFile();
      let snapshot_saved = false;
      if (prev.found && prev.user_id) {
        try { applyOnboardingCompleteToLiveFiles(); } catch (e) {}
        saveSnapshot(prev.user_id);
        snapshot_saved = true;
      }
      await resetDevice();
      return send(res, 200, {
        status: 'OK',
        data: {
          previous_user_id: prev.found ? prev.user_id : null,
          previous_email: prev.found ? prev.email : null,
          snapshot_saved,
        },
        msg: '已解除设备限制。请在 Typeless 中注册或登录新账号,完成后回到管理器点「完成」。',
      });
    }
    // 注册并添加新账号·探测是否已登录目标账号
    if (m === 'GET' && p === '/api/register-wizard/status') {
      const prevId = u.searchParams.get('previous_user_id') || '';
      const cur = detectCurrentAccountFromFile();
      if (!cur.found) {
        return send(res, 200, {
          status: 'OK',
          data: { logged_in: false, waiting: true, msg: '尚未检测到登录,请在 Typeless 完成注册/登录' },
        });
      }
      const isNew = !prevId || cur.user_id !== prevId;
      return send(res, 200, {
        status: 'OK',
        data: {
          logged_in: true,
          is_new_account: isNew,
          user_id: cur.user_id,
          email: cur.email,
          roles: cur.roles,
          msg: isNew
            ? `已检测到账号 ${cur.email || cur.user_id},可点完成`
            : '当前仍是原账号,请注册/登录另一个号,或继续用完成流程刷新凭证',
        },
      });
    }
    // 注册新账号·收尾:跳过教程 + 抓 token + 入库；词库随后后台自动对齐
    if (m === 'POST' && p === '/api/register-wizard/finish') {
      try {
        const b = await readBody(req);
        const result = await finishNewAccountWizard({
          import_master: false,
          nickname: b.nickname || '',
        });
        dictionarySync.schedule('registered-account');
        paywallMaintenance.schedule('registered-account', 1200);
        const safeResult = {
          ...result,
          account: accountForClient(result.account, null, hasSnapshot(result.account.user_id)),
        };
        return send(res, 200, { status: 'OK', data: safeResult, msg: result.msg });
      } catch (e) {
        return send(res, 500, { status: 'FAIL', msg: '完成新号流程失败:' + e.message });
      }
    }
    // 查询去弹窗补丁状态(只读)
    if (m === 'GET' && p === '/api/paywall-status') {
      return send(res, 200, { status: 'OK', data: paywallStatus() });
    }
    if (m === 'GET' && p === '/api/paywall-maintenance') {
      return send(res, 200, { status: 'OK', data: paywallMaintenance.status() });
    }
    if (m === 'POST' && p === '/api/paywall-maintenance/retry') {
      const outcome = await paywallMaintenance.run('permission-retry');
      return send(res, outcome.ok ? 200 : 409, {
        status: outcome.ok ? 'OK' : 'FAIL',
        data: outcome,
        msg: outcome.ok ? (outcome.result?.msg || outcome.status?.msg) : (outcome.error || outcome.status?.msg),
      });
    }
    // 查询 Typeless 官方 updater 已下载的更新包（macOS）
    if (m === 'GET' && p === '/api/official-update') {
      return send(res, 200, { status: 'OK', data: officialUpdateStatus({ typelessAppPath: TYPELESS_APP }) });
    }
    // 校验并安装官方更新包,恢复官方签名;当前应用先移到工具集数据目录备份
    if (m === 'POST' && p === '/api/official-update/install') {
      await readBody(req);
      let result;
      try {
        result = await installOfficialUpdate({
          typelessAppPath: TYPELESS_APP,
          dataRoot: ROOT,
          userDataDir: USERDATA_DIR,
          launchInstalledApp: false,
        });
        if (IS_MAC) markToolkitAppManagementAuthorized();
      } catch (error) {
        if (isMacAppManagementError(error)) {
          return send(res, 409, {
            status: 'FAIL',
            data: { code: 'APP_MANAGEMENT_REQUIRED', permission: toolkitAppManagementState() },
            msg: 'macOS 尚未允许“Typeless 工具集”管理其他 App，请开启后重试',
          });
        }
        throw error;
      }
      const maintenance = await paywallMaintenance.run('official-update');
      result.paywall_maintenance = maintenance;
      if (!maintenance.ok && !isTypelessRunning()) {
        try { await launchTypeless(); } catch (error) {
          result.paywall_launch_error = error.message;
        }
      }
      if (maintenance.ok && !maintenance.result?.already) {
        result.msg += '；弹窗补丁已自动重新应用';
      } else if (!maintenance.ok && maintenance.code === 'APP_MANAGEMENT_REQUIRED') {
        result.msg += '；请开启工具集的 App 管理权限，允许后会自动继续解除弹窗';
      } else if (!maintenance.ok) {
        result.msg += '；自动解除弹窗失败，可在工具栏状态入口重试';
      }
      return send(res, 200, { status: 'OK', data: result, msg: result.msg });
    }
    // 手动入口保留为状态查看与失败重试；正常情况下由后台维护自动完成。
    if (m === 'POST' && p === '/api/patch-paywall') {
      const outcome = await paywallMaintenance.run('manual');
      return send(res, outcome.ok ? 200 : (outcome.code === 'APP_MANAGEMENT_REQUIRED' ? 409 : 500), {
        status: outcome.ok ? 'OK' : 'FAIL',
        data: outcome.ok ? outcome.result : outcome,
        msg: outcome.ok ? (outcome.result?.msg || outcome.status?.msg) : (outcome.error || outcome.status?.msg),
      });
    }
    // 跳过新手引导(双写本地文件 + 写入当前账号快照)
    if (m === 'POST' && p === '/api/skip-onboarding') {
      try {
        const r = await skipOnboarding({ restart: true, saveSnap: true });
        return send(res, 200, { status: 'OK', data: r, msg: r.note });
      } catch (e) {
        return send(res, 500, { status: 'FAIL', msg: '跳过新手引导失败:' + e.message });
      }
    }
    // 查询新手引导状态
    if (m === 'GET' && p === '/api/onboarding-status') {
      try {
        const r = await checkOnboardingStatus();
        return send(res, 200, { status: 'OK', data: r });
      } catch (e) {
        return send(res, 200, { status: 'OK', data: { completed: false, reason: e.message } });
      }
    }
    // 把主词库导入此账号(走完整 sync 回灌校验)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/import-master')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const r = await syncAccount(acc);
      dictionarySync.schedule('single-account-sync');
      return send(res, 200, { status: r.aligned ? 'OK' : 'FAIL', data: r, msg: r.msg });
    }
    // 从源账号复制词库到此账号
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.includes('/copy-from/')) {
      const parts = p.split('/');
      const dstId = decodeURIComponent(parts[3]);
      const srcId = decodeURIComponent(parts[5]);
      const accs = readAccounts();
      const src = accs.find(x => x.user_id === srcId);
      const dst = accs.find(x => x.user_id === dstId);
      if (!src || !dst) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const sl = await fetchAllWords(src.token);
      const srcWords = (sl.words || []).map(w => w.term).filter(Boolean);
      const dl = await fetchAllWords(dst.token);
      const have = new Set((dl.words || []).map(w => w.term));
      const missing = srcWords.filter(w => !have.has(w));
      let imported = 0;
      if (missing.length) {
        const r = await curlApi('POST', '/user/dictionary/bulk-import', dst.token, { content: missing.join('\n') });
        imported = r.data?.success_count ?? 0;
      }
      dictionarySync.schedule('dictionary-copy');
      return send(res, 200, { status: 'OK', data: { src_count: srcWords.length, imported, already: srcWords.length - missing.length } });
    }
    // 删除账号
    const deleteAccountId = m === 'DELETE' ? accountDeleteId(p) : null;
    if (deleteAccountId) {
      const id = deleteAccountId;
      let accs = readAccounts();
      accs = accs.filter(x => x.user_id !== id);
      writeAccounts(accs);
      dictionarySync.schedule('account-removed');
      return send(res, 200, { status: 'OK' });
    }
    // 单账号词库(全量分页)
    if (m === 'GET' && p.startsWith('/api/accounts/') && p.endsWith('/dictionary')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const dl = await fetchAllWords(acc.token);
      return send(res, 200, { status: 'OK', data: dl });
    }
    // 导出单账号词库为 txt 文件下载
    if (m === 'GET' && p.startsWith('/api/accounts/') && p.endsWith('/dictionary/export')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const dl = await fetchAllWords(acc.token);
      const name = (acc.nickname || id).replace(/[\\/:*?"<>|]/g, '_');
      return sendDownload(res, `Typeless词库_${name}.txt`, dictToText(dl.words));
    }
    // 单账号同步(分批导入 + 回拉校验)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/sync')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const r = await syncAccount(acc);
      dictionarySync.schedule('single-account-sync');
      return send(res, 200, { status: r.aligned ? 'OK' : 'FAIL', data: r, msg: r.msg });
    }
    // 自动词库对齐状态
    if (m === 'GET' && p === '/api/dictionary-sync/status') {
      return send(res, 200, { status: 'OK', data: dictionarySync.status() });
    }
    // 手动立即检查:与后台任务共用 single-flight,不会重复并发同步
    if (m === 'POST' && p === '/api/dictionary-sync/run') {
      const outcome = await dictionarySync.run('manual');
      const result = outcome.result;
      return send(res, 200, {
        status: outcome.ok ? 'OK' : 'FAIL',
        data: result ? result.results : [],
        summary: result ? {
          master_count: result.master_count,
          account_count: result.account_count,
          aligned_count: result.aligned_count,
          failed_count: result.failed_count,
          all_aligned: result.all_aligned,
        } : outcome.status?.summary,
        sync_status: outcome.status,
        msg: result?.msg || outcome.error || outcome.status?.msg,
      });
    }
    // 兼容旧入口,同样进入自动对齐控制器
    if (m === 'POST' && p === '/api/sync-all') {
      const outcome = await dictionarySync.run('legacy-manual');
      const r = outcome.result;
      if (!r) return send(res, 200, { status: 'FAIL', data: [], summary: outcome.status?.summary, msg: outcome.error || '同步失败' });
      return send(res, 200, {
        status: r.all_aligned ? 'OK' : 'FAIL',
        data: r.results,
        summary: {
          master_count: r.master_count,
          account_count: r.account_count,
          aligned_count: r.aligned_count,
          failed_count: r.failed_count,
          all_aligned: r.all_aligned,
        },
        msg: r.msg,
      });
    }
    // 给账号加单个词
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      const b = await readBody(req);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: b.term });
      if (r._error || r.detail) return send(res, 502, { status: 'FAIL', msg: String(r.detail || r._error || r._raw || '添加失败') });
      clearDictionaryDeletions([b.term]);
      dictionarySync.schedule('word-added');
      return send(res, 200, { status: 'OK', data: r.data });
    }
    // 删账号单个词(按 term)
    if (m === 'DELETE' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const term = u.searchParams.get('term');
      const dl = await fetchAllWords(acc.token);
      const w = (dl.words || []).find(x => x.term === term);
      if (!w) return send(res, 404, { status: 'FAIL', msg: '词条不存在' });
      const r = await curlApi('POST', '/user/dictionary/delete', acc.token, { user_dictionary_id: w.user_dictionary_id });
      if (r._error || r.detail) return send(res, 502, { status: 'FAIL', msg: String(r.detail || r._error || r._raw || '删除失败') });
      recordDictionaryDeletions([term], `account:${id}`);
      dictionarySync.schedule('word-deleted');
      return send(res, 200, { status: 'OK', data: r.data, msg: '已删除，并将在后台从其他账号同步移除' });
    }
    // 主 CSV
    if (m === 'GET' && p === '/api/master') return send(res, 200, { status: 'OK', data: readMaster() });
    if (m === 'POST' && p === '/api/master') {
      const b = await readBody(req);
      const incomingKeys = new Set((b.terms || []).map(term => String(term || '').trim().toLowerCase()).filter(Boolean));
      const removedCount = readMaster().filter(term => !incomingKeys.has(String(term).toLowerCase())).length;
      if (removedCount > 500) {
        return send(res, 400, {
          status: 'FAIL',
          msg: `本次将同步删除 ${removedCount} 个词，已超过单次 500 条安全上限。请分批删除，避免对每个账号产生大量远端写入。`,
        });
      }
      const changed = replaceMasterTerms(b.terms || []);
      dictionarySync.schedule('master-edited');
      return send(res, 200, {
        status: 'OK',
        data: changed.terms,
        changes: { added: changed.added.length, removed: changed.removed.length },
        msg: changed.removed.length
          ? `已保存，新增 ${changed.added.length} 条、移除 ${changed.removed.length} 条；后台将自动对齐所有账号`
          : `已保存，后台将自动对齐所有账号`,
      });
    }
    // 导出主词库为 txt 下载
    if (m === 'GET' && p === '/api/master/export') {
      return sendDownload(res, 'Typeless主词库.txt', readMaster().join('\n'));
    }
    // 运行环境信息(排错用:平台、探测到的路径、凭据名)
    if (m === 'GET' && p === '/api/env') {
      return send(res, 200, { status: 'OK', data: envInfo() });
    }
    // 一键备份(账号表 + 主词库,带时间戳)
    if (m === 'POST' && p === '/api/backup') {
      const r = backupData();
      return send(res, 200, { status: 'OK', data: r, msg: `已备份 ${r.files.length} 个文件到 backups/${r.stamp}` });
    }
    // 启动 Typeless：已运行则完全不打扰；未运行才以普通模式启动。
    if (m === 'POST' && p === '/api/launch') {
      if (await isTypelessRunning()) return send(res, 200, { status: 'OK', msg: 'Typeless 已在运行' });
      const maintenance = await paywallMaintenance.run('launch');
      if (!isTypelessRunning()) await launchTypeless();
      return send(res, 200, {
        status: 'OK',
        data: { paywall_maintenance: maintenance },
        msg: maintenance.ok && !maintenance.result?.already
          ? '弹窗已自动解除，Typeless 已启动'
          : 'Typeless 已启动',
      });
    }
    // 功能快捷键:直接读写 app-settings.json,可绕过设置页冲突黑名单(如单独 RightCtrl)
    if (m === 'GET' && p === '/api/shortcuts') {
      try {
        return send(res, 200, { status: 'OK', data: getFeatureShortcuts() });
      } catch (e) {
        return send(res, 500, { status: 'FAIL', msg: e.message });
      }
    }
    if (m === 'POST' && p === '/api/shortcuts') {
      try {
        const b = await readBody(req);
        const result = await setFeatureShortcuts(b.bindings || b, { restart: b.restart !== false });
        return send(res, 200, { status: 'OK', data: result, msg: result.msg });
      } catch (e) {
        return send(res, 400, { status: 'FAIL', msg: e.message });
      }
    }
    send(res, 404, { status: 'FAIL', msg: 'not found: ' + p });
  } catch (e) { send(res, 500, { status: 'FAIL', msg: e.message }); }
});

function startServer() {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      log('[mgr] 管理器运行于 http://127.0.0.1:' + PORT);
      dictionarySync.start();
      paywallMaintenance.start();
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '127.0.0.1');
  });
}

server.on('close', () => {
  dictionarySync.stop();
  paywallMaintenance.stop();
});

if (require.main === module) {
  startServer().catch(error => {
    console.error('[mgr] 启动失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  server, startServer, PORT,
  isTrustedLocalOrigin, isTrustedLocalHost,
  accountForClient, accountDeleteId, shouldReconnectCurrent,
  createDictionarySyncController, createPaywallMaintenanceController,
  waitForTypelessRunning, writeDiagnosticLog, runPaywallPatchTransaction,
};
