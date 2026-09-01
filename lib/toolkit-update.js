const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_REPOSITORY = 'Jia131313/typeless-toolkit';
const MAX_RELEASE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

function compareVersions(left, right) {
  const parse = value => String(value || '')
    .replace(/^v/i, '')
    .split('-', 1)[0]
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function releaseVersion(tagName) {
  const match = String(tagName || '').match(/^v?(\d+(?:\.\d+){1,3})$/i);
  return match ? match[1] : null;
}

function windowsFlavor(codeRoot) {
  return fs.existsSync(path.join(codeRoot, '..', 'runtime', 'node.exe')) ? 'portable' : 'lite';
}

function assetNames(version, platform, flavor) {
  if (platform === 'win32') {
    const archive = `TypelessToolkit-v${version}-win-x64-${flavor}.zip`;
    return { archive, checksum: `${archive}.sha256.txt` };
  }
  if (platform === 'darwin') {
    const archive = `Typeless-Toolkit-${version}-universal.dmg`;
    return { archive, checksum: `${archive}.sha256.txt` };
  }
  return null;
}

function findAsset(release, name) {
  return (release && Array.isArray(release.assets) ? release.assets : [])
    .find(asset => asset && asset.name === name) || null;
}

function parseSha256File(text, expectedFileName) {
  const line = String(text || '').split(/\r?\n/).find(item => item.trim());
  const match = line && line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
  if (!match) throw new Error('SHA-256 校验文件格式无效');
  if (path.basename(match[2].trim()) !== expectedFileName) {
    throw new Error('SHA-256 校验文件与下载包不匹配');
  }
  return match[1].toLowerCase();
}

function isSafeZipEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  return !!normalized &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadToFile(url, filePath, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const onProgress = options.onProgress || (() => {});
  const maxBytes = options.maxBytes || MAX_RELEASE_DOWNLOAD_BYTES;
  const response = await fetchFn(url, {
    headers: { 'User-Agent': 'typeless-toolkit-updater' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) throw new Error(`下载更新包失败: HTTP ${response.status}`);
  const total = Number(response.headers?.get?.('content-length') || 0);
  if (total && total > maxBytes) throw new Error('更新包大小超出安全上限');
  const output = fs.createWriteStream(filePath, { flags: 'w', mode: 0o600 });
  let downloaded = 0;
  const body = Readable.fromWeb(response.body);
  try {
    for await (const chunk of body) {
      downloaded += chunk.length;
      if (downloaded > maxBytes) throw new Error('更新包大小超出安全上限');
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
      onProgress(downloaded, total);
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    try { fs.unlinkSync(filePath); } catch (unlinkError) {}
    throw error;
  }
  return { downloaded, total };
}

function releaseSummary(release, version, currentVersion, platform, flavor) {
  const names = assetNames(version, platform, flavor);
  const archive = names && findAsset(release, names.archive);
  const checksum = names && findAsset(release, names.checksum);
  return {
    checked_at: new Date().toISOString(),
    current_version: currentVersion,
    version,
    available: compareVersions(version, currentVersion) > 0,
    release_url: release.html_url || null,
    published_at: release.published_at || null,
    notes: String(release.body || ''),
    platform: platform === 'darwin' ? 'macos' : 'windows',
    flavor: platform === 'win32' ? flavor : null,
    asset: archive ? {
      name: archive.name,
      url: archive.browser_download_url,
      size: archive.size || 0,
    } : null,
    checksum: checksum ? {
      name: checksum.name,
      url: checksum.browser_download_url,
    } : null,
    error: archive && checksum ? null : `该版本未提供当前平台所需的更新包或 SHA-256 校验文件（需要 ${names.archive} 与 ${names.checksum}）`,
  };
}

async function fetchLatestRelease(options = {}) {
  const repository = options.repository || DEFAULT_REPOSITORY;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const response = await fetchFn(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'typeless-toolkit-updater',
    },
  });
  if (!response.ok) throw new Error(`检查 GitHub Release 失败: HTTP ${response.status}`);
  const release = await response.json();
  const version = releaseVersion(release.tag_name);
  if (!version) throw new Error('最新 Release 的标签不是受支持的版本号');
  return { release, version };
}

function powershell(command, args, options = {}) {
  const executable = options.executable || 'powershell.exe';
  const result = spawnSync(executable, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', command,
    ...args,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'PowerShell 执行失败').trim());
}

function safeExtractZipWindows(zipPath, outputDir, options = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$zip = [System.IO.Compression.ZipFile]::OpenRead($args[0])',
    'try {',
    '  foreach ($entry in $zip.Entries) {',
    '    $name = $entry.FullName.Replace("\\", "/")',
    '    if (!$name -or $name.StartsWith("/") -or $name -match "^[A-Za-z]:/" -or $name.Split("/") -contains "..") { throw "更新包包含不安全路径: $name" }',
    '  }',
    '} finally { $zip.Dispose() }',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($args[0], $args[1])',
  ].join('; ');
  powershell(script, [zipPath, outputDir], options);
}

