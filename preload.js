// preload.js — exposes a controlled API surface to the renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intercom', {
  attach: (webContentsId) => ipcRenderer.invoke('relay:attach', webContentsId),
  lock: () => ipcRenderer.invoke('relay:lock'),
  unlock: () => ipcRenderer.invoke('relay:unlock'),
  status: () => ipcRenderer.invoke('relay:status'),
});
