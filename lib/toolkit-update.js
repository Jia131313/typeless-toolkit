const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_REPOSITORY = 'Jia131313/typeless-toolkit';
const MAX_RELEASE_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const STAGING_PREFIX = 'typeless-toolkit-update-';
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ZIP_SINGLE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

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

function installationInfo(codeRoot, dataRoot) {
  const installDir = path.resolve(codeRoot, '..');
  const expectedDataDir = path.join(installDir, 'data');
  const result = {
    ok: false,
    install_dir: installDir,
    edition: null,
    error: null,
  };
  if (path.parse(installDir).root === installDir) {
    result.error = '拒绝将磁盘根目录作为更新安装目录';
    return result;
  }
  if (path.resolve(codeRoot) !== path.join(installDir, 'server')) {
    result.error = '当前代码目录不是受支持的发行版 server 目录';
    return result;
  }
  if (path.resolve(dataRoot) !== expectedDataDir) {
    result.error = '当前数据目录不在发行版 data 目录，不能自动替换';
    return result;
  }
  for (const required of [
    path.join(installDir, 'TypelessToolkit.exe'),
    path.join(installDir, 'server', 'manager.js'),
    path.join(installDir, 'server', 'package.json'),
    expectedDataDir,
  ]) {
    if (!fs.existsSync(required)) {
      result.error = `当前发行版目录不完整: ${path.basename(required)}`;
      return result;
    }
  }
  try {
    if (!fs.statSync(expectedDataDir).isDirectory()) throw new Error('not-directory');
  } catch (error) {
    result.error = '当前发行版 data 目录无效';
    return result;
  }
  const nodePath = path.join(installDir, 'runtime', 'node.exe');
  result.ok = true;
  result.edition = fs.existsSync(nodePath) ? 'portable' : 'lite';
  return result;
}

function windowsFlavor(codeRoot, dataRoot) {
  return installationInfo(codeRoot, dataRoot || path.join(codeRoot, '..', 'data')).edition;
}

function assetNames(version, platform, flavor) {
  if (platform === 'win32') {
    if (!['portable', 'lite'].includes(flavor)) return null;
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

function validateZipEntryMetadata(entry) {
  const name = String(entry?.name || '');
  const length = Number(entry?.length || 0);
  const compressedLength = Number(entry?.compressedLength || 0);
  if (!isSafeZipEntry(name)) throw new Error(`更新包包含不安全路径: ${name}`);
  if (!Number.isFinite(length) || length < 0 || length > MAX_ZIP_SINGLE_FILE_BYTES) {
    throw new Error(`更新包文件大小超出上限: ${name}`);
  }
  if (length > 0 && (!Number.isFinite(compressedLength) || compressedLength <= 0 || length / compressedLength > MAX_ZIP_COMPRESSION_RATIO)) {
    throw new Error(`更新包压缩比例异常: ${name}`);
  }
}

function validateZipMetadata(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('更新包文件数量超出上限');
  }
  let total = 0;
  for (const entry of entries) {
    validateZipEntryMetadata(entry);
    total += Number(entry.length || 0);
    if (total > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) throw new Error('更新包解压总大小超出上限');
  }
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
  let downloaded = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > maxBytes) return callback(new Error('更新包大小超出安全上限'));
      onProgress(downloaded, total);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      fs.createWriteStream(filePath, { flags: 'w', mode: 0o600 }),
    );
  } catch (error) {
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
    error: !names
      ? '当前 Windows 安装类型无法确认，请从 Release 手动升级'
      : (archive && checksum ? null : `该版本未提供当前平台所需的更新包或 SHA-256 校验文件（需要 ${names.archive} 与 ${names.checksum}）`),
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
    '$destinationRoot = [IO.Path]::GetFullPath($args[1])',
    '$destinationPrefix = $destinationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar',
    '$maxEntries = [int]$args[2]; $maxTotal = [int64]$args[3]; $maxSingle = [int64]$args[4]; $maxRatio = [double]$args[5]',
    '$entryCount = 0; $totalLength = [int64]0',
    '$zip = [System.IO.Compression.ZipFile]::OpenRead($args[0])',
    'try {',
    '  foreach ($entry in $zip.Entries) {',
    '    $name = $entry.FullName.Replace("\\", "/")',
    '    if (!$name -or $name.StartsWith("/") -or $name -match "^[A-Za-z]:/" -or $name.Split("/") -contains "..") { throw "更新包包含不安全路径: $name" }',
    '    $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($destinationRoot, $name.Replace("/", [IO.Path]::DirectorySeparatorChar)))',
    '    if (!$candidate.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "更新包路径超出解压目录: $name" }',
    '    $entryCount++; if ($entryCount -gt $maxEntries) { throw "更新包文件数量超出上限" }',
    '    if ($entry.Length -gt $maxSingle) { throw "更新包单文件大小超出上限: $name" }',
    '    $totalLength += $entry.Length; if ($totalLength -gt $maxTotal) { throw "更新包解压总大小超出上限" }',
    '    if ($entry.Length -gt 0 -and ($entry.CompressedLength -le 0 -or ([double]$entry.Length / [double]$entry.CompressedLength) -gt $maxRatio)) { throw "更新包压缩比例异常: $name" }',
    '  }',
    '} finally { $zip.Dispose() }',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($args[0], $args[1])',
  ].join('; ');
  powershell(script, [zipPath, outputDir, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES, MAX_ZIP_SINGLE_FILE_BYTES, MAX_ZIP_COMPRESSION_RATIO], options);
}

