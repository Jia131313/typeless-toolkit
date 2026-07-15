/**
 * Typeless 工具集共享模块
 *
 * 抽出 manager.js / typeless-dict-sync.js 的重复逻辑:
 *   - 路径常量、配置加载、Typeless.exe 探测
 *   - curl 调 API(走系统代理,数组传参避免 shell 转义)
 *   - CDP 抓 token(注入 fetch/XHR 捕获 + 重载 + 读 window.__captured)
 *   - 账号存储、登录态快照、主 CSV、kill/launch、实时状态、单账号同步
 *
 * 全部路径来自 config.json + 环境变量,禁止任何硬编码用户目录。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execSync, spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
// 平台适配层(Windows / macOS 差异集中在此)
const { platform: PLAT, IS_WIN, IS_MAC } = require('./platform');
// 优先 ws 包(打包版 Electron 主进程可能无可用全局 WebSocket);开发版无 ws 包则用全局
const WebSocket = (() => {
  try { const W = require('ws'); if (typeof W === 'function') return W; } catch (e) {}
  return typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : undefined;
})();
// 优先关闭 Electron 的嵌入式 asar 完整性校验；依赖不可用时仍回退到传统 hash 更新。
let flipFuses, FuseVersion, FuseV1Options;
try { ({ flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')); } catch (e) {}

// 数据目录:打包后由 electron-main.js 通过 TYPELESS_DATA_DIR 指向 exe 同级 data/(可写);开发模式用项目根
const ROOT = process.env.TYPELESS_DATA_DIR || path.join(__dirname, '..');
// 代码目录:文件所在目录(asar 内只读),用于读静态资源如 manager.html
const CODE_DIR = path.join(__dirname, '..');

// ---------- 默认配置 ----------
const DEFAULT_CONFIG = {
  typeless_exe: '',
  // 以下路径/凭据留空=用平台默认(见 lib/platform.js);macOS 上若默认不对可在此覆盖
  userdata_dir: '',        // 登录态快照来源目录(Win: %APPDATA%\Typeless.exe;Mac: ~/Library/Application Support/Typeless.exe)
  device_cache_dir: '',    // device.cache 所在目录
  credential_target: '',   // 设备 ID 凭据名(Win 凭据管理器 / Mac Keychain)
  cdp_port: 9222,
  manager_port: 7788,
  api_base: 'https://api.typeless.com',
  master_csv: 'Typeless词库主清单.csv',
  paywall: {
    // v2.0 的目标文件路径(asar 内相对路径数组)
    file_path: ['dist', 'renderer', 'static', 'js', 'BYriTiPi.mjs'],
    // 等长 12 字节替换:_n(x) -> (0,x),让付费墙渲染函数直接返回入参即跳过显示
    // 不同版本的 minified 变量名会自动检测，无需用户手动维护。
    replacements: [
      ['_n(_0x4a75c6)', '(0,_0x4a75c6)'],
      ['_n(_0x55e021)', '(0,_0x55e021)'],
    ],
    // config 的 file_path 在 asar 里找不到时,自动遍历 .mjs 找含 'paywall' 的文件
    auto_detect_file: true,
  },
};

// ---------- 配置加载 ----------
function loadConfig() {
  // 先读 config.json(基准),再用 config.local.json(用户本地覆盖,不进 git)覆盖之
  const candidates = ['config.json', 'config.local.json'];
  let cfg = {};
  for (const name of candidates) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(p, 'utf8') || '{}') }; }
      catch (e) { /* 配置损坏时忽略,用默认 */ }
    }
  }
  // 深合并 paywall
  cfg.paywall = { ...DEFAULT_CONFIG.paywall, ...(cfg.paywall || {}) };
  cfg.paywall.replacements = cfg.paywall.replacements && cfg.paywall.replacements.length
    ? cfg.paywall.replacements : DEFAULT_CONFIG.paywall.replacements;
  return { ...DEFAULT_CONFIG, ...cfg };
}
const config = loadConfig();

// ---------- Typeless 可执行文件探测 ----------
// 优先级: config.typeless_exe → 环境变量 TYPELESS_EXE → 平台默认安装路径(见 platform.js) → 抛错
function detectTypelessExe() {
  const tryPath = (p) => {
    if (!p) return null;
    try { if (fs.existsSync(p)) return p; } catch (e) {}
    return null;
  };
  // 1. config 显式配置
  if (config.typeless_exe) {
    const p = tryPath(config.typeless_exe);
    if (p) return p;
  }
  // 2. 环境变量
  if (process.env.TYPELESS_EXE) {
    const p = tryPath(process.env.TYPELESS_EXE);
    if (p) return p;
  }
  // 3. 平台默认安装路径(逐个候选探测)
  const candidates = PLAT.exeCandidates();
  for (const def of candidates) { const p = tryPath(def); if (p) return def; }
  throw new Error(
    '未找到 Typeless 可执行文件。请在 config.json 里配置 typeless_exe(' +
    (IS_MAC ? 'macOS 指向 Typeless.app/Contents/MacOS/Typeless' : '指向 Typeless 安装目录下的 Typeless.exe') +
    ')。默认探测路径:' + candidates.join(' , ')
  );
}