function validateWindowsPayload(payloadDir) {
  const executable = path.join(payloadDir, 'TypelessToolkit.exe');
  const manager = path.join(payloadDir, 'server', 'manager.js');
  if (!fs.existsSync(executable) || !fs.existsSync(manager)) {
    throw new Error('更新包内容不完整，未找到启动器或本地服务');
  }
}

function resolveWindowsPayloadRoot(extractedDir) {
  if (fs.existsSync(path.join(extractedDir, 'TypelessToolkit.exe'))) return extractedDir;
  const children = fs.readdirSync(extractedDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory());
  if (children.length === 1) {
    const nested = path.join(extractedDir, children[0].name);
    if (fs.existsSync(path.join(nested, 'TypelessToolkit.exe'))) return nested;
  }
  throw new Error('更新包目录结构不符合预期');
}

function writeWindowsUpdateHelper(stageDir) {
  const helperPath = path.join(stageDir, 'apply-update.ps1');
  const script = String.raw`param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][int]$HostPid,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$PayloadDir,
  [Parameter(Mandatory=$true)][string]$RestartExe,
  [Parameter(Mandatory=$true)][string]$StageDir
)
$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -or (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { throw '旧版工具集未在 75 秒内退出；请手动退出后重试。' }
  Start-Sleep -Milliseconds 250
}
if (!(Test-Path -LiteralPath (Join-Path $PayloadDir 'TypelessToolkit.exe')) -or !(Test-Path -LiteralPath (Join-Path $PayloadDir 'server\manager.js'))) {
  throw '更新包内容不完整，已取消替换。'
}
Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force
}
Get-ChildItem -LiteralPath $PayloadDir -Force | ForEach-Object {
  if ($_.Name -ne 'data') { Copy-Item -LiteralPath $_.FullName -Destination $InstallDir -Recurse -Force }
}
Start-Process -FilePath $RestartExe -WorkingDirectory $InstallDir
$cleanup = 'timeout /t 5 /nobreak >nul & rmdir /s /q "' + $StageDir + '"'
Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', $cleanup -WindowStyle Hidden
`;
  fs.writeFileSync(helperPath, script, { encoding: 'utf8', mode: 0o600 });
  return helperPath;
}

function launchWindowsUpdateHelper({ parentPid, hostPid, installDir, payloadDir, helperPath }) {
  const restartExe = path.join(installDir, 'TypelessToolkit.exe');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-ParentPid', String(parentPid),
    '-HostPid', String(hostPid || parentPid),
    '-InstallDir', installDir,
    '-PayloadDir', payloadDir,
    '-RestartExe', restartExe,
    '-StageDir', path.dirname(helperPath),
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid, restartExe };
}

