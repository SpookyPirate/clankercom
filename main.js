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

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  webContents,
  shell,
} = require('electron');

const { APP_NAME, DEFAULT_CHANNEL } = require('./src/config');
const { Store } = require('./src/hub/store');
const { Hub } = require('./src/hub/bus');
const { PeerManager } = require('./src/browser/peer-manager');
const { createHubServer } = require('./src/mcp/http-server');

let mainWindow = null;
let tray = null;
let store = null;
let hub = null;
let peers = null;
let hubServer = null;
let httpServer = null;
let humanAgent = null;

// Closing the window hides it; only an explicit Quit ends the process, because
// the hub has to outlive the window for agents to reach it.
let isQuitting = false;

// What is waiting on the human, surfaced in the tray and the taskbar.
let unreadCount = 0;

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
  hub.on('agent:removed', (agent) => send('hub:agentRemoved', agent));
  hub.on('channel:created', (channel) => send('hub:channel', channel));
  hub.on('channel:updated', (channel) => send('hub:channel', channel));
  hub.on('group:changed', (groups) => send('hub:groups', groups));
  hub.on('task:changed', (task) => send('hub:task', task));
  hub.on('settings:changed', (settings) => send('hub:settings', settings));
  hub.on('files:changed', (scope) => send('hub:files', scope));
  hub.on('channel:cleared', (channel) => send('hub:cleared', channel));
  hub.on('listeners:changed', (handles) => send('hub:listeners', handles));
  hub.on('message:seen', (receipt) => send('hub:seen', receipt));
  peers.on('peers:changed', (list) => send('hub:peers', list));

  hub.on('message', (message) => notifyIfForHuman(message));
  hub.on('task:changed', (task) => notifyIfAwaitingApproval(task));
}

// ============================================
// Notifications
// ============================================

/**
 * Raise a notification when a message actually wants the human.
 *
 * Silent otherwise. A hub where agents talk constantly would be unusable if
 * every message rang — so this fires only for a direct mention or a DM, never
 * for the human's own messages, and never while the window already has focus,
 * where the message is visible anyway.
 */
function notifyIfForHuman(message) {
  if (message.kind !== 'message' || message.authorId === humanAgent?.id) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  const channel = hub.getChannel(message.channelId);
  const isDm = !!channel?.isDm && channel.members.has(humanAgent.id);
  const mentionsYou = message.mentions.includes(humanAgent.handle);
  if (!isDm && !mentionsYou) return;

  raise({
    title: isDm ? `${message.authorDisplayName}` : `${message.authorDisplayName} in #${channel.name}`,
    body: message.text.slice(0, 220),
    channel: channel?.name,
  });
}

/** Work waiting on approval is the one thing the hub cannot proceed without. */
function notifyIfAwaitingApproval(task) {
  if (task.status !== 'pending_approval') return;

  raise({
    title: 'Task needs your approval',
    body: `@${task.fromHandle} asked @${task.toHandle}: ${task.title}`,
    view: 'tasks',
  });
}

function raise({ title, body, channel = null, view = null }) {
  unreadCount++;
  renderAttention();

  if (!Notification.isSupported()) return;

  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => {
    revealWindow();
    mainWindow?.webContents.send('hub:reveal', { channel, view });
  });
  notification.show();
}

/**
 * Reflect the pending count where the operating system shows it: the tray
 * tooltip, and the window title, which is what the taskbar reads.
 */
function renderAttention() {
  const suffix = unreadCount > 0 ? ` (${unreadCount})` : '';
  tray?.setToolTip(`${APP_NAME}${suffix || ' — running'}`);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`${suffix ? suffix.trim() + ' ' : ''}${APP_NAME}`);
    if (unreadCount > 0 && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  }
}

function clearAttention() {
  unreadCount = 0;
  mainWindow?.flashFrame(false);
  renderAttention();
}

// ============================================
// Tray
// ============================================

/**
 * The hub is only useful if it is there when an agent calls. Closing the
 * window used to end the process, so every agent's next request failed with
 * "cannot reach the hub" — the tray is what makes running it a background
 * service rather than an app you must remember to keep open.
 */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: revealWindow },
      { type: 'separator' },
      {
        label: 'Quit — agents lose the hub',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );

  tray.on('click', revealWindow);
  renderAttention();
}

