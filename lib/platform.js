/**
 * 平台适配层 —— 隔离 Windows / macOS 的进程、路径、凭据、原始文件复制、重签名差异。
 *
 * 设计:common.js 只调用本模块暴露的 PLAT.xxx(),不再直接写 taskkill/cmdkey/cmd copy 等
 *   平台专有命令。Windows 分支与历史行为字节级等价;macOS 分支为合理默认值,均可经
 *   config.json 覆盖(userdata_dir / device_cache_dir / credential_target / typeless_exe)。
 *
 * ⚠️ macOS 分支未在真实 Mac 上验证。以下值基于 Electron/macOS 惯例推断,首次在 Mac 运行时
 *   若报路径/凭据错误,请按 README「macOS 适配」章节核对后填入 config.json。
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

// ---------- macOS(合理默认,未实测,可经 config 覆盖) ----------
const mac = {
  os: 'macos',
  processName: 'Typeless',
  exeCandidates() {
    return [
      '/Applications/Typeless.app/Contents/MacOS/Typeless',
      path.join(HOME, 'Applications', 'Typeless.app', 'Contents', 'MacOS', 'Typeless'),
    ];
  },
  // Electron app name 跨平台一致时为 "Typeless.exe";Mac 惯例也可能是 "Typeless" —— 优先探测已存在者
  userDataDir() { return firstExisting(APPSUPPORT, ['Typeless.exe', 'Typeless']); },
  deviceCacheDir() { return firstExisting(APPSUPPORT, [path.join('Typeless', 'Cache'), path.join('Typeless.exe', 'Cache')]); },
  credentialTarget() { return 'Typeless.deviceIdentifier'; },
  // app.asar 在 .app/Contents/Resources/ 下(exe 在 .app/Contents/MacOS/)
  asarPathFor(exe) { return path.join(path.dirname(exe), '..', 'Resources', 'app.asar'); },
  // 内嵌整头 SHA256 的可执行文件:Mach-O 可执行自身
  binaryPathFor(exe) { return exe; },
  killApp() { try { execSync('killall Typeless', { stdio: 'ignore' }); } catch (e) {} },
  // 直接 spawn 二进制并透传调试端口(比 `open -a` 更可靠地传参给 Electron);失败 reject
  launchApp(exe, cdpPort) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; fn(v); };
      try {
        const child = spawn(exe, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
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
  // 删 Keychain 通用密码:按 service(-s)与 label(-l)各试一次
  deleteDeviceCredential(target) {
    for (const flag of ['-s', '-l']) {
      try { execSync(`security delete-generic-password ${flag} "${target}"`, { stdio: 'ignore' }); } catch (e) {}
    }
  },
  // macOS 无 asar hook 困扰,直接复制即可
  copyRaw(src, dst) { fs.copyFileSync(src, dst); },
  // 改 Mach-O 二进制后必须 ad-hoc 重签名,否则 AMFI/Gatekeeper 拒绝运行(实验性,未实测)
  resignApp(exe) {
    const appBundle = String(exe).split('/Contents/')[0]; // .../Typeless.app
    try {
      execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'ignore' });
      // 移除隔离属性,避免"已损坏"提示
      try { execSync(`xattr -dr com.apple.quarantine "${appBundle}"`, { stdio: 'ignore' }); } catch (e) {}
      return { done: true, app: appBundle };
    } catch (e) { return { done: false, error: e.message, app: appBundle, hint: '请手动执行 codesign --force --deep --sign - ' + appBundle }; }
  },
};

const platform = IS_MAC ? mac : win;

module.exports = { IS_WIN, IS_MAC, platform, HOME, APPDATA, LOCALAPPDATA, APPSUPPORT, firstExisting };