function createToolkitUpdateController(options = {}) {
  const platform = options.platform || process.platform;
  const codeRoot = options.codeRoot || path.join(__dirname, '..');
  const dataRoot = options.dataRoot || codeRoot;
  const currentVersion = options.currentVersion || require(path.join(codeRoot, 'package.json')).version;
  const flavor = options.flavor || (platform === 'win32' ? windowsFlavor(codeRoot) : null);
  const fetchFn = options.fetchFn || globalThis.fetch;
  const repository = options.repository || DEFAULT_REPOSITORY;
  const state = {
    state: 'idle', running: false, checked_at: null, current_version: currentVersion,
    version: null, available: false, platform: platform === 'darwin' ? 'macos' : 'windows',
    flavor, progress: null, error: null, update: null, download_path: null,
  };
  let inFlight = null;

  const snapshot = () => JSON.parse(JSON.stringify(state));

  async function check() {
    state.state = 'checking'; state.running = true; state.error = null;
    try {
      const { release, version } = await fetchLatestRelease({ repository, fetchFn });
      const update = releaseSummary(release, version, currentVersion, platform, flavor);
      state.checked_at = update.checked_at;
      state.version = version;
      state.available = update.available;
      state.update = update;
      state.state = update.available ? (update.error ? 'incomplete' : 'available') : 'up-to-date';
      state.error = update.error;
      return snapshot();
    } catch (error) {
      state.state = 'error'; state.error = error.message; state.update = null;
      throw error;
    } finally { state.running = false; }
  }

  async function download() {
    if (inFlight) return snapshot();
    inFlight = (async () => {
      let current = state.update;
      if (!current || !current.available) {
        await check();
        current = state.update;
      }
      if (!current?.available) throw new Error('当前已是最新版本');
      if (current.error || !current.asset || !current.checksum) throw new Error(current.error || '当前版本缺少可验证的更新包');
      state.state = 'downloading'; state.running = true; state.error = null;
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-toolkit-update-'));
      const archivePath = path.join(stageDir, current.asset.name);
      try {
        const checksumResponse = await fetchFn(current.checksum.url, {
          headers: { 'User-Agent': 'typeless-toolkit-updater' }, redirect: 'follow',
        });
        if (!checksumResponse.ok) throw new Error(`下载 SHA-256 校验文件失败: HTTP ${checksumResponse.status}`);
        const expectedHash = parseSha256File(await checksumResponse.text(), current.asset.name);
        await downloadToFile(current.asset.url, archivePath, {
          fetchFn,
          onProgress(downloaded, total) {
            state.progress = { downloaded, total, percent: total ? Math.floor(downloaded * 100 / total) : null };
          },
        });
        const actualHash = await sha256File(archivePath);
        if (actualHash !== expectedHash) throw new Error('更新包 SHA-256 校验失败，已取消安装');
        state.download_path = archivePath;
        state.stage_dir = stageDir;
        state.state = 'downloaded';
        state.progress = { ...(state.progress || {}), percent: 100 };
        return snapshot();
      } catch (error) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (cleanupError) {}
        throw error;
      }
    })();
    try { return await inFlight; }
    catch (error) { state.state = 'error'; state.error = error.message; throw error; }
    finally { state.running = false; inFlight = null; }
  }

  function prepareWindowsInstall() {
    if (platform !== 'win32') throw new Error('工具集自动替换目前仅支持 Windows');
    if (state.state !== 'downloaded' || !state.download_path || !state.stage_dir) {
      throw new Error('请先完成更新包下载和 SHA-256 校验');
    }
    const installDir = path.resolve(codeRoot, '..');
    const expectedDataDir = path.join(installDir, 'data');
    if (path.resolve(dataRoot) !== path.resolve(expectedDataDir)) {
      throw new Error('当前不是可安全更新的 Windows 发行版目录，请从 Release 手动更新');
    }
    const extractionDir = path.join(state.stage_dir, 'payload');
    fs.mkdirSync(extractionDir, { recursive: true, mode: 0o700 });
    safeExtractZipWindows(state.download_path, extractionDir);
    const payloadDir = resolveWindowsPayloadRoot(extractionDir);
    validateWindowsPayload(payloadDir);
    const helperPath = writeWindowsUpdateHelper(state.stage_dir);
    const launched = launchWindowsUpdateHelper({
      parentPid: options.parentPid || process.pid,
      hostPid: options.hostPid || options.parentPid || process.pid,
      installDir,
      payloadDir,
      helperPath,
    });
    state.state = 'installing';
    state.helper_pid = launched.pid;
    return { ...launched, version: state.version, preserve: 'data' };
  }

  return { check, download, prepareWindowsInstall, status: snapshot };
}

module.exports = {
  DEFAULT_REPOSITORY,
  compareVersions,
  releaseVersion,
  windowsFlavor,
  assetNames,
  findAsset,
  parseSha256File,
  isSafeZipEntry,
  sha256File,
  downloadToFile,
  releaseSummary,
  fetchLatestRelease,
  safeExtractZipWindows,
  validateWindowsPayload,
  resolveWindowsPayloadRoot,
  writeWindowsUpdateHelper,
  createToolkitUpdateController,
};
