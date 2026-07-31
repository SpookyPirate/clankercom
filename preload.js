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
const SUBSCRIBABLE_EVENTS = ['hub:message', 'hub:agent', 'hub:channel', 'hub:peers'];

contextBridge.exposeInMainWorld('clanker', {
  // ---- hub ----
  bootstrap: () => ipcRenderer.invoke('hub:bootstrap'),
  readChannel: (channel, limit) => ipcRenderer.invoke('hub:readChannel', { channel, limit }),
  send: (channel, text) => ipcRenderer.invoke('hub:send', { channel, text }),
  createChannel: (name, topic) => ipcRenderer.invoke('hub:createChannel', { name, topic }),
  setIdentity: (name, handle) => ipcRenderer.invoke('hub:setIdentity', { name, handle }),
  openDm: (handle) => ipcRenderer.invoke('hub:openDm', { handle }),
  joinChannel: (channel, handle) => ipcRenderer.invoke('hub:joinChannel', { channel, handle }),

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
