$ErrorActionPreference = 'Stop'

$publicVersion = '1.3.1'
$nodeVersion = '24.15.0'
$nodeDist = "node-v$nodeVersion-win-x64"
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
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

  $rootFiles = @(
    'TypelessToolkit.exe',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
    'LICENSE',
    'README.md'
  )
  foreach ($file in $rootFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $target $file) -Force
  }
  Copy-Item -LiteralPath (Join-Path $sourceRoot '.build\webview2\1.0.4078.44\LICENSE.txt') -Destination (Join-Path $target 'WEBVIEW2-LICENSE.txt') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\tray-icon.ico') -Destination (Join-Path $target 'tray-icon.ico') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\icon-rounded.png') -Destination (Join-Path $target 'icon.png') -Force

  $serverFiles = @('manager.js', 'manager.html', 'typeless-dict-sync.js', 'package.json', 'package-lock.json')
  foreach ($file in $serverFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $target "server\$file") -Force
  }
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'icon\icon-rounded.png') -Destination (Join-Path $target 'server\icon.png') -Force
  Copy-Item -Path (Join-Path $sourceRoot 'lib\*') -Destination (Join-Path $target 'server\lib') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'node_modules') -Destination (Join-Path $target 'server\node_modules') -Recurse -Force

  Copy-Item -LiteralPath (Join-Path $sourceRoot 'config.example.json') -Destination (Join-Path $target 'data\config.json') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'accounts.example.json') -Destination (Join-Path $target 'data\accounts.example.json') -Force
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'accounts.example.json') -Destination (Join-Path $target 'data\accounts.json') -Force
}

function Assert-PublicData([string]$target) {
  $accountsPath = Join-Path $target 'data\accounts.json'
  $accounts = @(Get-Content -Raw -Encoding UTF8 $accountsPath | ConvertFrom-Json)
  if ($accounts.Count -ne 1 -or $accounts[0].email -ne 'account@example.com' -or $accounts[0].token -notmatch '^<') {
    throw "Public accounts.json is not sanitized: $accountsPath"
  }
  if (@(Get-ChildItem (Join-Path $target 'data\profiles') -Force).Count) {
    throw "Public profiles directory is not empty: $target"
  }
  foreach ($private in @('webview2-profile', 'chrome-profile', 'backups', 'config.local.json')) {
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
Assert-PublicData $liteTarget
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
$bundledVersion = (& (Join-Path $portableTarget 'runtime\node.exe') --version).Trim()
if ($bundledVersion -ne "v$nodeVersion") { throw "Portable Node.js version mismatch: $bundledVersion" }

Write-Host '[public] Compressing packages...'
Write-ArchiveAndHash $liteTarget $liteZip $liteSha
Write-ArchiveAndHash $portableTarget $portableZip $portableSha

Write-Host '[public] Complete:'
Write-Host "  Lite:     $liteZip"
Write-Host "  Portable: $portableZip"
