const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const TRUSTED_TEAM_IDS = new Set(['947QKAND4W']);
const TYPELESS_BUNDLE_ID = 'now.typeless.desktop';

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const b = String(right || '').split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function pendingVersionFromFileName(fileName) {
  const match = String(fileName || '').match(/^Typeless-([0-9]+(?:\.[0-9]+)+)-(?:arm64|x64|universal)\.zip$/i);
  return match ? match[1] : null;
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally { fs.closeSync(fd); }
  return hash.digest('base64');
}

function plistValue(plistPath, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plistPath], { encoding: 'utf8' }).trim();
}

function appMetadata(appPath) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  return {
    bundle_id: plistValue(plistPath, 'CFBundleIdentifier'),
    version: plistValue(plistPath, 'CFBundleShortVersionString'),
    build: plistValue(plistPath, 'CFBundleVersion'),
  };
}

function codesignIdentity(appPath) {
  const result = spawnSync('/usr/bin/codesign', ['-dvv', appPath], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const teamMatch = output.match(/TeamIdentifier=([^\s]+)/);
  const authorityMatch = output.match(/^Authority=(Developer ID Application:[^\n]+)$/m);
  return {
    teamId: teamMatch ? teamMatch[1] : null,
    developerIdAuthority: authorityMatch ? authorityMatch[1] : null,
  };
}

function validateOfficialApp(appPath, expectedVersion) {
  const metadata = appMetadata(appPath);
  if (metadata.bundle_id !== TYPELESS_BUNDLE_ID) {
    throw new Error(`更新包 Bundle ID 不匹配:${metadata.bundle_id}`);
  }
  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(`更新包版本不匹配:文件名 ${expectedVersion},应用 ${metadata.version}`);
  }

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
  const identity = codesignIdentity(appPath);
  if (!identity.developerIdAuthority) {
    throw new Error('更新包不是 Developer ID Application 签名');
  }
  if (!TRUSTED_TEAM_IDS.has(identity.teamId)) {
    throw new Error(`更新包签名团队不受信任:${identity.teamId || '无 Team ID'}`);
  }
  execFileSync('/usr/sbin/spctl', ['-a', '-vv', appPath], { stdio: 'ignore' });
  return { ...metadata, team_id: identity.teamId, authority: identity.developerIdAuthority };
}

function findPendingUpdate(homeDir = os.homedir()) {
  const pendingDir = path.join(homeDir, 'Library', 'Caches', 'typeless-updater', 'pending');
  const infoPath = path.join(pendingDir, 'update-info.json');
  if (!fs.existsSync(infoPath)) return null;
  let info;
  try { info = JSON.parse(fs.readFileSync(infoPath, 'utf8')); }
  catch (error) { throw new Error('官方更新信息损坏:' + error.message); }
  const version = pendingVersionFromFileName(info.fileName);
  if (!version || !info.sha512) throw new Error('官方更新信息缺少有效的文件名或 SHA-512');
  const packagePath = path.join(pendingDir, info.fileName);
  if (!fs.existsSync(packagePath)) return null;
  return { infoPath, packagePath, fileName: info.fileName, version, sha512: info.sha512 };
}

function officialUpdateStatus({ typelessAppPath, homeDir = os.homedir() }) {
  if (process.platform !== 'darwin') return { supported: false, reason: '官方升级安装目前仅支持 macOS' };
  if (!typelessAppPath || !fs.existsSync(typelessAppPath)) {
    return { supported: true, available: false, reason: '未找到 Typeless.app' };
  }
  const current = appMetadata(typelessAppPath);
  const pending = findPendingUpdate(homeDir);
  if (!pending) return { supported: true, available: false, current, reason: '尚未发现 Typeless 官方下载的更新包' };
  return {
    supported: true,
    available: compareVersions(pending.version, current.version) > 0,
    current,
    pending: { version: pending.version, fileName: pending.fileName, packagePath: pending.packagePath },
    reason: compareVersions(pending.version, current.version) > 0 ? null : '当前版本不低于已下载更新包',
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function installOfficialUpdate({
  typelessAppPath,
  dataRoot,
  homeDir = os.homedir(),
  stopRunningApp = true,
  launchInstalledApp = true,
}) {
  if (process.platform !== 'darwin') throw new Error('官方升级安装目前仅支持 macOS');
  const pending = findPendingUpdate(homeDir);
  if (!pending) throw new Error('尚未发现 Typeless 官方下载的更新包');
  const current = appMetadata(typelessAppPath);
  if (compareVersions(pending.version, current.version) <= 0) throw new Error('当前版本不低于已下载更新包');

  const actualHash = sha512Base64(pending.packagePath);
  if (actualHash !== pending.sha512) throw new Error('官方更新包 SHA-512 校验失败');

  const workRoot = path.join(dataRoot, 'update-staging');
  fs.mkdirSync(workRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(workRoot, 'typeless-'));
  const extractedApp = path.join(stageDir, 'Typeless.app');
  let backupApp = null;
  let installed = false;

  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', pending.packagePath, stageDir], { stdio: 'ignore' });
    if (!fs.existsSync(extractedApp)) throw new Error('官方更新包内未找到 Typeless.app');
    const update = validateOfficialApp(extractedApp, pending.version);

    if (stopRunningApp) {
      try { execFileSync('/usr/bin/killall', ['Typeless'], { stdio: 'ignore' }); } catch (error) {}
      await delay(1500);
    }

    const backupDir = path.join(dataRoot, 'backups', 'typeless-app', timestamp());
    fs.mkdirSync(backupDir, { recursive: true });
    backupApp = path.join(backupDir, 'Typeless.app');
    fs.renameSync(typelessAppPath, backupApp);
    fs.renameSync(extractedApp, typelessAppPath);
    installed = true;

    validateOfficialApp(typelessAppPath, pending.version);
    if (launchInstalledApp) execFileSync('/usr/bin/open', [typelessAppPath], { stdio: 'ignore' });
    return {
      done: true,
      previous_version: current.version,
      version: update.version,
      build: update.build,
      team_id: update.team_id,
      backup: backupApp,
      msg: `Typeless 已从 ${current.version} 升级到 ${update.version},官方签名已恢复`,
    };
  } catch (error) {
    const rollbackErrors = [];
    if (installed && fs.existsSync(typelessAppPath)) {
      const failedPath = path.join(path.dirname(backupApp), 'failed-update.app');
      try { fs.renameSync(typelessAppPath, failedPath); }
      catch (moveError) { rollbackErrors.push('无法移走失败版本:' + moveError.message); }
    }
    if (backupApp && fs.existsSync(backupApp) && !fs.existsSync(typelessAppPath)) {
      try { fs.renameSync(backupApp, typelessAppPath); }
      catch (restoreError) { rollbackErrors.push('无法恢复原应用:' + restoreError.message); }
    }
    if (backupApp && !fs.existsSync(typelessAppPath)) {
      rollbackErrors.push('回滚后目标应用不存在');
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message};自动回滚失败:${rollbackErrors.join(';')};原应用备份:${backupApp || '未创建'}`);
    }
    throw error;
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (error) {}
  }
}

module.exports = {
  TYPELESS_BUNDLE_ID,
  TRUSTED_TEAM_IDS,
  compareVersions,
  pendingVersionFromFileName,
  sha512Base64,
  appMetadata,
  validateOfficialApp,
  findPendingUpdate,
  officialUpdateStatus,
  installOfficialUpdate,
};