// ---------- 常量(供 manager / sync 脚本共用;路径经 config 覆盖,否则用平台默认) ----------
const TYPELESS_EXE = (() => { try { return detectTypelessExe(); } catch (e) { return ''; } })();
const USERDATA_DIR = config.userdata_dir || PLAT.userDataDir();
const DEVICE_CACHE_DIR = config.device_cache_dir || PLAT.deviceCacheDir();
const CRED_TARGET = config.credential_target || PLAT.credentialTarget();
const ASAR_PATH = TYPELESS_EXE ? PLAT.asarPathFor(TYPELESS_EXE) : '';
const API_BASE = config.api_base;
const CDP_PORT = config.cdp_port;
const MASTER_CSV = path.join(ROOT, config.master_csv);
const PROFILES_DIR = path.join(ROOT, 'profiles');
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const SNAPSHOT_FILES = ['app-storage.json', 'user-data.json', 'app-onboarding.json'];

// ---------- 工具 ----------
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 账号存储 ----------
function readAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8') || '[]'); }
  catch (e) { return []; }
}
function writeAccounts(a) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2)); }

// ---------- 登录态快照(切换账号用) ----------
function profileDir(uid) { return path.join(PROFILES_DIR, uid); }
function saveSnapshot(uid) {
  const dir = profileDir(uid); fs.mkdirSync(dir, { recursive: true });
  for (const f of SNAPSHOT_FILES) {
    const src = path.join(USERDATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
}
function restoreSnapshot(uid) {
  const dir = profileDir(uid);
  for (const f of SNAPSHOT_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(USERDATA_DIR, f));
  }
}
function hasSnapshot(uid) { return fs.existsSync(path.join(profileDir(uid), 'user-data.json')); }

function currentUserFromStorage(storage) {
  const userInfo = storage && typeof storage.userData === 'object' ? storage.userData : null;
  if (!userInfo || !userInfo.user_id) return null;
  return { user_id: userInfo.user_id, user_info: userInfo, source: 'local-storage' };
}

function readCurrentUser() {
  try {
    const storage = JSON.parse(fs.readFileSync(path.join(USERDATA_DIR, 'app-storage.json'), 'utf8'));
    return currentUserFromStorage(storage);
  } catch (e) { return null; }
}

// ---------- kill / launch ----------
function killTypeless() { PLAT.killApp(); }
async function launchTypeless() {
  if (!TYPELESS_EXE) throw new Error('Typeless 可执行文件路径未配置,无法启动');
  await PLAT.launchApp(TYPELESS_EXE);
}
function isTypelessRunning() { return TYPELESS_EXE ? !!PLAT.isAppRunning(TYPELESS_EXE) : false; }

// ---------- 解除设备限制 ----------
async function resetDevice() {
  killTypeless(); await sleep(1500);
  // 1) 删设备 ID 凭据(真正来源:Win 凭据管理器 / Mac Keychain)
  PLAT.deleteDeviceCredential(CRED_TARGET);
  // 2) 删 device.cache
  try { fs.unlinkSync(path.join(DEVICE_CACHE_DIR, 'device.cache')); } catch (e) {}
  // 3) 删 user-data.json(加密登录凭证,含设备绑定)
  try { fs.unlinkSync(path.join(USERDATA_DIR, 'user-data.json')); } catch (e) {}
  // 4) 清 app-storage 的 userData / quotaUsage
  try {
    const ap = path.join(USERDATA_DIR, 'app-storage.json');
    const a = JSON.parse(fs.readFileSync(ap, 'utf8'));
    a.userData = {}; if ('quotaUsage' in a) delete a.quotaUsage;
    fs.writeFileSync(ap, JSON.stringify(a, null, '\t'));
  } catch (e) {}
  // 5) 清 Local Storage / Cookies(登录残留)
  for (const sub of ['Local Storage', 'Network']) {
    try { fs.rmSync(path.join(USERDATA_DIR, sub), { recursive: true, force: true }); } catch (e) {}
  }
  await launchTypeless();
}

// 跳过新手引导(文件方案):kill Typeless → 改 app-onboarding.json → 重启,全程无 CDP
async function skipOnboarding() {
  const filePath = path.join(USERDATA_DIR, 'app-onboarding.json');
  if (!fs.existsSync(filePath))
    throw new Error('未找到 app-onboarding.json(' + filePath + '),Typeless 是否已安装?');

  // 1) kill Typeless
  killTypeless();
  await sleep(1500);

  // 2) 改 app-onboarding.json
  let data = {};
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '') || '{}'); } catch (e) {}
  const flags = {
    isCompleted: true, step: 999, setUpStep: 999, tryItStep: 999,
    tryItPlaygroundStep: 999, onboardingTryItPlaygroundIsCompleted: true,
    __ONBOARDING_UPGRADE_NOTICE: true, onboardingMaxReachedStep: 999, onboardingStep: 999,
  };
  data = { ...data, ...flags };
  fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf8');

  // 3) 重启 Typeless(干净,无调试端口)
  await PLAT.launchApp(TYPELESS_EXE);
  return { done: true, results: flags, note: '已以干净模式重启 Typeless' };
}

// 检测新手引导状态(文件方案):直接读 app-onboarding.json
function checkOnboardingStatus() {
  const filePath = path.join(USERDATA_DIR, 'app-onboarding.json');
  if (!fs.existsSync(filePath)) return { completed: false, reason: 'file_not_found' };
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    const data = JSON.parse(raw);
    return { completed: !!data.isCompleted, step: data.step ?? 0 };
  } catch (e) {
    return { completed: false, reason: 'parse_error' };
  }
}


