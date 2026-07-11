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
    // minified 变量名无法自动推测,版本变了需手动填
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
const INTEGRITY_PATH = TYPELESS_EXE ? PLAT.integrityPathFor(TYPELESS_EXE) : '';
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
function launchTypeless() {
  if (!TYPELESS_EXE) throw new Error('Typeless 可执行文件路径未配置,无法启动');
  PLAT.launchApp(TYPELESS_EXE, CDP_PORT);
}

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
  launchTypeless();
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
async function portUp() {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return r.ok; }
  catch (e) { return false; }
}
async function ensureApp() {
  if (await portUp()) return;
  log('Typeless 未带调试端口,正在以调试端口重启…');
  killTypeless();
  // 等旧进程端口真正关闭,避免 portUp 捡到旧进程残余误判就绪
  for (let i = 0; i < 10; i++) { if (!(await portUp())) break; await sleep(500); }
  await sleep(500);
  launchTypeless();
  for (let i = 0; i < 40; i++) { if (await portUp()) return; await sleep(500); }
}
async function withCDP(fn) {
  let targets;
  for (let i = 0; i < 40; i++) {
    for (const ep of ['/json', '/json/list']) {
      try {
        const ts = await (await fetch(`http://127.0.0.1:${CDP_PORT}${ep}`)).json();
        if (Array.isArray(ts) && ts.length) { targets = ts; break; }
      } catch (e) {}
    }
    if (targets && targets.length) break;
    await sleep(500);
  }
  if (!targets || !targets.length) throw new Error('CDP 无响应,请确认 Typeless 已用 --remote-debugging-port=' + CDP_PORT + ' 启动');
  const t = targets.find(x => x.title === 'Typeless') || targets.find(x => x.type === 'page') || targets[0];
  if (!t) throw new Error('找不到 Typeless 渲染窗口');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(res => {
    id++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error('JS 错误: ' + (r.result.exceptionDetails.exception?.description?.slice(0, 300)));
    return r.result.result.value;
  };
  try { return await fn(send, ev); } finally { ws.close(); }
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

// 抓 token: 注入捕获 → 重载 → 读 window.__captured 里的 Bearer
async function captureTokenCDP(port, autoRestart = true) {
  const usePort = port || CDP_PORT;
  // 检查端口是否就绪
  let ready = false;
  try { ready = (await fetch(`http://127.0.0.1:${usePort}/json/version`)).ok; } catch (e) {}
  if (!ready) {
    // autoRestart=false(如打开管理器时的自动检测)不杀 Typeless,避免一打开就打断用户正在用的 Typeless
    if (!autoRestart) throw new Error('Typeless 未以调试端口运行');
    await ensureApp();
  }
  return withCDP(async (send, ev) => {
    await send('Page.enable');
    const sid = (await send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT })).result.identifier;
    await send('Page.reload');
    await sleep(6000);
    const captured = JSON.parse(await ev('JSON.stringify(window.__captured||[])') || '[]');
    try { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch (e) {}
    const hit = captured.find(c => /Bearer\s+\S+/.test(c.auth));
    if (!hit) throw new Error('未抓到 token,请确认 Typeless 已登录账号后再试');
    const token = hit.auth.replace(/^Bearer\s+/, '');
    const origin = (() => { try { return new URL(hit.url).origin; } catch (e) { return API_BASE; } })();
    // 附带 user_info(若失败不阻断)
    let user_info = null;
    try {
      const ui = await curlApi('GET', '/user/get_user_info', token);
      user_info = ui.data || null;
    } catch (e) {}
    // 解 JWT payload 取 user_id
    let user_id = null, payload = null;
    try {
      payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      user_id = payload.subject?.user_id;
    } catch (e) {}
    return { token, origin, user_id, user_info, captured_at: new Date().toISOString() };
  });
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

// ---------- 弹窗补丁(两层 asar 完整性) ----------
// 自动探测 asar 内可能承载弹窗逻辑的脚本文件
function detectPaywallFile(header) {
  const found = [];
  const walk = (node, prefix) => {
    if (!node || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) { walk(child, p); }
      else if (child.offset !== undefined && /\.(mjs|js)$/i.test(name)) found.push(p);
    }
  };
  walk(header, '');
  return found; // 相对路径数组(用 / 分隔)
}

function nodeAtPath(header, parts) {
  let node = header;
  for (const part of parts) {
    if (!node || !node.files) return null;
    node = node.files[part];
  }
  return node || null;
}

function locatePaywallTarget(header, buf, dataStart) {
  const configuredPath = config.paywall.file_path;
  const configuredKey = configuredPath.join('/');
  const paths = [configuredKey, ...(config.paywall.auto_detect_file ? detectPaywallFile(header) : [])];
  const seen = new Set();
  let best = null;

  for (const rel of paths) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const parts = rel.split('/');
    const node = nodeAtPath(header, parts);
    if (!node || node.offset === undefined) continue;
    const offset = dataStart + (+node.offset);
    const content = buf.subarray(offset, offset + node.size).toString('utf8');
    const hasConfiguredMarker = config.paywall.replacements.some(([from, to]) => content.includes(from) || content.includes(to));
    const hasHandlerShape = content.includes('paywall') &&
      content.includes('onImportantNotification') && content.includes('onSessionInterrupt');
    const score = (hasConfiguredMarker ? 100 : 0) + (hasHandlerShape ? 50 : 0) + (rel === configuredKey ? 1 : 0);
    if (score === 0) continue;
    if (!best || score > best.score) best = { filePath: parts, node, content, score };
  }

  if (!best) return null;
  return { ...best, detected: best.filePath.join('/') !== configuredKey };
}

