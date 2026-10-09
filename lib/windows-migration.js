const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const parameters = require('../windows-build.json');

function json(file, empty) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : empty;
}
function words(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).map(word => word.trim()).filter(Boolean) : [];
}
function filesUnder(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('迁移目录包含符号链接，请改用备份导入：' + relative);
  if (stat.isFile()) return [{ relative, bytes: stat.size }];
  return fs.readdirSync(absolute).flatMap(name => filesUnder(root, path.join(relative, name)));
}
function sourceRunning(directory) {
  const escaped = directory.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $root='${escaped}\\'; $items=@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'TypelessToolkit.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -eq 'node.exe' -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.Contains('manager.js')))) }); $items.Count`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error('无法查询旧工具集进程：' + result.error.message);
  if (result.status !== 0) throw new Error('无法确认旧工具集已退出：' + result.stderr.trim());
  return Number(result.stdout.trim()) > 0;
}
function targetEmpty(target, masterName) {
  const config = { ...json(path.join(target, 'config.json'), {}), ...json(path.join(target, 'config.local.json'), {}) };
  const master = config.master_csv || masterName;
  const accounts = json(path.join(target, 'accounts.json'), []);
  const profiles = filesUnder(target, 'profiles');
  return accounts.length === 0 && words(path.isAbsolute(master) ? master : path.join(target, master)).length === 0 && profiles.length === 0;
}
function previewMigration({ sourceDir, targetDir, masterName, checkRunning = sourceRunning }) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (!sourceDir || !fs.existsSync(path.join(source, 'TypelessToolkit.exe')) || !fs.existsSync(path.join(source, 'server', 'package.json'))) throw new Error('请选择包含 TypelessToolkit.exe 与 server 的旧 ZIP 工具集目录。');
  const data = path.join(source, 'data');
  if (source === target || data === target) throw new Error('来源与当前数据目录相同，无需迁移。');
  if (!targetEmpty(target, masterName)) throw new Error('当前安装已有账号、词库或登录快照，请使用“导入备份”合并数据。');
  if (checkRunning(source)) throw new Error('旧目录的工具集仍在运行，请从旧工具集托盘完整退出后重试。');
  const config = { ...json(path.join(data, 'config.json'), {}), ...json(path.join(data, 'config.local.json'), {}) };
  const sourceMaster = config.master_csv || masterName;
  const dictionaryFile = path.isAbsolute(sourceMaster) ? sourceMaster : path.join(data, sourceMaster);
  const dictionaryName = path.basename(sourceMaster);
  const entries = [...parameters.migration.files.flatMap(name => filesUnder(data, name)), ...parameters.migration.directories.flatMap(name => filesUnder(data, name))];
  if (fs.existsSync(dictionaryFile)) entries.push({ relative: dictionaryName, source: dictionaryFile, bytes: fs.statSync(dictionaryFile).size });
  const accounts = json(path.join(data, 'accounts.json'), []);
  if (!Array.isArray(accounts)) throw new Error('旧目录账号文件不是账号列表，请检查来源。');
  return { source_dir: source, source_data: data, target_dir: target, master_name: dictionaryName, account_count: accounts.length, dictionary_count: words(dictionaryFile).length, profile_count: fs.existsSync(path.join(data, 'profiles')) ? fs.readdirSync(path.join(data, 'profiles')).length : 0, file_count: entries.length, bytes: entries.reduce((total, file) => total + file.bytes, 0), entries };
}
function rewritePaths(value, source, target) {
  if (Array.isArray(value)) return value.map(item => rewritePaths(item, source, target));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item, source, target)]));
  if (typeof value === 'string' && path.isAbsolute(value) && (value === source || value.toLowerCase().startsWith((source + path.sep).toLowerCase()))) return path.join(target, path.relative(source, value));
  return value;
}
function copyMigration(preview) {
  fs.mkdirSync(preview.target_dir, { recursive: true });
  for (const entry of preview.entries) {
    const destination = path.join(preview.target_dir, entry.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const source = entry.source || path.join(preview.source_data, entry.relative);
    if (entry.relative === 'config.json' || entry.relative === 'config.local.json') {
      const config = rewritePaths(json(source, {}), preview.source_data, preview.target_dir);
      if (config.master_csv) config.master_csv = preview.master_name;
      fs.writeFileSync(destination, JSON.stringify(config, null, 2), 'utf8');
    } else fs.copyFileSync(source, destination);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function applyRequest(requestFile) {
  const request = json(requestFile);
  const resultFile = path.join(request.targetDir, 'windows-migration-result.json');
  let outcome;
  try {
    const deadline = Date.now() + parameters.migration.wait_timeout_ms;
    while (alive(request.hostPid) || alive(request.backendPid)) {
      if (Date.now() >= deadline) throw new Error('工具集未完整退出，迁移未执行。请退出后重新尝试。');
      await new Promise(resolve => setTimeout(resolve, parameters.migration.poll_interval_ms));
    }
    const preview = previewMigration(request);
    copyMigration(preview);
    outcome = { state: 'succeeded', account_count: preview.account_count, dictionary_count: preview.dictionary_count, file_count: preview.file_count, bytes: preview.bytes, message: '旧 ZIP 数据已迁入，旧目录未删除。' };
  } catch (error) {
    outcome = { state: 'failed', message: error.message };
  }
  fs.writeFileSync(resultFile, JSON.stringify({ ...outcome, completed_at: new Date().toISOString() }, null, 2), 'utf8');
  fs.unlinkSync(requestFile);
  const child = spawn(path.join(request.installDir, 'TypelessToolkit.exe'), [], { detached: true, stdio: 'ignore', cwd: request.installDir });
  child.unref();
}
async function prepareMigration(request) {
  const preview = previewMigration(request);
  const requestFile = path.join(request.targetDir, 'windows-migration-request.json');
  fs.writeFileSync(requestFile, JSON.stringify(request), 'utf8');
  const child = spawn(process.execPath, [__filename, '--apply', requestFile], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => { fs.unlinkSync(requestFile); reject(error); });
  });
  child.unref();
  const { entries, ...summary } = preview;
  return { ...summary, prepared: true };
}
module.exports = { previewMigration, prepareMigration, copyMigration, targetEmpty };
if (require.main === module && process.argv[2] === '--apply') applyRequest(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
