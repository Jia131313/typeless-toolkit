const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('macOS Node runtime can only be prepared on macOS');

const projectRoot = path.join(__dirname, '..');
const buildConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'macos-build.json'), 'utf8'));
const requestedArch = process.argv[2];
const architecture = buildConfig.architectures[requestedArch];
if (!architecture) {
  throw new Error(`Usage: node scripts/fetch-mac-node.js <${Object.keys(buildConfig.architectures).join('|')}>`);
}

const version = buildConfig.nodeVersion;
const distributionName = `node-v${version}-darwin-${architecture.nodeArch}`;
const cacheDir = path.join(projectRoot, buildConfig.paths.nodeCache, `v${version}`, requestedArch);
const nodePath = path.join(cacheDir, 'node');
const licensePath = path.join(cacheDir, 'NODE-LICENSE.txt');
const versionPath = path.join(cacheDir, 'NODE-VERSION.txt');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  return (result.stdout || '').trim();
}

function verifyRuntime() {
  if (!fs.existsSync(nodePath) || !fs.existsSync(licensePath) || !fs.existsSync(versionPath)) return false;
  const arches = run('/usr/bin/lipo', ['-archs', nodePath]).split(/\s+/);
  if (!arches.includes(architecture.binaryArch)) return false;
  const recorded = fs.readFileSync(versionPath, 'utf8').trim();
  if (recorded !== `Node.js v${version} (darwin-${architecture.nodeArch})`) return false;
  if (process.arch === requestedArch) {
    const runtimeVersion = run(nodePath, ['--version']);
    if (runtimeVersion !== `v${version}`) return false;
  }
  return true;
}

if (!verifyRuntime()) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, `${distributionName}.tar.gz`);
  const extractDir = path.join(cacheDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  const url = `https://nodejs.org/dist/v${version}/${distributionName}.tar.gz`;
  run('/usr/bin/curl', ['--fail', '--location', '--output', archivePath, url], { stdio: 'inherit' });
  run('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir]);

  const distributionDir = path.join(extractDir, distributionName);
  fs.copyFileSync(path.join(distributionDir, 'bin', 'node'), nodePath);
  fs.chmodSync(nodePath, 0o755);
  fs.copyFileSync(path.join(distributionDir, 'LICENSE'), licensePath);
  fs.writeFileSync(versionPath, `Node.js v${version} (darwin-${architecture.nodeArch})\n`, 'ascii');
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
}

if (!verifyRuntime()) throw new Error(`Prepared Node.js runtime did not pass version/architecture validation: ${nodePath}`);
console.log(nodePath);