// ---------- 主 CSV ----------
function readMaster() {
  if (!fs.existsSync(MASTER_CSV)) return [];
  return fs.readFileSync(MASTER_CSV, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function writeMaster(terms) {
  const uniq = [...new Set(terms.map(t => t.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  fs.writeFileSync(MASTER_CSV, uniq.join('\n') + '\n');
  return uniq;
}

// ---------- curl 调 Typeless API(走系统代理,数组传参避免 shell 转义) ----------
async function curlApi(method, p, token, body) {
  const tmp = path.join(os.tmpdir(), `typeless_${process.pid}_${Date.now()}.json`);
  const args = [
    '-s', '-m', '20', '-X', method,
    `${API_BASE}${p}`,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body !== undefined) {
    fs.writeFileSync(tmp, JSON.stringify(body));
    // Windows 下 --data-binary 用 Windows 路径分隔符也可,curl 都接受
    args.push('--data-binary', `@${tmp}`);
  }
  let out, errOut = '';
  try {
    const r = await execFileAsync('curl', args, { maxBuffer: 1 << 26, windowsHide: true });
    out = r.stdout || ''; errOut = r.stderr || '';
  } catch (e) { out = (e.stdout || '') + ''; errOut = (e.stderr || '') + ''; }
  try { if (body !== undefined) fs.unlinkSync(tmp); } catch (e) {}
  try { return JSON.parse(out); }
  catch (e) { return { _error: 'non-json', _raw: out.slice(0, 200), _stderr: errOut.slice(0, 200) }; }
}

// ---------- CDP ----------
async function fetchLocal(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function portUp(port = CDP_PORT) {
  try { const r = await fetchLocal(`http://127.0.0.1:${port}/json/version`); return r.ok; }
  catch (e) { return false; }
}
async function withCDP(fn, port = CDP_PORT) {
  let targets;
  for (let i = 0; i < 24; i++) {
    for (const ep of ['/json', '/json/list']) {
      try {
        const ts = await (await fetchLocal(`http://127.0.0.1:${port}${ep}`)).json();
        if (Array.isArray(ts) && ts.length) { targets = ts; break; }
      } catch (e) {}
    }
    if (targets && targets.length) break;
    await sleep(500);
  }
  if (!targets || !targets.length) throw new Error('CDP 无响应，请确认 Typeless 能正常启动');
  const t = targets.find(x => x.title === 'Typeless') || targets.find(x => x.type === 'page') || targets[0];
  if (!t) throw new Error('找不到 Typeless 渲染窗口');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Typeless 调试窗口超时')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('无法连接 Typeless 调试窗口')); };
  });
  let id = 0; const pending = new Map();
  const eventListeners = [];
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (pending.has(m.id)) {
      const item = pending.get(m.id);
      clearTimeout(item.timer);
      pending.delete(m.id);
      item.resolve(m);
      return;
    }
    if (m.method) eventListeners.forEach(listener => { try { listener(m); } catch (err) {} });
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    id++;
    const requestId = id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Typeless 调试命令超时: ' + method));
    }, 6000);
    pending.set(requestId, { resolve, reject, timer });
    try { ws.send(JSON.stringify({ id: requestId, method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(requestId); reject(e); }
  });
  const onEvent = listener => eventListeners.push(listener);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('JS 错误: ' + (r.result.exceptionDetails.exception?.description?.slice(0, 300)));
    return r.result.result.value;
  };
  try { return await fn(send, ev, onEvent); }
  finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Typeless 调试连接已关闭')); }
    pending.clear();
    try { ws.close(); } catch (e) {}
  }
}

// 注入 fetch/XHR 捕获脚本(已验证逻辑)
const CAPTURE_SCRIPT = `(function(){
  window.__captured=[];
  const of=window.fetch;
  window.fetch=function(u,o){
    try{
      const a=o&&(o.headers&&(o.headers.Authorization||o.headers.authorization))
        ||((o&&o.headers&&o.headers.get)?o.headers.get('Authorization'):null);
      if(a)window.__captured.push({url:String(u),auth:String(a)});
    }catch(e){}
    return of.apply(this,arguments);
  };
  const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return oo.apply(this,arguments);};
  XMLHttpRequest.prototype.setRequestHeader=function(k,v){
    if(/authorization/i.test(k))window.__captured.push({url:String(this.__u),auth:String(v)});
    return os.apply(this,arguments);
  };
})();`;

// 抓 token:注入捕获 → 重载 → 读 window.__captured 里的 Bearer
// 流程:若 Typeless 未带调试端口运行,会先 kill → 启动(带调试端口) → 抓 → 最后恢复干净模式
async function captureTokenCDP(port, autoRestart = true) {
  const usePort = port || CDP_PORT;
  const captureStartedAt = Date.now();
  const captureLog = message => log('[capture +' + ((Date.now() - captureStartedAt) / 1000).toFixed(1) + 's] ' + message);

  // 探测当前状态
  let portReady = await portUp(usePort);
  let typelessWasRunning = await PLAT.isAppRunning(TYPELESS_EXE);
  let restartedByUs = false;

  try {
    if (!portReady) {
      // autoRestart=false(仅做状态探测)时不杀 Typeless，避免打断用户正在使用。
      if (!autoRestart) throw new Error('Typeless 未以调试端口运行');
      if (!TYPELESS_EXE) throw new Error('未找到 Typeless 可执行文件');
      restartedByUs = true;
      captureLog('正在临时重启 Typeless 调试模式');
      await PLAT.restartWithDebug(TYPELESS_EXE, usePort);
      captureLog('调试端口已就绪');
    }

    return await withCDP(async (send, ev, onEvent) => {
      captureLog('已连接 Typeless 窗口');
      const captured = [];
      const addCapture = (url, auth) => {
        if (auth && /Bearer\s+\S+/i.test(String(auth))) captured.push({ url: String(url || API_BASE), auth: String(auth) });
      };
      onEvent(message => {
        if (message.method !== 'Network.requestWillBeSent') return;
        const request = message.params && message.params.request;
        const headers = request && request.headers || {};
        addCapture(request && request.url, headers.Authorization || headers.authorization);
      });

      await send('Page.enable');
      await send('Network.enable');
      let scriptId = null;
      try {
        const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT });
        scriptId = added.result && added.result.identifier;
        await send('Page.reload');
        captureLog('页面已重载，等待登录请求');

        // 网络事件为主通道，固定最长等待 12 秒；不要在循环里反复等待 CDP 命令超时。
        for (let i = 0; i < 48 && !captured.length; i++) await sleep(250);

        // 页面注入作为一次性兜底，最多再等 1.2 秒。
        if (!captured.length) {
          try {
            const pageJson = await Promise.race([
              ev('JSON.stringify(window.__captured||[])'),
              sleep(1200).then(() => { throw new Error('读取页面凭证超时'); }),
            ]);
            const pageCaptured = JSON.parse(pageJson || '[]');
            pageCaptured.forEach(item => addCapture(item.url, item.auth));
          } catch (e) {}
        }
      } finally {
        if (scriptId) { try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch (e) {} }
      }

      const hit = captured[0];
      if (!hit) throw new Error('未抓到登录凭证。请确认 Typeless 已完成登录并能正常使用，然后重试');
      captureLog('已抓到登录凭证');
      const token = hit.auth.replace(/^Bearer\s+/i, '');
      const origin = (() => { try { return new URL(hit.url).origin; } catch (e) { return API_BASE; } })();
      let user_id = null;
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        user_id = payload.subject?.user_id;
      } catch (e) {}
      if (!user_id) throw new Error('已抓到凭证，但无法识别账号 ID');
      // 邮箱和套餐可直接从本地 app-storage.json 取得，避免抓取流程被外部 API 网络超时拖住。
      const currentInfo = detectCurrentAccountFromFile();
      const user_info = currentInfo.found && currentInfo.user_id === user_id ? {
        email: currentInfo.email || '',
        roles: String(currentInfo.roles || '').split(',').filter(Boolean).map(name => ({ name })),
      } : null;
      return { token, origin, user_id, user_info, captured_at: new Date().toISOString() };
    }, usePort);
  } finally {
    // 无论成功、失败或超时，只要是本工具开启的调试模式，就必须恢复普通启动。
    if (restartedByUs) {
      try {
        captureLog('正在恢复 Typeless 普通模式');
        await PLAT.restartClean(TYPELESS_EXE, typelessWasRunning);
        captureLog('Typeless 已恢复普通模式');
      }
      catch (e) { log('[capture] 恢复 Typeless 普通模式失败:', e.message); }
    }
  }
}

