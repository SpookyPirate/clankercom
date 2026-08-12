/**
 * preload.js — Context-isolated bridge between the renderer and the hub.
 *
 * Exposes a narrow, explicit API. The renderer has no direct access to
 * ipcRenderer, Node, or the hub itself; everything it can do is enumerated
 * here.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Bus events the renderer may subscribe to, allow-listed so a compromised
// renderer cannot attach to arbitrary IPC channels.
const SUBSCRIBABLE_EVENTS = [
  'window:state',
  'hub:message',
  'hub:agent',
  'hub:agentRemoved',
  'hub:channel',
  'hub:groups',
  'hub:channelGroups',
  'hub:task',
  'hub:settings',
  'hub:peers',
  'hub:files',
  'hub:cleared',
  'hub:reveal',
  'hub:listeners',
  'hub:seen',
];

contextBridge.exposeInMainWorld('clanker', {
  // ---- window controls (the title bar is drawn by the renderer) ----
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // ---- hub ----
  bootstrap: () => ipcRenderer.invoke('hub:bootstrap'),
  readChannel: (channel, limit) => ipcRenderer.invoke('hub:readChannel', { channel, limit }),
  send: (channel, text) => ipcRenderer.invoke('hub:send', { channel, text }),
  createChannel: (name, topic) => ipcRenderer.invoke('hub:createChannel', { name, topic }),
  updateChannel: (channel, patch) => ipcRenderer.invoke('hub:updateChannel', { channel, ...patch }),
  channelGroups: () => ipcRenderer.invoke('hub:channelGroups'),
  createChannelGroup: (name) => ipcRenderer.invoke('hub:createChannelGroup', { name }),
  updateChannelGroup: (id, patch) => ipcRenderer.invoke('hub:updateChannelGroup', { id, ...patch }),
  deleteChannelGroup: (id) => ipcRenderer.invoke('hub:deleteChannelGroup', { id }),
  setChannelGroupWrite: (id, agentGroupId, allowed) =>
    ipcRenderer.invoke('hub:setChannelGroupWrite', { id, agentGroupId, allowed }),
  setChannelGroup: (channel, groupId) => ipcRenderer.invoke('hub:setChannelGroup', { channel, groupId }),
  resyncChannel: (channel) => ipcRenderer.invoke('hub:resyncChannel', { channel }),
  setIdentity: (name, handle) => ipcRenderer.invoke('hub:setIdentity', { name, handle }),
  openDm: (handle) => ipcRenderer.invoke('hub:openDm', { handle }),
  joinChannel: (channel, handle) => ipcRenderer.invoke('hub:joinChannel', { channel, handle }),

  // ---- groups and roster management ----
  createGroup: (name) => ipcRenderer.invoke('hub:createGroup', { name }),
  renameGroup: (groupId, name) => ipcRenderer.invoke('hub:renameGroup', { groupId, name }),
  deleteGroup: (groupId) => ipcRenderer.invoke('hub:deleteGroup', { groupId }),
  listGroups: () => ipcRenderer.invoke('hub:listGroups'),
  setGroupMembership: (agentId, groupId, isMember) =>
    ipcRenderer.invoke('hub:setGroupMembership', { agentId, groupId, isMember }),
  setGroupPermission: (groupId, permission, value) =>
    ipcRenderer.invoke('hub:setGroupPermission', { groupId, permission, value }),
  removeAgent: (agentId) => ipcRenderer.invoke('hub:removeAgent', { agentId }),

  // ---- search ----
  search: (query, options) => ipcRenderer.invoke('hub:search', { query, ...options }),

  // ---- shared files ----
  listFiles: (scope, channel) => ipcRenderer.invoke('files:list', { scope, channel }),
  addFiles: (scope, channel) => ipcRenderer.invoke('files:add', { scope, channel }),
  deleteFile: (scope, channel, name) => ipcRenderer.invoke('files:delete', { scope, channel, name }),
  saveFileAs: (scope, channel, name) => ipcRenderer.invoke('files:save', { scope, channel, name }),

  // ---- history ----
  exportChannel: (channel) => ipcRenderer.invoke('hub:exportChannel', { channel }),
  clearChannel: (channel) => ipcRenderer.invoke('hub:clearChannel', { channel }),

  // ---- tasks ----
  listTasks: () => ipcRenderer.invoke('hub:listTasks'),
  decideTask: (taskId, approved) => ipcRenderer.invoke('hub:decideTask', { taskId, approved }),
  setAutoApprove: (enabled) => ipcRenderer.invoke('hub:setAutoApprove', { enabled }),

  // ---- browser peers ----
  addPeer: (webContentsId, handle) => ipcRenderer.invoke('peers:add', { webContentsId, handle }),
  lockPeer: (peerId) => ipcRenderer.invoke('peers:lock', { peerId }),
  unlockPeer: (peerId) => ipcRenderer.invoke('peers:unlock', { peerId }),
  removePeer: (peerId) => ipcRenderer.invoke('peers:remove', { peerId }),
  listPeers: () => ipcRenderer.invoke('peers:list'),
  cancelPeerTurn: (handle) => ipcRenderer.invoke('peers:cancel', { handle }),

  /**
   * Subscribe to a bus event. Returns an unsubscribe function so the renderer
   * can detach listeners without leaking them across view changes.
   */
  on: (event, callback) => {
    if (!SUBSCRIBABLE_EVENTS.includes(event)) {
      throw new Error(`event "${event}" is not subscribable`);
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
