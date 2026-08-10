const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  platform,
  appBundleForExecutable,
  appBundleProcessPattern,
  macLaunchArgs,
} = require('../lib/platform');

function createSignedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-signing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Fixture.app');
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const frameworks = path.join(contents, 'Frameworks');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(frameworks, { recursive: true });

  const exe = path.join(macos, 'Fixture');
  fs.copyFileSync('/usr/bin/true', exe);
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Fixture</string>
  <key>CFBundleIdentifier</key><string>com.typeless-toolkit.signing-fixture</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>`);

  const electronFramework = path.join(frameworks, 'Electron Framework.framework');
  const frameworkVersion = path.join(electronFramework, 'Versions', 'A');
  const frameworkResources = path.join(frameworkVersion, 'Resources');
  fs.mkdirSync(frameworkResources, { recursive: true });
  const frameworkBinary = path.join(frameworkVersion, 'Electron Framework');
  fs.copyFileSync('/usr/bin/true', frameworkBinary);
  fs.chmodSync(frameworkBinary, 0o755);
  fs.writeFileSync(path.join(frameworkResources, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Electron Framework</string>
  <key>CFBundleIdentifier</key><string>com.typeless-toolkit.fixture-framework</string>
  <key>CFBundleName</key><string>Electron Framework</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  const frameworkState = path.join(frameworkResources, 'state.txt');
  fs.writeFileSync(frameworkState, 'original');
  fs.symlinkSync('A', path.join(electronFramework, 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(electronFramework, 'Electron Framework'));
  fs.symlinkSync('Versions/Current/Resources', path.join(electronFramework, 'Resources'));

  const helperApp = path.join(frameworks, 'Fixture Helper.app');
  const helperContents = path.join(helperApp, 'Contents');
  const helperMacos = path.join(helperContents, 'MacOS');
  fs.mkdirSync(helperMacos, { recursive: true });
  const helperExe = path.join(helperMacos, 'Fixture Helper');
  fs.copyFileSync('/usr/bin/true', helperExe);
  fs.chmodSync(helperExe, 0o755);
  fs.writeFileSync(path.join(helperContents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Fixture Helper</string>
  <key>CFBundleIdentifier</key><string>com.typeless-toolkit.fixture-helper</string>
  <key>CFBundleName</key><string>Fixture Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  const entitlements = path.join(root, 'entitlements.plist');
  fs.writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>`);
  fs.writeFileSync(path.join(resources, 'state.txt'), 'original');
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--options', 'runtime', electronFramework,
  ], { stdio: 'ignore' });
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--options', 'runtime', helperApp,
  ], { stdio: 'ignore' });
  execFileSync('/usr/bin/codesign', [
    '--force', '--sign', '-', '--identifier', 'com.typeless-toolkit.signing-fixture',
    '--options', 'runtime', '--entitlements', entitlements, app,
  ], { stdio: 'ignore' });
  return { root, app, exe, resources, electronFramework, frameworkBinary, frameworkState, helperApp };
}

function codeDirectoryHash(codePath) {
  const details = spawnSync('/usr/bin/codesign', ['-dvvv', codePath], { encoding: 'utf8' });
  const text = `${details.stdout || ''}\n${details.stderr || ''}`;
  const match = text.match(/CDHash=([a-f0-9]+)/i);
  assert.ok(match, `missing CDHash for ${codePath}`);
  return match[1];
}

test('derives the app bundle from its main executable', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(
    appBundleForExecutable('/Applications/Typeless.app/Contents/MacOS/Typeless'),
    '/Applications/Typeless.app',
  );
  assert.equal(
    appBundleProcessPattern('/Users/test/Applications/Typeless Preview.app/Contents/MacOS/Typeless'),
    '/Users/test/Applications/Typeless Preview.app/',
  );
  assert.deepEqual(macLaunchArgs(9222, '/tmp/custom Typeless data'), [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/custom Typeless data',
  ]);
});

test('macOS re-signing preserves identifier, entitlements, and hardened runtime', { skip: process.platform !== 'darwin' }, t => {
  const fixture = createSignedFixture(t);
  fs.writeFileSync(path.join(fixture.resources, 'state.txt'), 'patched');
  fs.writeFileSync(fixture.frameworkState, 'patched');
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;fixture;Codex;', fixture.app]);
  const helperHashBefore = codeDirectoryHash(fixture.helperApp);

  const result = platform.resignApp(fixture.exe);
  assert.equal(result.done, true);
  assert.equal(result.verified, true);
  assert.equal(result.quarantine_removed, true);
  assert.equal(result.framework_resigned, true);

  const details = spawnSync('/usr/bin/codesign', ['-dvv', fixture.app], { encoding: 'utf8' });
  const detailText = `${details.stdout || ''}\n${details.stderr || ''}`;
  assert.match(detailText, /Identifier=com\.typeless-toolkit\.signing-fixture/);
  assert.match(detailText, /Runtime Version=/);

  const entitlements = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', fixture.app], { encoding: 'utf8' });
  const entitlementText = `${entitlements.stdout || ''}\n${entitlements.stderr || ''}`;
  assert.match(entitlementText, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlementText, /com\.apple\.security\.cs\.disable-library-validation/);
  assert.match(entitlementText, /com\.apple\.security\.device\.audio-input/);
  assert.equal(codeDirectoryHash(fixture.helperApp), helperHashBefore);
  const quarantine = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', fixture.app], { encoding: 'utf8' });
  assert.notEqual(quarantine.status, 0);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.app], { stdio: 'ignore' });
});

test('macOS full-app backup restores resources and a valid signature', { skip: process.platform !== 'darwin' }, t => {
  const fixture = createSignedFixture(t);
  const backup = platform.backupApp(fixture.exe, path.join(fixture.root, 'backup'));
  assert.equal(backup.source, fixture.app);
  assert.match(backup.app, /\.app\.backup$/);
  assert.equal(backup.app.startsWith(fixture.app + path.sep), false);

  fs.writeFileSync(path.join(fixture.resources, 'state.txt'), 'broken');
  platform.resignApp(fixture.exe);
  const restored = platform.restoreApp(fixture.exe, backup.app);

  assert.equal(restored.restored, true);
  assert.equal(fs.readFileSync(path.join(fixture.resources, 'state.txt'), 'utf8'), 'original');
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', fixture.app], { stdio: 'ignore' });
});
