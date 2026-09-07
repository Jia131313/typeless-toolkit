const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('Windows update helper smoke test skipped: requires Windows.');
  process.exit(0);
}

const { writeWindowsUpdateHelper, readUpdateResult } = require('../lib/toolkit-update');

const OLD_VERSION = '1.6.2';
const NEW_VERSION = '1.6.3';
const ABSENT_PID = 2147483000;

function findCsc() {
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Windows .NET Framework C# compiler was not found.');
  return found;
}

function compileHost(csc, outputPath, behavior) {
  const sourcePath = `${outputPath}.${behavior}.cs`;
  const readyBehavior = behavior === 'ready'
    ? String.raw`
      string readyPath = null;
      string version = null;
      for (int i = 0; i + 1 < args.Length; i++) {
        if (args[i] == "--toolkit-update-ready") readyPath = args[++i];
        else if (args[i] == "--toolkit-update-version") version = args[++i];
      }
      if (String.IsNullOrEmpty(readyPath) || String.IsNullOrEmpty(version)) return 21;
      File.WriteAllText(readyPath, version + Environment.NewLine, new UTF8Encoding(false));
      return 0;`
    : behavior === 'fail' ? 'return 23;' : 'return 0;';
  const source = `using System;\nusing System.IO;\nusing System.Text;\npublic static class FakeToolkitHost {\n  public static int Main(string[] args) {\n    ${readyBehavior}\n  }\n}\n`;
  fs.writeFileSync(sourcePath, `\uFEFF${source}`, 'utf8');
  const compiled = spawnSync(csc, [
    '/nologo', '/target:exe', `/out:${outputPath}`, sourcePath,
  ], { encoding: 'utf8', windowsHide: true });
  if (compiled.error) throw compiled.error;
  assert.equal(compiled.status, 0, `C# fake host compilation failed:\n${compiled.stderr || compiled.stdout}`);
  fs.rmSync(sourcePath, { force: true });
}

function writeRelease(root, version, executablePath, dataContents) {
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.copyFileSync(executablePath, path.join(root, 'TypelessToolkit.exe'));
  fs.writeFileSync(path.join(root, 'server', 'manager.js'), `module.exports = ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(root, 'server', 'package.json'), `${JSON.stringify({ version })}\n`);
  fs.writeFileSync(path.join(root, 'runtime', 'node.exe'), `fake-node-${version}\n`);
  for (const [relativePath, contents] of Object.entries(dataContents)) {
    const target = path.join(root, 'data', relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function snapshotUserData(dataDir) {
  const result = {};
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dataDir, absolute).replaceAll(path.sep, '/');
      if (relative === 'toolkit-update-result.json') continue;
      if (entry.isDirectory()) visit(absolute);
      else result[relative] = fs.readFileSync(absolute).toString('base64');
    }
  };
  visit(dataDir);
  return result;
}

function runPowerShellHelper(helperPath, options) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-ParentPid', String(ABSENT_PID),
    '-HostPid', String(ABSENT_PID),
    '-InstallDir', options.installDir,
    '-PayloadDir', options.payloadDir,
    '-RestartExe', path.join(options.installDir, 'TypelessToolkit.exe'),
    '-StageDir', options.stageDir,
    '-RollbackDir', options.rollbackDir,
    '-ResultPath', options.resultPath,
    '-ReadyPath', options.readyPath,
    '-TargetVersion', NEW_VERSION,
    '-Flavor', 'portable',
  ], { encoding: 'utf8', windowsHide: true, timeout: 70000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `PowerShell helper failed:\n${result.stderr || result.stdout}`);
}

async function waitUntilRemoved(targetPath, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(targetPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(fs.existsSync(targetPath), false, `Temporary staging directory was not removed: ${targetPath}`);
}

async function exerciseScenario(csc, behavior, expectedState) {
  const token = `${process.pid}-${Date.now()}-${behavior}`;
  const fixtureRoot = path.join(os.tmpdir(), `Typeless 更新冒烟 ${token}`);
  const installDir = path.join(fixtureRoot, '安装 目录');
  const stageDir = path.join(os.tmpdir(), `typeless-toolkit-update-中文 空格-${token}`);
  const payloadDir = path.join(stageDir, '更新 包内容');
  const rollbackDir = path.join(installDir, `.typeless-toolkit-update-rollback-${process.pid}${behavior}`);
  const resultPath = path.join(installDir, 'data', 'toolkit-update-result.json');
  const readyPath = path.join(stageDir, `.typeless-toolkit-ready-${process.pid}${behavior}.marker`);
  const oldHost = path.join(fixtureRoot, '旧版 假宿主.exe');
  const newHost = path.join(fixtureRoot, `新版 ${behavior} 假宿主.exe`);
  const originalData = {
    'accounts.json': Buffer.from('{"账号":["一","二"]}\n', 'utf8'),
    '词库/Typeless词库主清单.csv': Buffer.from('word,source\n中文词,本机\n', 'utf8'),
  };
  const packagedData = {
    'accounts.json': Buffer.from('{"should":"never replace user data"}\n', 'utf8'),
    '词库/Typeless词库主清单.csv': Buffer.from('overwritten,package\n', 'utf8'),
  };

  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });
  try {
    compileHost(csc, oldHost, 'old');
    compileHost(csc, newHost, behavior);
    writeRelease(installDir, OLD_VERSION, oldHost, originalData);
    writeRelease(payloadDir, NEW_VERSION, newHost, packagedData);
    const beforeData = snapshotUserData(path.join(installDir, 'data'));
    const helperPath = writeWindowsUpdateHelper(stageDir);

    runPowerShellHelper(helperPath, {
      installDir, payloadDir, stageDir, rollbackDir, resultPath, readyPath,
    });

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(result.state, expectedState, result.message);
    assert.equal(readUpdateResult(path.join(installDir, 'data')).state, expectedState, 'Toolkit must read Windows UTF-8 result files.');
    assert.deepEqual(snapshotUserData(path.join(installDir, 'data')), beforeData, 'User data bytes changed during update.');
    assert.equal(fs.existsSync(rollbackDir), false, 'Temporary rollback directory was not removed.');
    const installedVersion = JSON.parse(fs.readFileSync(path.join(installDir, 'server', 'package.json'), 'utf8')).version;
    assert.equal(installedVersion, expectedState === 'succeeded' ? NEW_VERSION : OLD_VERSION);
    await waitUntilRemoved(stageDir);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

async function main() {
  const csc = findCsc();
  await exerciseScenario(csc, 'ready', 'succeeded');
  await exerciseScenario(csc, 'fail', 'rolled-back');
  console.log('Windows update helper smoke test passed: replacement, rollback, data preservation, and cleanup verified.');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
