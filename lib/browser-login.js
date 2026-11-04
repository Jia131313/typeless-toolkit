/**
 * 隔离浏览器登录 —— 用独立 profile 打开 typeless.com 登录页。
 *
 * 背景：Typeless 桌面端发起登录时通过 shell.openExternal 打开系统默认浏览器。
 *   网页端把登录凭证存在 localStorage 的 TYPELESS_CLIENT__FEATURES__AUTH__TOKEN_INFO 里。
 *   主浏览器仍保留上一个账号的凭证时，登录页会直接判定「已经登录」，
 *   点击「打开桌面应用」触发 typeless:// 深链，旧账号就被重新登回本机 ——
 *   用户想注册新号，结果回到了旧号。
 *   换成全新 profile，浏览器里没有任何残留，网页只能老老实实走登录/注册流程。
 *
 * 不依赖深链：注册完成后直接读临时 profile 的 localStorage 拿到 access/refresh token，
 *   再用 auth:login IPC 注入 Typeless（实测 client_user_id 可缺省，不影响登录）。
 *
 * 只支持 Chromium 系（Chrome / Edge）——它们的 localStorage 是 leveldb，格式可解析。
 *   Firefox 用的是不同的 sqlite 结构，本模块不支持，找不到可用浏览器时由调用方退回人工提示。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// 网页端存放登录凭证的 localStorage 键名（大小写必须完全一致）
const TOKEN_KEY = 'TYPELESS_CLIENT__FEATURES__AUTH__TOKEN_INFO';
// 值对象的开头，用来在 leveldb 字节流里定位 JSON 起点
const TOKEN_VALUE_MARKER = Buffer.from('{"accessToken"', 'latin1');

// 登录页入口。邮箱登录页同时带「注册」入口，注册完就停在同一个 origin 下。
const LOGIN_URL = 'https://www.typeless.com/login/email';

/** 隔离浏览器使用的 profile 根目录（挂在工具集数据目录下，随数据一起迁移） */
function profilesRoot(dataDir) {
  return path.join(dataDir, 'browser-login');
}

/**
 * Chromium 系浏览器的候选路径，按优先级排列。
 * 找不到任何一个时返回空数组，由调用方退回人工提示。
 */
function chromiumCandidates() {
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      { name: 'Chrome', exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chrome', exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Chrome', exe: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Edge', exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Edge', exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    ];
  }
  if (IS_MAC) {
    return [
      { name: 'Chrome', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Edge', exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    ];
  }
  return [];
}

/** 探测本机可用的 Chromium 系浏览器；都没有则返回 null */
function detectChromiumBrowser() {
  for (const candidate of chromiumCandidates()) {
    try {
      if (candidate.exe && fs.existsSync(candidate.exe)) return candidate;
    } catch (e) {}
  }
  return null;
}

/** 在数据目录下建一个新的临时 profile 目录，返回绝对路径 */
function createIsolatedProfile(dataDir) {
  const base = profilesRoot(dataDir);
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'profile-'));
}

/**
 * 用指定 profile 启动浏览器并打开登录页。
 * 独立进程、独立 profile，不会影响用户日常使用的浏览器窗口与登录状态。
 */
function launchIsolatedBrowser(browser, profileDir, url = LOGIN_URL) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 关掉翻译浮层，避免遮挡登录表单
    '--disable-features=Translate',
    url,
  ];
  const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore' });
  // detached 进程的启动错误走异步 error 事件，不挂监听会带崩后端
  child.on('error', () => {});
  child.unref();
  return child;
}

/** profile 里 localStorage 的实际落盘目录（leveldb） */
function leveldbDir(profileDir) {
  return path.join(profileDir, 'Default', 'Local Storage', 'leveldb');
}

/**
 * 从字节流里截取一个完整的 JSON 对象（按字节做括号配平，正确处理字符串里的转义）。
 * 找不到闭合括号时返回 null。
 */
