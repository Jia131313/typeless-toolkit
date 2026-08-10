const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('typelessToolkitDesktop', {
  setTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      ipcRenderer.send('typeless-toolkit:set-theme', theme);
    }
  },
});