function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  // No application menu: File/Edit/View/Window/Help are stock Electron chrome
  // that has nothing to do with this app, and a frameless window would still
  // surface them via Alt.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    title: APP_NAME,
    // Frameless, with the title bar drawn by the renderer so it matches the
    // console rather than the operating system.
    frame: false,
    backgroundColor: '#0a0c10',
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

  // The default menu carried reload and devtools accelerators; removing it
  // takes those with it, so the two worth keeping are rebound here.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key === 'I');
    if (devtools) mainWindow.webContents.toggleDevTools();
    if (input.control && input.key.toLowerCase() === 'r') mainWindow.webContents.reload();
  });

  // The title bar draws its own maximize/restore control, so it needs to know
  // which state the window is actually in.
  const reportWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', reportWindowState);
  mainWindow.on('unmaximize', reportWindowState);

  // Looking at the window is the same as reading what was waiting.
  mainWindow.on('focus', clearAttention);

  // Closing hides. The hub keeps running, because an agent calling into a
  // process that quit gets an error it cannot do anything about. Quitting is
  // explicit, from the tray.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    announceBackgroundOnce();
  });
}

/**
 * A window that vanishes with no explanation reads as a crash. Said once, the
 * first time, then never again.
 */
let hasAnnouncedBackground = false;
function announceBackgroundOnce() {
  if (hasAnnouncedBackground || !Notification.isSupported()) return;
  hasAnnouncedBackground = true;

  new Notification({
    title: `${APP_NAME} is still running`,
    body: 'The hub stays up so agents can reach it. Open it from the tray, or quit there.',
    silent: true,
  }).show();
}

/**
 * Wait for the UI to settle, write a PNG, then quit. Dev use only.
 *
 * CLANKER_SCREENSHOT_EVAL runs arbitrary JavaScript in the renderer first, so
 * states that need interaction — an added browser peer, a filled-in form —
 * can be captured and verified without a human at the keyboard.
 */
function captureAndExit(outputPath) {
  mainWindow.webContents.once('did-finish-load', async () => {
    // The window must be visible and painted before capturePage returns
    // pixels; capturing an unshown window yields an empty image.
    mainWindow.show();
    mainWindow.focus();

    // The capture waits for the script to resolve. An eval that drives a slow
    // state — waiting on a real agent to connect, say — would otherwise be
    // photographed mid-flight, and the screenshot would show the state before
    // the one being tested while still looking like a pass.
    const script = process.env.CLANKER_SCREENSHOT_EVAL;
    if (script) {
      const budget = Number(process.env.CLANKER_SCREENSHOT_TIMEOUT || 30000);
      try {
        const result = await Promise.race([
          mainWindow.webContents.executeJavaScript(script),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`eval exceeded ${budget}ms`)), budget)
          ),
        ]);
        if (result !== undefined) console.log(`[${APP_NAME}] eval ->`, result);
      } catch (error) {
        console.error(`[${APP_NAME}] eval failed:`, error.message);
      }
    }

    // A short settle for animations that started as the script finished.
    await new Promise((resolve) => setTimeout(resolve, script ? 900 : 3500));
    try {
      const image = await mainWindow.webContents.capturePage();
      const size = image.getSize();
      require('fs').writeFileSync(outputPath, image.toPNG());
      console.log(`[${APP_NAME}] screenshot ${size.width}x${size.height} -> ${outputPath}`);
    } catch (error) {
      console.error(`[${APP_NAME}] screenshot failed:`, error.message);
    }
    app.exit(0);
  });
}

// ============================================
// IPC — hub queries
// ============================================

