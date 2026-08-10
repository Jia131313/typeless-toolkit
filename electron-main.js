const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { preferredManagerPort, selectManagerEndpoint } = require('./lib/desktop-host');

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

async function launch() {
  const dataDir = prepareDataDirectory();
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
