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
const net = require('net');
const { execFileSync, execSync, spawn } = require('child_process');

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
      execFileSync('/usr/bin/pgrep', ['-x', exeName], { stdio: 'ignore' });
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

// 杀进程 + 用调试端口重新启动(用于抓 token)。成功后返回实际使用的端口
// (配置端口被占用时会自动避让到空闲端口,调用方需用返回值继续 CDP 流程)。
async function taskRestartWithDebug(exe, cdpPort, userDataDir) {
  if (IS_WIN) win.killApp(exe, userDataDir); else mac.killApp(exe, userDataDir);
  const stillRunning = () => IS_WIN ? isProcessRunning(exe) : mac.isAppRunning(exe);
  // 必须真正等待旧进程退出。旧实现漏了 await，会让新旧实例争抢锁并卡住主窗口。
  for (let i = 0; i < 50; i++) {
    if (!stillRunning()) break;
    await sleep(100);
  }
  if (stillRunning()) throw new Error('无法关闭 Typeless，请手动退出后重试');

  await sleep(400);
  // 调试端口避让:配置端口被占时 Chromium 会静默换随机端口,这里主动跳开避免死等。
  const preferredPort = Number(cdpPort) || 9222;
  const usePort = await findFreePort(preferredPort);
  const debugArgs = [`--remote-debugging-port=${usePort}`];
  if (IS_MAC) debugArgs.push(`--user-data-dir=${userDataDir || mac.userDataDir()}`);
  await launchCheckedWithRetry(exe, debugArgs);

  // 等调试端口就绪，超时必须报错，交给上层 finally 恢复普通模式。
  for (let i = 0; i < 30; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`http://127.0.0.1:${usePort}/json/version`, { signal: controller.signal });
      if (response.ok) return usePort;
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }
    await sleep(400);
  }
  // 超时诊断:区分「端口被占」与「Typeless 没起来」,方便用户定位。
  const still = stillRunning();
  const occupied = await portOccupied(usePort);
  throw new Error(
    'Typeless 调试端口启动超时' +
    (usePort !== preferredPort ? `(配置端口 ${preferredPort} 被占用,已避让到 ${usePort})` : '') +
    (still ? ';Typeless 进程仍在运行,可能未监听调试端口' : ';Typeless 进程未在运行') +
    (occupied ? `;端口 ${usePort} 当前被其他程序占用` : '') +
    '。请确认 Typeless 能正常启动,或换一个 cdp_port 后重试'
  );
}

// 恢复干净模式:杀掉带调试端口的 Typeless;如果之前它在跑,重新干净启动
async function taskRestartClean(exe, wasRunning, userDataDir) {
  if (IS_WIN) win.killApp(exe, userDataDir); else mac.killApp(exe, userDataDir);
  const stillRunning = () => IS_WIN ? isProcessRunning(exe) : mac.isAppRunning(exe);
  for (let i = 0; i < 50; i++) {
    if (!stillRunning()) break;
    await sleep(100);
  }
  if (!wasRunning) return; // 之前没在跑，不需要重启
  await sleep(400);
  const cleanArgs = IS_MAC ? [`--user-data-dir=${userDataDir || mac.userDataDir()}`] : [];
  await launchCheckedWithRetry(exe, cleanArgs);
  for (let i = 0; i < 20; i++) {
    if (stillRunning()) return;
    await sleep(250);
  }
  throw new Error('Typeless 普通模式重启超时');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// TCP 端口占用探测(不含超时的裸 connect 会在 Windows 上挂很久,必须用短超时)
function portOccupied(port, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (e) {}
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, '127.0.0.1'); } catch (e) { finish(false); }
  });
}

