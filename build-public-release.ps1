$ErrorActionPreference = 'Stop'

$buildConfig = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'windows-build.json') | ConvertFrom-Json
$publicVersion = (Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json).version
$nodeVersion = $buildConfig.node_version
$nodeDist = "node-v$nodeVersion-win-x64"
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$windowsBuildRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot '.build\windows'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot '..\release'))
$baseName = "TypelessToolkit-v$publicVersion-win-x64"
$liteTarget = [IO.Path]::GetFullPath((Join-Path $releaseRoot "$baseName-lite"))
$portableTarget = [IO.Path]::GetFullPath((Join-Path $releaseRoot "$baseName-portable"))
$liteZip = "$liteTarget.zip"
$portableZip = "$portableTarget.zip"
$liteSha = "$liteZip.sha256.txt"
$portableSha = "$portableZip.sha256.txt"

function Assert-ChildPath([string]$parent, [string]$child) {
  $prefix = $parent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe build path: $child"
  }
}

function Get-Sha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $algorithm.ComputeHash($stream) }
    finally { $algorithm.Dispose() }
  }
  finally { $stream.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Remove-BuildPath([string]$path, [switch]$Recurse) {
  Assert-ChildPath $releaseRoot $path
  if (Test-Path -LiteralPath $path) {
    if ($Recurse) { Remove-Item -LiteralPath $path -Recurse -Force }
    else { Remove-Item -LiteralPath $path -Force }
  }
}

function Copy-PublicFiles([string]$target) {
  New-Item -ItemType Directory -Force -Path (Join-Path $target 'server\lib') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $target 'data\profiles') | Out-Null

  $desktopFiles = @(
    'TypelessToolkit.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll'
  )
  foreach ($file in $desktopFiles) {
    Copy-Item -LiteralPath (Join-Path $windowsBuildRoot $file) -Destination (Join-Path $target $file) -Force
  }
  foreach ($file in @('LICENSE', 'README.md', 'windows-build.json', 'toolkit-update.json')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $target $file) -Force
  }
  Copy-Item -LiteralPath (Join-Path $sourceRoot ".build\webview2\$($buildConfig.webview2_version)\LICENSE.txt") -Destination (Join-Path $target 'WEBVIEW2-LICENSE.txt') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\tray-icon.ico') -Destination (Join-Path $target 'tray-icon.ico') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\icon-rounded.png') -Destination (Join-Path $target 'icon.png') -Force

  $serverFiles = @('manager.js', 'manager.html', 'typeless-dict-sync.js', 'package.json', 'package-lock.json', 'windows-build.json', 'toolkit-update.json')
  foreach ($file in $serverFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $target "server\$file") -Force
  }
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\icon-rounded.png') -Destination (Join-Path $target 'server\icon.png') -Force
  Copy-Item -Path (Join-Path $sourceRoot 'lib\*') -Destination (Join-Path $target 'server\lib') -Recurse -Force

  Copy-Item -LiteralPath (Join-Path $sourceRoot 'config.example.json') -Destination (Join-Path $target 'data\config.json') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'accounts.example.json') -Destination (Join-Path $target 'data\accounts.example.json') -Force
  $accountsPath = Join-Path $target 'data\accounts.json'
  [IO.File]::WriteAllText($accountsPath, '[]', [Text.UTF8Encoding]::new($false))
}