function validateWindowsPayload(payloadDir, targetVersion, flavor) {
  const executable = path.join(payloadDir, 'TypelessToolkit.exe');
  const manager = path.join(payloadDir, 'server', 'manager.js');
  const packageFile = path.join(payloadDir, 'server', 'package.json');
  const dataDir = path.join(payloadDir, 'data');
  if (!fs.existsSync(executable) || !fs.existsSync(manager) || !fs.existsSync(packageFile) || !fs.existsSync(dataDir)) {
    throw new Error('更新包内容不完整，未找到启动器或本地服务');
  }
  let packageJson;
  try { packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')); } catch (error) {
    throw new Error('更新包中的 server/package.json 无法读取');
  }
  if (String(packageJson.version || '') !== String(targetVersion || '')) {
    throw new Error('更新包版本与目标 Release 不一致');
  }
  const bundledNode = path.join(payloadDir, 'runtime', 'node.exe');
  if (flavor === 'portable' && !fs.existsSync(bundledNode)) {
    throw new Error('Portable 更新包缺少内置 Node.js');
  }
  if (flavor === 'lite' && fs.existsSync(bundledNode)) {
    throw new Error('Lite 更新包包含内置 Node.js，已取消替换');
  }
  if (!['portable', 'lite'].includes(flavor)) throw new Error('无法确认更新包的 Windows 类型');
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
  [Parameter(Mandatory=$true)][string]$StageDir,
  [Parameter(Mandatory=$true)][string]$RollbackDir,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [Parameter(Mandatory=$true)][string]$TargetVersion,
  [Parameter(Mandatory=$true)][string]$Flavor
)
$ErrorActionPreference = 'Stop'
function Assert-ChildPath([string]$parent, [string]$child) {
  $base = [IO.Path]::GetFullPath($parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $full = [IO.Path]::GetFullPath($child)
  $prefix = $base + [IO.Path]::DirectorySeparatorChar
  if (!$full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "路径超出受支持目录: $full" }
  return $full
}
function Assert-Payload([string]$root, [string]$version, [string]$edition) {
  if (!(Test-Path -LiteralPath (Join-Path $root 'TypelessToolkit.exe')) -or !(Test-Path -LiteralPath (Join-Path $root 'server\manager.js')) -or !(Test-Path -LiteralPath (Join-Path $root 'server\package.json')) -or !(Test-Path -LiteralPath (Join-Path $root 'data'))) { throw '更新包或安装目录结构不完整。' }
  try { $manifest = Get-Content -LiteralPath (Join-Path $root 'server\package.json') -Raw | ConvertFrom-Json } catch { throw 'server/package.json 无法读取。' }
  if ([string]$manifest.version -ne [string]$version) { throw '更新包版本与目标 Release 不一致。' }
  $node = Join-Path $root 'runtime\node.exe'
  if ($edition -eq 'portable' -and !(Test-Path -LiteralPath $node)) { throw 'Portable 更新包缺少内置 Node.js。' }
  if ($edition -eq 'lite' -and (Test-Path -LiteralPath $node)) { throw 'Lite 更新包包含内置 Node.js。' }
  if ($edition -ne 'portable' -and $edition -ne 'lite') { throw '无法确认 Windows 更新包类型。' }
}
function Write-Result([string]$state, [string]$message) {
  try {
    @{ state = $state; version = $TargetVersion; at = (Get-Date).ToUniversalTime().ToString('o'); message = $message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
  } catch { }
}
$install = [IO.Path]::GetFullPath($InstallDir)
if ($install.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -eq [IO.Path]::GetPathRoot($install).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) { throw '拒绝将磁盘根目录作为更新安装目录。' }
$payload = Assert-ChildPath $StageDir $PayloadDir
$rollback = Assert-ChildPath $install $RollbackDir
$result = Assert-ChildPath (Join-Path $install 'data') $ResultPath
if ((Split-Path -Leaf $rollback) -notmatch '^\.typeless-toolkit-update-rollback-[A-Za-z0-9]+$') { throw '临时回退目录名称无效。' }
if (Test-Path -LiteralPath $rollback) { throw '临时回退目录已存在，请重试更新。' }
if ([IO.Path]::GetFullPath($RestartExe) -ne (Join-Path $install 'TypelessToolkit.exe')) { throw '重启程序路径无效。' }
$deadline = (Get-Date).AddSeconds(75)
$rollbackStarted = $false
$newProcess = $null
try {
  while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -or (Get-Process -Id $HostPid -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -gt $deadline) { throw '旧版工具集未在 75 秒内退出；请手动退出后重试。' }
    Start-Sleep -Milliseconds 250
  }
  Assert-Payload $payload $TargetVersion $Flavor
  $currentManifest = Get-Content -LiteralPath (Join-Path $install 'server\package.json') -Raw | ConvertFrom-Json
  $currentFlavor = if (Test-Path -LiteralPath (Join-Path $install 'runtime\node.exe')) { 'portable' } else { 'lite' }
  Assert-Payload $install ([string]$currentManifest.version) $currentFlavor
  New-Item -ItemType Directory -LiteralPath $rollback | Out-Null
  $rollbackStarted = $true
  Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne 'data' -and $_.FullName -ne $rollback } | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $rollback -Force
  }
  Get-ChildItem -LiteralPath $payload -Force | Where-Object { $_.Name -ne 'data' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $install -Recurse -Force
  }
  Assert-Payload $install $TargetVersion $Flavor
  $newProcess = Start-Process -FilePath $RestartExe -WorkingDirectory $install -PassThru
  Start-Sleep -Seconds 4
  if ($newProcess.HasExited) { throw "新版工具集启动失败，退出代码 $($newProcess.ExitCode)。" }
  Remove-Item -LiteralPath $rollback -Recurse -Force
  Write-Result 'succeeded' "已更新到 v$TargetVersion。"
} catch {
  $message = $_.Exception.Message
  if ($newProcess -and !$newProcess.HasExited) { try { Stop-Process -Id $newProcess.Id -Force } catch { } }
  if ($rollbackStarted) {
    try {
      Get-ChildItem -LiteralPath $install -Force | Where-Object { $_.Name -ne 'data' -and $_.FullName -ne $rollback } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
      Get-ChildItem -LiteralPath $rollback -Force | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $install -Force }
      Remove-Item -LiteralPath $rollback -Recurse -Force
      Start-Process -FilePath $RestartExe -WorkingDirectory $install
      Write-Result 'rolled-back' "更新失败，已恢复原版本：$message"
    } catch {
      Write-Result 'failed' "更新失败，且恢复原版本失败：$message；$($_.Exception.Message)"
    }
  } else { Write-Result 'failed' "更新未开始替换：$message" }
}
$cleanup = 'timeout /t 5 /nobreak >nul & rmdir /s /q "' + $StageDir + '"'
Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', $cleanup -WindowStyle Hidden
`;
  fs.writeFileSync(helperPath, script, { encoding: 'utf8', mode: 0o600 });
  return helperPath;
}

function launchWindowsUpdateHelper({ parentPid, hostPid, installDir, payloadDir, helperPath, version, flavor }) {
  const restartExe = path.join(installDir, 'TypelessToolkit.exe');
  const rollbackDir = path.join(installDir, `.typeless-toolkit-update-rollback-${crypto.randomBytes(8).toString('hex')}`);
  const resultPath = path.join(installDir, 'data', 'toolkit-update-result.json');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-ParentPid', String(parentPid),
    '-HostPid', String(hostPid || parentPid),
    '-InstallDir', installDir,
    '-PayloadDir', payloadDir,
    '-RestartExe', restartExe,
    '-StageDir', path.dirname(helperPath),
    '-RollbackDir', rollbackDir,
    '-ResultPath', resultPath,
    '-TargetVersion', String(version),
    '-Flavor', flavor,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid, restartExe };
}

function createToolkitUpdateController(options = {}) {
  const platform = options.platform || process.platform;
  const codeRoot = options.codeRoot || path.join(__dirname, '..');
  const dataRoot = options.dataRoot || codeRoot;
  const currentVersion = options.currentVersion || require(path.join(codeRoot, 'package.json')).version;
  const initialInstall = platform === 'win32' ? installationInfo(codeRoot, dataRoot) : null;
  const flavor = options.flavor || (initialInstall ? initialInstall.edition : null);
  const backendOwned = options.backendOwned === true;
  const automaticInstallAllowed = platform !== 'win32' || (backendOwned && (options.flavor ? true : initialInstall.ok));
  const manualInstallReason = platform !== 'win32'
    ? null
    : (!backendOwned
      ? '当前窗口复用了已有本地服务，只能手动从 Release 更新，避免替换其他窗口正在使用的程序。'
      : (initialInstall.ok ? null : initialInstall.error));
  const fetchFn = options.fetchFn || globalThis.fetch;
  const repository = options.repository || DEFAULT_REPOSITORY;
  const state = {
    state: 'idle', running: false, checked_at: null, current_version: currentVersion,
    version: null, available: false, platform: platform === 'darwin' ? 'macos' : 'windows',
    flavor, progress: null, error: null, update: null, download_path: null,
    automatic_install: automaticInstallAllowed,
    manual_install_reason: manualInstallReason,
    last_result: readUpdateResult(dataRoot),
  };
  let inFlight = null;

  const snapshot = () => JSON.parse(JSON.stringify(state));

  async function check() {
    state.state = 'checking'; state.running = true; state.error = null;
    try {
      const { release, version } = await fetchLatestRelease({ repository, fetchFn });
      const update = releaseSummary(release, version, currentVersion, platform, flavor);
      if (platform === 'win32' && !automaticInstallAllowed) {
        update.manual_only = true;
        update.error = manualInstallReason || '当前安装不能自动替换，请从 Release 手动更新';
      }
      state.checked_at = update.checked_at;
      state.version = version;
      state.available = update.available;
      state.update = update;
      state.state = update.available ? (update.manual_only ? 'manual-only' : (update.error ? 'incomplete' : 'available')) : 'up-to-date';
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
      if (current.manual_only) throw new Error(current.error || '当前安装只能手动更新');
      if (current.error || !current.asset || !current.checksum) throw new Error(current.error || '当前版本缺少可验证的更新包');
      state.state = 'downloading'; state.running = true; state.error = null;
      cleanupStaging();
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), STAGING_PREFIX));
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
        state.download_path = null; state.stage_dir = null;
        throw error;
      }
    })();
    try { return await inFlight; }
    catch (error) { state.state = 'error'; state.error = error.message; throw error; }
    finally { state.running = false; inFlight = null; }
  }

  function prepareWindowsInstall() {
    if (platform !== 'win32') throw new Error('工具集自动替换目前仅支持 Windows');
    if (!backendOwned) throw new Error('当前窗口复用了已有本地服务，只能手动从 Release 更新');
    if (state.state !== 'downloaded' || !state.download_path || !state.stage_dir) {
      throw new Error('请先完成更新包下载和 SHA-256 校验');
    }
    const currentInstall = installationInfo(codeRoot, dataRoot);
    if (!currentInstall.ok) throw new Error(currentInstall.error || '当前不是可安全更新的 Windows 发行版目录，请从 Release 手动更新');
    if (currentInstall.edition !== state.flavor) throw new Error('当前 Windows 安装类型发生变化，请重新检查更新');
    const installDir = currentInstall.install_dir;
    const extractionDir = path.join(state.stage_dir, 'payload');
    fs.mkdirSync(extractionDir, { recursive: true, mode: 0o700 });
    safeExtractZipWindows(state.download_path, extractionDir);
    const payloadDir = resolveWindowsPayloadRoot(extractionDir);
    validateWindowsPayload(payloadDir, state.version, state.flavor);
    const helperPath = writeWindowsUpdateHelper(state.stage_dir);
    const launched = launchWindowsUpdateHelper({
      parentPid: options.parentPid || process.pid,
      hostPid: options.hostPid || options.parentPid || process.pid,
      installDir,
      payloadDir,
      helperPath,
      version: state.version,
      flavor: state.flavor,
    });
    state.state = 'installing';
    state.helper_pid = launched.pid;
    return { ...launched, version: state.version, preserve: 'data' };
  }

  function cleanupStaging() {
    if (!state.stage_dir || state.state === 'installing') return;
    try { fs.rmSync(state.stage_dir, { recursive: true, force: true }); } catch (error) {}
    state.stage_dir = null;
    state.download_path = null;
    state.progress = null;
  }

  return { check, download, prepareWindowsInstall, cleanupStaging, status: snapshot };
}

function readUpdateResult(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataRoot, 'toolkit-update-result.json'), 'utf8'));
    if (!['succeeded', 'rolled-back', 'failed'].includes(value?.state)) return null;
    return {
      state: value.state,
      version: String(value.version || ''),
      at: String(value.at || ''),
      message: String(value.message || '').slice(0, 500),
    };
  } catch (error) { return null; }
}

module.exports = {
  DEFAULT_REPOSITORY,
  compareVersions,
  releaseVersion,
  installationInfo,
  windowsFlavor,
  assetNames,
  findAsset,
  parseSha256File,
  isSafeZipEntry,
  validateZipEntryMetadata,
  validateZipMetadata,
  sha256File,
  downloadToFile,
  releaseSummary,
  fetchLatestRelease,
  safeExtractZipWindows,
  validateWindowsPayload,
  resolveWindowsPayloadRoot,
  writeWindowsUpdateHelper,
  readUpdateResult,
  createToolkitUpdateController,
};
