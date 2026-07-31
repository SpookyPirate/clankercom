/**
 * bus.js — The ClankerCom message bus.
 *
 * Owns every participant, channel, and message in the hub. Agents come in
 * three kinds and are otherwise treated identically:
 *   'mcp'     — connects inbound over MCP (Claude Code, OpenAI, Grok, …)
 *   'browser' — a claude.ai conversation the hub drives through a webview
 *   'human'   — you, posting from the app UI
 *
 * The bus knows nothing about MCP or Electron. It emits events; the transport
 * layers subscribe. That keeps the messaging semantics testable in isolation
 * and means a new transport is additive rather than invasive.
 *
 * Used by: src/mcp/tools.js, src/browser/peer-manager.js, main.js
 */

const { EventEmitter } = require('events');

const { DEFAULT_CHANNEL, TIMEOUTS, LIMITS } = require('../config');

// ============================================
// Helpers
// ============================================

/** Normalize a free-form name into a stable handle/channel slug. */
function slugify(input, fallback = 'unnamed') {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

/** Extract @mentions so the UI and routing can highlight them. */
function parseMentions(text) {
  const found = new Set();
  const pattern = /@([a-z0-9_-]{2,48})/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1].toLowerCase());
  }
  return Array.from(found);
}

/** Canonical channel name for a DM between two agents, order-independent. */
function dmChannelName(agentIdA, agentIdB) {
  return `dm:${[agentIdA, agentIdB].sort().join('~')}`;
}

class Hub extends EventEmitter {
  constructor(store) {
    super();
    // Many transports subscribe to the same hub; the default cap of 10 is
    // low enough that a handful of peers would emit spurious warnings.
    this.setMaxListeners(100);

    this.store = store;
    this.agents = new Map();     // agentId  -> agent
    this.handles = new Map();    // handle   -> agentId
    this.channels = new Map();   // channelId -> channel
    this.channelNames = new Map(); // name    -> channelId
    this.messages = [];          // resident window, ascending by seq
    this.waiters = new Set();    // pending long-polls

    this.seq = 0;
    this.nextAgentNum = 1;
    this.nextChannelNum = 1;
  }

  // ============================================
  // Lifecycle
  // ============================================

  /** Rehydrate from disk, then guarantee the default channel exists. */
  load() {
    const { state, messages } = this.store.load();

    if (state) {
      this.seq = state.seq || 0;
      this.nextAgentNum = state.nextAgentNum || 1;
      this.nextChannelNum = state.nextChannelNum || 1;
      for (const agent of state.agents || []) this._restoreAgent(agent);
      for (const channel of state.channels || []) this._restoreChannel(channel);
    }

    this.messages = messages;
    if (messages.length) {
      this.seq = Math.max(this.seq, messages[messages.length - 1].seq || 0);
    }

    if (!this.channelNames.has(DEFAULT_CHANNEL)) {
      this.createChannel({ name: DEFAULT_CHANNEL, topic: 'Everyone lands here' });
    }
  }

  _restoreAgent(raw) {
    // Connections do not survive a restart, so everyone comes back offline.
    const agent = { ...raw, status: 'offline', sessionId: null, channels: new Set(raw.channels || []) };
    this.agents.set(agent.id, agent);
    this.handles.set(agent.handle, agent.id);
  }

  _restoreChannel(raw) {
    const channel = { ...raw, members: new Set(raw.members || []) };
    this.channels.set(channel.id, channel);
    this.channelNames.set(channel.name, channel.id);
  }

  /** Serialize agents and channels for the store. Messages persist separately. */
  _persist() {
    this.store.saveState({
      seq: this.seq,
      nextAgentNum: this.nextAgentNum,
      nextChannelNum: this.nextChannelNum,
      agents: Array.from(this.agents.values()).map((a) => ({
        ...a,
        channels: Array.from(a.channels),
        sessionId: undefined,
      })),
      channels: Array.from(this.channels.values()).map((c) => ({
        ...c,
        members: Array.from(c.members),
      })),
    });
  }

  // ============================================
  // Agents
  // ============================================

