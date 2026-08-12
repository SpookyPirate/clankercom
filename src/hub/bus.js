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

const { DEFAULT_CHANNEL, DEFAULT_CHANNEL_BRIEF, TIMEOUTS, LIMITS } = require('../config');
const { TaskBoard } = require('./tasks');
const { FileVault } = require('./files');

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

/**
 * Permissions a group can grant. An open map rather than a fixed set — adding
 * a capability later means adding a key here and honouring it, with existing
 * groups defaulting to not having it.
 */
const DEFAULT_GROUP_PERMISSIONS = {
  // Work raised by a member skips the human approval queue.
  autoApproveTasks: false,

  // Shared files. Reading is granted by default because it is inert and the
  // whole point of a common folder; writing is not, because it changes state
  // every other member of the channel then relies on.
  readChannelFiles: true,
  writeChannelFiles: false,
  readGlobalFiles: true,
  writeGlobalFiles: false,
};

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
    this.groups = new Map();     // groupId  -> group (agent roles)
    this.channelGroups = new Map(); // channelGroupId -> category
    this.messages = [];          // resident window, ascending by seq
    this.waiters = new Set();    // pending long-polls

    this.seq = 0;
    this.nextAgentNum = 1;
    this.nextChannelNum = 1;
    this.nextGroupNum = 1;
    this.nextChannelGroupNum = 1;

    this.defaultChannelName = DEFAULT_CHANNEL;

    // Hub-wide settings, persisted so the human never has to wonder whether
    // approval is currently required.
    this.settings = { autoApproveTasks: false };

    this.taskBoard = new TaskBoard(this);
    this.files = new FileVault(this, store.dataDir);
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
      this.nextGroupNum = state.nextGroupNum || 1;
      this.nextChannelGroupNum = state.nextChannelGroupNum || 1;
      this.settings = { ...this.settings, ...(state.settings || {}) };
      for (const agent of state.agents || []) this._restoreAgent(agent);
      for (const channel of state.channels || []) this._restoreChannel(channel);
      for (const group of state.groups || []) this.groups.set(group.id, group);
      for (const group of state.channelGroups || []) this.channelGroups.set(group.id, group);
      this.taskBoard.restore(state.tasks);
      this.files.restore(state.files);
    }

    this.messages = messages;
    if (messages.length) {
      this.seq = Math.max(this.seq, messages[messages.length - 1].seq || 0);
    }

    this._pruneDetachedBrowserAgents();

    if (!this.channelNames.has(DEFAULT_CHANNEL)) {
      this.createChannel({ name: DEFAULT_CHANNEL, topic: 'Everyone lands here' });
    }
  }

  _restoreAgent(raw) {
    // Connections do not survive a restart, so everyone comes back offline.
    const agent = {
      ...raw,
      status: 'offline',
      sessionId: null,
      channels: new Set(raw.channels || []),
      groupIds: new Set(raw.groupIds || []),
    };
    this.agents.set(agent.id, agent);
    this.handles.set(agent.handle, agent.id);
  }

  /**
   * Drop browser peers left over from a previous run.
   *
   * A browser peer cannot outlive the webview that hosted it — the relay is
   * gone, so nothing can drive the conversation. Restoring one leaves an agent
   * in the roster that looks reachable and silently ignores every mention.
   *
   * History is unaffected: messages carry a denormalized author handle and
   * display name precisely so the record survives the agent.
   */
  _pruneDetachedBrowserAgents() {
    for (const agent of Array.from(this.agents.values())) {
      if (agent.kind !== 'browser') continue;

      this.agents.delete(agent.id);
      this.handles.delete(agent.handle);
      for (const channelId of agent.channels) {
        this.channels.get(channelId)?.members.delete(agent.id);
      }
    }
  }

  _restoreChannel(raw) {
    const channel = { ...raw, members: new Set(raw.members || []) };

    // Channels created before briefs existed have no field at all; give them
    // the house default so an upgrade improves them rather than leaving them
    // silently worse than a fresh install. An empty string is left alone — that
    // is a human having deliberately cleared it, not an absence.
    if (channel.brief === undefined) {
      channel.brief = channel.isDm ? '' : DEFAULT_CHANNEL_BRIEF;
    }
    this.channels.set(channel.id, channel);
    this.channelNames.set(channel.name, channel.id);
  }

  /** Serialize everything but messages, which persist to their own log. */
  _persist() {
    this.store.saveState({
      seq: this.seq,
      nextAgentNum: this.nextAgentNum,
      nextChannelNum: this.nextChannelNum,
      nextGroupNum: this.nextGroupNum,
      nextChannelGroupNum: this.nextChannelGroupNum,
      settings: this.settings,
      agents: Array.from(this.agents.values()).map((a) => ({
        ...a,
        channels: Array.from(a.channels),
        groupIds: Array.from(a.groupIds),
        sessionId: undefined,
      })),
      channels: Array.from(this.channels.values()).map((c) => ({
        ...c,
        members: Array.from(c.members),
      })),
      groups: Array.from(this.groups.values()),
      channelGroups: Array.from(this.channelGroups.values()),
      tasks: this.taskBoard.serialize(),
      files: this.files.serialize(),
    });
  }

  /** Public alias, for subsystems that mutate hub-owned state. */
  persist() {
    this._persist();
  }

  /** Change a hub-wide setting. Currently just task auto-approval. */
  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._persist();
    this.emit('settings:changed', this.settings);
    return this.settings;
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
      groupIds: new Set(),
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
      groupIds: Array.from(agent.groupIds || []),
      groups: Array.from(agent.groupIds || [])
        .map((id) => this.groups.get(id)?.name)
        .filter(Boolean),
      canAutoApprove: this.canAutoApprove(agent.id),
      channels: Array.from(agent.channels)
        .map((id) => this.channels.get(id)?.name)
        .filter(Boolean),
    };
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => this.publicAgent(a));
  }

  /**
   * Remove an agent from the roster. Used to clear out old connections that
   * are never coming back.
   *
   * History is unaffected — every message carries a denormalized author handle
   * and display name precisely so the record outlives the agent.
   */
  removeAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    // The operator is not a participant that can be evicted. The console no
    // longer offers it, but the rule belongs here rather than in the one UI
    // that happened to expose it — main.js recreates the human on every launch,
    // so a removal would look like it worked and quietly come back.
    if (agent.kind === 'human') {
      throw new Error('the human running ClankerCom cannot be removed from the roster');
    }

    for (const channelId of agent.channels) {
      this.channels.get(channelId)?.members.delete(agentId);
    }
    this.agents.delete(agentId);
    this.handles.delete(agent.handle);

    // Any long-poll this agent was holding would otherwise never resolve.
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.agent.id !== agentId) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve([]);
    }
    this._announceListeners();

    this._persist();
    this.emit('agent:removed', { id: agentId, handle: agent.handle });
    return agent;
  }

  // ============================================
  // Groups
  // ============================================

  /**
   * Groups behave like roles: an agent holds as many as apply, and each group
   * carries permissions the human grants to everyone in it.
   *
   * Agents can read their own groups, so "you are in Research" is something an
   * agent can act on rather than decoration for the human alone.
   */
  createGroup({ name, permissions = {} }) {
    const label = String(name || '').trim().slice(0, 48) || `Group ${this.nextGroupNum}`;
    const existing = Array.from(this.groups.values()).find(
      (group) => group.name.toLowerCase() === label.toLowerCase()
    );
    if (existing) return existing;

    const group = {
      id: `grp_${this.nextGroupNum++}`,
      name: label,
      permissions: { ...DEFAULT_GROUP_PERMISSIONS, ...permissions },
      createdAt: Date.now(),
    };
    this.groups.set(group.id, group);
    this._persist();
    this.emit('group:changed', this.listGroups());
    return group;
  }

  renameGroup(groupId, name) {
    const group = this._requireGroup(groupId);
    group.name = String(name).trim().slice(0, 48) || group.name;
    this._persist();
    this.emit('group:changed', this.listGroups());
    return group;
  }

  /**
   * Grant or revoke a permission for everyone in a group. Permissions are an
   * open map rather than a fixed set, so a new one is additive.
   */
  setGroupPermission(groupId, permission, value) {
    const group = this._requireGroup(groupId);
    group.permissions = { ...group.permissions, [permission]: !!value };
    this._persist();
    this.emit('group:changed', this.listGroups());
    return group;
  }

  /** Deleting a group leaves its members in place, just without that role. */
  deleteGroup(groupId) {
    if (!this.groups.has(groupId)) return null;

    for (const agent of this.agents.values()) agent.groupIds.delete(groupId);
    this.groups.delete(groupId);

    this._persist();
    this.emit('group:changed', this.listGroups());
    return groupId;
  }

  setGroupMembership(agentId, groupId, isMember) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    this._requireGroup(groupId);

    // Groups grant agents permissions. `can()` short-circuits to true for a
    // human before it ever looks at groups, so putting one in a group would
    // change nothing while appearing to change something.
    if (agent.kind === 'human') {
      throw new Error('agent groups apply to agents; the human already has every permission');
    }

    if (isMember) agent.groupIds.add(groupId);
    else agent.groupIds.delete(groupId);

    this._persist();
    this.emit('agent:updated', this.publicAgent(agent));
    return agent;
  }

  /**
   * Whether an agent holds a permission.
   *
   * Two rules, and the interaction between them is the whole model:
   *
   *   1. An agent holding no groups falls back to the defaults, so a fresh
   *      connection can read shared files without any setup.
   *   2. Once it holds groups, its groups define it — and among them
   *      permissions *add*. Holding one permissive group is enough, whatever
   *      else it holds, so a trusted role is never cancelled by an untrusted
   *      one. New groups start from the same defaults, so adding an agent to a
   *      group never silently strips something it already had unless the human
   *      deliberately turned that permission off.
   *
   * The human runs the hub and is not gated by any of it.
   */
  can(agentId, permission, { channelId = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.kind === 'human') return true;

    if (permission === 'autoApproveTasks' && this.settings.autoApproveTasks) return true;

    // A channel group can grant file-write across its channels to named agent
    // groups. This is the join between the two axes, and like every other
    // permission here it only ever adds: a category grant cannot take away
    // something a role already carried, and vice versa.
    if (permission === 'writeChannelFiles' && channelId && this._categoryGrantsWrite(agent, channelId)) {
      return true;
    }

    if (agent.groupIds.size === 0) return DEFAULT_GROUP_PERMISSIONS[permission] === true;

    return Array.from(agent.groupIds).some(
      (groupId) => this.groups.get(groupId)?.permissions?.[permission] === true
    );
  }

  _categoryGrantsWrite(agent, channelId) {
    const channel = this.channels.get(channelId) || this.getChannel(channelId);
    const group = channel && this.channelGroups.get(channel.channelGroupId);
    if (!group || !group.writeGroupIds?.length) return false;
    return group.writeGroupIds.some((agentGroupId) => agent.groupIds.has(agentGroupId));
  }

  /** Whether work raised by this agent skips the approval queue. */
  canAutoApprove(agentId) {
    return this.can(agentId, 'autoApproveTasks');
  }

  /**
   * Raise a permission failure that names the capability rather than just
   * refusing, so an agent can tell its human what to grant.
   */
  requirePermission(agentId, permission, action, scope = {}) {
    if (this.can(agentId, permission, scope)) return;
    throw new Error(
      `you do not have permission to ${action}. Ask the human to grant "${permission}" ` +
        `to one of your groups in the console.`
    );
  }

  resolveGroup(reference) {
    if (!reference) return null;
    if (this.groups.has(reference)) return this.groups.get(reference);
    return (
      Array.from(this.groups.values()).find(
        (group) => group.name.toLowerCase() === String(reference).toLowerCase()
      ) || null
    );
  }

  listGroups() {
    return Array.from(this.groups.values()).map((group) => ({
      ...group,
      members: Array.from(this.agents.values())
        .filter((agent) => agent.groupIds.has(group.id))
        .map((agent) => agent.handle),
    }));
  }

  _requireGroup(groupId) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`no group with id ${groupId}`);
    return group;
  }

  // ============================================
  // Channel groups
  // ============================================

  /**
   * Channel groups — categories that channels sit inside and inherit from.
   *
   * Two products solve this differently and only one of them is relevant here.
   * Slack sections are a *personal* sidebar arrangement: per-user, carrying no
   * permissions, invisible to everyone else. With one human at one console that
   * solves nothing. Discord categories are *structural*: everyone sees the same
   * ones, and channels inside inherit the category's settings.
   *
   * So this follows Discord, including the part of its design worth copying —
   * a channel is either **synced** with its group or it is not. Override
   * something on the channel and it stops tracking the group; a resync pulls it
   * back. That makes drift visible instead of silent, which is the whole
   * problem with inheritance that only flows one way.
   *
   * What a group carries is what is actually worth setting once for a set of
   * channels: the brief every agent reads, and which agent groups may write
   * files in them. That second one is the join between the two axes — agent
   * groups answer "what may this agent do", channel groups answer "what are the
   * rules in this room", and the grant is the intersection.
   */
  createChannelGroup({ name, brief = '' } = {}) {
    const label = String(name || '').trim().slice(0, 48) || `Group ${this.nextChannelGroupNum}`;
    const existing = Array.from(this.channelGroups.values()).find(
      (group) => group.name.toLowerCase() === label.toLowerCase()
    );
    if (existing) return existing;

    const group = {
      id: `cgrp_${this.nextChannelGroupNum++}`,
      name: label,
      brief: String(brief || '').slice(0, LIMITS.maxBriefLength),
      // Agent groups whose members may write files in channels here. Additive,
      // like every other permission in the hub: this grants, never revokes.
      writeGroupIds: [],
      order: this.channelGroups.size,
      createdAt: Date.now(),
    };

    this.channelGroups.set(group.id, group);
    this._persist();
    this.emit('channelGroups:changed', this.listChannelGroups());
    return group;
  }

  updateChannelGroup(groupId, { name, brief } = {}) {
    const group = this.channelGroups.get(groupId);
    if (!group) throw new Error(`unknown channel group: ${groupId}`);

    if (typeof name === 'string' && name.trim()) group.name = name.trim().slice(0, 48);
    if (typeof brief === 'string') group.brief = brief.slice(0, LIMITS.maxBriefLength);

    this._persist();
    this.emit('channelGroups:changed', this.listChannelGroups());
    // Synced channels just changed meaning, so the console has to redraw them.
    for (const channel of this.channels.values()) {
      if (channel.channelGroupId === groupId) {
        this.emit('channel:updated', this.publicChannel(channel));
      }
    }
    return group;
  }

  /** Grant or revoke file-write for an agent group across this category. */
  setChannelGroupWriteAccess(groupId, agentGroupId, allowed) {
    const group = this.channelGroups.get(groupId);
    if (!group) throw new Error(`unknown channel group: ${groupId}`);

    const held = new Set(group.writeGroupIds || []);
    if (allowed) held.add(agentGroupId);
    else held.delete(agentGroupId);
    group.writeGroupIds = Array.from(held);

    this._persist();
    this.emit('channelGroups:changed', this.listChannelGroups());
    return group;
  }

  /** Removing a group leaves its channels intact and ungrouped. */
  deleteChannelGroup(groupId) {
    if (!this.channelGroups.has(groupId)) return false;

    for (const channel of this.channels.values()) {
      if (channel.channelGroupId !== groupId) continue;
      // Keep whatever the channel was showing, so deleting a category never
      // silently changes what agents in those channels are being told.
      channel.brief = this.effectiveBrief(channel);
      channel.channelGroupId = null;
      channel.briefSynced = false;
      this.emit('channel:updated', this.publicChannel(channel));
    }

    this.channelGroups.delete(groupId);
    this._persist();
    this.emit('channelGroups:changed', this.listChannelGroups());
    return true;
  }

  /** Move a channel into a group, or out of one with a null group. */
  setChannelGroup(channelReference, groupId) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);
    if (groupId && !this.channelGroups.has(groupId)) {
      throw new Error(`unknown channel group: ${groupId}`);
    }

    channel.channelGroupId = groupId || null;
    // Joining a group means adopting its settings — the Discord behaviour, and
    // the only one that makes a category worth creating.
    if (groupId) channel.briefSynced = true;

    this._persist();
    this.emit('channel:updated', this.publicChannel(channel));
    return channel;
  }

  /** Pull a drifted channel back onto its group's settings. */
  resyncChannel(channelReference) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);
    if (!channel.channelGroupId) throw new Error(`#${channel.name} is not in a channel group`);

    channel.briefSynced = true;
    this._persist();
    this.emit('channel:updated', this.publicChannel(channel));
    return channel;
  }

  /**
   * What agents in this channel are actually told.
   *
   * A synced channel in a group whose brief is set reads the group's. Anything
   * else falls back to the channel's own, which is what an override writes to.
   */
  effectiveBrief(channel) {
    if (channel.channelGroupId && channel.briefSynced !== false) {
      const group = this.channelGroups.get(channel.channelGroupId);
      if (group && group.brief) return group.brief;
    }
    return channel.brief || '';
  }

  listChannelGroups() {
    return Array.from(this.channelGroups.values())
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((group) => ({
        ...group,
        writeGroupIds: Array.from(group.writeGroupIds || []),
        channels: Array.from(this.channels.values())
          .filter((channel) => channel.channelGroupId === group.id && !channel.isDm)
          .map((channel) => channel.name),
      }));
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
      // Standing context handed to agents on arrival; see setChannelBrief.
      // Every channel starts with the house default rather than empty, so the
      // out-of-the-box behaviour is the good one. DMs get none — there is no
      // room to read, so there is nothing to be tactful about.
      brief: isDm ? '' : DEFAULT_CHANNEL_BRIEF,
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

    // The operator is in every room. The console shows every channel in the
    // rail whatever its membership, so a human who was not a member could read
    // and post in a channel while the agents in it were told nobody else was
    // there — and a channel an agent created over MCP left the human out
    // entirely. Membership now matches what is actually true.
    if (!isDm) {
      for (const agent of this.agents.values()) {
        if (agent.kind !== 'human') continue;
        channel.members.add(agent.id);
        agent.channels.add(channel.id);
      }
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
      // What agents actually read, after inheritance. `ownBrief` is what an
      // override would edit, which the console needs to show the two apart.
      brief: this.effectiveBrief(channel),
      ownBrief: channel.brief || '',
      channelGroupId: channel.channelGroupId || null,
      briefSynced: channel.briefSynced !== false,
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

    message.audience = this._audienceFor(channel, authorId);

    this.emit('message', message);

    // Waking a waiter removes it from the pool, so the moment this returns the
    // listener count is back to zero. Anything asking "was anyone listening?"
    // afterwards gets "no" even when the message was delivered instantly —
    // which is precisely backwards. The answer only exists here, so it rides
    // back with the message rather than being reconstructed from events.
    message.deliveredTo = this._wakeWaiters(message);
    return message;
  }

  /**
   * The agents a message was actually aimed at, captured when it is posted.
   *
   * Read receipts are per-agent and always were, but the console reported the
   * first reader with no denominator — so "Read by @alpha" looked like the
   * message had been handled when four others had not seen it. Knowing how many
   * were in the room at the time is what turns that into "1 of 5".
   *
   * Humans are excluded because they generate no receipts, and the author is
   * excluded because reading your own message is not a fact worth reporting.
   */
  _audienceFor(channel, authorId) {
    const handles = [];
    for (const memberId of channel.members) {
      if (memberId === authorId) continue;
      const agent = this.agents.get(memberId);
      if (!agent || agent.kind === 'human') continue;
      handles.push(agent.handle);
    }
    return handles;
  }

  /**
   * Standing context every agent is handed on arrival in a channel.
   *
   * An agent joining mid-conversation knows only what the tool descriptions
   * say — nothing about what this particular room is for or how to behave in
   * it. With several agents in one channel that gap is what produces six
   * replies to a message meant for one of them.
   */
  setChannelBrief(channelReference, brief) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);
    channel.brief = String(brief || '').slice(0, LIMITS.maxBriefLength || 2000);
    // Writing a brief on the channel is an override, so it stops tracking its
    // group. Drift has to be visible; silent divergence is the failure mode
    // one-way inheritance always has.
    if (channel.channelGroupId) channel.briefSynced = false;
    this._persist();
    this.emit('channel:updated', this.publicChannel(channel));
    return channel;
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
  // Clearing and export
  // ============================================

  /**
   * Delete a channel's conversation history.
   *
   * The resident window is only half of it — the transcript on disk is the
   * durable copy, so it is rewritten without this channel's lines. Anything
   * less would restore every "deleted" message on the next launch.
   *
   * Returns how many messages were removed.
   */
  /**
   * Delete a channel outright: its messages, its shared files, and the channel.
   *
   * The default channel is refused rather than deleted, because load() recreates
   * it — deleting it would appear to work, survive until the next launch, and
   * come back empty with every member gone. A refusal is honest; a deletion that
   * silently undoes itself is not.
   *
   * DMs are refused too. A DM channel is derived from its two participants, so
   * it would simply be recreated by the next message between them.
   */
  async deleteChannel(channelReference) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);
    if (channel.isDm) throw new Error('a direct message cannot be deleted');
    if (channel.name === DEFAULT_CHANNEL) {
      throw new Error(
        `#${DEFAULT_CHANNEL} cannot be deleted — every agent lands there on connect. ` +
          `Clear its history instead.`
      );
    }

    const removedMessages = await this.clearChannel(channel.id);
    this.files.removeChannelScope(channel.id);

    for (const memberId of channel.members) {
      this.agents.get(memberId)?.channels.delete(channel.id);
    }

    this.channels.delete(channel.id);
    this.channelNames.delete(channel.name);
    this._persist();
    this.emit('channel:removed', { id: channel.id, name: channel.name });
    return { name: channel.name, removedMessages };
  }

  async clearChannel(channelReference) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);

    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.channelId !== channel.id);
    const removedResident = before - this.messages.length;

    const removedOnDisk = await this.store.deleteChannelMessages(channel.id);

    this._persist();
    this.emit('channel:cleared', { id: channel.id, name: channel.name });
    return Math.max(removedResident, removedOnDisk);
  }

  /**
   * Render a channel as a markdown transcript.
   *
   * Written to be read later by a person or handed to another model, so it
   * leads with who took part and groups by day rather than emitting a flat
   * list of timestamps.
   */
  async exportChannelMarkdown(channelReference) {
    const channel = this.getChannel(channelReference);
    if (!channel) throw new Error(`unknown channel: ${channelReference}`);

    const messages = await this.allChannelMessages(channel.id);
    const label = channel.isDm ? 'Direct message' : `#${channel.name}`;

    const participants = new Map();
    for (const message of messages) {
      if (message.kind === 'system' || !message.authorHandle) continue;
      participants.set(message.authorHandle, {
        name: message.authorDisplayName || message.authorHandle,
        platform: message.authorPlatform,
      });
    }

    const lines = [`# ${label}`, ''];
    if (channel.topic) lines.push(`> ${channel.topic}`, '');
    lines.push(
      `**Exported** ${new Date().toLocaleString()}  `,
      `**Messages** ${messages.length}`,
      ''
    );

    if (participants.size) {
      lines.push('## Participants', '');
      for (const [handle, who] of participants) {
        lines.push(`- **${who.name}** \`@${handle}\` — ${who.platform}`);
      }
      lines.push('');
    }

    lines.push('## Transcript', '');

    let lastDay = null;
    for (const message of messages) {
      const day = new Date(message.ts).toDateString();
      if (day !== lastDay) {
        lines.push(`### ${new Date(message.ts).toLocaleDateString([], {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        })}`, '');
        lastDay = day;
      }

      const time = new Date(message.ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

      if (message.kind === 'system') {
        lines.push(`_${time} — ${message.text}_`, '');
        continue;
      }

      lines.push(
        `**${message.authorDisplayName || message.authorHandle}** ` +
          `\`@${message.authorHandle}\` · ${time}`,
        '',
        message.text,
        ''
      );
    }

    lines.push('---', '', `_Exported from ClankerCom._`);
    return lines.join('\n');
  }

  // ============================================
  // Search
  // ============================================

  /**
   * Find messages by text, across the whole transcript rather than the
   * resident window.
   *
   * This is the one read that must reach disk. `read_messages` returns the
   * most recent N and `since_seq` only moves forward, so without this there is
   * no way for anyone — human or agent — to look backward for a topic. For an
   * app whose value is accumulated context, that was the sharpest gap in it.
   *
   * A linear scan, deliberately. The transcript is one file of a few tens of
   * megabytes at worst, this runs on an explicit user action rather than on
   * the messaging path, and an index would need maintaining against a log that
   * is otherwise append-only. If search ever becomes hot, that is the signal
   * to reconsider — not before.
   */
  async search({ query, channelId = null, fromHandle = null, limit = 50, viewerId = null }) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle && !fromHandle) return [];

    const visible = this._visibleChannelIds(viewerId);
    const matches = (message) => {
      if (channelId && message.channelId !== channelId) return false;
      if (visible && !visible.has(message.channelId)) return false;
      if (fromHandle && message.authorHandle !== fromHandle) return false;
      return !needle || message.text.toLowerCase().includes(needle);
    };

    const found = new Map();
    for (const message of await this.store.scanMessages(matches)) found.set(message.id, message);
    // The resident window is authoritative for anything recent, and covers
    // messages written since the last flush to disk.
    for (const message of this.messages) if (matches(message)) found.set(message.id, message);

    return Array.from(found.values())
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Math.max(1, Math.min(LIMITS.maxReadLimit, limit)));
  }

  /**
   * Which channels a searcher may see. A DM must never surface in someone
   * else's results. Null means no restriction, for the console's own searches.
   */
  _visibleChannelIds(viewerId) {
    if (!viewerId) return null;

    const ids = new Set();
    for (const channel of this.channels.values()) {
      if (!channel.isDm || channel.members.has(viewerId)) ids.add(channel.id);
    }
    return ids;
  }

  /** Every message in a channel, resident window plus on-disk history. */
  async allChannelMessages(channelId) {
    const resident = this.messages.filter((message) => message.channelId === channelId);
    const oldest = resident.length ? resident[0].seq : null;
    const older = await this.store.readChannelHistory(channelId, {
      beforeSeq: oldest,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return [...older, ...resident].sort((a, b) => a.seq - b.seq);
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
      this.markSeen(backlog, agent);
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
        this._announceListeners();
        resolve([]);
      }, waitMs);
      this.waiters.add(waiter);
      this._announceListeners();
    });
  }

  /**
   * Who is currently parked in wait_for_messages.
   *
   * This is the answer to the question the console could not previously
   * answer: is anyone actually listening? A message sent to a hub where every
   * agent is idle looks identical to one sent to a hub full of attentive
   * agents, and the human is left wondering whether the app is broken.
   */
  listeners() {
    const handles = new Set();
    for (const waiter of this.waiters) handles.add(waiter.agent.handle);
    return Array.from(handles);
  }

  _announceListeners() {
    this.emit('listeners:changed', this.listeners());
  }

  /**
   * Record that an agent actually received a message.
   *
   * Held in memory rather than written to the log: it is a live indicator of
   * what is happening right now, not part of the record. A restart forgetting
   * who had read what is the correct behaviour, not a loss.
   */
  markSeen(messages, agent) {
    if (!agent || agent.kind === 'human') return;

    const touched = [];
    for (const message of messages) {
      if (message.authorId === agent.id) continue;
      if (!message.seenBy) message.seenBy = new Set();
      if (message.seenBy.has(agent.handle)) continue;

      message.seenBy.add(agent.handle);
      touched.push(message);
    }

    for (const message of touched) {
      this.emit('message:seen', {
        id: message.id,
        seq: message.seq,
        channelName: message.channelName,
        seenBy: Array.from(message.seenBy),
      });
    }
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

  /** Hand the message to everyone parked on it. Returns the handles woken. */
  _wakeWaiters(message) {
    const delivered = new Set();
    for (const waiter of Array.from(this.waiters)) {
      if (!this._isForAgent(message, waiter.agent, waiter.scope, waiter.cursor)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.agent.cursor = Math.max(waiter.agent.cursor || 0, message.seq);
      this.markSeen([message], waiter.agent);
      waiter.resolve([message]);
      delivered.add(waiter.agent.handle);
    }
    this._announceListeners();
    return Array.from(delivered);
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
