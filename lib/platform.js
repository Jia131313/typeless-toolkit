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
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
      try {
        const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
        child.once('error', (err) => {
          const code = err && err.code;
          let hint = (err && err.message) || String(err);
          if (code === 'EACCES') hint = '启动被拒绝(EACCES),可能被占用、无执行权限或杀软拦截: ' + exe;
          else if (code === 'ENOENT') hint = '找不到可执行文件: ' + exe;
          done(reject, new Error(hint));
        });
        child.unref();
        // 短延迟:若立刻 error 会先 reject,否则视为 spawn 已排队
        setTimeout(() => done(resolve), 50);
      } catch (e) {
        done(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });
  },
  // 删 Windows 凭据管理器里的设备 ID
  deleteDeviceCredential(target) { try { execSync(`cmdkey /delete:${target}`, { stdio: 'ignore' }); } catch (e) {} },
  // 原样复制:Windows 打包版 fs 被 asar hook 拦,用 cmd copy 绕过(见 packaging 备忘)
  copyRaw(src, dst) { execSync(`cmd /c chcp 65001 >nul & copy /b /y "${src}" "${dst}"`, { stdio: 'ignore' }); },
  // Windows 改 exe 让 Authenticode 签名失效,但本机仍可运行,无需重签名
  resignApp() { return { skipped: true, reason: 'windows-no-resign-needed' }; },
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
    const args = [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${ud}`];
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', env: process.env });
        child.once('error', (err) => {
          const code = err && err.code;
          let hint = (err && err.message) || String(err);
          if (code === 'EACCES') hint = '启动被拒绝(EACCES),可能无执行权限: ' + exe;
          else if (code === 'ENOENT') hint = '找不到可执行文件: ' + exe;
          done(reject, new Error(hint));
        });
        child.unref();
        setTimeout(() => done(resolve), 50);
      } catch (e) {
        done(reject, e instanceof Error ? e : new Error(String(e)));
      }
    });
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
  // 打包后的 Electron 会把 .asar 路径当归档处理;用系统 cp 读取归档文件本体
  copyRaw(src, dst) { execFileSync('/bin/cp', [src, dst], { stdio: 'ignore' }); },
  // 改 Mach-O 二进制后必须 ad-hoc 重签名,否则 AMFI/Gatekeeper 拒绝运行
  resignApp(exe) {
    const appBundle = String(exe).split('/Contents/')[0]; // .../Typeless.app
    try {
      execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'ignore' });
      try { execSync(`xattr -dr com.apple.quarantine "${appBundle}"`, { stdio: 'ignore' }); } catch (e) {}
      return { done: true, app: appBundle };
    } catch (e) { return { done: false, error: e.message, app: appBundle, hint: '请手动执行 codesign --force --deep --sign - ' + appBundle }; }
  },
};

const platform = IS_MAC ? mac : win;

module.exports = { IS_WIN, IS_MAC, platform, HOME, APPDATA, LOCALAPPDATA, APPSUPPORT, firstExisting };