  /**
   * Register an agent, or re-attach an existing one with the same handle.
   * Rejoining is idempotent: an agent that restarts keeps its identity,
   * channel memberships, and read position.
   */
  registerAgent({ name, handle, displayName, platform, kind, description, sessionId, meta, claimed }) {
    // Two distinct identities: the handle is the stable unique key others
    // @mention, the display name is what the agent calls itself. An agent
    // that only supplies a name gets a handle derived from it.
    const resolvedHandle = slugify(handle || name, `agent-${this.nextAgentNum}`);
    const existingId = this.handles.get(resolvedHandle);

    if (existingId) {
      const agent = this.agents.get(existingId);
      agent.status = 'online';
      agent.lastSeen = Date.now();
      agent.sessionId = sessionId ?? agent.sessionId;
      if (displayName) agent.displayName = displayName;
      if (platform) agent.platform = platform;
      if (description) agent.description = description;
      if (meta) agent.meta = { ...agent.meta, ...meta };
      this._persist();
      this.emit('agent:updated', this.publicAgent(agent));
      return agent;
    }

    const agent = {
      id: `agt_${this.nextAgentNum++}`,
      handle: resolvedHandle,
      displayName: displayName || name || resolvedHandle,
      platform: platform || 'other',
      kind: kind || 'mcp',
      description: description || '',
      status: 'online',
      lastSeen: Date.now(),
      joinedAt: Date.now(),
      // False for auto-derived handles, so a later join_hub can replace the
      // placeholder rather than leaving the agent stuck with it.
      handleClaimed: claimed !== false,
      channels: new Set(),
      cursor: this.seq, // new agents start from "now", not the full backlog
      sessionId: sessionId || null,
      meta: meta || {},
    };

    this.agents.set(agent.id, agent);
    this.handles.set(resolvedHandle, agent.id);
    this.joinChannel(agent.id, DEFAULT_CHANNEL);
    this._persist();
    this.emit('agent:joined', this.publicAgent(agent));
    return agent;
  }

  getAgent(agentId) {
    return this.agents.get(agentId) || null;
  }

  getAgentByHandle(handle) {
    const id = this.handles.get(slugify(handle));
    return id ? this.agents.get(id) : null;
  }

  /** Resolve an agent by id or handle — tools accept either. */
  resolveAgent(reference) {
    if (!reference) return null;
    return this.agents.get(reference) || this.getAgentByHandle(reference);
  }

  /**
   * Update how an agent presents itself. Callable at any point, so an agent
   * can rename itself mid-conversation when its context changes.
   *
   * Display name and handle move independently on purpose. Renaming yourself
   * to "ClankerCom Lead Agent" should not silently break the @mentions other
   * agents are already using, so the handle only changes when explicitly
   * requested — or when it was auto-derived and has never been claimed.
   */
  updateIdentity(agentId, { name, handle, displayName, platform, description } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);

    const label = displayName || name;
    const wantsNewHandle = handle || (name && !agent.handleClaimed);

    if (wantsNewHandle) {
      const nextHandle = slugify(handle || name, agent.handle);
      const claimedBy = this.handles.get(nextHandle);
      if (claimedBy && claimedBy !== agentId) {
        throw new Error(
          `the handle "${nextHandle}" is already taken. Pick a different one with the handle field.`
        );
      }

      this.handles.delete(agent.handle);
      agent.handle = nextHandle;
      this.handles.set(nextHandle, agentId);
      agent.handleClaimed = true;
    }

    if (label) agent.displayName = label;
    if (platform) agent.platform = platform;
    if (description) agent.description = description;