function extractJsonObject(buf, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const byte = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;      // 反斜杠
      else if (byte === 0x22) inString = false;    // 引号
      continue;
    }
    if (byte === 0x22) { inString = true; continue; }
    if (byte === 0x7b) { depth++; continue; }              // {
    if (byte === 0x7d) {                                   // }
      depth--;
      if (depth === 0) return buf.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 从单个 leveldb 文件里读最后一条登录凭证。
 * .log 是写前日志，追加写入，所以「最后一条」就是最新一条；
 * .ldb 经 compaction 后同一 key 只保留一个值，取最后一条同样安全。
 */
function readTokenFromFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  const start = buf.lastIndexOf(TOKEN_VALUE_MARKER);
  if (start < 0) return null;
  const slice = extractJsonObject(buf, start);
  if (!slice) return null;
  try {
    const parsed = JSON.parse(slice.toString('utf8'));
    if (parsed && parsed.accessToken && parsed.refreshToken) return parsed;
  } catch (e) {}
  return null;
}

/**
 * 从临时 profile 里读当前登录的 typeless 凭证。
 * 文件按修改时间从新到旧排，同一时刻 .log 优先于 .ldb（写前日志更新）。
 * 没登录时返回 null。
 */
function readTokenFromProfile(profileDir) {
  const dir = leveldbDir(profileDir);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const files = names
    .filter(name => /\.(ldb|log)$/.test(name))
    .map(name => {
      const full = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
      // .log 是写前日志，同一毫秒内写入也比 .ldb 新
      const weight = name.endsWith('.log') ? mtime + 1000 : mtime;
      return { full, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  for (const file of files) {
    const token = readTokenFromFile(file.full);
    if (token) return token;
  }
  return null;
}

/** 解析 JWT 里的 user_id；失败返回 null */
function tokenUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const userId = payload && payload.subject && payload.subject.user_id;
    return typeof userId === 'string' && userId ? userId : null;
  } catch (e) { return null; }
}

/**
 * 轮询临时 profile，等出现「不是 excludeUserId」的新账号凭证。
 * 返回 { token, userId } 或超时返回 null。
 *
 * 第三参数既接受 { timeoutMs, intervalMs }，也接受直接传超时毫秒数
 * （早期调用点写的是 waitForNewToken(dir, uid, 20000)，两种都要能用）。
 */
async function waitForNewToken(profileDir, excludeUserId, options = {}) {
  const opts = typeof options === 'number' ? { timeoutMs: options } : (options || {});
  const timeoutMs = opts.timeoutMs || 0;      // 0 表示只查一次
  const intervalMs = opts.intervalMs || 1500;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = readTokenFromProfile(profileDir);
    if (token) {
      const userId = tokenUserId(token.accessToken) || token.userId || null;
      if (userId && (!excludeUserId || userId !== excludeUserId)) {
        return { token, userId };
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** 删除临时 profile（登录流程结束后调用；目录不存在时静默返回） */
function removeIsolatedProfile(profileDir) {
  if (!profileDir) return;
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
}

/**
 * 清理过期的临时 profile。浏览器被强制关闭、注册中途放弃时目录会残留。
 * 每个 profile 上百 MB，不能让它们无限堆积，所以后端启动和每次开始注册时都会扫一遍。
 *
 * 默认 1 小时：注册流程一般几分钟内完成，超过一小时的几乎都是放弃或崩溃留下的。
 * 正在被浏览器使用的 profile 删不掉（Windows 会锁文件），此时静默跳过、留待下次。
 */
function cleanupOldProfiles(dataDir, maxAgeMs = 60 * 60 * 1000) {
  const base = profilesRoot(dataDir);
  let names;
  try { names = fs.readdirSync(base); } catch (e) { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    const full = path.join(base, name);
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch (e) {}
  }
  return removed;
}

module.exports = {
  LOGIN_URL,
  TOKEN_KEY,
  detectChromiumBrowser,
  createIsolatedProfile,
  launchIsolatedBrowser,
  readTokenFromProfile,
  waitForNewToken,
  removeIsolatedProfile,
  cleanupOldProfiles,
  tokenUserId,
};
