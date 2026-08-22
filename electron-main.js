const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { preferredManagerPort, selectManagerEndpoint } = require('./lib/desktop-host');
const { platform, appBundleForExecutable, macCodeRequirement } = require('./lib/platform');

const APP_NAME = 'Typeless 工具集';
let mainWindow;
let managerServer;
let managerPort;

app.setName(APP_NAME);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on('second-instance', showMainWindow);

function prepareDataDirectory() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch (error) {}

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(path.join(__dirname, 'config.json'), configPath);
  }
  try { fs.chmodSync(configPath, 0o600); } catch (error) {}

  process.env.TYPELESS_DATA_DIR = dataDir;
  return dataDir;
}

function reconcileToolkitPermissionIdentity(dataDir) {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const statePath = path.join(dataDir, 'mac-permission-identity.json');
  let currentRequirement;
  try {
    currentRequirement = macCodeRequirement(appBundleForExecutable(process.execPath));
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let previousRequirement = null;
  try {
    previousRequirement = JSON.parse(fs.readFileSync(statePath, 'utf8')).requirement || null;
  } catch (error) {}
  if (previousRequirement === currentRequirement) return { ok: true, changed: false };

  // Toolkit 使用 ad-hoc 签名，每次重新构建都会产生新的 CDHash。主动删除旧 App 管理身份，
  // 以及旧版错误启动 Typeless 时遗留的 Toolkit 辅助功能项，避免系统设置保留无效的开启开关。
  const reset = platform.resetPrivacyPermissions(
    'com.typeless-toolkit.manager',
    ['SystemPolicyAppBundles', 'Accessibility']
  );
  if (!reset.ok) return { ok: false, changed: true, reset };

  fs.writeFileSync(statePath, JSON.stringify({
    requirement: currentRequirement,
    previous_requirement: previousRequirement,
    updated_at: new Date().toISOString(),
    app_management_regrant_required: true,
    app_management_authorized_at: null,
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(statePath, 0o600); } catch (error) {}
  return { ok: true, changed: true, reset };
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    title: APP_NAME,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1420' : '#f5f6f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'electron-preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `http://127.0.0.1:${port}/`) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.on('typeless-toolkit:set-theme', (event, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (theme !== 'light' && theme !== 'dark') return;
  nativeTheme.themeSource = theme;
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0f1420' : '#f5f6f9');
});

ipcMain.on('typeless-toolkit:open-privacy-settings', (event, section) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (process.platform !== 'darwin') return;
  const panes = {
    'app-management': 'Privacy_AppBundles',
    accessibility: 'Privacy_Accessibility',
    microphone: 'Privacy_Microphone',
  };
  const pane = panes[section];
  if (!pane) return;
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
});

ipcMain.handle('typeless-toolkit:reset-privacy-permissions', (event, target) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return { ok: false, message: '无效的窗口请求' };
  }
  if (process.platform !== 'darwin') return { ok: false, message: '仅支持 macOS' };

  const plans = {
    toolkit: {
      bundleId: 'com.typeless-toolkit.manager',
      // 旧版直接 spawn Typeless 时，macOS 可能把 Typeless 的辅助功能请求错误归到工具集。
      // 一并清掉该无用记录；工具集正常只需要 App 管理。
      services: ['SystemPolicyAppBundles', 'Accessibility'],
      appName: 'Typeless 工具集',
    },
    typeless: {
      bundleId: 'now.typeless.desktop',
      services: ['Accessibility', 'Microphone'],
      appName: 'Typeless',
    },
  };
  const plan = plans[target];
  if (!plan) return { ok: false, message: '未知的权限目标' };

  const failures = [];
  for (const service of plan.services) {
    try {
      execFileSync('/usr/bin/tccutil', ['reset', service, plan.bundleId], { stdio: 'ignore' });
    } catch (error) {
      failures.push(service);
    }
  }
  if (failures.length) {
    return { ok: false, message: `无法清除 ${plan.appName} 的 ${failures.join('、')} 权限记录` };
  }
  return { ok: true, message: `已清除 ${plan.appName} 的旧权限记录，请重新启动并按系统提示授权` };
});

async function launch() {
  const dataDir = prepareDataDirectory();
  const permissionIdentity = reconcileToolkitPermissionIdentity(dataDir);
  if (permissionIdentity && !permissionIdentity.ok) {
    console.warn('[macOS permissions] 无法清理旧工具集权限身份:', permissionIdentity);
  }
  const preferredPort = preferredManagerPort(
    path.join(dataDir, 'config.json'),
    process.env.TYPELESS_MANAGER_PORT,
  );
  const endpoint = await selectManagerEndpoint(preferredPort);
  managerPort = endpoint.port;

  if (!endpoint.reuseExisting) {
    process.env.TYPELESS_MANAGER_PORT = String(managerPort);
    const { startServer } = require('./manager');
    managerServer = await startServer();
  }
  createWindow(managerPort);
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(launch).catch((error) => {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, error.message);
    app.quit();
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && managerPort) {
    createWindow(managerPort);
  } else {
    showMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (managerServer?.listening) managerServer.close();
});