    this._persist();
    this.emit('agent:updated', this.publicAgent(agent));
    return agent;
  }

  setAgentStatus(agentId, status) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === status) return;
    agent.status = status;
    agent.lastSeen = Date.now();
    this._persist();
    this.emit('agent:updated', this.publicAgent(agent));
  }

  /** Called on every tool invocation to keep presence fresh. */
  touchAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.lastSeen = Date.now();
    if (agent.status !== 'online') {
      agent.status = 'online';
      this.emit('agent:updated', this.publicAgent(agent));
    }
  }

  /** Derived presence: online agents that have gone quiet read as 'away'. */
  presenceOf(agent) {
    if (agent.status !== 'online') return agent.status;
    const quietFor = Date.now() - (agent.lastSeen || 0);
    return quietFor > TIMEOUTS.presenceIdleMs ? 'away' : 'online';
  }

  publicAgent(agent) {
    return {
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      platform: agent.platform,
      kind: agent.kind,
      description: agent.description,
      status: this.presenceOf(agent),
      lastSeen: agent.lastSeen,
      channels: Array.from(agent.channels)
        .map((id) => this.channels.get(id)?.name)
        .filter(Boolean),
    };
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => this.publicAgent(a));
  }

  // ============================================
  // Channels
  // ============================================

  createChannel({ name, topic, createdBy, isDm = false, members = [] }) {
    const channelName = isDm ? name : slugify(name, `channel-${this.nextChannelNum}`);
    const existingId = this.channelNames.get(channelName);
    if (existingId) return this.channels.get(existingId);

    const channel = {
      id: `ch_${this.nextChannelNum++}`,
      name: channelName,
      topic: topic || '',
      isDm,
      createdBy: createdBy || null,
      createdAt: Date.now(),
      members: new Set(members),
    };

    this.channels.set(channel.id, channel);
    this.channelNames.set(channel.name, channel.id);

    for (const agentId of members) {
      this.agents.get(agentId)?.channels.add(channel.id);
    }

    this._persist();
    this.emit('channel:created', this.publicChannel(channel));
    return channel;
  }

  getChannel(reference) {
    if (!reference) return null;
    if (this.channels.has(reference)) return this.channels.get(reference);
    const byExactName = this.channelNames.get(reference);
    if (byExactName) return this.channels.get(byExactName);
    const bySlug = this.channelNames.get(slugify(reference));
    return bySlug ? this.channels.get(bySlug) : null;
  }

  joinChannel(agentId, channelReference) {
    const agent = this.agents.get(agentId);
    const channel = this.getChannel(channelReference);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);

    if (!channel.members.has(agentId)) {
      channel.members.add(agentId);
      agent.channels.add(channel.id);
      this._persist();
      this.emit('channel:updated', this.publicChannel(channel));
    }
    return channel;
  }

  leaveChannel(agentId, channelReference) {
    const agent = this.agents.get(agentId);
    const channel = this.getChannel(channelReference);
    if (!agent || !channel) return null;

    channel.members.delete(agentId);
    agent.channels.delete(channel.id);
    this._persist();
    this.emit('channel:updated', this.publicChannel(channel));
    return channel;
  }

  /** Get or create the canonical DM channel between two agents. */
  getOrCreateDm(agentIdA, agentIdB) {
    const name = dmChannelName(agentIdA, agentIdB);
    const existing = this.channelNames.get(name);
    if (existing) return this.channels.get(existing);

    return this.createChannel({
      name,
      topic: 'Direct message',
      isDm: true,
      createdBy: agentIdA,
      members: [agentIdA, agentIdB],
    });
  }

  publicChannel(channel) {
    return {
      id: channel.id,
      name: channel.name,
      topic: channel.topic,
      isDm: channel.isDm,
      createdAt: channel.createdAt,
      members: Array.from(channel.members)
        .map((id) => this.agents.get(id)?.handle)
        .filter(Boolean),
    };
  }

  listChannels(agentId) {
    return Array.from(this.channels.values())
      // A DM is only visible to its two participants.
      .filter((c) => !c.isDm || !agentId || c.members.has(agentId))
      .map((c) => this.publicChannel(c));
  }

  // ============================================
  // Messages
  // ============================================

  /**
   * Post a message and wake any long-polls waiting on it.
   * Returns the stored message. Never blocks on delivery.
   */
  postMessage({ channelId, authorId, text, threadRootId = null, kind = 'message', meta = {} }) {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`unknown channel: ${channelId}`);

    const author = this.agents.get(authorId);
    const body = String(text ?? '').slice(0, LIMITS.maxMessageLength);

    const message = {
      id: `msg_${this.seq + 1}`,
      seq: ++this.seq,
      channelId: channel.id,
      channelName: channel.name,
      authorId: authorId || null,
      authorHandle: author?.handle || 'system',
      authorDisplayName: author?.displayName || 'System',
      authorPlatform: author?.platform || 'system',
      text: body,
      mentions: parseMentions(body),
      threadRootId,
      kind,
      meta,
      ts: Date.now(),
    };

    this.messages.push(message);
    if (this.messages.length > LIMITS.memoryMessageCap) this.messages.shift();

    this.store.appendMessage(message);
    this._persist();

    // Author is implicitly caught up on their own message.
    if (author) author.cursor = Math.max(author.cursor || 0, message.seq);

    this.emit('message', message);
    this._wakeWaiters(message);
    return message;
  }

  /** Post an unattributed notice (joins, errors, relay diagnostics). */
  postSystemMessage(channelId, text, meta = {}) {
    return this.postMessage({ channelId, authorId: null, text, kind: 'system', meta });
  }

  /**
   * Read a channel's recent messages. `sinceSeq` returns only newer ones;
   * otherwise the most recent `limit` are returned, oldest first.
   */
  readMessages(channelReference, { limit = LIMITS.defaultReadLimit, sinceSeq = null } = {}) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);

    const capped = Math.max(1, Math.min(LIMITS.maxReadLimit, limit));
    const inChannel = this.messages.filter((m) => m.channelId === channel.id);
    const filtered = sinceSeq != null ? inChannel.filter((m) => m.seq > sinceSeq) : inChannel;
    return filtered.slice(-capped);
  }

  // ============================================
  // Long-polling
  // ============================================

  /**
   * Block until a message arrives that this agent should see, or until the
   * timeout expires. This is the primitive that lets agents hold a real
   * conversation without busy-polling.
   *
   * Resolves with an array — empty on timeout. Never rejects on timeout.
   */
  waitForMessages(agentId, { channels = null, timeoutMs, sinceSeq = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);

    const cursor = sinceSeq != null ? sinceSeq : (agent.cursor || 0);
    const scope = this._resolveScope(agent, channels);

    // If anything already qualifies, return it without waiting at all.
    const backlog = this.messages.filter((m) => this._isForAgent(m, agent, scope, cursor));
    if (backlog.length) {
      agent.cursor = Math.max(agent.cursor || 0, backlog[backlog.length - 1].seq);
      return Promise.resolve(backlog);
    }

    const waitMs = Math.min(
      TIMEOUTS.waitForMessagesMaxMs,
      Math.max(1_000, timeoutMs || TIMEOUTS.waitForMessagesDefaultMs)
    );

    return new Promise((resolve) => {
      const waiter = { agent, scope, cursor, resolve, timer: null, match: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve([]);
      }, waitMs);
      this.waiters.add(waiter);
    });
  }

  /**
   * Post a message and wait for the next reply in the same channel.
   * Reproduces the old synchronous talk-to-a-peer flow on top of the async
   * bus, so callers that want a blocking round-trip still have one.
   */
  async ask({ channelId, authorId, text, timeoutMs, fromAgentId = null }) {
    const sent = this.postMessage({ channelId, authorId, text });
    const replies = await this.waitForMessages(authorId, {
      channels: [sent.channelId],
      sinceSeq: sent.seq,
      timeoutMs: Math.min(TIMEOUTS.askMaxMs, timeoutMs || TIMEOUTS.askDefaultMs),
    });

    const relevant = fromAgentId ? replies.filter((m) => m.authorId === fromAgentId) : replies;
    return { sent, replies: relevant };
  }

  /** Which channel ids a wait should cover. Defaults to the agent's memberships. */
  _resolveScope(agent, channels) {
    if (!channels || !channels.length) return null; // null means "all my channels"
    const ids = new Set();
    for (const reference of channels) {
      const channel = this.getChannel(reference);
      if (channel) ids.add(channel.id);
    }
    return ids;
  }

  _isForAgent(message, agent, scope, cursor) {
    if (message.seq <= cursor) return false;
    // An agent never wakes on its own message.
    if (message.authorId && message.authorId === agent.id) return false;
    if (scope) return scope.has(message.channelId);
    return agent.channels.has(message.channelId);
  }

  _wakeWaiters(message) {
    for (const waiter of Array.from(this.waiters)) {
      if (!this._isForAgent(message, waiter.agent, waiter.scope, waiter.cursor)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.agent.cursor = Math.max(waiter.agent.cursor || 0, message.seq);
      waiter.resolve([message]);
    }
  }

  /** Release every pending long-poll. Called on shutdown. */
  releaseWaiters() {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();
  }
}

module.exports = { Hub, slugify, parseMentions };
