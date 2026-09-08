const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const artifactPath = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-release-package.js <release.zip|release.dmg>');
if (!fs.existsSync(artifactPath)) throw new Error(`Release artifact not found: ${artifactPath}`);

function artifactVersion(filePath) {
  const match = path.basename(filePath).match(/(?:^|[-_])v?(\d+(?:\.\d+){2,3})(?=[-_.]|$)/i);
  if (!match) throw new Error(`Cannot determine release version from artifact name: ${path.basename(filePath)}`);
  return match[1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
  return (result.stdout || '').trim();
}

function assertSanitizedData(dataDir) {
  const accountsPath = path.join(dataDir, 'accounts.json');
  assert.equal(fs.existsSync(accountsPath), true, 'Public package is missing data/accounts.json.');
  assert.deepEqual(JSON.parse(fs.readFileSync(accountsPath, 'utf8')), [], 'Public accounts.json is not empty.');
  const profilesDir = path.join(dataDir, 'profiles');
  assert.equal(fs.existsSync(profilesDir), true, 'Public package is missing data/profiles/.');
  assert.deepEqual(fs.readdirSync(profilesDir), [], 'Public profiles directory is not empty.');
  const forbidden = new Set([
    'config.local.json', 'account-sync.json', 'account-sync-tombstones.json',
    'webview2-profile', 'chrome-profile', 'backups',
  ]);
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    assert.equal(forbidden.has(entry.name), false, `Private data leaked into release package: data/${entry.name}`);
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: route, timeout: 1500 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        contentType: response.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('timeout', () => request.destroy(new Error(`Request timed out: ${route}`)));
    request.on('error', reject);
  });
}

async function waitForServer(port, child, output, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged manager exited before becoming ready (${child.exitCode}).\n${output.text}`);
    }
    try {
      const response = await request(port, '/api/env');
      if (response.statusCode === 200) return response;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Packaged manager did not become ready in ${timeoutMs / 1000}s: ${lastError?.message || 'unknown error'}\n${output.text}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function isolatedEnvironment(tempRoot, port) {
  const dataDir = path.join(tempRoot, '隔离 data');
  const userDataDir = path.join(tempRoot, 'Typeless 用户数据');
  const deviceCacheDir = path.join(tempRoot, '设备 cache');
  const missingTypeless = path.join(tempRoot, '不存在 Typeless', process.platform === 'win32' ? 'Typeless.exe' : 'Typeless');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(deviceCacheDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify({
    typeless_exe: missingTypeless,
    userdata_dir: userDataDir,
    device_cache_dir: deviceCacheDir,
    manager_port: port,
  }, null, 2)}\n`);
  return {
    dataDir,
    env: {
      ...process.env,
      TYPELESS_DATA_DIR: dataDir,
      TYPELESS_EXE: missingTypeless,
      TYPELESS_MANAGER_PORT: String(port),
    },
  };
}

