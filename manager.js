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
  readMaster, writeMaster,
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
  return {
    ...safe, live, has_snapshot: hasSnapshotValue,
    snapshot_ok: snap && snap.snapshot_ok,
    snapshot_mismatch: snap && snap.snapshot_mismatch,
    snapshot_email: snap && snap.snapshot_email,
  };
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
    // 注册并添加新账号·收尾:跳过教程 + 抓 token + 入库 + 可选灌主词库
    if (m === 'POST' && p === '/api/register-wizard/finish') {
      try {
        const b = await readBody(req);
        const result = await finishNewAccountWizard({
          import_master: b.import_master !== false,
          nickname: b.nickname || '',
        });
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
    // 查询 Typeless 官方 updater 已下载的更新包（macOS）
    if (m === 'GET' && p === '/api/official-update') {
      return send(res, 200, { status: 'OK', data: officialUpdateStatus({ typelessAppPath: TYPELESS_APP }) });
    }
    // 校验并安装官方更新包,恢复官方签名;当前应用先移到工具集数据目录备份
    if (m === 'POST' && p === '/api/official-update/install') {
      const result = await installOfficialUpdate({
        typelessAppPath: TYPELESS_APP,
        dataRoot: ROOT,
        userDataDir: USERDATA_DIR,
      });
      return send(res, 200, { status: 'OK', data: result, msg: result.msg });
    }
    // 解除升级弹窗；无论成功或失败都恢复 Typeless 普通启动。
    if (m === 'POST' && p === '/api/patch-paywall') {
      const currentStatus = paywallStatus();
      if (currentStatus.patched) {
        return send(res, 200, { status: 'OK', data: { already: true, msg: '已是无弹窗补丁版,无需重复操作' } });
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
      } catch (e) {
        operationError = e;
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
          try { if (rollbackAsar) fs.unlinkSync(rollbackAsar); } catch (_) {}
          try { if (rollbackExe) fs.unlinkSync(rollbackExe); } catch (_) {}
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
        return send(res, 500, {
          status: 'FAIL', msg: details,
          data: { phase: operationPhase, diagnostic_log: diagnosticLog },
        });
      }
      if (appBackup && appBackup.app) result.backup = appBackup.app;
      return send(res, 200, { status: 'OK', data: result });
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
      return send(res, 200, { status: 'OK', data: { src_count: srcWords.length, imported, already: srcWords.length - missing.length } });
    }
    // 删除账号
    const deleteAccountId = m === 'DELETE' ? accountDeleteId(p) : null;
    if (deleteAccountId) {
      const id = deleteAccountId;
      let accs = readAccounts();
      accs = accs.filter(x => x.user_id !== id);
      writeAccounts(accs);
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
      return send(res, 200, { status: r.aligned ? 'OK' : 'FAIL', data: r, msg: r.msg });
    }
    // 全部同步(先全量并集主库,再统一回灌 + 对账摘要)
    if (m === 'POST' && p === '/api/sync-all') {
      const r = await syncAllAccounts();
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
      const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: b.term });
      return send(res, 200, { status: 'OK', data: r.data });
    }
    // 删账号单个词(按 term)
    if (m === 'DELETE' && p.startsWith('/api/accounts/') && p.endsWith('/word')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      const term = u.searchParams.get('term');
      const dl = await fetchAllWords(acc.token);
      const w = (dl.words || []).find(x => x.term === term);
      if (!w) return send(res, 404, { status: 'FAIL', msg: '词条不存在' });
      const r = await curlApi('POST', '/user/dictionary/delete', acc.token, { user_dictionary_id: w.user_dictionary_id });
      return send(res, 200, { status: 'OK', data: r.data });
    }
    // 主 CSV
    if (m === 'GET' && p === '/api/master') return send(res, 200, { status: 'OK', data: readMaster() });
    if (m === 'POST' && p === '/api/master') {
      const b = await readBody(req); const t = writeMaster(b.terms || []);
      return send(res, 200, { status: 'OK', data: t });
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
      await launchTypeless();
      return send(res, 200, { status: 'OK', msg: 'Typeless 已启动' });
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
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '127.0.0.1');
  });
}

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
  waitForTypelessRunning, writeDiagnosticLog,
};