// 探测当前文件:读 app-storage.json(userData),无需 CDP
function detectCurrentAccountFromFile() {
  if (!TYPELESS_EXE || !fs.existsSync(TYPELESS_EXE)) return { found: false, error: 'Typeless 未配置' };
  const sp = path.join(USERDATA_DIR, 'app-storage.json');
  try {
    const raw = fs.readFileSync(sp, 'utf8').replace(/^﻿/, '');
    const s = JSON.parse(raw);
    if (!s.userData) return { found: false, error: 'app-storage.json 无 userData' };
    const u = s.userData;
    return {
      found: true, user_id: u.user_id, email: u.email,
      roles: (u.roles || []).map(r => r.name).join(','),
      raw: u,
    };
  } catch (e) { return { found: false, error: e.message }; }
}

// ---------- JWT 解析 ----------
// 解 JWT payload;失败返回 null(不抛)
function parseJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
  catch (e) { return null; }
}
// 取 token 过期时间(毫秒时间戳);无 exp 返回 null
function tokenExpiryMs(token) {
  const p = parseJwt(token);
  return p && p.exp ? p.exp * 1000 : null;
}

// ---------- 词库全量拉取(自动翻页,突破单页 size 上限) ----------
async function fetchAllWords(token, pageSize = 500) {
  const first = await curlApi('GET', `/user/dictionary/list?size=${pageSize}`, token);
  const total = first.data?.total_count ?? (first.data?.words || []).length;
  let words = first.data?.words || [];
  // 词库超过单页上限时继续翻页(offset/page 二选一,优先 offset)
  while (words.length < total) {
    const next = await curlApi('GET', `/user/dictionary/list?size=${pageSize}&offset=${words.length}`, token);
    const batch = next.data?.words || [];
    if (!batch.length) break;
    words = words.concat(batch);
  }
  return { words, total_count: total };
}