// 在[preferred, preferred+step, ...]里挑一个未被占用的端口,用于 CDP 调试端口避让。
// 配置的 cdp_port 可能被浏览器/其他工具占用;Chromium 占位时静默换随机端口,
// 工具却仍死等配置端口,导致「调试端口启动超时」。这里主动探测并跳开。
async function findFreePort(preferred, step = 1, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const candidate = preferred + i * step;
    if (candidate < 0 || candidate > 65535) break;
    if (!(await portOccupied(candidate))) return candidate;
  }
  return preferred; // 全部被占,返回原值,交给上层超时报错
}

function commandFailureMessage(error) {
  const output = [error && error.stderr, error && error.stdout]
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value || ''))
    .map(value => value.trim())
    .filter(Boolean)
    .join(' | ');
  return (error && error.message ? error.message : String(error)) + (output ? ';' + output : '');
}

function appBundleForExecutable(exe) {
  const marker = `${path.sep}Contents${path.sep}`;
  const index = String(exe || '').indexOf(marker);
  if (index < 0) throw new Error('无法从 Typeless 可执行文件路径定位 .app Bundle:' + exe);
  return String(exe).slice(0, index);
}

function appBundleProcessPattern(exe) {
  return appBundleForExecutable(exe) + path.sep;
}

function isMacAppBundleRunning(exe) {
  try {
    execFileSync('/usr/bin/pgrep', ['-f', appBundleProcessPattern(exe)], { stdio: 'ignore' });
    return true;
  } catch (error) { return false; }
}

function macLaunchArgs(cdpPort, userDataDir) {
  const args = [`--user-data-dir=${userDataDir || mac.userDataDir()}`];
  if (cdpPort) args.unshift(`--remote-debugging-port=${cdpPort}`);
  return args;
}

function copyMacAppBundle(src, dst) {
  try {
    // APFS clone 优先：完整保留签名/xattr，且初始几乎不额外占用磁盘。
    execFileSync('/bin/cp', ['-cR', src, dst], { stdio: 'ignore' });
  } catch (cloneError) {
    // 非 APFS 或 clone 不可用时退回 ditto，仍保留资源叉与扩展属性。
    execFileSync('/usr/bin/ditto', [src, dst], { stdio: 'ignore' });
  }
}

function verifyMacAppBundle(appBundle) {
  execFileSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', appBundle,
  ], { stdio: 'ignore' });
  return { verified: true, app: appBundle };
}

function macRootEntitlements(appBundle) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-entitlements-'));
  const entitlementsFile = path.join(tempDir, 'root-entitlements.plist');
  try {
    const xml = execFileSync('/usr/bin/codesign', [
      '-d', '--entitlements', ':-', appBundle,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    fs.writeFileSync(entitlementsFile, xml, { encoding: 'utf8', mode: 0o600 });
    try {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c', 'Set :com.apple.security.cs.disable-library-validation true', entitlementsFile,
      ], { stdio: 'ignore' });
    } catch (error) {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c', 'Add :com.apple.security.cs.disable-library-validation bool true', entitlementsFile,
      ], { stdio: 'ignore' });
    }
    return { tempDir, entitlementsFile };
  } catch (error) {
    try { fs.unlinkSync(entitlementsFile); } catch (e) {}
    try { fs.rmdirSync(tempDir); } catch (e) {}
    throw new Error('读取或扩展 Typeless 权限失败:' + commandFailureMessage(error));
  }
}