function resolvePaywallReplacements(content) {
  const configured = config.paywall.replacements;
  const hasConfiguredOld = configured.every(([from]) => content.includes(from));
  const hasConfiguredNew = configured.every(([, to]) => content.includes(to));
  if (hasConfiguredOld || hasConfiguredNew) {
    return { replacements: configured, alreadyPatched: !hasConfiguredOld && hasConfiguredNew, detected: false };
  }

  const patchedPattern = /if\(([_$\w]+)\['type'\]===['"]paywall['"]\)\(0,\1\)/g;
  if ([...content.matchAll(patchedPattern)].length >= 2) {
    return { replacements: [], alreadyPatched: true, detected: true };
  }

  const callPattern = /if\(([_$\w]+)\['type'\]===['"]paywall['"]\)([_$\w]+)\(\1\)/g;
  const calls = [...content.matchAll(callPattern)];
  const unique = [];
  for (const match of calls) {
    const from = `${match[2]}(${match[1]})`;
    const to = `(0,${match[1]})`;
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) continue;
    if (!unique.some(([existing]) => existing === from)) unique.push([from, to]);
  }
  if (unique.length < 2) {
    throw new Error('已定位弹窗处理文件,但无法推导两个等长替换标记;当前 Typeless 版本结构可能已变化');
  }
  return { replacements: unique.slice(0, 2), alreadyPatched: false, detected: true };
}

// 复制 app.asar 到非 .asar 临时文件,绕过 Electron 打包版 asar hook
// Windows 与打包后的 macOS Electron 都必须经 platform.copyRaw 绕过 asar 路径拦截
function asarToTmp() {
  const tmp = path.join(os.tmpdir(), `tt_asar_${process.pid}_${Date.now()}.bin`);
  PLAT.copyRaw(ASAR_PATH, tmp);
  return tmp;
}
// 把临时文件覆盖回 app.asar
function tmpToAsar(tmp) { PLAT.copyRaw(tmp, ASAR_PATH); }

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
        error: 'asar 内未找到弹窗处理文件(config.paywall.file_path 不匹配,且自动探测未找到处理器结构)。' +
               '请阅读 README「弹窗补丁适配」章节,定位你版本的文件后填入 config.json',
      };
    }
    const { filePath, node, detected, content: contentText } = target;
    const foff = dataStart + (+node.offset), size = node.size;
    const content = buf.subarray(foff, foff + size);
    const resolved = resolvePaywallReplacements(contentText);
    const repls = resolved.replacements;
    const hasOld = repls.every(([from]) => content.includes(Buffer.from(from, 'utf8')));
    const hasNew = repls.every(([, to]) => content.includes(Buffer.from(to, 'utf8')));
    return {
      exists: true,
      patched: resolved.alreadyPatched || (!hasOld && hasNew),
      detected_file: detected ? filePath.join('/') : null,
      file_path: filePath.join('/'),
      detected_replacements: resolved.detected ? repls : null,
      has_backup: fs.existsSync(ASAR_PATH + '.bak') && fs.existsSync(INTEGRITY_PATH + '.bak'),
    };
  } catch (e) { return { exists: false, error: e.message }; }
  finally { if (tmpAsar) try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 执行补丁:内容替换 + 同步 per-file SHA256 + 同步 exe 内嵌整头 SHA256
function patchPaywall() {
  if (!ASAR_PATH || !fs.existsSync(ASAR_PATH)) throw new Error('app.asar 未找到(Typeless.exe 路径未配置?)');
  if (!TYPELESS_EXE || !fs.existsSync(TYPELESS_EXE)) throw new Error('Typeless.exe 未找到');
  const asarBak = ASAR_PATH + '.bak', integrityBak = INTEGRITY_PATH + '.bak';
  // 首次备份:asar 用 platform.copyRaw 绕 hook,完整性文件用 fs
  if (!fs.existsSync(asarBak)) { try { PLAT.copyRaw(ASAR_PATH, asarBak); } catch (e) {} }
  if (!fs.existsSync(integrityBak)) fs.copyFileSync(INTEGRITY_PATH, integrityBak);

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

    const target = locatePaywallTarget(header, buf, dataStart);
    if (!target) throw new Error('asar 内未找到弹窗处理文件,请阅读 README「弹窗补丁适配」章节定位你版本的文件后填入 config.json');

    const { filePath, node, content: contentText } = target;
    const foff = dataStart + (+node.offset), size = node.size;
    const oldHash = node.integrity.hash;
    const content = Buffer.from(buf.subarray(foff, foff + size));

    const resolved = resolvePaywallReplacements(contentText);
    if (resolved.alreadyPatched) {
      fs.closeSync(fd);
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }
    const repls = resolved.replacements.map(([f, t]) => [Buffer.from(f, 'utf8'), Buffer.from(t, 'utf8')]);
    // 幂等:已打过则跳过
    const alreadyPatched = repls.every(([from], i) => !content.includes(from) && content.includes(repls[i][1]));
    if (alreadyPatched) {
      fs.closeSync(fd);
      return { already: true, msg: '已是无弹窗补丁版,无需重复操作' };
    }

    // 1) 内容补丁(等长替换)
    for (const [from, to] of repls) {
      const i = content.indexOf(from);
      if (i < 0) throw new Error(
        '未找到标记 ' + from.toString() + ',你的 Typeless 版本可能不同。' +
        '请阅读 README「弹窗补丁适配」章节,用 DevTools 定位你版本的函数名后填入 config.json'
      );
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

    // 6) 更新整头 SHA256(Windows:PE exe;macOS:Info.plist 的 ElectronAsarIntegrity)
    const exfd = fs.openSync(INTEGRITY_PATH, 'r+');
    const estat = fs.statSync(INTEGRITY_PATH);
    const exb = Buffer.alloc(estat.size);
    fs.readSync(exfd, exb, 0, estat.size, 0);
    const oldEB = Buffer.from(oldHeaderHash, 'utf8'), newEB = Buffer.from(newHeaderHash, 'utf8');
    let ei = exb.indexOf(oldEB), ecnt = 0, eidxs = [];
    while (ei >= 0) { ecnt++; eidxs.push(ei); ei = exb.indexOf(oldEB, ei + 1); }
    if (ecnt < 1) throw new Error('完整性文件里找不到旧整头 hash(可能已被改过或版本不符),已还原请检查');
    for (const pp of eidxs) newEB.copy(exb, pp);
    fs.writeSync(exfd, exb, 0, estat.size, 0);
    fs.closeSync(exfd);

    // 7) 把改好的临时 asar 覆盖回原 app.asar(此时 Typeless 已关闭,可写)
    tmpToAsar(tmpAsar);

    // 8) macOS:改过应用包内容后必须 ad-hoc 重签名,否则 AMFI/Gatekeeper 拒绝运行
    let resign = null;
    if (IS_MAC) resign = PLAT.resignApp(TYPELESS_EXE);

    return {
      already: false, done: true, integrity_hits: ecnt, resign,
      file_path: filePath.join('/'),
      file_hash: { old: oldHash, new: newHash },
      header_hash: { old: oldHeaderHash, new: newHeaderHash },
      msg: '补丁已打好,升级/会员弹窗将不再弹出(重启 Typeless 生效)' +
        (IS_MAC ? (resign && resign.done ? ';已 ad-hoc 重签名' : ';⚠️ 自动重签名未成功,请手动执行 codesign --force --deep --sign - <Typeless.app>') : ''),
    };
  } catch (e) {
    // 失败:二进制可能已改,从备份还原;asar 未覆盖回(只改了 tmp),保持原样无需还原
    try { if (fs.existsSync(integrityBak)) fs.copyFileSync(integrityBak, INTEGRITY_PATH); } catch (_) {}
    throw e;
  } finally { try { fs.unlinkSync(tmpAsar); } catch (e) {} }
}

// 运行环境信息(供前端 /api/env 排错,尤其 macOS 定位路径问题)
function envInfo() {
  return {
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
}

module.exports = {
  // 常量
  ROOT, CODE_DIR, config, DEFAULT_CONFIG, IS_WIN, IS_MAC,
  TYPELESS_EXE, USERDATA_DIR, DEVICE_CACHE_DIR, CRED_TARGET, ASAR_PATH, INTEGRITY_PATH,
  API_BASE, CDP_PORT, MASTER_CSV, PROFILES_DIR, ACCOUNTS_FILE, SNAPSHOT_FILES,
  // 工具
  log, sleep, execAsync, execFileAsync,
  detectTypelessExe, loadConfig, envInfo,
  // 账号 / 快照
  readAccounts, writeAccounts, readCurrentUser, currentUserFromStorage,
  saveSnapshot, restoreSnapshot, hasSnapshot,
  // kill / launch / 设备
  killTypeless, launchTypeless, resetDevice,
  // 主 CSV
  readMaster, writeMaster,
  // API + CDP
  curlApi, ensureApp, captureTokenCDP,
  fetchAllWords, dictToText, parseJwt, tokenExpiryMs,
  // 状态 + 同步 + 备份
  liveStatus, syncAccount, backupData,
  // 弹窗补丁
  paywallStatus, patchPaywall, resolvePaywallReplacements,
};
