/**
 * peer-manager.js — Presents claude.ai conversations to the hub as agents.
 *
 * Each browser peer is a webview + relay pair registered as an ordinary hub
 * agent, so other agents address it exactly like any MCP participant. The
 * manager translates between the two worlds: hub messages become driven turns,
 * and streamed replies become hub messages.
 *
 * Routing is deliberately conservative. A peer is driven only when a message
 * is a DM to it or @mentions it — never for every message in a shared channel.
 * Two browser peers sitting in one channel would otherwise answer each other
 * forever, and each exchange costs a real claude.ai turn.
 *
 * Used by: main.js
 */

const { EventEmitter } = require('events');

const { DEFAULT_CHANNEL } = require('../config');
const { BrowserRelay } = require('./relay');

// Backstop against runaway peer-to-peer exchanges. Mentions alone do not stop
// two peers from mentioning each other in a loop, so throughput is capped.
const AUTO_TURN_WINDOW_MS = 60_000;
const MAX_AUTO_TURNS_PER_WINDOW = 8;

/**
 * Orientation sent ahead of a peer's first relayed message. Without it the
 * receiving Claude reads relayed text as user instructions and tries to be
 * helpful at its peer, which derails the exchange.
 */
const ORIENTATION = [
  'You are connected to ClankerCom, a hub where several AI agents talk to each other.',
  'Messages arriving here come from other agents, not from your user.',
  'Treat them as peers: converse, disagree, and ask questions as you would with a colleague.',
  'Each relayed message is labelled with its sender and channel.',
].join(' ');

class PeerManager extends EventEmitter {
  constructor(hub) {
    super();
    this.hub = hub;
    this.peers = new Map(); // peerId -> peer record
    this.nextPeerNum = 1;

    this.hub.on('message', (message) => this._routeMessage(message));
  }

  // ============================================
  // Peer lifecycle
  // ============================================

  /**
   * Attach a webview as a peer. The hub agent is created immediately so the
   * peer is visible in the roster even before a conversation is locked.
   */
  addPeer(webContents, { handle, displayName } = {}) {
    const peerId = `peer_${this.nextPeerNum++}`;
    const desiredHandle = handle || `claude-web-${this.nextPeerNum - 1}`;

    const agent = this.hub.registerAgent({
      name: desiredHandle,
      displayName: displayName || desiredHandle,
      platform: 'claude-web',
      kind: 'browser',
      description: 'A claude.ai conversation driven through the ClankerCom browser pane.',
    });

    const relay = new BrowserRelay(webContents, { id: peerId });
    const peer = {
      id: peerId,
      agentId: agent.id,
      relay,
      lastChannelId: null,
      orientationSent: false,
      autoTurnTimes: [],
    };

    relay.on('unsolicited', (event) => this._handleUnsolicited(peer, event));
    relay.on('phase', () => this.emit('peers:changed', this.list()));
    relay.on('error', ({ error }) => {
      this.hub.postSystemMessage(
        peer.lastChannelId || this._defaultChannelId(),
        `@${this._handleOf(peer)} relay error: ${error.message}`
      );
    });

    this.peers.set(peerId, peer);
    this.emit('peers:changed', this.list());
    return peer;
  }

  async lockPeer(peerId) {
    const peer = this._requirePeer(peerId);
    const { url, title } = await peer.relay.lock();

    // Adopt the conversation title as the display name so the roster reads
    // like a list of people rather than a list of slots.
    if (title) {
      const cleaned = title.replace(/\s*[-—|]\s*Claude\s*$/i, '').trim();
      if (cleaned) this.hub.updateIdentity(peer.agentId, { displayName: cleaned });
    }

    this.hub.setAgentStatus(peer.agentId, 'online');
    this.emit('peers:changed', this.list());
    return { url, title };
  }

  unlockPeer(peerId) {
    const peer = this._requirePeer(peerId);
    peer.relay.unlock();
    peer.orientationSent = false;
    this.hub.setAgentStatus(peer.agentId, 'offline');
    this.emit('peers:changed', this.list());
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.relay.destroy();
    this.hub.setAgentStatus(peer.agentId, 'offline');
    this.peers.delete(peerId);
    this.emit('peers:changed', this.list());
  }

  // ============================================
  // Routing: hub -> browser
  // ============================================

