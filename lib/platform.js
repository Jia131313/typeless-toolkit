/**
 * 平台适配层 —— 隔离 Windows / macOS 的进程、路径、凭据、原始文件复制、重签名差异。
 *
 * 设计:common.js 只调用本模块暴露的 PLAT.xxx(),不再直接写 taskkill/cmdkey/cmd copy 等
 *   平台专有命令。Windows 分支与历史行为字节级等价;macOS 分支基于真实 Mac(Typeless 2.0)实测。
 *
 * macOS 实测要点(Typeless 2.0.0 / Electron 33, Bundle ID now.typeless.desktop):
 *   - 用户数据目录:~/Library/Application Support/Typeless(按平台固定,不探测 Windows 的 Typeless.exe)
 *   - 设备缓存:~/Library/Application Support/now.typeless.desktop/device.cache
 *   - Keychain 服务名:now.typeless.desktop.deviceIdentifier
 *   - 从 Dock/Finder 启动不会带 --remote-debugging-port,管理器需主动以调试端口重启
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPSUPPORT = path.join(HOME, 'Library', 'Application Support'); // macOS 用户数据根

// 在若干候选(相对 base)里选第一个已存在的;都不存在则返回首个(作为默认/待创建路径)
function firstExisting(base, rels) {
  for (const r of rels) { const p = path.join(base, r); try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return path.join(base, rels[0]);
}

function firstExistingAbs(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return paths[0];
}

// ---------- 跨平台工具函数 ----------

// 检测 exe 对应的进程是否在运行
function isProcessRunning(exe) {
  const exeName = path.basename(exe);
  try {
    if (IS_WIN) {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.toLowerCase().includes(exeName.toLowerCase());
    } else {
      execSync(`pgrep -x "${exeName}"`, { stdio: 'ignore' });
      return true;
    }
  } catch (e) { return false; }
}

// detached 子进程的启动错误通过异步 error 事件报告，单靠 try/catch 接不住。
// 始终挂载监听器，避免 EACCES 等启动失败直接带崩管理器后端。
function appSpawnSpec(exe, args) {
  if (!IS_WIN) return { file: exe, args: args || [], options: { detached: true, stdio: 'ignore' } };
  // 本机 Electron 安装在用户目录时，Node 直接 spawn/cmd start 可能收到 EACCES。
  // 交给 Windows PowerShell 的 Start-Process（ShellExecute）启动，并用 base64 传值避免转义问题。
  const encode = value => Buffer.from(String(value), 'utf8').toString('base64');
  const exe64 = encode(exe);
  const workDir64 = encode(path.dirname(exe));
  const args64 = encode((args || []).join(' '));
  const script = [
    '$ErrorActionPreference="Stop"',
    '$exe=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + exe64 + '"))',
    '$wd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + workDir64 + '"))',
    '$argLine=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + args64 + '"))',
    'if($argLine){Start-Process -FilePath $exe -WorkingDirectory $wd -ArgumentList $argLine}else{Start-Process -FilePath $exe -WorkingDirectory $wd}',
  ].join(';');
  return {
    file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    options: { stdio: 'ignore', windowsHide: true },
  };
}

function spawnDetachedSafe(exe, args) {
  const spec = appSpawnSpec(exe, args);
  const child = spawn(spec.file, spec.args, spec.options);
  child.on('error', () => {});
  child.unref();
  return child;
}

function spawnDetachedChecked(exe, args) {
  return new Promise((resolve, reject) => {
    const spec = appSpawnSpec(exe, args);
    const child = spawn(spec.file, spec.args, spec.options);
    let settled = false;
    child.once('spawn', () => {
      if (!IS_WIN) {
        settled = true;
        child.unref();
        resolve();
      }
    });
    child.once('exit', code => {
      if (settled || !IS_WIN) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error('Windows Start-Process 失败，退出码 ' + code));
    });
    child.on('error', error => {
      if (!settled) { settled = true; reject(error); }
    });
  });
}

async function launchCheckedWithRetry(exe, args) {
  let lastError;
  for (let i = 0; i < 5; i++) {
    try { await spawnDetachedChecked(exe, args); return; }
    catch (e) { lastError = e; await sleep(800); }
  }
  throw new Error('无法启动 Typeless: ' + (lastError?.message || '未知错误'));
}

// 杀进程 + 用调试端口重新启动(用于抓 token)
async function taskRestartWithDebug(exe, cdpPort) {
  if (IS_WIN) win.killApp(); else mac.killApp();
  // 必须真正等待旧进程退出。旧实现漏了 await，会让新旧实例争抢锁并卡住主窗口。
  for (let i = 0; i < 50; i++) {
    if (!isProcessRunning(exe)) break;
    await sleep(100);
  }
  if (isProcessRunning(exe)) throw new Error('无法关闭 Typeless，请手动退出后重试');

  await sleep(400);
  const debugArgs = [`--remote-debugging-port=${cdpPort}`];
  if (IS_MAC) debugArgs.push(`--user-data-dir=${mac.userDataDir()}`);
  await launchCheckedWithRetry(exe, debugArgs);

  // 等调试端口就绪，超时必须报错，交给上层 finally 恢复普通模式。
  for (let i = 0; i < 30; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: controller.signal });
      if (response.ok) return;
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }
    await sleep(400);
  }
  throw new Error('Typeless 调试端口启动超时');
}

// 恢复干净模式:杀掉带调试端口的 Typeless;如果之前它在跑,重新干净启动
async function taskRestartClean(exe, wasRunning) {
  if (IS_WIN) win.killApp(); else mac.killApp();
  for (let i = 0; i < 50; i++) {
    if (!isProcessRunning(exe)) break;
    await sleep(100);
  }
  if (!wasRunning) return; // 之前没在跑，不需要重启
  await sleep(400);
  const cleanArgs = IS_MAC ? [`--user-data-dir=${mac.userDataDir()}`] : [];
  await launchCheckedWithRetry(exe, cleanArgs);
  for (let i = 0; i < 20; i++) {
    if (isProcessRunning(exe)) return;
    await sleep(250);
  }
  throw new Error('Typeless 普通模式重启超时');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Windows(保持与历史行为等价) ----------
const win = {
  os: 'windows',
  processName: 'Typeless.exe',
  // 默认安装路径候选(config.typeless_exe / 环境变量优先,在 common.js 里处理)
  exeCandidates() { return [path.join(LOCALAPPDATA, 'Programs', 'Typeless', 'Typeless.exe')]; },
  userDataDir() { return path.join(APPDATA, 'Typeless.exe'); },
  deviceCacheDir() { return path.join(APPDATA, 'Typeless', 'Cache'); },
  credentialTarget() { return 'Typeless.deviceIdentifier'; },
  // app.asar 在 exe 同级 resources/ 下
  asarPathFor(exe) { return path.join(path.dirname(exe), 'resources', 'app.asar'); },
  // 内嵌整头 SHA256 的可执行文件:PE exe 自身
  binaryPathFor(exe) { return exe; },
  killApp() { try { execSync('taskkill /F /IM Typeless.exe', { stdio: 'ignore' }); } catch (e) {} },
  // 返回 Promise:spawn 失败(EACCES/ENOENT)会 reject,避免 Uncaught Exception
  launchApp(exe, cdpPort) {
    const args = cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [];
    return spawnDetachedSafe(exe, args);
  },
  // 删 Windows 凭据管理器里的设备 ID
  deleteDeviceCredential(target) { try { execSync(`cmdkey /delete:${target}`, { stdio: 'ignore' }); } catch (e) {} },
  // 原样复制:Windows 打包版 fs 被 asar hook 拦,用 cmd copy 绕过(见 packaging 备忘)
  copyRaw(src, dst) { execSync(`cmd /c chcp 65001 >nul & copy /b /y "${src}" "${dst}"`, { stdio: 'ignore' }); },
  // Windows 改 exe 让 Authenticode 签名失效,但本机仍可运行,无需重签名
  resignApp() { return { skipped: true, reason: 'windows-no-resign-needed' }; },
  // 跨平台工具:进程检测 / 调试端口重启 / 干净重启
  isAppRunning: e => isProcessRunning(e),
  restartWithDebug: (e, p) => taskRestartWithDebug(e, p),
  restartClean: (e, w) => taskRestartClean(e, w),
};

// ---------- macOS(基于 Typeless 2.0 真实 Mac 实测;路径按平台固定,不混用 Windows 的 .exe 命名) ----------
const mac = {
  os: 'macos',
  processName: 'Typeless',
  exeCandidates() {
    return [
      '/Applications/Typeless.app/Contents/MacOS/Typeless',
      path.join(HOME, 'Applications', 'Typeless.app', 'Contents', 'MacOS', 'Typeless'),
    ];
  },
  // Electron userData 实测为 Application Support/Typeless
  userDataDir() { return path.join(APPSUPPORT, 'Typeless'); },
  // 设备缓存实测在 now.typeless.desktop/;若无则回退 Typeless/Cache
  deviceCacheDir() {
    return firstExistingAbs([
      path.join(APPSUPPORT, 'now.typeless.desktop'),
      path.join(APPSUPPORT, 'Typeless', 'Cache'),
    ]);
  },
  // Keychain 服务名实测为 now.typeless.desktop.deviceIdentifier
  credentialTarget() { return 'now.typeless.desktop.deviceIdentifier'; },
  // app.asar 在 .app/Contents/Resources/ 下(二进制在 .app/Contents/MacOS/)
  asarPathFor(exe) { return path.join(path.dirname(exe), '..', 'Resources', 'app.asar'); },
  // 内嵌整头 SHA256 的可执行文件:Mach-O 可执行自身
  binaryPathFor(exe) { return exe; },
  isAppRunning() {
    try {
      execSync('pgrep -x Typeless', { stdio: 'ignore' });
      return true;
    } catch (e) { return false; }
  },
  killApp() {
    // 先温和再强制;一并清掉 Helper,避免 SingletonLock 残留导致重启失败
    try { execSync('pkill -x Typeless', { stdio: 'ignore' }); } catch (e) {}
    try { execSync('pkill -f "/Applications/Typeless.app/"', { stdio: 'ignore' }); } catch (e) {}
    for (let i = 0; i < 20; i++) {
      try { execSync('pgrep -x Typeless', { stdio: 'ignore' }); }
      catch (e) { break; }
      try { execSync('sleep 0.25'); } catch (_) {}
    }
    try { execSync('pkill -9 -x Typeless', { stdio: 'ignore' }); } catch (e) {}
    try { execSync('pkill -9 -f "/Applications/Typeless.app/"', { stdio: 'ignore' }); } catch (e) {}
    // 清掉可能残留的单实例锁(进程已死后仍占着会阻止 relaunch)
    try {
      const ud = this.userDataDir();
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(ud, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
        } catch (e) {}
      }
    } catch (e) {}
  },
  launchApp(exe, cdpPort) {
    // 直接 spawn 二进制并透传调试端口(比 `open -a` 更可靠地传参给 Electron)
    const ud = this.userDataDir();
    const args = [`--user-data-dir=${ud}`];
    if (cdpPort) args.unshift(`--remote-debugging-port=${cdpPort}`);
    return spawnDetachedChecked(exe, args);
  },
  // 删 Keychain:实测服务名 + 旧文档名各试一次
  deleteDeviceCredential(target) {
    const targets = [...new Set([
      target,
      'now.typeless.desktop.deviceIdentifier',
      'Typeless.deviceIdentifier',
    ].filter(Boolean))];
    for (const t of targets) {
      for (const flag of ['-s', '-l']) {
        try { execSync(`security delete-generic-password ${flag} "${t}"`, { stdio: 'ignore' }); } catch (e) {}
      }
    }
  },
  // macOS 无 asar hook 困扰,直接复制即可
  copyRaw(src, dst) { fs.copyFileSync(src, dst); },
  // 改 Mach-O 二进制后必须 ad-hoc 重签名,否则 AMFI/Gatekeeper 拒绝运行
  resignApp(exe) {
    const appBundle = String(exe).split('/Contents/')[0]; // .../Typeless.app
    try {
      execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'ignore' });
      try { execSync(`xattr -dr com.apple.quarantine "${appBundle}"`, { stdio: 'ignore' }); } catch (e) {}
      return { done: true, app: appBundle };
    } catch (e) { return { done: false, error: e.message, app: appBundle, hint: '请手动执行 codesign --force --deep --sign - ' + appBundle }; }
  },
  isAppRunning: e => isProcessRunning(e),
  restartWithDebug: (e, p) => taskRestartWithDebug(e, p),
  restartClean: (e, w) => taskRestartClean(e, w),
};

const platform = IS_MAC ? mac : win;

module.exports = { IS_WIN, IS_MAC, platform, HOME, APPDATA, LOCALAPPDATA, APPSUPPORT, firstExisting };
