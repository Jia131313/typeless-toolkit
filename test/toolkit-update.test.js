const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  assetNames,
  compareVersions,
  createToolkitUpdateController,
  downloadToFile,
  installationInfo,
  isSafeZipEntry,
  parseSha256File,
  releaseSummary,
  resolveWindowsPayloadRoot,
  validateWindowsPayload,
  validateZipEntryMetadata,
  validateZipMetadata,
  writeWindowsUpdateHelper,
} = require('../lib/toolkit-update');

const HASH = 'a'.repeat(64);

test('selects an update package that exactly matches the platform and Windows flavor', () => {
  assert.deepEqual(assetNames('1.6.3', 'win32', 'portable'), {
    archive: 'TypelessToolkit-v1.6.3-win-x64-portable.zip',
    checksum: 'TypelessToolkit-v1.6.3-win-x64-portable.zip.sha256.txt',
  });
  assert.deepEqual(assetNames('1.6.3', 'darwin'), {
    archive: 'Typeless-Toolkit-1.6.3-universal.dmg',
    checksum: 'Typeless-Toolkit-1.6.3-universal.dmg.sha256.txt',
  });
  assert.equal(assetNames('1.6.3', 'win32', 'unknown'), null);
  assert.equal(compareVersions('v1.6.10', '1.6.2'), 1);
  assert.equal(compareVersions('1.6.2', '1.6.2'), 0);
});

test('requires a checksum that names the selected release asset', () => {
  assert.equal(parseSha256File(`${HASH}  TypelessToolkit-v1.6.3-win-x64-lite.zip\n`, 'TypelessToolkit-v1.6.3-win-x64-lite.zip'), HASH);
  assert.throws(() => parseSha256File(`${HASH}  other.zip\n`, 'expected.zip'), /不匹配/);
  assert.throws(() => parseSha256File('not-a-hash expected.zip', 'expected.zip'), /格式无效/);
});

test('rejects archive paths that could escape the update staging directory', () => {
  assert.equal(isSafeZipEntry('server/lib/toolkit-update.js'), true);
  assert.equal(isSafeZipEntry('../data/accounts.json'), false);
  assert.equal(isSafeZipEntry('/Windows/System32/file'), false);
  assert.equal(isSafeZipEntry('C:\\Windows\\System32\\file'), false);
});

test('rejects oversized or suspicious ZIP entry metadata before extraction', () => {
  assert.doesNotThrow(() => validateZipEntryMetadata({ name: 'server/manager.js', length: 100, compressedLength: 50 }));
  assert.throws(() => validateZipEntryMetadata({ name: '../data/accounts.json', length: 1, compressedLength: 1 }), /不安全路径/);
  assert.throws(() => validateZipEntryMetadata({ name: 'big.bin', length: 513 * 1024 * 1024, compressedLength: 1 }), /大小超出上限/);
  assert.throws(() => validateZipEntryMetadata({ name: 'bomb.txt', length: 1000, compressedLength: 1 }), /压缩比例异常/);
  assert.throws(() => validateZipMetadata(Array.from({ length: 5001 }, (_, index) => ({ name: `file-${index}`, length: 0, compressedLength: 0 }))), /文件数量超出上限/);
  assert.throws(() => validateZipMetadata(Array.from({ length: 5 }, (_, index) => ({ name: `large-${index}.bin`, length: 512 * 1024 * 1024, compressedLength: 512 * 1024 * 1024 }))), /解压总大小超出上限/);
});

test('reports an update only when release assets and checksums are both present', () => {
  const names = assetNames('1.6.3', 'win32', 'portable');
  const release = {
    html_url: 'https://example.invalid/releases/v1.6.3',
    body: '## 新功能',
    assets: [
      { name: names.archive, browser_download_url: 'https://example.invalid/app.zip', size: 123 },
      { name: names.checksum, browser_download_url: 'https://example.invalid/app.sha256.txt' },
    ],
  };
  const state = releaseSummary(release, '1.6.3', '1.6.2', 'win32', 'portable');
  assert.equal(state.available, true);
  assert.equal(state.error, null);
  assert.equal(state.asset.name, names.archive);
});