// 词库导出为文本(一行一词,按中文排序)
function dictToText(words) {
  return [...new Set((words || []).map(w => (typeof w === 'string' ? w : w.term)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh')).join('\n');
}

// ---------- 实时状态 ----------
async function liveStatus(acc) {
  const out = {
    token_valid: true, usage: null, personal: null, dict_count: 0, user_info: null,
    token_exp: tokenExpiryMs(acc.token), token_days_left: null,
  };
  if (out.token_exp) out.token_days_left = Math.floor((out.token_exp - Date.now()) / 86400000);
  // token 本地已过期,直接判失效,省去网络往返
  if (out.token_exp && out.token_exp < Date.now()) { out.token_valid = false; return out; }
  try {
    const [ui, us, ps, dl] = await Promise.all([
      curlApi('GET', '/user/get_user_info', acc.token),
      curlApi('POST', '/user/usage_stats', acc.token, {}),
      curlApi('POST', '/user/personal_stats', acc.token, {}),
      curlApi('GET', '/user/dictionary/list?size=1', acc.token),
    ]);
    out.user_info = ui.data || null;
    out.usage = us.data?.voice_transcription || null;
    out.personal = ps.data || null;
    out.dict_count = dl.data?.total_count ?? 0;
    if (ui.detail && /Unauthorized|invalid|expired/i.test(JSON.stringify(ui))) out.token_valid = false;
    // 全部子请求都拿不到有效数据时,判为失效(网络异常也归此类,前端提示重抓)
    if (!out.user_info && !out.usage && !out.personal) out.token_valid = false;
  } catch (e) { out.token_valid = false; out._err = e.message; }
  return out;
}

// ---------- 数据备份(账号表 + 主词库,带时间戳,永不覆盖) ----------
function backupData() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const f of ['accounts.json', config.master_csv]) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, path.basename(f))); copied.push(path.basename(f)); }
  }
  return { dir, stamp, files: copied };
}

// ---------- 同步(单账号:导出→合并主 CSV→补齐缺失) ----------
async function syncAccount(acc) {
  const dl = await fetchAllWords(acc.token);
  const accountWords = (dl.words || []).map(w => w.term).filter(Boolean);
  const masterBefore = readMaster();
  const masterMerged = writeMaster([...masterBefore, ...accountWords]);
  const accountSet = new Set(accountWords);
  const missing = masterMerged.filter(w => !accountSet.has(w));
  let imported = 0;
  if (missing.length) {
    const r = await curlApi('POST', '/user/dictionary/bulk-import', acc.token, { content: missing.join('\n') });
    imported = r.data?.success_count ?? 0;
  }
  return { exported: accountWords.length, imported, master_count: masterMerged.length };
}

// ---------- 弹窗补丁(自动定位 + asar 完整性处理) ----------
// 枚举渲染层脚本。不能再只找第一个含 paywall 的文件：2.0.1 新增了
// onboarding 埋点 "22_paywall"，会让宽泛搜索命中错误文件。
function detectPaywallFile(header) {
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) { walk(child, p); }
      else if (child.offset !== undefined &&
               /^dist\/renderer\/static\/js\//i.test(p) &&
               /\.(?:mjs|js)$/i.test(name)) found.push(p);
    }
  };
  walk(header, '');
  // 优先检查现代 mjs chunk，再检查兼容/历史 js chunk。
  return found.sort((a, b) => Number(/\.js$/i.test(a)) - Number(/\.js$/i.test(b)));
}

function getAsarNode(header, filePath) {
  let node = header;
  for (const part of filePath) {
    if (!node || !node.files) return null;
    node = node.files[part];
  }
  return node || null;
}

// 复制 app.asar 到非 .asar 临时文件,绕过 Electron 打包版 asar hook
// (Windows 用 cmd copy 绕过;macOS 无此困扰,platform.copyRaw 直接 fs 复制)
function asarToTmp() {
  const tmp = path.join(os.tmpdir(), `tt_asar_${process.pid}_${Date.now()}.bin`);
  PLAT.copyRaw(ASAR_PATH, tmp);
  return tmp;
}
// 把临时文件覆盖回 app.asar
function tmpToAsar(tmp) { PLAT.copyRaw(tmp, ASAR_PATH); }

