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
const { execSync, spawn } = require('child_process');

const C = require('./lib/common');
const { installOfficialUpdate, officialUpdateStatus } = require('./lib/official-update');
const {
  config, ROOT, TYPELESS_EXE, ASAR_PATH, IS_MAC,
  readAccounts, writeAccounts, readCurrentUser,
  saveSnapshot, restoreSnapshot, hasSnapshot,
  killTypeless, launchTypeless, isTypelessRunning, resetDevice,
  readMaster, writeMaster,
  curlApi, captureTokenCDP,
  fetchAllWords, dictToText, backupData, envInfo,
  liveStatus, syncAccount,
  paywallStatus, patchPaywall,
  skipOnboarding, checkOnboardingStatus, detectCurrentAccountFromFile,
  log, sleep,
} = C;

const PORT = config.manager_port;
const ACCOUNT_STATUS_CONCURRENCY = 3;
const TYPELESS_APP = TYPELESS_EXE ? String(TYPELESS_EXE).split('/Contents/')[0] : '';

function isTrustedLocalOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
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
    // 图标资源
    if (m === 'GET' && (p === '/icon.png' || p === '/favicon.ico')) {
      try {
        var iconPath = path.join(C.CODE_DIR, 'icon', 'icon-rounded.png');
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
      const data = accs.map((a, i) => ({ ...a, live: live[i], has_snapshot: hasSnapshot(a.user_id) }));
      return send(res, 200, { status: 'OK', data });
    }
    // 当前账号优先从 app-storage.json 读取,日常检测不重启 Typeless、不依赖 CDP。
    // macOS 若本地文件暂不可读,保留 soft CDP 重连作为兜底；?reconnect=0 可强制纯探测。
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
      if (IS_MAC) {
        const mode = u.searchParams.get('reconnect');
        if (mode === '0') return send(res, 200, { status: 'FAIL', msg: info.error || '无法探测当前账号' });
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
    // 保存账号
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
      saveSnapshot(b.user_id); // 保存登录态快照,供切换账号用
      return send(res, 200, { status: 'OK', data: rec });
    }
    // 手动更新当前账号快照(当前 Typeless 登录态 -> 该账号)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/snapshot')) {
      const id = decodeURIComponent(p.split('/')[3]);
      saveSnapshot(id);
      return send(res, 200, { status: 'OK', msg: '快照已保存', has_snapshot: hasSnapshot(id) });
    }
    // 切换到此账号(还原快照 + 重启 Typeless)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/switch')) {
      const id = decodeURIComponent(p.split('/')[3]);
      if (!hasSnapshot(id)) return send(res, 400, { status: 'FAIL', msg: '该账号无快照,请先在 Typeless 登录该号后点「更新快照」' });
      killTypeless(); await sleep(1500);
      restoreSnapshot(id);
      await launchTypeless();
      return send(res, 200, { status: 'OK', msg: '已切换并重启 Typeless' });
    }
    // 解除设备限制(重置设备 ID,准备注册新账号)
    if (m === 'POST' && p === '/api/reset-device') {
      await resetDevice();
      return send(res, 200, { status: 'OK', msg: '设备已重置,Typeless 已以新设备 ID 启动(登录页),可注册新账号' });
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
      if (!isTrustedLocalOrigin(req)) return send(res, 403, { status: 'FAIL', msg: '拒绝来自外部网页的升级请求' });
      const result = await installOfficialUpdate({ typelessAppPath: TYPELESS_APP, dataRoot: ROOT });
      return send(res, 200, { status: 'OK', data: result, msg: result.msg });
    }
    // 解除升级弹窗；无论成功或失败都恢复 Typeless 普通启动。
    if (m === 'POST' && p === '/api/patch-paywall') {
      killTypeless(); await sleep(1500);
      // 每次尝试都备份“当前版本”用于事务回滚。不能直接依赖长期 .bak：
      // Typeless 更新后旧 .bak 可能属于上一版本，失败时覆盖回来会造成版本错配。
      const rollbackAsar = ASAR_PATH + '.toolkit-rollback';
      const rollbackExe = TYPELESS_EXE + '.toolkit-rollback';
      let result = null;
      let patchError = null;
      try {
        fs.copyFileSync(ASAR_PATH, rollbackAsar);
        fs.copyFileSync(TYPELESS_EXE, rollbackExe);
        result = await patchPaywall();
      } catch (e) {
        // 失败则从本次尝试前的快照还原,避免半改或跨版本 .bak 导致闪退。
        try { if (fs.existsSync(rollbackAsar)) fs.copyFileSync(rollbackAsar, ASAR_PATH); } catch (_) {}
        try { if (fs.existsSync(rollbackExe)) fs.copyFileSync(rollbackExe, TYPELESS_EXE); } catch (_) {}
        patchError = e;
      } finally {
        try { fs.unlinkSync(rollbackAsar); } catch (_) {}
        try { fs.unlinkSync(rollbackExe); } catch (_) {}
      }

      let restartError = null;
      try { await launchTypeless(); } catch (e) { restartError = e; }
      if (patchError) {
        const restartNote = restartError
          ? ';Typeless 自动重启失败:' + restartError.message
          : ';已从备份还原并重新启动 Typeless';
        return send(res, 500, { status: 'FAIL', msg: '打补丁失败:' + patchError.message + restartNote });
      }
      if (restartError) return send(res, 500, { status: 'FAIL', msg: '补丁已完成,但 Typeless 自动重启失败:' + restartError.message });
      return send(res, 200, { status: 'OK', data: result });
    }
    // 跳过新手引导(纯文件方式写 app-onboarding 完成标志)
    if (m === 'POST' && p === '/api/skip-onboarding') {
      try {
        const r = await skipOnboarding();
        return send(res, 200, { status: 'OK', data: r });
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
    // 把主词库导入此账号(单向 master -> account,不导出)
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/import-master')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const master = readMaster();
      const dl = await fetchAllWords(acc.token);
      const have = new Set((dl.words || []).map(w => w.term));
      const missing = master.filter(w => !have.has(w));
      let imported = 0;
      if (missing.length) {
        const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: missing.join('\n') });
        imported = r.data?.success_count ?? 0;
      }
      return send(res, 200, { status: 'OK', data: { master: master.length, already: master.length - missing.length, imported } });
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
    if (m === 'DELETE' && p.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(p.split('/').pop());
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
    // 单账号同步
    if (m === 'POST' && p.startsWith('/api/accounts/') && p.endsWith('/sync')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const acc = readAccounts().find(x => x.user_id === id);
      if (!acc) return send(res, 404, { status: 'FAIL', msg: '账号不存在' });
      const r = await syncAccount(acc);
      return send(res, 200, { status: 'OK', data: r });
    }
    // 全部同步
    if (m === 'POST' && p === '/api/sync-all') {
      const accs = readAccounts();
      const results = [];
      for (const a of accs) {
        try { results.push({ user_id: a.user_id, nickname: a.nickname, ...(await syncAccount(a)) }); }
        catch (e) { results.push({ user_id: a.user_id, nickname: a.nickname, error: e.message }); }
      }
      return send(res, 200, { status: 'OK', data: results });
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

module.exports = { server, startServer, PORT };