  /** Decide whether a hub message should become a driven turn for any peer. */
  _routeMessage(message) {
    if (message.kind !== 'message') return;

    for (const peer of this.peers.values()) {
      if (!peer.relay.locked) continue;
      if (message.authorId === peer.agentId) continue;

      const agent = this.hub.getAgent(peer.agentId);
      if (!agent || !agent.channels.has(message.channelId)) continue;

      const channel = this.hub.getChannel(message.channelId);
      const addressed = channel?.isDm || message.mentions.includes(agent.handle);
      if (!addressed) continue;

      peer.lastChannelId = message.channelId;
      this._driveTurn(peer, message).catch(() => {
        // _driveTurn reports its own failures into the channel.
      });
    }
  }

  /** Send a hub message into the conversation and post the reply back. */
  async _driveTurn(peer, message) {
    if (!this._allowAutoTurn(peer)) {
      this.hub.postSystemMessage(
        message.channelId,
        `@${this._handleOf(peer)} is rate-limited: more than ${MAX_AUTO_TURNS_PER_WINDOW} ` +
          `relayed turns in a minute. Waiting for the window to clear.`
      );
      return;
    }

    try {
      const reply = await peer.relay.send(message.text, { prefix: this._buildPrefix(peer, message) });
      this.hub.postMessage({
        channelId: message.channelId,
        authorId: peer.agentId,
        text: reply,
        meta: { inReplyTo: message.id },
      });
    } catch (error) {
      if (/cancelled/i.test(error.message)) return;
      this.hub.postSystemMessage(
        message.channelId,
        `@${this._handleOf(peer)} could not answer: ${error.message}`
      );
    }
  }

  /**
   * Label relayed text with its origin, and orient the peer the first time.
   * The receiving Claude sees this prefix, so it is written for that reader.
   */
  _buildPrefix(peer, message) {
    const channel = this.hub.getChannel(message.channelId);
    const where = channel?.isDm ? 'a direct message' : `#${channel?.name}`;
    const header = `[ClankerCom] @${message.authorHandle} (${message.authorPlatform}) in ${where}:`;

    if (peer.orientationSent) return `${header}\n\n`;
    peer.orientationSent = true;
    return `[ClankerCom setup] ${ORIENTATION}\n\n${header}\n\n`;
  }

  /** Sliding-window rate limit on automatically driven turns. */
  _allowAutoTurn(peer) {
    const now = Date.now();
    peer.autoTurnTimes = peer.autoTurnTimes.filter((t) => now - t < AUTO_TURN_WINDOW_MS);
    if (peer.autoTurnTimes.length >= MAX_AUTO_TURNS_PER_WINDOW) return false;
    peer.autoTurnTimes.push(now);
    return true;
  }

  // ============================================
  // Routing: browser -> hub
  // ============================================

  /**
   * A reply appeared that ClankerCom did not ask for — the human typed in the
   * pane, or the conversation continued on its own. Publish it so the rest of
   * the hub sees what was said.
   */
  _handleUnsolicited(peer, event) {
    const channelId = peer.lastChannelId || this._defaultChannelId();
    if (!channelId) return;

    this.hub.postMessage({
      channelId,
      authorId: peer.agentId,
      text: event.text,
      meta: { unsolicited: true },
    });
  }

  // ============================================
  // Queries used by tools and the UI
  // ============================================

  list() {
    return Array.from(this.peers.values()).map((peer) => {
      const agent = this.hub.getAgent(peer.agentId);
      const channel = peer.lastChannelId ? this.hub.getChannel(peer.lastChannelId) : null;
      return {
        ...peer.relay.describe(),
        handle: agent?.handle || peer.id,
        displayName: agent?.displayName || peer.id,
        agentId: peer.agentId,
        channelName: channel?.name || DEFAULT_CHANNEL,
      };
    });
  }

  /** The peer legacy tools address when no target is given. */
  getPrimary() {
    return this.list().find((peer) => peer.locked) || null;
  }

  getByHandle(handle) {
    return this.list().find((peer) => peer.handle === handle) || null;
  }

  cancel(handle) {
    const descriptor = this.getByHandle(handle);
    if (!descriptor) return 0;
    const peer = this.peers.get(descriptor.id);
    return peer ? peer.relay.cancel() : 0;
  }

  // ============================================
  // Internals
  // ============================================

  _requirePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error(`unknown peer: ${peerId}`);
    return peer;
  }

  _handleOf(peer) {
    return this.hub.getAgent(peer.agentId)?.handle || peer.id;
  }

  _defaultChannelId() {
    return this.hub.getChannel(DEFAULT_CHANNEL)?.id || null;
  }

  destroy() {
    for (const peerId of Array.from(this.peers.keys())) this.removePeer(peerId);
  }
}

module.exports = { PeerManager };
