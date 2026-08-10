const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const arch = process.argv[2] || process.arch;
const fileName = `Typeless-Toolkit-${version}-${arch}.dmg`;
const filePath = path.join(projectRoot, 'dist', fileName);
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
