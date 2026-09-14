const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('本地 macOS 安装脚本只能在 Mac 上运行');

const projectRoot = path.join(__dirname, '..');
const buildConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'macos-build.json'), 'utf8'));
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const firstArgument = process.argv[2];
const defaultArch = process.arch === 'arm64' ? 'arm64' : 'x64';
let expectedArch = defaultArch;
let expectedEdition = 'portable';
let dmgPath;

if (firstArgument && firstArgument.toLowerCase().endsWith('.dmg')) {
  dmgPath = path.resolve(firstArgument);
  const match = path.basename(dmgPath).match(/-mac-(arm64|x64)-(portable|lite)\.dmg$/i);
  if (!match) throw new Error(`macOS 安装包名称不符合规范: ${path.basename(dmgPath)}`);
  expectedArch = match[1].toLowerCase();
  expectedEdition = match[2].toLowerCase();
} else {
  expectedArch = firstArgument || defaultArch;
  expectedEdition = process.argv[3] || 'portable';
  if (!buildConfig.architectures[expectedArch] || !buildConfig.editions.includes(expectedEdition)) {
    throw new Error('Usage: node scripts/install-mac-build.js [dmg-path|<arm64|x64> <portable|lite>]');
  }
  const fileName = buildConfig.artifactName
    .replace('{version}', version)
    .replace('{arch}', expectedArch)
    .replace('{edition}', expectedEdition);
  dmgPath = path.join(projectRoot, buildConfig.paths.distDir, fileName);
}

if (!fs.existsSync(dmgPath)) throw new Error(`找不到 macOS 构建产物: ${dmgPath}`);

const appName = `${buildConfig.productName}.app`;
const targetApp = path.join('/Applications', appName);
const runId = `${process.pid}-${Date.now()}`;
const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'Typeless-Toolkit-DMG-'));
const stagingApp = path.join('/Applications', `.Typeless-Toolkit-installing-${runId}.app`);
const previousApp = path.join('/Applications', `.Typeless-Toolkit-previous-${runId}.app`);
let mounted = false;
let movedPrevious = false;
let installedNew = false;

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
}

function findAppBundle(directory) {
  const queue = [directory];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name === appName) return absolute;
      if (entry.isDirectory()) queue.push(absolute);
    }
  }
  throw new Error(`DMG 中未找到 ${appName}`);
}

function appRunning() {
  try {
    run('/usr/bin/pgrep', ['-f', `${targetApp}/Contents/MacOS/`]);
    return true;
  } catch (error) {
    return false;
  }
}

function backendRunning() {
  try {
    run('/usr/bin/pgrep', ['-f', `${targetApp}/Contents/Resources/server/manager.js`]);
    return true;
  } catch (error) {
    return false;
  }
}

function stopInstalledApp() {
  try { run('/usr/bin/pkill', ['-f', `${targetApp}/Contents/MacOS/`]); } catch (error) {}
  try { run('/usr/bin/pkill', ['-f', `${targetApp}/Contents/Resources/server/manager.js`]); } catch (error) {}
  for (let i = 0; i < 40 && (appRunning() || backendRunning()); i++) run('/bin/sleep', ['0.25']);
  if (appRunning() || backendRunning()) throw new Error('旧版 Typeless 工具集未能退出，请手动退出后重试');
}

function verify(appPath) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')]);
  if (identifier !== buildConfig.bundleIdentifier) throw new Error(`Bundle ID 不正确: ${identifier}`);
  const info = JSON.parse(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'server', 'toolkit-build.json'), 'utf8'));
  if (info.version !== version || info.arch !== expectedArch || info.edition !== expectedEdition) {
    throw new Error(`构建元数据不匹配: ${JSON.stringify(info)}`);
  }
  const bundledNode = path.join(appPath, 'Contents', 'MacOS', 'node');
  if (fs.existsSync(bundledNode) !== (expectedEdition === 'portable')) {
    throw new Error(`${expectedEdition} 构建包含了错误的 Node.js 布局`);
  }
}

try {
  run('/usr/bin/hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mountPoint], { timeout: 30000 });
  mounted = true;
  const sourceApp = findAppBundle(mountPoint);
  verify(sourceApp);
  run('/usr/bin/ditto', [sourceApp, stagingApp]);
  verify(stagingApp);

  stopInstalledApp();
  if (fs.existsSync(targetApp)) {
    fs.renameSync(targetApp, previousApp);
    movedPrevious = true;
  }
  fs.renameSync(stagingApp, targetApp);
  installedNew = true;
  verify(targetApp);
  run('/usr/bin/open', ['-a', targetApp]);

  for (let i = 0; i < 40 && !appRunning(); i++) run('/bin/sleep', ['0.25']);
  if (!appRunning()) throw new Error('新版 Typeless 工具集安装后未能正常启动');
  if (movedPrevious && fs.existsSync(previousApp)) fs.rmSync(previousApp, { recursive: true, force: true });

  console.log(`已安装 ${path.basename(dmgPath)} 到 ${targetApp}`);
  console.log('账号、快照、词库和配置继续使用 Application Support 中的原数据目录。');
} catch (error) {
  try { if (installedNew) stopInstalledApp(); } catch (stopError) {}
  try { if (installedNew && fs.existsSync(targetApp)) fs.rmSync(targetApp, { recursive: true, force: true }); } catch (removeError) {}
  if (movedPrevious && fs.existsSync(previousApp) && !fs.existsSync(targetApp)) {
    fs.renameSync(previousApp, targetApp);
    run('/usr/bin/open', ['-a', targetApp]);
  }
  throw error;
} finally {
  if (mounted) {
    try { run('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 30000 }); }
    catch (error) { run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { timeout: 30000 }); }
  }
  fs.rmSync(mountPoint, { recursive: true, force: true });
  fs.rmSync(stagingApp, { recursive: true, force: true });
}