function Write-BuildMetadata([string]$target, [string]$edition, [string]$distribution) {
  $metadata = [ordered]@{
    platform = 'windows'; distribution = $distribution; edition = $edition
    version = $publicVersion; arch = $buildConfig.architecture
    data_directory = $buildConfig.data_directory; node_minimum = $buildConfig.node_minimum
    node_probe_timeout_ms = $buildConfig.node_probe_timeout_ms
  }
  [IO.File]::WriteAllText((Join-Path $target 'toolkit-build.json'), ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

function Build-Installer([string]$target, [string]$edition) {
  $installerStage = Join-Path $releaseRoot "$baseName-$edition-installer"
  Remove-BuildPath $installerStage -Recurse
  Copy-Item -LiteralPath $target -Destination $installerStage -Recurse
  # Defaults live in the program tree; Setup never writes the user's existing data.
  Move-Item -LiteralPath (Join-Path $installerStage 'data') -Destination (Join-Path $installerStage 'defaults')
  Write-BuildMetadata $installerStage $edition 'installer'
  $compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  & $compiler "/DSourceDir=$installerStage" "/DOutputDir=$releaseRoot" "/DAppVersion=$publicVersion" "/DEdition=$edition" "/DAppId=$($buildConfig.installer_app_id)" "/DInstallDirectory=$($buildConfig.install_directory)" "/DWaitSeconds=$($buildConfig.installer_wait_seconds)" (Join-Path $sourceRoot 'scripts\windows-installer.iss')
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $edition" }
  $setupPath = Join-Path $releaseRoot "$baseName-$edition-setup.exe"
  [IO.File]::WriteAllText("$setupPath.sha256.txt", (Get-Sha256 $setupPath) + '  ' + [IO.Path]::GetFileName($setupPath) + [Environment]::NewLine, [Text.Encoding]::ASCII)
  Remove-BuildPath $installerStage -Recurse
}

function Install-ProductionDependencies([string]$target) {
  $serverDir = Join-Path $target 'server'
  & npm.cmd --prefix $serverDir ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed with exit code $LASTEXITCODE" }

  foreach ($devModule in @('electron', 'electron-builder', 'app-builder-lib')) {
    if (Test-Path -LiteralPath (Join-Path $serverDir "node_modules\$devModule")) {
      throw "Development dependency leaked into public package: $devModule"
    }
  }
}

function Assert-PublicData([string]$target) {
  $accountsPath = Join-Path $target 'data\accounts.json'
  $accountsJson = Get-Content -Raw -Encoding UTF8 $accountsPath
  if ($accountsJson.Trim() -ne '[]') {
    throw "Public accounts.json is not sanitized: $accountsPath"
  }
  if (@(Get-ChildItem (Join-Path $target 'data\profiles') -Force).Count) {
    throw "Public profiles directory is not empty: $target"
  }
  foreach ($private in @('webview2-profile', 'chrome-profile', 'backups', 'config.local.json', 'account-sync.json', 'account-sync-tombstones.json')) {
    if (Test-Path (Join-Path $target "data\$private")) { throw "Private data found: $private" }
  }
}

function Write-ArchiveAndHash([string]$target, [string]$zip, [string]$shaPath) {
  Compress-Archive -LiteralPath $target -DestinationPath $zip -CompressionLevel Optimal
  $hash = Get-Sha256 $zip
  [IO.File]::WriteAllText(
    $shaPath,
    $hash + '  ' + [IO.Path]::GetFileName($zip) + [Environment]::NewLine,
    [Text.Encoding]::ASCII
  )
  Write-Host "[public] $([IO.Path]::GetFileName($zip)) SHA256 $hash"
}

Write-Host '[public] Building desktop launcher...'
& cmd.exe /c (Join-Path $sourceRoot 'build-tray.bat')
if ($LASTEXITCODE -ne 0) { throw "build-tray.bat failed with exit code $LASTEXITCODE" }

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
foreach ($path in @($liteTarget, $portableTarget)) { Remove-BuildPath $path -Recurse }
foreach ($path in @($liteZip, $portableZip, $liteSha, $portableSha)) { Remove-BuildPath $path }

Write-Host '[public] Creating sanitized Lite package...'
Copy-PublicFiles $liteTarget
Install-ProductionDependencies $liteTarget
Assert-PublicData $liteTarget
Write-BuildMetadata $liteTarget 'lite' 'portable'
if (Test-Path (Join-Path $liteTarget 'runtime\node.exe')) { throw 'Lite package unexpectedly contains Node.js' }

Write-Host '[public] Preparing pinned Node.js runtime...'
$nodeCacheRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot '.build\node'))
$nodeCache = [IO.Path]::GetFullPath((Join-Path $nodeCacheRoot $nodeDist))
$nodeExe = Join-Path $nodeCache 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  New-Item -ItemType Directory -Force -Path $nodeCacheRoot | Out-Null
  $nodeZip = Join-Path $nodeCacheRoot "$nodeDist.zip"
  $checksums = Join-Path $nodeCacheRoot "SHASUMS256-v$nodeVersion.txt"
  $baseUrl = "https://nodejs.org/dist/v$nodeVersion"
  Invoke-WebRequest -UseBasicParsing "$baseUrl/$nodeDist.zip" -OutFile $nodeZip
  Invoke-WebRequest -UseBasicParsing "$baseUrl/SHASUMS256.txt" -OutFile $checksums
  $line = Get-Content $checksums | Where-Object { $_ -match "\s$([regex]::Escape("$nodeDist.zip"))$" } | Select-Object -First 1
  if (-not $line) { throw "Node.js checksum entry not found for $nodeDist.zip" }
  $expected = ($line -split '\s+')[0].ToLowerInvariant()
  $actual = Get-Sha256 $nodeZip
  if ($actual -ne $expected) { throw "Node.js archive checksum mismatch: expected $expected, got $actual" }
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeCacheRoot -Force
  Remove-Item -LiteralPath $nodeZip, $checksums -Force
}

Write-Host '[public] Creating sanitized Portable package...'
Copy-Item -LiteralPath $liteTarget -Destination $portableTarget -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $portableTarget 'runtime') | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $portableTarget 'runtime\node.exe') -Force
Copy-Item -LiteralPath (Join-Path $nodeCache 'LICENSE') -Destination (Join-Path $portableTarget 'runtime\NODE-LICENSE.txt') -Force
[IO.File]::WriteAllText((Join-Path $portableTarget 'runtime\NODE-VERSION.txt'), "Node.js v$nodeVersion (win-x64)" + [Environment]::NewLine, [Text.Encoding]::ASCII)
Assert-PublicData $portableTarget
Write-BuildMetadata $portableTarget 'portable' 'portable'
$bundledVersion = (& (Join-Path $portableTarget 'runtime\node.exe') --version).Trim()
if ($bundledVersion -ne "v$nodeVersion") { throw "Portable Node.js version mismatch: $bundledVersion" }

Write-Host '[public] Compressing packages...'
Write-ArchiveAndHash $liteTarget $liteZip $liteSha
Write-ArchiveAndHash $portableTarget $portableZip $portableSha
Build-Installer $liteTarget 'lite'
Build-Installer $portableTarget 'portable'

Write-Host '[public] Complete:'
Write-Host "  Lite:     $liteZip"
Write-Host "  Portable: $portableZip"
