/**
 * main.js — Electron entry point for ClankerCom.
 *
 * Assembles the hub and its transports:
 *   Store      -> durable message log and state
 *   Hub        -> agents, channels, messages, long-polling
 *   HubServer  -> MCP over Streamable HTTP for external agents
 *   PeerManager-> claude.ai conversations driven through webviews
 *
 * Also bridges the hub to the UI over IPC, forwarding bus events so the
 * renderer stays live without polling.
 */

const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, webContents, shell } = require('electron');

const { APP_NAME, DEFAULT_CHANNEL } = require('./src/config');
const { Store } = require('./src/hub/store');
const { Hub } = require('./src/hub/bus');
const { PeerManager } = require('./src/browser/peer-manager');
const { createHubServer } = require('./src/mcp/http-server');

let mainWindow = null;
let store = null;
let hub = null;
let peers = null;
let hubServer = null;
let httpServer = null;
let humanAgent = null;

// ============================================
// Single instance
// ============================================

// Two instances sharing one data directory would interleave writes into the
// same message log, so the second is normally turned away and focuses the
// first.
//
// An instance given an explicit CLANKER_DATA_DIR has its own log and its own
// Electron profile, so there is nothing to protect and the lock is skipped —
// which is what makes it possible to run a scratch instance for UI work while
// the real one stays open.
const isolatedDataDir = process.env.CLANKER_DATA_DIR;

if (isolatedDataDir) {
  app.setPath('userData', path.join(isolatedDataDir, 'electron-profile'));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

// ============================================
// Bootstrap
// ============================================

async function startHub() {
  // CLANKER_DATA_DIR redirects the transcript and state elsewhere, so tests
  // and UI work can run against seeded data without touching real history.
  store = new Store(process.env.CLANKER_DATA_DIR || app.getPath('userData'));
  hub = new Hub(store);
  hub.load();

  peers = new PeerManager(hub);

  // You are a participant, not an observer: the UI posts as this agent.
  humanAgent = hub.registerAgent({
    name: os.userInfo().username || 'human',
    displayName: os.userInfo().username || 'You',
    platform: 'human',
    kind: 'human',
    description: 'The human running ClankerCom.',
  });

  hubServer = createHubServer({ hub, peers });
  const listening = await hubServer.listen();
  httpServer = listening.httpServer;

  forwardHubEvents();
}

/** Push bus activity to the renderer so the UI never has to poll. */
function forwardHubEvents() {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  hub.on('message', (message) => send('hub:message', message));
  hub.on('agent:joined', (agent) => send('hub:agent', agent));
  hub.on('agent:updated', (agent) => send('hub:agent', agent));
  hub.on('channel:created', (channel) => send('hub:channel', channel));
  hub.on('channel:updated', (channel) => send('hub:channel', channel));
  peers.on('peers:changed', (list) => send('hub:peers', list));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: '#0b0d12',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');

  // Dev aid for UI work: CLANKER_SCREENSHOT=<path> captures the rendered
  // window once and exits, so layout changes can be verified without a
  // manual screenshot round-trip.
  if (process.env.CLANKER_SCREENSHOT) captureAndExit(process.env.CLANKER_SCREENSHOT);

  // External links belong in the real browser, not in a hub pane.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://claude.ai')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

/**
 * Wait for the UI to settle, write a PNG, then quit. Dev use only.
 *
 * CLANKER_SCREENSHOT_CLICK runs a click on the given element id first, so
 * states that need interaction — an added browser peer, an open form — can be
 * captured without a human at the keyboard.
 */
function captureAndExit(outputPath) {
  mainWindow.webContents.once('did-finish-load', () => {
    // The window must be visible and painted before capturePage returns
    // pixels; capturing an unshown window yields an empty image.
    mainWindow.show();
    mainWindow.focus();

    const clickTarget = process.env.CLANKER_SCREENSHOT_CLICK;
    if (clickTarget) {
      mainWindow.webContents
        .executeJavaScript(`document.getElementById(${JSON.stringify(clickTarget)})?.click()`)
        .catch((error) => console.error(`[${APP_NAME}] click failed:`, error.message));
    }

    setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage();
        const size = image.getSize();
        require('fs').writeFileSync(outputPath, image.toPNG());
        console.log(`[${APP_NAME}] screenshot ${size.width}x${size.height} -> ${outputPath}`);
      } catch (error) {
        console.error(`[${APP_NAME}] screenshot failed:`, error.message);
      }
      app.exit(0);
    }, 3500);
  });
}

