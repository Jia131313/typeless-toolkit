const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const buildConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'macos-build.json'), 'utf8'));
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const firstArgument = process.argv[2];
let filePath;
if (firstArgument && firstArgument.toLowerCase().endsWith('.dmg')) {
  filePath = path.resolve(firstArgument);
} else {
  const arch = firstArgument || (process.arch === 'arm64' ? 'arm64' : 'x64');
  const edition = process.argv[3] || 'portable';
  if (!buildConfig.architectures[arch] || !buildConfig.editions.includes(edition)) {
    throw new Error(`Usage: node scripts/write-mac-checksum.js [dmg-path|<arch> <edition>]`);
  }
  const fileName = buildConfig.artifactName
    .replace('{version}', version)
    .replace('{arch}', arch)
    .replace('{edition}', edition);
  filePath = path.join(projectRoot, buildConfig.paths.distDir, fileName);
}
const fileName = path.basename(filePath);
const checksumPath = `${filePath}.sha256.txt`;

if (!fs.existsSync(filePath)) throw new Error(`找不到 macOS 发布包: ${filePath}`);

const hash = crypto.createHash('sha256');
const fd = fs.openSync(filePath, 'r');
const buffer = Buffer.alloc(1024 * 1024);
try {
  let bytesRead;
  do {
    bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
  } while (bytesRead);
} finally {
  fs.closeSync(fd);
}

const digest = hash.digest('hex');
fs.writeFileSync(checksumPath, `${digest}  ${fileName}\n`, { encoding: 'ascii', mode: 0o600 });
console.log(`[macOS] ${fileName} SHA256 ${digest}`);