function cleanupMacEntitlements(temp) {
  if (!temp) return;
  try { fs.unlinkSync(temp.entitlementsFile); } catch (e) {}
  try { fs.rmdirSync(temp.tempDir); } catch (e) {}
}

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
  killApp(exe, userDataDir) {
    try { execSync('taskkill /F /IM Typeless.exe', { stdio: 'ignore' }); } catch (e) {}
    // 清掉可能残留的单实例锁(与 mac 分支一致)。Chromium 进程死后 SingletonLock
    // 仍占着会让新实例立即退出,表现为「调试端口启动超时」。
    try {
      const ud = userDataDir || this.userDataDir();
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(ud, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
        } catch (e) {}
      }
    } catch (e) {}
  },
  // 返回 Promise:spawn 失败(EACCES/ENOENT)会 reject,避免 Uncaught Exception
  launchApp(exe, cdpPort) {
    const args = cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [];
    return spawnDetachedSafe(exe, args);
  },
  // 删 Windows 凭据管理器里的设备 ID
  deleteDeviceCredential(target) { try { execFileSync('cmdkey', [`/delete:${target}`], { stdio: 'ignore' }); } catch (e) {} },
  // 原样复制:Windows 打包版 fs 被 asar hook 拦,用 cmd copy 绕过(见 packaging 备忘)
  copyRaw(src, dst) { execSync(`cmd /c chcp 65001 >nul & copy /b /y "${src}" "${dst}"`, { stdio: 'ignore' }); },
  // Windows 改 exe 让 Authenticode 签名失效,但本机仍可运行,无需重签名
  resignApp() { return { skipped: true, reason: 'windows-no-resign-needed' }; },
  // 跨平台工具:进程检测 / 调试端口重启 / 干净重启
  isAppRunning: e => isProcessRunning(e),
  restartWithDebug: (e, p, u) => taskRestartWithDebug(e, p, u),
  restartClean: (e, w, u) => taskRestartClean(e, w, u),
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
  isAppRunning(exe) { return isMacAppBundleRunning(exe); },
  killApp(exe, userDataDir) {
    // 先温和再强制;一并清掉 Helper,避免 SingletonLock 残留导致重启失败
    const appPattern = exe ? appBundleProcessPattern(exe) : '/Applications/Typeless.app/';
    try { execFileSync('/usr/bin/pkill', ['-f', appPattern], { stdio: 'ignore' }); } catch (e) {}
    for (let i = 0; i < 20; i++) {
      if (!exe || !isMacAppBundleRunning(exe)) break;
      try { execFileSync('/bin/sleep', ['0.25'], { stdio: 'ignore' }); } catch (_) {}
    }
    try { execFileSync('/usr/bin/pkill', ['-9', '-f', appPattern], { stdio: 'ignore' }); } catch (e) {}
    // 清掉可能残留的单实例锁(进程已死后仍占着会阻止 relaunch)
    try {
      const ud = userDataDir || this.userDataDir();
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const p = path.join(ud, name);
        try {
          const st = fs.lstatSync(p);
          if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(p);
        } catch (e) {}
      }
    } catch (e) {}
  },
  launchApp(exe, cdpPort, userDataDir) {
    // 直接 spawn 二进制并透传调试端口(比 `open -a` 更可靠地传参给 Electron)
    return spawnDetachedChecked(exe, macLaunchArgs(cdpPort, userDataDir));
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
        try {
          execFileSync('/usr/bin/security', ['delete-generic-password', flag, t], { stdio: 'ignore' });
        } catch (e) {}
      }
    }
  },
  // 打包后的 Electron 会把 .asar 路径当归档处理;用系统 cp 读取归档文件本体
  copyRaw(src, dst) { execFileSync('/bin/cp', [src, dst], { stdio: 'ignore' }); },
  backupApp(exe, backupDir) {
    const appBundle = appBundleForExecutable(exe);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(backupDir, 0o700); } catch (e) {}
    const backupApp = path.join(backupDir, `${path.basename(appBundle)}.backup`);
    if (fs.existsSync(backupApp)) throw new Error('Typeless App 备份目标已存在:' + backupApp);
    copyMacAppBundle(appBundle, backupApp);
    verifyMacAppBundle(backupApp);
    return { app: backupApp, source: appBundle, backup_dir: backupDir };
  },
  restoreApp(exe, backupApp) {
    const appBundle = appBundleForExecutable(exe);
    if (!backupApp || !fs.existsSync(backupApp)) throw new Error('Typeless App 完整备份不存在:' + backupApp);
    const backupDir = path.dirname(backupApp);
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const failedApp = path.join(backupDir, `failed-patch-${suffix}.app.backup`);
    const failedRestore = path.join(backupDir, `failed-restore-${suffix}.app.backup`);
    let movedCurrent = false;
    try {
      if (fs.existsSync(appBundle)) {
        fs.renameSync(appBundle, failedApp);
        movedCurrent = true;
      }
      copyMacAppBundle(backupApp, appBundle);
      verifyMacAppBundle(appBundle);
      return { restored: true, app: appBundle, backup: backupApp, failed_app: movedCurrent ? failedApp : null };
    } catch (error) {
      try {
        if (fs.existsSync(appBundle)) fs.renameSync(appBundle, failedRestore);
      } catch (e) {}
      try {
        if (movedCurrent && fs.existsSync(failedApp) && !fs.existsSync(appBundle)) {
          fs.renameSync(failedApp, appBundle);
        }
      } catch (e) {}
      throw new Error('恢复 Typeless 完整 App 失败:' + error.message + ';原始备份:' + backupApp);
    }
  },
  verifyApp(exe) { return verifyMacAppBundle(appBundleForExecutable(exe)); },
  // 定向重签被 fuses 修改的 Electron Framework 与根 App；其他 Helper/Framework 保留官方签名。
  resignApp(exe) {
    const appBundle = appBundleForExecutable(exe);
    const electronFramework = path.join(
      appBundle, 'Contents', 'Frameworks', 'Electron Framework.framework'
    );
    let entitlements = null;
    try {
      entitlements = macRootEntitlements(appBundle);

      // @electron/fuses 在 macOS 上会修改 Electron Framework 本体。只在该 Framework
      // 已失效时定向改签，其他 Helper/Framework 继续保留官方 Developer ID 签名。
      let frameworkResigned = false;
      if (fs.existsSync(electronFramework)) {
        try {
          execFileSync('/usr/bin/codesign', [
            '--verify', '--strict', electronFramework,
          ], { stdio: 'ignore' });
        } catch (error) {
          execFileSync('/usr/bin/codesign', [
            '--force', '--sign', '-',
            '--preserve-metadata=identifier,entitlements,flags,runtime',
            electronFramework,
          ], { stdio: 'ignore' });
          frameworkResigned = true;
        }
      }

      execFileSync('/usr/bin/codesign', [
        '--force', '--sign', '-',
        '--preserve-metadata=identifier,flags,runtime',
        '--entitlements', entitlements.entitlementsFile,
        appBundle,
      ], { stdio: 'ignore' });
      verifyMacAppBundle(appBundle);
      // 官方下载的 App 通常仍带 quarantine；签名已改为 ad-hoc 后必须清除该 Bundle 的隔离标记，
      // 否则 Gatekeeper 会阻止补丁事务中的自动重启。完整备份仍保留原始 xattr，回滚不受影响。
      execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appBundle], { stdio: 'ignore' });
      return {
        done: true, verified: true, quarantine_removed: true,
        framework_resigned: frameworkResigned,
        accessibility_regrant_required: true,
        mode: 'adhoc-targeted-preserve-metadata', app: appBundle,
      };
    } catch (e) {
      throw new Error('Typeless ad-hoc 重签名或验证失败:' + commandFailureMessage(e));
    } finally {
      cleanupMacEntitlements(entitlements);
    }
  },
  restartWithDebug: (e, p, u) => taskRestartWithDebug(e, p, u),
  restartClean: (e, w, u) => taskRestartClean(e, w, u),
};

const platform = IS_MAC ? mac : win;

module.exports = {
  IS_WIN, IS_MAC, platform, HOME, APPDATA, LOCALAPPDATA, APPSUPPORT, firstExisting,
  appBundleForExecutable, appBundleProcessPattern, macLaunchArgs,
  portOccupied, findFreePort,
};