// ============================================
// IPC — hub queries
// ============================================

ipcMain.handle('hub:bootstrap', async () => ({
  self: hub.publicAgent(humanAgent),
  agents: hub.listAgents(),
  channels: hub.listChannels(humanAgent.id),
  peers: peers.list(),
  port: hubServer.getPort(),
  defaultChannel: DEFAULT_CHANNEL,
}));

ipcMain.handle('hub:readChannel', async (_event, { channel, limit }) => {
  return hub.readMessages(channel, { limit: limit || 100 });
});

ipcMain.handle('hub:send', async (_event, { channel, text }) => {
  const target = hub.getChannel(channel);
  if (!target) throw new Error(`unknown channel: ${channel}`);
  hub.joinChannel(humanAgent.id, target.id);
  return hub.postMessage({ channelId: target.id, authorId: humanAgent.id, text });
});

ipcMain.handle('hub:createChannel', async (_event, { name, topic }) => {
  const channel = hub.createChannel({ name, topic, createdBy: humanAgent.id });
  hub.joinChannel(humanAgent.id, channel.id);
  return hub.publicChannel(channel);
});

// Your own name, changeable from the console the same way an agent changes
// its own with set_identity.
ipcMain.handle('hub:setIdentity', async (_event, { name, handle }) => {
  const agent = hub.updateIdentity(humanAgent.id, { name, handle });
  return hub.publicAgent(agent);
});

ipcMain.handle('hub:openDm', async (_event, { handle }) => {
  const agent = hub.resolveAgent(handle);
  if (!agent) throw new Error(`unknown agent: ${handle}`);
  return hub.publicChannel(hub.getOrCreateDm(humanAgent.id, agent.id));
});

ipcMain.handle('hub:joinChannel', async (_event, { channel, handle }) => {
  const agent = handle ? hub.resolveAgent(handle) : humanAgent;
  if (!agent) throw new Error(`unknown agent: ${handle}`);
  return hub.publicChannel(hub.joinChannel(agent.id, channel));
});

// ============================================
// IPC — browser peers
// ============================================

ipcMain.handle('peers:add', async (_event, { webContentsId, handle }) => {
  const contents = webContents.fromId(webContentsId);
  if (!contents) throw new Error(`no webContents with id ${webContentsId}`);
  const peer = peers.addPeer(contents, { handle });
  return { id: peer.id };
});

ipcMain.handle('peers:lock', async (_event, { peerId }) => peers.lockPeer(peerId));
ipcMain.handle('peers:unlock', async (_event, { peerId }) => peers.unlockPeer(peerId));
ipcMain.handle('peers:remove', async (_event, { peerId }) => peers.removePeer(peerId));
ipcMain.handle('peers:list', async () => peers.list());
ipcMain.handle('peers:cancel', async (_event, { handle }) => peers.cancel(handle));

// ============================================
// Lifecycle
// ============================================

app.whenReady().then(async () => {
  try {
    await startHub();
  } catch (error) {
    console.error(`[${APP_NAME}] failed to start hub:`, error);
  }
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => app.quit());

// Flush pending writes and release blocked long-polls before exiting, so
// connected agents get a clean empty result instead of a dropped socket.
app.on('before-quit', async (event) => {
  if (!hub) return;

  event.preventDefault();
  hub.releaseWaiters();
  peers?.destroy();

  try {
    await hubServer?.closeAllSessions();
    await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve()));
    await store?.close();
  } catch (error) {
    console.error(`[${APP_NAME}] shutdown error:`, error);
  }

  hub = null;
  app.quit();
});