// 从 .mjs 内容中自动检测付费墙弹窗函数调用,生成等长替换对
// 匹配模式: if(type==='paywall')funcName(argName) 及反向变体
// 返回 [[from, to], ...] 或 null(未找到或数量不足)
function autoDetectReplacementsFromContent(content) {
  const results = [];
  const seen = new Set();

  // 模式1: type==='paywall')func(arg)  —— 最常见的 if 条件分支
  const re1 = /['"]paywall['"]\s*\)\s*(\w+)\s*\(\s*(\w+)\s*\)/g;
  let m;
  while ((m = re1.exec(content)) !== null) {
    const key = m[1] + '(' + m[2] + ')';
    if (!seen.has(key)) { seen.add(key); results.push([key, '(0,' + m[2] + ')']); }
  }

  // 模式2: 'paywall'===type&&func(arg)  —— 短路求值变体
  const re2 = /['"]paywall['"]\s*===\s*\w+(?:\[['"]type['"]\])?\s*&&\s*(\w+)\s*\(\s*(\w+)\s*\)/g;
  while ((m = re2.exec(content)) !== null) {
    const key = m[1] + '(' + m[2] + ')';
    if (!seen.has(key)) { seen.add(key); results.push([key, '(0,' + m[2] + ')']); }
  }

  // 正常应有 2 处( onImportantNotification + onSessionInterrupt )
  return results.length >= 2 ? results : null;
}

// 已补丁代码会从 func(arg) 变成 (0,arg)，函数名已经丢失；仍需能识别幂等状态。
function hasAutoPatchedPaywallCalls(content) {
  const matches = content.match(/['"]paywall['"]\s*\)\s*\(0,\s*\w+\s*\)/g) || [];
  return matches.length >= 2;
}

// 从源码推导等长替换对（供单测与版本探测；运行时补丁仍走 autoDetect + locatePaywallTarget）
function resolvePaywallReplacements(content) {
  const configured = (config.paywall && config.paywall.replacements) || [];
  if (configured.length) {
    const hasConfiguredOld = configured.every(([from]) => content.includes(from));
    const hasConfiguredNew = configured.every(([, to]) => content.includes(to));
    if (hasConfiguredOld || hasConfiguredNew) {
      return { replacements: configured, alreadyPatched: !hasConfiguredOld && hasConfiguredNew, detected: false };
    }
  }

  const patchedPattern = /if\(([_$\w]+)\[(?:'type'|"type")\]===(?:'paywall'|"paywall")\)\(0,\1\)/g;
  if ([...content.matchAll(patchedPattern)].length >= 2) {
    return { replacements: [], alreadyPatched: true, detected: true };
  }

  const callPattern = /if\(([_$\w]+)\[(?:'type'|"type")\]===(?:'paywall'|"paywall")\)([_$\w]+)\(\1\)/g;
  const unique = [];
  for (const match of content.matchAll(callPattern)) {
    const from = `${match[2]}(${match[1]})`;
    const to = `(0,${match[1]})`;
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) continue;
    if (!unique.some(([existing]) => existing === from)) unique.push([from, to]);
  }
  if (unique.length < 2) {
    throw new Error('无法推导两个等长替换标记；当前 Typeless 版本结构可能已变化');
  }
  return { replacements: unique.slice(0, 2), alreadyPatched: false, detected: true };
}

// 枚举 asar 内全部 js/mjs（作为 dist 路径探测的兜底，避免结构变化或测试夹具漏检）
function listAsarScripts(header) {
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) walk(child, p);
      else if (child.offset !== undefined && /\.(?:mjs|js)$/i.test(name)) found.push(p);
    }
  };
  walk(header, '');
  return found;
}

// 找到真正处理 onImportantNotification / onSessionInterrupt 的文件，并验证其中
// 存在两处可等长替换的 paywall 调用。返回第一个含 paywall 的文件会误中埋点。
function locatePaywallTarget(header, buf, dataStart) {
  const configured = (config.paywall.file_path || []).join('/');
  const candidates = [];
  const seen = new Set();
  const push = (rel) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    candidates.push(rel);
  };
  if (configured) push(configured);
  if (config.paywall.auto_detect_file) {
    for (const rel of detectPaywallFile(header)) push(rel);
    // 严格路径未命中时，再扫全部脚本（真实 asar 与单测夹具都适用）
    for (const rel of listAsarScripts(header)) push(rel);
  }

  for (const rel of candidates) {
    const filePath = rel.split('/');
    const node = getAsarNode(header, filePath);
    if (!node || node.offset === undefined || !node.size) continue;
    const offset = dataStart + (+node.offset);
    const content = buf.subarray(offset, offset + node.size);
    const text = content.toString('utf8');
    const configuredOld = config.paywall.replacements.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    const configuredNew = config.paywall.replacements.every(([, to]) => content.includes(Buffer.from(to, 'utf8')));
    const replacements = autoDetectReplacementsFromContent(text);
    const autoPatched = hasAutoPatchedPaywallCalls(text);
    const semanticMatch = /onImportantNotification/.test(text) && /onSessionInterrupt/.test(text);

    if (configuredOld || configuredNew || (semanticMatch && (replacements || autoPatched))) {
      return {
        filePath, node, content, replacements, autoPatched,
        detected: rel !== configured,
      };
    }
  }
  return null;
}

