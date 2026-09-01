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
  isSafeZipEntry,
  parseSha256File,
  releaseSummary,
  resolveWindowsPayloadRoot,
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
    platform: 'win32', currentVersion: '1.6.2', flavor: 'portable',
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

test('Windows replacement helper preserves data and never copies release data over it', t => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-helper-test-'));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const helper = writeWindowsUpdateHelper(stage);
  const source = fs.readFileSync(helper, 'utf8');
  assert.match(source, /\[int\]\$HostPid/);
  assert.match(source, /Get-Process -Id \$HostPid/);
  assert.match(source, /\[string\]\$StageDir/);
  assert.match(source, /rmdir \/s \/q/);
  assert.match(source, /Name -ne 'data'/);
  assert.match(source, /Where-Object \{ \$_\.Name -ne 'data' \}/);
});
