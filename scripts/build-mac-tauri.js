const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') throw new Error('Tauri macOS packages can only be built on macOS');

const projectRoot = path.join(__dirname, '..');
const buildConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'macos-build.json'), 'utf8'));
const packageManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const buildRoot = path.join(projectRoot, buildConfig.paths.buildRoot);
const serverDir = path.join(projectRoot, buildConfig.paths.bundleServer);
const tauriDir = path.join(projectRoot, buildConfig.paths.tauriDir);
const tauriCli = path.join(projectRoot, buildConfig.paths.tauriCli);
const distDir = path.join(projectRoot, buildConfig.paths.distDir);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function artifactName(arch, edition) {
  return buildConfig.artifactName
    .replace('{version}', packageManifest.version)
    .replace('{arch}', arch)
    .replace('{edition}', edition);
}

function selectedBuilds() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const nativeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return [{ arch: nativeArch, edition: 'portable' }];
  }
  if (args.length === 1 && args[0] === 'all') {
    return Object.keys(buildConfig.architectures).flatMap(arch =>
      buildConfig.editions.map(edition => ({ arch, edition })));
  }
  if (args.length !== 2 || !buildConfig.architectures[args[0]] || !buildConfig.editions.includes(args[1])) {
    throw new Error(`Usage: node scripts/build-mac-tauri.js [all|<${Object.keys(buildConfig.architectures).join('|')}> <${buildConfig.editions.join('|')}>]`);
  }
  return [{ arch: args[0], edition: args[1] }];
}

function preparePortableNode(arch, architecture) {
  run(process.execPath, [path.join(__dirname, 'fetch-mac-node.js'), arch]);
  const cacheDir = path.join(projectRoot, buildConfig.paths.nodeCache, `v${buildConfig.nodeVersion}`, arch);
  const sourceNode = path.join(cacheDir, 'node');
  const targetNode = path.join(projectRoot, `${buildConfig.paths.tauriBinaryBase}-${architecture.rustTarget}`);
  fs.mkdirSync(path.dirname(targetNode), { recursive: true });
  fs.copyFileSync(sourceNode, targetNode);
  fs.chmodSync(targetNode, 0o755);
  return cacheDir;
}

function writeBuildInfo(arch, edition) {
  const info = {
    version: packageManifest.version,
    arch,
    edition,
    bundledNodeVersion: edition === 'portable' ? buildConfig.nodeVersion : null,
    minimumSystemNodeVersion: edition === 'lite' ? buildConfig.minimumNodeVersion : null,
  };
  fs.writeFileSync(path.join(serverDir, 'toolkit-build.json'), `${JSON.stringify(info, null, 2)}\n`);
}

function writeMergeConfig(arch, edition, nodeCacheDir) {
  const resources = {
    [serverDir]: 'server',
  };
  if (edition === 'portable') {
    resources[path.join(nodeCacheDir, 'NODE-LICENSE.txt')] = 'node-runtime/NODE-LICENSE.txt';
    resources[path.join(nodeCacheDir, 'NODE-VERSION.txt')] = 'node-runtime/NODE-VERSION.txt';
  }
  const mergeConfig = {
    productName: buildConfig.productName,
    version: packageManifest.version,
    identifier: buildConfig.bundleIdentifier,
    bundle: {
      externalBin: edition === 'portable' ? ['binaries/node'] : [],
      resources,
    },
  };
  const configDir = path.join(buildRoot, 'tauri-config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, `${arch}-${edition}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(mergeConfig, null, 2)}\n`);
  return configPath;
}

function findBuiltDmg(target) {
  const dmgDir = path.join(tauriDir, 'target', target, 'release', 'bundle', 'dmg');
  const files = fs.existsSync(dmgDir)
    ? fs.readdirSync(dmgDir).filter(name => name.toLowerCase().endsWith('.dmg'))
    : [];
  if (files.length !== 1) throw new Error(`Expected one Tauri DMG in ${dmgDir}, found ${files.length}`);
  return path.join(dmgDir, files[0]);
}

if (!fs.existsSync(tauriCli)) throw new Error(`Tauri CLI is not installed: ${tauriCli}`);
if (!fs.existsSync(path.join(tauriDir, 'tauri.conf.json'))) throw new Error('Missing src-tauri/tauri.conf.json');

const builds = selectedBuilds();
run(process.execPath, [path.join(__dirname, 'prepare-tauri-bundle.js')]);
run('/usr/bin/swift', [path.join(projectRoot, buildConfig.paths.iconGenerator)]);
fs.mkdirSync(distDir, { recursive: true });

for (const { arch, edition } of builds) {
  const architecture = buildConfig.architectures[arch];
  run('rustup', ['target', 'add', architecture.rustTarget]);
  const dmgDir = path.join(tauriDir, 'target', architecture.rustTarget, 'release', 'bundle', 'dmg');
  fs.rmSync(dmgDir, { recursive: true, force: true });

  const nodeCacheDir = edition === 'portable' ? preparePortableNode(arch, architecture) : null;
  writeBuildInfo(arch, edition);
  const mergeConfig = writeMergeConfig(arch, edition, nodeCacheDir);
  console.log(`[macOS] Building ${arch} ${edition}...`);
  run(tauriCli, [
    'build',
    '--target', architecture.rustTarget,
    '--bundles', 'dmg',
    '--config', mergeConfig,
  ], {
    env: { ...process.env, TYPELESS_TOOLKIT_EDITION: edition },
  });

  const destination = path.join(distDir, artifactName(arch, edition));
  fs.rmSync(destination, { force: true });
  fs.copyFileSync(findBuiltDmg(architecture.rustTarget), destination);
  run(process.execPath, [path.join(__dirname, 'write-mac-checksum.js'), destination]);
  console.log(`[macOS] Built ${destination}`);
}
