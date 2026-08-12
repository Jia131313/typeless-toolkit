const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('typelessToolkitDesktop', {
  setTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      ipcRenderer.send('typeless-toolkit:set-theme', theme);
    }
  },
  openPrivacySettings(section) {
    if (['app-management', 'accessibility', 'microphone'].includes(section)) {
      ipcRenderer.send('typeless-toolkit:open-privacy-settings', section);
    }
  },
  async resetPrivacyPermissions(target) {
    if (target !== 'typeless' && target !== 'toolkit') return { ok: false };
    return ipcRenderer.invoke('typeless-toolkit:reset-privacy-permissions', target);
  },
});