// 只读检测:app.asar 内目标文件是否已打过补丁
function paywallStatus() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) return { exists: false, error: 'app.asar 未找到(Typeless.exe 路径未配置?)' };
  let tmpAsar = null;
  try {
    tmpAsar = asarToTmp();
    const buf = fs.readFileSync(tmpAsar);
    const jl = buf.readUInt32LE(12);
    const dataStart = 16 + jl + ((16 + jl) % 4 ? (4 - ((16 + jl) % 4)) : 0);
    const header = JSON.parse(buf.subarray(16, 16 + jl).toString('utf8'));

    const target = locatePaywallTarget(header, buf, dataStart);
    if (!target) {
      return {
        exists: true, patched: false,
        error: 'asar 内未找到经过语义验证的付费墙处理文件。' +
               '当前 Typeless 版本的渲染结构暂不受支持,请更新工具或提交 issue 并附上错误文本。',
      };
    }
    const { filePath, content } = target;
    // 检查所有替换标记
    const repls = config.paywall.replacements;
    const hasOld = repls.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    const hasNew = repls.every(([, to]) => content.includes(Buffer.from(to, 'utf8')));
    // 若配置标记不匹配,尝试自动检测(方便前端显示是否可自动修复)
    let autoDetected = null;
    if (!hasOld && !hasNew && target.replacements) autoDetected = target.replacements;
    return {
      exists: true,
      patched: (!hasOld && hasNew) || target.autoPatched,
      autoDetected,
      detected_file: target.detected ? filePath.join('/') : null,
      file_path: filePath.join('/'),
      has_backup: fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(TYPELESS_EXE + '.bak'),
    };
  } catch (e) { return { exists: false, error: e.message }; }
  finally { if (tmpAsar) try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 执行补丁:内容替换 + 同步 per-file SHA256 + (可选)同步 exe 内嵌整头 SHA256
async function patchPaywall() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) throw new Error('app.asar 未找到(Typeless.exe 路径未配置?)');
  if (!TYPELESS_EXE || !fs.existsSync(TYPELESS_EXE)) throw new Error('Typeless.exe 未找到');
  const asarBak = ASAR_PATH + '.bak', exeBak = TYPELESS_EXE + '.bak';
  // 首次备份:asar 用 platform.copyRaw(Win 绕 hook / Mac 直接复制),exe 用 fs
  if (!fs.existsSync(asarBak)) { try { PLAT.copyRaw(ASAR_PATH, asarBak); } catch (e) {} }
  if (!fs.existsSync(exeBak)) fs.copyFileSync(TYPELESS_EXE, exeBak);

  // 步骤 0:通过 @electron/fuses 关闭 exe 内嵌的 asar 完整性校验
  // 成功后不再需要在 exe 二进制里找 hash 替换(更稳健,避免版本差异导致失败)
  let fuseSkipped = false;
  if (flipFuses && FuseVersion && FuseV1Options) {
    try {
      await flipFuses(TYPELESS_EXE, {
        version: FuseVersion.V1,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      });
      fuseSkipped = true;
    } catch (e) { /* 失败则回退到传统 exe hash 替换 */ }
  }

  // 复制到临时非 .asar 文件操作,绕过 asar hook;最后覆盖回原 asar
  const tmpAsar = asarToTmp();
  try {
    const fd = fs.openSync(tmpAsar, 'r+');
    const fsize = fs.statSync(tmpAsar).size;
    const buf = Buffer.alloc(fsize);
    fs.readSync(fd, buf, 0, fsize, 0);
    const jl = buf.readUInt32LE(12);
    const dataStart = 16 + jl + ((16 + jl) % 4 ? (4 - ((16 + jl) % 4)) : 0);
    const headerStart = 16, headerEnd = 16 + jl;
    const header = JSON.parse(buf.subarray(headerStart, headerEnd).toString('utf8'));

    // 定位并语义验证目标文件(同 paywallStatus 逻辑)
    const target = locatePaywallTarget(header, buf, dataStart);
    if (!target) throw new Error('asar 内未找到经过语义验证的付费墙处理文件。当前 Typeless 版本暂不受支持,请更新工具或提交 issue 并附上错误文本');
    const { filePath, node } = target;

    const foff = dataStart + (+node.offset), size = node.size;
    const oldHash = node.integrity.hash;
    const content = Buffer.from(buf.subarray(foff, foff + size));

    let repls = config.paywall.replacements.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
    // 幂等:已打过则跳过
    const alreadyPatched = target.autoPatched || repls.every(([from], i) => !content.includes(from) && content.includes(repls[i][1]));
    if (alreadyPatched) {
      fs.closeSync(fd);
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }

    // 检查所有标记是否都存在;若缺失则尝试自动检测(不同版本混淆名不同)
    const allFound = repls.every(([from]) => content.includes(from));
    if (!allFound) {
      const contentStr = content.toString('utf8');
      const detected = target.replacements || autoDetectReplacementsFromContent(contentStr);
      if (detected && detected.length >= 2) {
        const cfgPath = path.join(ROOT, 'config.local.json');
        let localCfg = {};
        try { if (fs.existsSync(cfgPath)) localCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
        localCfg.paywall = { ...(localCfg.paywall || {}), file_path: filePath, replacements: detected };
        fs.writeFileSync(cfgPath, JSON.stringify(localCfg, null, 2) + '\n', 'utf8');
        // 重载 config & repls
        config.paywall.file_path = filePath;
        config.paywall.replacements = detected;
        repls = detected.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
      } else {
        throw new Error(
          '未找到标记,且自动检测失败。' +
          '当前 Typeless 版本的代码结构暂不受支持,请更新工具或提交 issue 并附上错误文本'
        );
      }
    }

    // 1) 内容补丁(等长替换)
    for (const [from, to] of repls) {
      const i = content.indexOf(from);
      if (i < 0) throw new Error('内部错误:标记应在 content 中但未找到:' + from.toString());
      if (i !== content.lastIndexOf(from)) throw new Error('标记不唯一(异常):' + from.toString());
      to.copy(content, i);
    }
    const newHash = crypto.createHash('sha256').update(content).digest('hex');

    // 2) 旧整头 SHA256(改 per-file 前) —— 这就是 exe 里现存的 hex
    const oldHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

    // 3) 头里替换 per-file hash(integrity.hash 与 blocks[0],共 2 处,等长 64 hex)
    const headerBuf = buf.subarray(headerStart, headerEnd);
    const oldHB = Buffer.from(oldHash, 'utf8'), newHB = Buffer.from(newHash, 'utf8');
    if (oldHB.length !== newHB.length) throw new Error('hash 长度不一致(异常)');
    let cnt = 0, idxs = [], p = headerBuf.indexOf(oldHB);
    while (p >= 0) { cnt++; idxs.push(p); p = headerBuf.indexOf(oldHB, p + 1); }
    if (cnt !== 2) throw new Error('头里旧 per-file hash 出现 ' + cnt + ' 次,预期 2 次(asar 结构异常)');
    for (const pp of idxs) newHB.copy(headerBuf, pp);

    // 4) 新整头 SHA256(头里 per-file 已改)
    const newHeaderHash = crypto.createHash('sha256').update(buf.subarray(headerStart, headerEnd)).digest('hex');

    // 5) 写回临时 asar 的内容区 + 头区
    fs.writeSync(fd, content, 0, size, foff);
    fs.writeSync(fd, headerBuf, 0, headerBuf.length, headerStart);
    fs.closeSync(fd);

    // 6) 改内嵌整头 SHA256 的可执行文件
    //    若步骤 0 的 @electron/fuses 已成功关闭校验,则跳过这一步
    const BIN = PLAT.binaryPathFor(TYPELESS_EXE);
    let exe_hits = 0;
    if (!fuseSkipped) {
      const exfd = fs.openSync(BIN, 'r+');
      const estat = fs.statSync(BIN);
      const exb = Buffer.alloc(estat.size);
      fs.readSync(exfd, exb, 0, estat.size, 0);
      const oldEB = Buffer.from(oldHeaderHash, 'utf8'), newEB = Buffer.from(newHeaderHash, 'utf8');
      let ei = exb.indexOf(oldEB), ecnt = 0, eidxs = [];
      while (ei >= 0) { ecnt++; eidxs.push(ei); ei = exb.indexOf(oldEB, ei + 1); }
      if (ecnt < 1) throw new Error('可执行文件里找不到旧整头 hash(可能已被改过或版本不符),已还原请检查');
      for (const pp of eidxs) newEB.copy(exb, pp);
      fs.writeSync(exfd, exb, 0, estat.size, 0);
      fs.closeSync(exfd);
      exe_hits = ecnt;
    }

    // 7) 把改好的临时 asar 覆盖回原 app.asar(此时 Typeless 已关闭,可写)
    tmpToAsar(tmpAsar);

    // 8) macOS:改过 Mach-O 二进制后必须 ad-hoc 重签名,否则 AMFI/Gatekeeper 拒绝运行(实验性)
    let resign = null;
    if (IS_MAC) resign = PLAT.resignApp(BIN);

    return {
      already: false, done: true, fuse_disabled: fuseSkipped, exe_hits, resign,
      file_hash: { old: oldHash, new: newHash },
      header_hash: { old: oldHeaderHash, new: newHeaderHash },
      msg: '补丁已打好,升级/会员弹窗将不再弹出(重启 Typeless 生效)' +
        (IS_MAC ? (resign && resign.done ? ';已 ad-hoc 重签名' : ';⚠️ 自动重签名未成功,请手动执行 codesign --force --deep --sign - <Typeless.app>') : ''),
    };
  } catch (e) {
    // 失败:二进制可能已改,从备份还原;asar 未覆盖回(只改了 tmp),保持原样无需还原
    try { if (fs.existsSync(exeBak)) fs.copyFileSync(exeBak, PLAT.binaryPathFor(TYPELESS_EXE)); } catch (_) {}
    throw e;
  } finally { try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 运行环境信息(供前端 /api/env 排错,尤其 macOS 定位路径问题)
function envInfo() {
  const deviceCacheFile = path.join(DEVICE_CACHE_DIR, 'device.cache');
  const info = {
    service: 'typeless-toolkit',
    manager_port: config.manager_port,
    platform: PLAT.os,
    node: process.version,
    typeless_exe: TYPELESS_EXE || null,
    exe_found: !!TYPELESS_EXE,
    userdata_dir: USERDATA_DIR,
    device_cache_dir: DEVICE_CACHE_DIR,
    credential_target: CRED_TARGET,
    asar_path: ASAR_PATH || null,
    data_root: ROOT,
  };
  // macOS 额外返回路径/进程探测结果,方便对照实测目录
  if (IS_MAC) {
    info.exe_found = !!TYPELESS_EXE && fs.existsSync(TYPELESS_EXE);
    info.typeless_running = isTypelessRunning();
    info.userdata_exists = fs.existsSync(USERDATA_DIR);
    info.device_cache_exists = fs.existsSync(deviceCacheFile);
    info.asar_exists = !!(ASAR_PATH && fs.existsSync(ASAR_PATH));
    info.cdp_port = CDP_PORT;
  }
  return info;
}

module.exports = {
  // 常量
  ROOT, CODE_DIR, config, DEFAULT_CONFIG, IS_WIN, IS_MAC,
  TYPELESS_EXE, USERDATA_DIR, DEVICE_CACHE_DIR, CRED_TARGET, ASAR_PATH,
  API_BASE, CDP_PORT, MASTER_CSV, PROFILES_DIR, ACCOUNTS_FILE, SNAPSHOT_FILES,
  // 工具
  log, sleep, execAsync, execFileAsync,
  detectTypelessExe, loadConfig, envInfo,
  // 账号 / 快照
  readAccounts, writeAccounts, readCurrentUser, currentUserFromStorage,
  saveSnapshot, restoreSnapshot, hasSnapshot,
  // kill / launch / 设备
  isTypelessRunning, killTypeless, launchTypeless, resetDevice, portUp,
  // 主 CSV
  readMaster, writeMaster,
  // API + CDP
  curlApi, captureTokenCDP,
  fetchAllWords, dictToText, parseJwt, tokenExpiryMs,
  // 状态 + 同步 + 备份
  liveStatus, syncAccount, backupData,
  // 弹窗补丁
  paywallStatus, patchPaywall,
  resolvePaywallReplacements,
  locatePaywallTarget,
  // 跳新手引导与当前账号探测（日常路径均无需 CDP）
  skipOnboarding, checkOnboardingStatus, detectCurrentAccountFromFile,
};
