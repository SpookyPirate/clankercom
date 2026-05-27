// main.js — Electron entry point (Claude Intercom)
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const path = require('path');
const { Relay } = require('./src/relay');
const { createMcpServer } = require('./src/mcp-server');

let win;
let relay;
let server;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Claude Intercom',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');

  // win.webContents.openDevTools({ mode: 'detach' }); // uncomment while developing
}

// --- IPC handlers ---

ipcMain.handle('relay:attach', async (_evt, webContentsId) => {
  const wc = webContents.fromId(webContentsId);
  if (!wc) throw new Error(`no webContents with id ${webContentsId}`);
  relay = new Relay(wc);

  // Start MCP server once
  if (!server) {
    const app = createMcpServer(relay);
    server = app.listen(7777, '127.0.0.1', () => {
      console.log('[intercom] MCP server listening on http://localhost:7777/mcp');
    });
  }
});

ipcMain.handle('relay:lock', async () => {
  if (!relay) throw new Error('relay not attached');
  return relay.lock();
});

ipcMain.handle('relay:unlock', async () => {
  if (!relay) return;
  relay.unlock();
});

ipcMain.handle('relay:status', async () => ({
  attached: !!relay,
  locked: relay?.locked ?? false,
  url: relay?.lockedUrl ?? null,
  busy: relay?.busy ?? false,
}));

// --- App lifecycle ---

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (server) {
    server.close(() => console.log('[intercom] MCP server closed'));
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
