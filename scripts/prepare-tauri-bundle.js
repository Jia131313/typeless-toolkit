const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const buildConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'macos-build.json'), 'utf8'));
const serverDir = path.join(projectRoot, buildConfig.paths.bundleServer);

function copy(source, destination) {
  fs.cpSync(path.join(projectRoot, source), path.join(serverDir, destination), {
    recursive: true,
    force: true,
  });
}

fs.rmSync(serverDir, { recursive: true, force: true });
fs.mkdirSync(serverDir, { recursive: true });

for (const file of buildConfig.serverFiles) copy(file, file);
copy('lib', 'lib');
copy('assets/icon-rounded.png', 'icon.png');
copy('config.example.json', 'config.json');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCommand, [
  'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
], {
  cwd: serverDir,
  encoding: 'utf8',
  stdio: 'inherit',
});
if (install.error) throw install.error;
if (install.status !== 0) throw new Error(`macOS bundle dependencies installation failed (${install.status})`);

for (const name of buildConfig.privateDataNames) {
  if (fs.existsSync(path.join(serverDir, name))) {
    throw new Error(`Private data must not enter macOS bundle staging: ${name}`);
  }
}
for (const name of ['electron', 'electron-builder', 'app-builder-lib']) {
  if (fs.existsSync(path.join(serverDir, 'node_modules', name))) {
    throw new Error(`Electron dependency entered Tauri bundle staging: ${name}`);
  }
}

console.log(`[macOS] Prepared public server bundle: ${serverDir}`);