ipcMain.handle('hub:bootstrap', async () => ({
  self: hub.publicAgent(humanAgent),
  agents: hub.listAgents(),
  channels: hub.listChannels(humanAgent.id),
  groups: hub.listGroups(),
  tasks: hub.taskBoard.list().map((task) => hub.taskBoard.publicTask(task)),
  settings: hub.settings,
  peers: peers.list(),
  listeners: hub.listeners(),
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

  // `seenBy` is an internal Set the hub mutates in place; the renderer wants
  // the delivery outcome, not a live handle onto hub state.
  const { seenBy, ...wire } = hub.postMessage({
    channelId: target.id,
    authorId: humanAgent.id,
    text,
  });
  return wire;
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
// IPC — window controls
// ============================================

ipcMain.handle('window:minimize', async () => mainWindow?.minimize());

ipcMain.handle('window:toggleMaximize', async () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle('window:close', async () => mainWindow?.close());
ipcMain.handle('window:isMaximized', async () => mainWindow?.isMaximized() ?? false);

// ============================================
// IPC — groups and roster management
// ============================================

ipcMain.handle('hub:createGroup', async (_event, { name }) => hub.createGroup({ name }));
ipcMain.handle('hub:renameGroup', async (_event, { groupId, name }) =>
  hub.renameGroup(groupId, name)
);
ipcMain.handle('hub:deleteGroup', async (_event, { groupId }) => hub.deleteGroup(groupId));
ipcMain.handle('hub:listGroups', async () => hub.listGroups());

ipcMain.handle('hub:setGroupMembership', async (_event, { agentId, groupId, isMember }) =>
  hub.publicAgent(hub.setGroupMembership(agentId, groupId, isMember))
);

ipcMain.handle('hub:setGroupPermission', async (_event, { groupId, permission, value }) =>
  hub.setGroupPermission(groupId, permission, value)
);

ipcMain.handle('hub:removeAgent', async (_event, { agentId }) => {
  // Removing yourself would leave the console with no identity to post as.
  if (agentId === humanAgent.id) throw new Error('you cannot remove yourself from the roster');
  hub.removeAgent(agentId);
  return true;
});

// ============================================
// IPC — search
// ============================================

ipcMain.handle('hub:search', async (_event, { query, channel, from, limit }) =>
  hub.search({
    query,
    channelId: channel ? hub.getChannel(channel)?.id : null,
    fromHandle: from || null,
    limit: limit || 60,
    viewerId: humanAgent.id,
  })
);

// ============================================
// IPC — shared files
// ============================================

ipcMain.handle('files:list', async (_event, { scope, channel }) => {
  const channelId = scope === 'global' ? null : hub.getChannel(channel)?.id;
  return hub.files.list(scope, channelId);
});

/** Add files through a native picker; the vault re-sanitises every name. */
ipcMain.handle('files:add', async (_event, { scope, channel }) => {
  const channelId = scope === 'global' ? null : hub.getChannel(channel)?.id;

  const picked = await dialog.showOpenDialog(mainWindow, {
    title: scope === 'global' ? 'Add to global files' : `Add to #${channel} files`,
    properties: ['openFile', 'multiSelections'],
  });
  if (picked.canceled) return [];

  const added = [];
  for (const filePath of picked.filePaths) {
    const contents = fs.readFileSync(filePath);
    added.push(
      hub.files.write(scope, channelId, {
        name: path.basename(filePath),
        content: contents.toString('base64'),
        encoding: 'base64',
        authorId: humanAgent.id,
      })
    );
  }
  return added;
});

ipcMain.handle('files:delete', async (_event, { scope, channel, name }) => {
  const channelId = scope === 'global' ? null : hub.getChannel(channel)?.id;
  return hub.files.remove(scope, channelId, name);
});

ipcMain.handle('files:save', async (_event, { scope, channel, name }) => {
  const channelId = scope === 'global' ? null : hub.getChannel(channel)?.id;
  const source = hub.files.pathOf(scope, channelId, name);

  const target = await dialog.showSaveDialog(mainWindow, { defaultPath: name });
  if (target.canceled) return null;

  fs.copyFileSync(source, target.filePath);
  return target.filePath;
});

// ============================================
// IPC — history
// ============================================

ipcMain.handle('hub:exportChannel', async (_event, { channel }) => {
  const markdown = await hub.exportChannelMarkdown(channel);
  const target = hub.getChannel(channel);

  const chosen = await dialog.showSaveDialog(mainWindow, {
    title: 'Export transcript',
    defaultPath: `${target?.name || 'channel'}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (chosen.canceled) return null;

  fs.writeFileSync(chosen.filePath, markdown, 'utf8');
  return chosen.filePath;
});

ipcMain.handle('hub:clearChannel', async (_event, { channel }) => hub.clearChannel(channel));

// ============================================
// IPC — tasks
// ============================================

ipcMain.handle('hub:listTasks', async () =>
  hub.taskBoard.list().map((task) => hub.taskBoard.publicTask(task))
);

ipcMain.handle('hub:decideTask', async (_event, { taskId, approved }) =>
  hub.taskBoard.publicTask(hub.taskBoard.decide(taskId, { approved, byAgentId: humanAgent.id }))
);

ipcMain.handle('hub:setAutoApprove', async (_event, { enabled }) =>
  hub.updateSettings({ autoApproveTasks: !!enabled })
);

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
  // Without this, Windows attributes notifications to the Electron host and
  // may drop them entirely.
  app.setAppUserModelId('com.spookypirate.clankercom');

  try {
    await startHub();
  } catch (error) {
    console.error(`[${APP_NAME}] failed to start hub:`, error);
  }

  createWindow();
  createTray();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Deliberately does not quit: the hub keeps serving agents with no window
// open. Quit comes from the tray, which sets isQuitting first.
app.on('window-all-closed', () => {});

// Flush pending writes and release blocked long-polls before exiting, so
// connected agents get a clean empty result instead of a dropped socket.
app.on('before-quit', async (event) => {
  isQuitting = true;
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
  tray?.destroy();
  app.quit();
});
