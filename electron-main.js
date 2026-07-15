const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');

const APP_NAME = 'Typeless 工具集';
let mainWindow;
let managerServer;

app.setName(APP_NAME);

function prepareDataDirectory() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(path.join(__dirname, 'config.json'), configPath);
  }

  process.env.TYPELESS_DATA_DIR = dataDir;
  return dataDir;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: APP_NAME,
    show: false,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

async function launch() {
  prepareDataDirectory();
  const { startServer, PORT } = require('./manager');
  managerServer = await startServer();
  createWindow(PORT);
}

app.whenReady().then(launch).catch((error) => {
  dialog.showErrorBox(`${APP_NAME} 启动失败`, error.message);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && managerServer?.listening) {
    const { PORT } = require('./manager');
    createWindow(PORT);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (managerServer?.listening) managerServer.close();
});