async function smokeManager({ executable, args, cwd, environment, version }) {
  const port = Number(environment.env.TYPELESS_MANAGER_PORT);
  const output = { text: '' };
  const child = spawn(executable, args, {
    cwd, env: environment.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = chunk => { output.text = (output.text + chunk.toString()).slice(-16000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  try {
    const envResponse = await waitForServer(port, child, output);
    const envPayload = JSON.parse(envResponse.body);
    assert.equal(envPayload.status, 'OK');
    assert.equal(envPayload.data.service, 'typeless-toolkit');
    assert.equal(envPayload.data.manager_port, port);
    assert.equal(path.resolve(envPayload.data.data_root), path.resolve(environment.dataDir));
    if (envPayload.data.toolkit_version !== undefined) {
      assert.equal(envPayload.data.toolkit_version, version);
    }

    const current = await request(port, '/api/current');
    assert.equal(current.statusCode, 200);
    const currentPayload = JSON.parse(current.body);
    assert.equal(currentPayload.status, 'FAIL', 'Fresh isolated data unexpectedly exposed a current account.');

    const home = await request(port, '/');
    assert.equal(home.statusCode, 200);
    assert.match(home.contentType, /^text\/html/i);
    assert.match(home.body, /Typeless/);
  } finally {
    await stopChild(child);
  }
}

async function testWindowsZip(version) {
  assert.equal(process.platform, 'win32', 'Windows ZIP smoke test must run on Windows.');
  const flavorMatch = path.basename(artifactPath).match(/-(lite|portable)\.zip$/i);
  assert.ok(flavorMatch, 'Windows artifact name must end in -lite.zip or -portable.zip.');
  const flavor = flavorMatch[1].toLowerCase();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Typeless 发布包冒烟 '));
  const extractionDir = path.join(tempRoot, '解压 目录');
  fs.mkdirSync(extractionDir, { recursive: true });
  try {
    const { safeExtractZipWindows, resolveWindowsPayloadRoot } = require('../lib/toolkit-update');
    safeExtractZipWindows(artifactPath, extractionDir);
    const payloadRoot = resolveWindowsPayloadRoot(extractionDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'server', 'package.json'), 'utf8'));
    assert.equal(manifest.version, version, 'ZIP package version does not match its artifact name.');
    assertSanitizedData(path.join(payloadRoot, 'data'));
    const bundledNode = path.join(payloadRoot, 'runtime', 'node.exe');
    assert.equal(fs.existsSync(bundledNode), flavor === 'portable', `${flavor} package has the wrong Node.js layout.`);

    const port = await freePort();
    const environment = isolatedEnvironment(tempRoot, port);
    const nodeExecutable = flavor === 'portable' ? bundledNode : process.execPath;
    await smokeManager({
      executable: nodeExecutable,
      args: [path.join(payloadRoot, 'server', 'manager.js')],
      cwd: path.join(payloadRoot, 'server'),
      environment,
      version,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function findAppBundle(mountPoint) {
  const queue = [mountPoint];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.app')) return absolute;
      if (entry.isDirectory()) queue.push(absolute);
    }
  }
  throw new Error('Mounted DMG does not contain an App bundle.');
}

function inspectMacAsar(electronExecutable, asarPath) {
  const expression = `const fs=require('fs'),p=require('path'),r=${JSON.stringify(asarPath)};` +
    `process.stdout.write(JSON.stringify({version:require(p.join(r,'package.json')).version,` +
    `accounts:fs.existsSync(p.join(r,'accounts.json')),profiles:fs.existsSync(p.join(r,'profiles')),` +
    `privateFiles:['config.local.json','account-sync.json','account-sync-tombstones.json'].filter(x=>fs.existsSync(p.join(r,x)))}));`;
  const output = run(electronExecutable, ['-e', expression], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15000,
  });
  return JSON.parse(output);
}

async function testMacDmg(version) {
  assert.equal(process.platform, 'darwin', 'macOS DMG smoke test must run on macOS.');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Typeless 发布包冒烟 '));
  const mountPoint = path.join(tempRoot, '只读 挂载点');
  fs.mkdirSync(mountPoint, { recursive: true });
  let mounted = false;
  try {
    run('/usr/bin/hdiutil', ['attach', artifactPath, '-readonly', '-nobrowse', '-mountpoint', mountPoint], { timeout: 30000 });
    mounted = true;
    const appBundle = findAppBundle(mountPoint);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { timeout: 30000 });
    const electronExecutable = path.join(appBundle, 'Contents', 'MacOS', path.basename(appBundle, '.app'));
    const asarPath = path.join(appBundle, 'Contents', 'Resources', 'app.asar');
    assert.equal(fs.existsSync(electronExecutable), true, 'App bundle is missing its Electron executable.');
    assert.equal(fs.existsSync(asarPath), true, 'App bundle is missing Resources/app.asar.');
    const packaged = inspectMacAsar(electronExecutable, asarPath);
    assert.equal(packaged.version, version, 'DMG package version does not match its artifact name.');
    assert.equal(packaged.accounts, false, 'macOS app bundle unexpectedly contains accounts.json.');
    assert.equal(packaged.profiles, false, 'macOS app bundle unexpectedly contains profiles/.');
    assert.deepEqual(packaged.privateFiles, [], 'macOS app bundle contains private synchronization configuration.');

    const port = await freePort();
    const environment = isolatedEnvironment(tempRoot, port);
    environment.env.ELECTRON_RUN_AS_NODE = '1';
    await smokeManager({
      executable: electronExecutable,
      args: [path.join(asarPath, 'manager.js')],
      cwd: path.dirname(asarPath),
      environment,
      version,
    });
  } finally {
    if (mounted) {
      try { run('/usr/bin/hdiutil', ['detach', mountPoint], { timeout: 30000 }); } catch (error) {
        run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { timeout: 30000 });
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const version = artifactVersion(artifactPath);
  const extension = path.extname(artifactPath).toLowerCase();
  if (extension === '.zip') await testWindowsZip(version);
  else if (extension === '.dmg') await testMacDmg(version);
  else throw new Error(`Unsupported release artifact: ${path.basename(artifactPath)}`);
  console.log(`Release package smoke test passed: ${path.basename(artifactPath)} (headless manager/API verification).`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