test('checks the GitHub latest-release response without downloading an asset', async () => {
  const names = assetNames('1.6.3', 'win32', 'portable');
  const controller = createToolkitUpdateController({
    platform: 'win32', currentVersion: '1.6.2', flavor: 'portable', backendOwned: true,
    fetchFn: async url => {
      assert.match(url, /\/releases\/latest$/);
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.6.3', html_url: 'https://example.invalid/r', body: 'notes', assets: [
            { name: names.archive, browser_download_url: 'https://example.invalid/app.zip' },
            { name: names.checksum, browser_download_url: 'https://example.invalid/app.sha256.txt' },
          ],
        }),
      };
    },
  });
  const state = await controller.check();
  assert.equal(state.state, 'available');
  assert.equal(state.available, true);
  assert.equal(state.version, '1.6.3');
});

test('reused Windows backend is explicitly manual-update only', async () => {
  const names = assetNames('1.6.3', 'win32', 'portable');
  const controller = createToolkitUpdateController({
    platform: 'win32', currentVersion: '1.6.2', flavor: 'portable', backendOwned: false,
    fetchFn: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.6.3', assets: [
      { name: names.archive, browser_download_url: 'https://example.invalid/app.zip' },
      { name: names.checksum, browser_download_url: 'https://example.invalid/app.sha256.txt' },
    ] }) }),
  });
  const state = await controller.check();
  assert.equal(state.state, 'manual-only');
  assert.equal(state.update.manual_only, true);
  assert.match(state.update.error, /复用了已有本地服务/);
});

test('downloads an update to staging and verifies SHA-256 before exposing it', async t => {
  const version = '1.6.3';
  const names = assetNames(version, 'darwin');
  const payload = Buffer.from('verified-dmg-fixture');
  const checksum = crypto.createHash('sha256').update(payload).digest('hex');
  const controller = createToolkitUpdateController({
    platform: 'darwin', currentVersion: '1.6.2',
    fetchFn: async url => {
      if (url.includes('/releases/latest')) return {
        ok: true,
        json: async () => ({ tag_name: `v${version}`, body: 'notes', assets: [
          { name: names.archive, browser_download_url: 'https://example.invalid/toolkit.dmg' },
          { name: names.checksum, browser_download_url: 'https://example.invalid/toolkit.dmg.sha256.txt' },
        ] }),
      };
      if (url.endsWith('.sha256.txt')) return { ok: true, text: async () => `${checksum}  ${names.archive}\n` };
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    },
  });
  t.after(() => {
    const download = controller.status().download_path;
    if (download) fs.rmSync(path.dirname(download), { recursive: true, force: true });
  });
  await controller.check();
  const state = await controller.download();
  assert.equal(state.state, 'downloaded');
  assert.equal(fs.readFileSync(state.download_path).toString(), payload.toString());
  const stage = state.stage_dir;
  controller.cleanupStaging();
  assert.equal(fs.existsSync(stage), false);
});

test('macOS IPC only opens a regular DMG in the exact updater staging directory', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron-main.js'), 'utf8');
  assert.match(source, /fs\.lstatSync\(target\)/);
  assert.match(source, /fs\.realpathSync\(os\.tmpdir\(\)\)/);
  assert.match(source, /path\.dirname\(realStage\) !== realTemp/);
  assert.match(source, /path\.basename\(realStage\)\.startsWith\('typeless-toolkit-update-'\)/);
});

test('accepts the single top-level directory produced by the public Windows ZIP', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-payload-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'TypelessToolkit-v1.6.3-win-x64-portable');
  fs.mkdirSync(path.join(payload, 'server'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'TypelessToolkit.exe'), 'launcher');
  fs.writeFileSync(path.join(payload, 'server', 'manager.js'), 'server');
  assert.equal(resolveWindowsPayloadRoot(root), payload);
});

function makeWindowsInstall(root, version = '1.6.3', edition = 'portable') {
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'TypelessToolkit.exe'), 'launcher');
  fs.writeFileSync(path.join(root, 'server', 'manager.js'), 'server');
  fs.writeFileSync(path.join(root, 'server', 'package.json'), JSON.stringify({ version }));
  if (edition === 'portable') {
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', 'node.exe'), 'node');
  }
}

