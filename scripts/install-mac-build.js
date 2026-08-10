const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') throw new Error('本地 macOS 安装脚本只能在 Mac 上运行');

const projectRoot = path.join(__dirname, '..');
const arch = process.argv[2] || process.arch;
const outputDir = path.join(projectRoot, 'dist', `mac-${arch}`);
const appName = 'Typeless 工具集.app';
const sourceCandidates = [
  path.join(outputDir, `${appName}.noindex`),
  path.join(outputDir, appName),
];
const sourceApp = sourceCandidates.find(candidate => fs.existsSync(candidate));
const targetApp = path.join('/Applications', appName);
const runId = `${process.pid}-${Date.now()}`;
const stagingApp = path.join('/Applications', `.Typeless-Toolkit-installing-${runId}.app.noindex`);
const previousApp = path.join('/Applications', `.Typeless-Toolkit-previous-${runId}.app.noindex`);

if (!sourceApp) throw new Error(`找不到 ${arch} 构建产物，请先运行对应的 build:mac 命令`);

function run(file, args, options = {}) {
  return execFileSync(file, args, { stdio: 'ignore', ...options });
}

function appRunning() {
  try {
    run('/usr/bin/pgrep', ['-f', `${targetApp}/Contents/MacOS/Typeless 工具集`]);
    return true;
  } catch (error) {
    return false;
  }
}

function stopInstalledApp() {
  try { run('/usr/bin/pkill', ['-f', `${targetApp}/`]); } catch (error) {}
  for (let i = 0; i < 40 && appRunning(); i++) {
    try { run('/bin/sleep', ['0.25']); } catch (error) {}
  }
  if (appRunning()) throw new Error('旧版 Typeless 工具集未能退出，请手动退出后重试');
}

function verify(appPath) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
}

let movedPrevious = false;
let installedNew = false;
try {
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

  for (let i = 0; i < 40 && !appRunning(); i++) {
    try { run('/bin/sleep', ['0.25']); } catch (error) {}
  }
  if (!appRunning()) throw new Error('新版 Typeless 工具集安装后未能正常启动');

  if (movedPrevious && fs.existsSync(previousApp)) {
    fs.rmSync(previousApp, { recursive: true, force: true });
  }
  console.log(`已安装 ${targetApp}`);
  console.log('账号、快照、词库和配置继续使用 Application Support 中的原数据目录。');
} catch (error) {
  try { if (installedNew) stopInstalledApp(); } catch (stopError) {}
  try { if (installedNew && fs.existsSync(targetApp)) fs.rmSync(targetApp, { recursive: true, force: true }); } catch (removeError) {}
  try {
    if (movedPrevious && fs.existsSync(previousApp) && !fs.existsSync(targetApp)) {
      fs.renameSync(previousApp, targetApp);
      run('/usr/bin/open', ['-a', targetApp]);
    }
  } catch (restoreError) {
    throw new Error(`${error.message};旧版自动恢复失败:${restoreError.message};保留位置:${previousApp}`);
  }
  throw error;
} finally {
  try { if (fs.existsSync(stagingApp)) fs.rmSync(stagingApp, { recursive: true, force: true }); } catch (error) {}
}
