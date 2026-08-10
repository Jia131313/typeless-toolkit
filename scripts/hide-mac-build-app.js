const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(distDir)) process.exit(0);

for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^mac(?:-|$)/.test(entry.name)) continue;
  const appPath = path.join(distDir, entry.name, 'Typeless 工具集.app');
  const hiddenPath = `${appPath}.noindex`;
  if (!fs.existsSync(appPath)) continue;
  if (fs.existsSync(hiddenPath)) fs.rmSync(hiddenPath, { recursive: true, force: true });
  fs.renameSync(appPath, hiddenPath);
}