test('requires a standard Windows release root and derives its edition from the runtime', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeWindowsInstall(root);
  assert.deepEqual(installationInfo(path.join(root, 'server'), path.join(root, 'data')), {
    ok: true, install_dir: root, edition: 'portable', error: null,
  });
  assert.equal(installationInfo(root, path.join(root, 'data')).ok, false);
  fs.rmSync(path.join(root, 'runtime'), { recursive: true });
  assert.equal(installationInfo(path.join(root, 'server'), path.join(root, 'data')).edition, 'lite');
});

test('requires the target version and matching Portable/Lite payload structure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-payload-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makeWindowsInstall(root, '1.6.3', 'portable');
  assert.doesNotThrow(() => validateWindowsPayload(root, '1.6.3', 'portable'));
  assert.throws(() => validateWindowsPayload(root, '1.6.4', 'portable'), /版本与目标/);
  assert.throws(() => validateWindowsPayload(root, '1.6.3', 'lite'), /包含内置 Node/);
  fs.rmSync(path.join(root, 'runtime'), { recursive: true });
  assert.throws(() => validateWindowsPayload(root, '1.6.3', 'portable'), /缺少内置 Node/);
});

test('removes a partially downloaded file when its stream fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-download-test-'));
  const output = path.join(dir, 'failed.bin');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('partial')); controller.error(new Error('network lost')); },
  });
  await assert.rejects(downloadToFile('https://example.invalid/file', output, {
    fetchFn: async () => ({ ok: true, headers: { get: () => null }, body }),
  }), /network lost/);
  assert.equal(fs.existsSync(output), false);
});

test('Windows replacement helper uses one temporary rollback and never copies release data over it', t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-helper-test-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const helper = writeWindowsUpdateHelper(stage);
  const source = fs.readFileSync(helper, 'utf8');
  assert.match(source, /\[int\]\$HostPid/);
  assert.match(source, /Get-Process -Id \$HostPid/);
  assert.match(source, /\[string\]\$StageDir/);
  assert.match(source, /\[string\]\$RollbackDir/);
  assert.match(source, /\[string\]\$ReadyPath/);
  assert.match(source, /Move-Item -LiteralPath/);
  assert.match(source, /\$oldMoveCompleted = \$false/);
  assert.match(source, /\$replacementStarted = \$false/);
  assert.match(source, /\$oldMoveCompleted = \$true\s+\$replacementStarted = \$true/);
  assert.match(source, /if \(\$oldMoveCompleted -and \$replacementStarted\) \{\s+Get-ChildItem -LiteralPath \$install/);
  assert.match(source, /Start-Process -FilePath \$RestartExe .*--toolkit-update-ready/);
  assert.match(source, /while \(!\(Test-Path -LiteralPath \$ready\)\)/);
  assert.match(source, /Get-Content -LiteralPath \$ready -Raw/);
  assert.doesNotMatch(source, /Start-Sleep -Seconds 4/);
  assert.match(source, /Write-Result 'rolled-back'/);
  assert.match(source, /rmdir \/s \/q/);
  assert.match(source, /Name -ne 'data'/);
  assert.match(source, /Where-Object \{ \$_\.Name -ne 'data' \}/);
});

test('desktop ready handshake verifies the running backend version before writing a stage marker', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'manager.js'), 'utf8');
  const desktop = fs.readFileSync(path.join(__dirname, '..', 'main.cs'), 'utf8');
  const updater = fs.readFileSync(path.join(__dirname, '..', 'lib', 'toolkit-update.js'), 'utf8');
  assert.match(manager, /toolkit_version: TOOLKIT_VERSION/);
  assert.match(manager, /code_root: C\.CODE_DIR/);
  assert.match(desktop, /--toolkit-update-ready/);
  assert.match(desktop, /SignalUpdateReady\(\)/);
  assert.match(desktop, /ProbeToolkit\(updateTargetVersion\)/);
  assert.match(desktop, /File\.WriteAllText\(updateReadyPath, updateTargetVersion/);
  assert.match(updater, /fs\.rmSync\(extractionDir, \{ recursive: true, force: true \}\)/);
});
