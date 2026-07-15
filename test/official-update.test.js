const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  compareVersions,
  findPendingUpdate,
  pendingVersionFromFileName,
  sha512Base64,
} = require('../lib/official-update');

test('compares dotted Typeless versions numerically', () => {
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('2.0.10', '2.0.9'), 1);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
});

test('extracts a version only from supported official package names', () => {
  assert.equal(pendingVersionFromFileName('Typeless-2.0.1-arm64.zip'), '2.0.1');
  assert.equal(pendingVersionFromFileName('Typeless-2.1.0-universal.zip'), '2.1.0');
  assert.equal(pendingVersionFromFileName('../Typeless-2.0.1-arm64.zip'), null);
  assert.equal(pendingVersionFromFileName('Other-2.0.1-arm64.zip'), null);
});

test('finds a pending update and verifies its SHA-512 representation', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-update-test-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const pendingDir = path.join(homeDir, 'Library', 'Caches', 'typeless-updater', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const packagePath = path.join(pendingDir, 'Typeless-2.0.1-arm64.zip');
  fs.writeFileSync(packagePath, 'official-update-fixture');
  const sha512 = crypto.createHash('sha512').update('official-update-fixture').digest('base64');
  fs.writeFileSync(path.join(pendingDir, 'update-info.json'), JSON.stringify({
    fileName: 'Typeless-2.0.1-arm64.zip',
    sha512,
  }));

  const pending = findPendingUpdate(homeDir);
  assert.equal(pending.version, '2.0.1');
  assert.equal(pending.packagePath, packagePath);
  assert.equal(sha512Base64(packagePath), sha512);
});
