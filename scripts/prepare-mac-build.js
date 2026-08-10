const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, '.metadata_never_index'), '', { flag: 'a', mode: 0o600 });
