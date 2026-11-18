const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicBuild = fs.readFileSync(path.join(root, 'build', 'build-public-release.ps1'), 'utf8');
const localBuild = fs.readFileSync(path.join(root, 'build', 'build-release.bat'), 'utf8');
// 默认 README.md 已改为简体中文，英文版保留在 README.en.md；脱敏说明两处都要在
const readme = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');
const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const releaseGuide = fs.readFileSync(path.join(root, '.github', 'release-guide.md'), 'utf8');
const { releaseContent } = require('../scripts/prepare-release-notes');

test('release version is consistent across packages, launchers, and scripts', () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const manifest = fs.readFileSync(path.join(root, 'windows', 'app.manifest'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'windows', 'main.cs'), 'utf8');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  // 构建脚本已移入 build/，$sourceRoot 指向仓库根，package.json 从根目录读取
  assert.match(publicBuild, /\$publicVersion\s*=\s*\(Get-Content\s+-Raw\s+-Encoding\s+UTF8\s+\(Join-Path\s+\$sourceRoot\s+'package\.json'\)\s*\|\s*ConvertFrom-Json\)\.version/);
  assert.match(localBuild, new RegExp(`TypelessToolkit-v${version.replaceAll('.', '\\.')}`));
  assert.match(manifest, new RegExp(`version="${version.replaceAll('.', '\\.')}\\.0"`));
  assert.match(host, new RegExp(`AssemblyVersion\\("${version.replaceAll('.', '\\.')}\\.0"\\)`));
  assert.match(host, new RegExp(`AssemblyFileVersion\\("${version.replaceAll('.', '\\.')}\\.0"\\)`));
  assert.match(host, new RegExp(`AssemblyInformationalVersion\\("${version.replaceAll('.', '\\.')}"\\)`));
});

test('public packages start with an empty account list', () => {
  assert.match(publicBuild, /WriteAllText\([^\n]*accountsPath[\s\S]*?'\[\]'/);
  assert.match(publicBuild, /accountsJson\.Trim\(\)\s+-ne\s+'\[\]'/);
  assert.doesNotMatch(publicBuild, /accounts\[0\]\.email/);
  assert.match(publicBuild, /account-sync\.json/);
  assert.match(publicBuild, /account-sync-tombstones\.json/);
});

test('local release initializes only missing account data as empty', () => {
  assert.match(localBuild, /if not exist "%RELEASE%\\data\\accounts\.json" echo \[\]/i);
  assert.doesNotMatch(localBuild, /if not exist[^\r\n]+accounts\.example\.json[^\r\n]+accounts\.json/i);
});

test('release documentation describes empty first-run data', () => {
  // 主 README 是英文版：公开包以空账号列表起步
  assert.match(readme, /empty account list/i);
  assert.doesNotMatch(readme, /sample accounts?\b/i);
  // 中文版同步维护同一说明
  assert.match(readmeZh, /公开包[^。]*空账号列表/);
  assert.doesNotMatch(readmeZh, /公开包[^。]*示例账号/);
});

test('release notes guide users to the correct downloads and safe upgrade path', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const content = releaseContent('1.6.2', changelog, releaseGuide);
  assert.equal(content.title, 'v1.6.2 - 引导旧账号更新长期凭证');
  assert.match(content.notes, /TypelessToolkit-v1\.6\.2-win-x64-portable\.zip/);
  assert.match(content.notes, /TypelessToolkit-v1\.6\.2-win-x64-lite\.zip/);
  assert.match(content.notes, /Typeless-Toolkit-1\.6\.2-mac-arm64-portable\.dmg/);
  assert.match(content.notes, /Typeless-Toolkit-1\.6\.2-mac-x64-lite\.dmg/);
  assert.match(content.notes, /不要用公开包内的空 `data\/` 覆盖自己的旧数据/);
  assert.match(content.notes, /替换 App 本体不会删除账号、快照、词库或配置/);
  assert.match(releaseWorkflow, /node scripts\/prepare-release-notes\.js/);
});
