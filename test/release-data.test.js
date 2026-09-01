const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicBuild = fs.readFileSync(path.join(root, 'build-public-release.ps1'), 'utf8');
const localBuild = fs.readFileSync(path.join(root, 'build-release.bat'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('release version is consistent across packages, launchers, scripts, and docs', () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const manifest = fs.readFileSync(path.join(root, 'app.manifest'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'main.cs'), 'utf8');
  assert.equal(version, '1.6.2');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.match(publicBuild, new RegExp(`publicVersion = '${version.replaceAll('.', '\\.')}'`));
  assert.match(localBuild, new RegExp(`TypelessToolkit-v${version.replaceAll('.', '\\.')}`));
  assert.match(manifest, new RegExp(`version="${version.replaceAll('.', '\\.')}\\.0"`));
  assert.match(host, new RegExp(`AssemblyInformationalVersion\\("${version.replaceAll('.', '\\.')}"\\)`));
  assert.match(readme, new RegExp(`TypelessToolkit-v${version.replaceAll('.', '\\.')}.*portable`));
});

test('public packages start with an empty account list', () => {
  assert.match(publicBuild, /WriteAllText\([^\n]*accountsPath[\s\S]*?'\[\]'/);
  assert.match(publicBuild, /accountsJson\.Trim\(\)\s+-ne\s+'\[\]'/);
  assert.doesNotMatch(publicBuild, /accounts\[0\]\.email/);
});

test('local release initializes only missing account data as empty', () => {
  assert.match(localBuild, /if not exist "%RELEASE%\\data\\accounts\.json" echo \[\]/i);
  assert.doesNotMatch(localBuild, /if not exist[^\r\n]+accounts\.example\.json[^\r\n]+accounts\.json/i);
});

test('release documentation describes empty first-run data', () => {
  assert.match(readme, /公开包[^。]*空账号列表/);
  assert.doesNotMatch(readme, /公开包[^。]*示例账号/);
});
