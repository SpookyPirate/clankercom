/**
 * handlers.js — Implementations for every tool in tool-specs.js.
 *
 * Each handler receives (args, context) where context carries the hub, the
 * browser peer manager, and the per-session identity record. Handlers are
 * transport-agnostic: the HTTP server and any future transport can reuse them.
 *
 * Results are returned as human-readable text rather than raw JSON wherever a
 * model is the consumer. Transcripts especially: a formatted transcript costs
 * far fewer tokens than the equivalent JSON and models read it more reliably.
 *
 * Used by: src/mcp/http-server.js
 */

const { TIMEOUTS } = require('../config');
const { slugify } = require('../hub/bus');

// ============================================
// Result formatting
// ============================================

/** Wrap a value in the MCP tool-result envelope. */
function asText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Render a clock time for transcripts, local to the hub machine. */
function clock(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Render messages as a compact transcript. Sequence numbers are included so a
 * caller can resume precisely with since_seq.
 */
function formatTranscript(messages, { header } = {}) {
  if (!messages.length) return header ? `${header}\n(no messages)` : '(no messages)';

  const lines = messages.map((message) => {
    // Handle first because that is what a reader needs in order to reply;
    // the self-chosen name and platform follow as context.
    const who =
      message.kind === 'system'
        ? '* system'
        : `@${message.authorHandle} (${message.authorDisplayName}, ${message.authorPlatform})`;
    return `[${message.seq}] ${clock(message.ts)} #${message.channelName} ${who}: ${message.text}`;
  });

  const latest = messages[messages.length - 1].seq;
  const body = lines.join('\n');
  return `${header ? header + '\n' : ''}${body}\n\n-- latest seq: ${latest} --`;
}

/** Render tasks as a compact list. Status leads, since that drives what to do next. */
function formatTasks(tasks) {
  return tasks
    .map((task) => {
      const status = task.status.replace('_', ' ');
      const header = `${task.id}  [${status}]  @${task.fromHandle} → @${task.toHandle}`;
      const detail = task.detail ? `\n     ${task.detail.replace(/\n/g, '\n     ')}` : '';
      return `${header}\n     ${task.title}${detail}`;
    })
    .join('\n\n');
}

// ============================================
// Identity
// ============================================

/**
 * Resolve the calling agent, registering one on first contact.
 *
 * Agents are not required to call join_hub: an identity is derived from the
 * MCP client name so a freshly connected agent can talk immediately. The
 * handle is de-duplicated because several Claude Code instances all announce
 * themselves with the same client name.
 */
function ensureIdentity(context) {
  const { hub, session } = context;
  if (session.agentId && hub.getAgent(session.agentId)) {
    hub.touchAgent(session.agentId);
    return hub.getAgent(session.agentId);
  }

  const clientName = session.clientInfo?.name || 'agent';
  const agent = hub.registerAgent({
    handle: uniqueHandle(hub, clientName),
    displayName: `${clientName} (unnamed)`,
    platform: guessPlatform(clientName),
    kind: 'mcp',
    description: 'Auto-registered on connect. Call join_hub to say who you are.',
    sessionId: session.id,
    // Placeholder handle: join_hub may replace it with one derived from the
    // name the agent picks for itself.
    claimed: false,
  });

  session.agentId = agent.id;
  return agent;
}

/**
 * Pick the handle an auto-registering client should get.
 *
 * A client that reconnects — a closed and reopened editor window, a restarted
 * process — should come back as itself rather than accumulating
 * `claude-code-2`, `-3`, `-4` beside its own ghosts. So an existing identity
 * is reclaimed when it is safe to do so.
 *
 * "Safe" means the holder is **offline** and never claimed the handle
 * deliberately. Two windows open at once are two agents and must stay
 * distinct, which is exactly what the offline test preserves: a live holder is
 * never displaced, and the newcomer takes a suffix as before.
 */
function uniqueHandle(hub, desired) {
  const base = slugify(desired, 'agent');

  const holder = hub.getAgentByHandle(base);
  if (!holder) return base;
  if (isReclaimable(holder)) return base;

  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    const occupant = hub.getAgentByHandle(candidate);
    if (!occupant || isReclaimable(occupant)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** An auto-derived identity whose connection is gone can be taken over. */
function isReclaimable(agent) {
  return agent.kind === 'mcp' && agent.status === 'offline' && !agent.handleClaimed;
}

/** Map an MCP client name onto a known platform for UI grouping. */
function guessPlatform(clientName) {
  const name = String(clientName).toLowerCase();
  if (name.includes('claude-code') || name.includes('claude code')) return 'claude-code';
  if (name.includes('claude')) return 'claude-desktop';
  if (name.includes('openai') || name.includes('gpt')) return 'openai';
  if (name.includes('grok') || name.includes('xai')) return 'grok';
  if (name.includes('gemini')) return 'gemini';
  return 'other';
}

// ============================================
// Target resolution
// ============================================

/** Strip the sigil users and models habitually type. */
function stripSigil(reference) {
  return String(reference || '').replace(/^[#@]/, '').trim();
}

/**
 * Resolve an ask/send target into a channel.
 * "@handle" opens a DM; anything else is treated as a channel name, falling
 * back to an agent handle so "ask code-reviewer" also works.
 */
function resolveTarget(hub, selfAgent, target) {
  const bare = stripSigil(target);

  if (String(target).startsWith('@')) {
    const peer = hub.resolveAgent(bare);
    if (!peer) throw new Error(`no agent with handle "${bare}". Call list_agents to see who is here.`);
    return { channel: hub.getOrCreateDm(selfAgent.id, peer.id), targetAgent: peer };
  }

  const channel = hub.getChannel(bare);
  if (channel) return { channel, targetAgent: null };

  const peer = hub.resolveAgent(bare);
  if (peer) {
    return { channel: hub.getOrCreateDm(selfAgent.id, peer.id), targetAgent: peer };
  }

  throw new Error(
    `"${bare}" is neither a channel nor an agent. Call list_channels or list_agents to see what exists.`
  );
}

/**
 * Work out which folder a file tool means.
 *
 * Channel scope needs a channel, and there is no implicit "current" one — an
 * agent may be in several, so guessing would quietly file things in the wrong
 * place. The error says exactly what to pass.
 */
function resolveFileScope(hub, agent, args) {
  const scope = args.scope || 'channel';
  if (scope === 'global') return { scope, channelId: null, label: 'global files' };

  if (!args.channel) {
    const options = hub
      .publicAgent(agent)
      .channels.map((name) => `"${name}"`)
      .join(', ');
    throw new Error(
      `channel scope needs a channel — pass one of ${options || 'the channels you have joined'}, ` +
        `or use scope "global".`
    );
  }

  const channel = requireChannel(hub, args.channel);
  return { scope, channelId: channel.id, label: `#${channel.name} files` };
}

/** Map a scope and an action onto the group permission that governs it. */
function permissionFor(scope, action) {
  const noun = scope === 'global' ? 'GlobalFiles' : 'ChannelFiles';
  return `${action}${noun}`;
}

/** Look up a channel for tools that require one, with a helpful failure. */
function requireChannel(hub, reference) {
  const channel = hub.getChannel(stripSigil(reference));
  if (!channel) {
    throw new Error(`no channel named "${stripSigil(reference)}". Call list_channels to see what exists.`);
  }
  return channel;
}

// ============================================
// Handlers
// ============================================

const handlers = {
  // ---- identity and discovery ----

  join_hub(args, context) {
    const { hub, session } = context;
    const existing = session.agentId ? hub.getAgent(session.agentId) : null;

    // An auto-registered identity is updated in place so the agent keeps its
    // channel memberships and read position across the upgrade.
    const agent = existing
      ? hub.updateIdentity(existing.id, {
          name: args.name,
          handle: args.handle,
          platform: args.platform,
          description: args.description,
        })
      : hub.registerAgent({
          name: args.name,
          handle: args.handle,
          displayName: args.name,
          platform: args.platform || 'other',
          kind: 'mcp',
          description: args.description,
          sessionId: session.id,
        });

    session.agentId = agent.id;
    const channels = hub.publicAgent(agent).channels.map((c) => '#' + c).join(', ') || 'none';

    return asText(
      `Joined as "${agent.displayName}" — others reach you at @${agent.handle}.\n` +
        `Channels: ${channels}\n\n` +
        `Send with send_message, listen with wait_for_messages, rename yourself with set_identity.`
    );
  },

  set_identity(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const previousHandle = agent.handle;

    const updated = hub.updateIdentity(agent.id, {
      name: args.name,
      handle: args.handle,
      description: args.description,
      platform: args.platform,
    });

    const handleNote =
      updated.handle === previousHandle
        ? `@${updated.handle} is unchanged, so existing mentions still work.`
        : `Your handle changed from @${previousHandle} to @${updated.handle}.`;

    return asText(`You are now "${updated.displayName}". ${handleNote}`);
  },

  whoami(_args, context) {
    const agent = ensureIdentity(context);
    return asText(context.hub.publicAgent(agent));
  },

  list_agents(_args, context) {
    const { hub } = context;
    ensureIdentity(context);

    const agents = hub.listAgents();
    if (!agents.length) return asText('No agents registered yet.');

    const lines = agents.map((agent) => {
      const marker = { online: '●', away: '◐', offline: '○' }[agent.status] || '○';
      const group = agent.groups.length ? ` {${agent.groups.join(', ')}}` : '';
      const detail = agent.description ? `\n    ${agent.description}` : '';
      return `${marker} ${agent.displayName} — @${agent.handle} [${agent.platform}]${group}${detail}`;
    });
    return asText(`${agents.length} agent(s):\n${lines.join('\n')}`);
  },

  list_channels(_args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);

    const channels = hub.listChannels(agent.id);
    const lines = channels.map((channel) => {
      const label = channel.isDm ? `(dm) ${channel.members.map((m) => '@' + m).join(' ↔ ')}` : `#${channel.name}`;
      const topic = channel.topic ? ` — ${channel.topic}` : '';
      const mine = channel.members.includes(agent.handle) ? ' [joined]' : '';
      return `${label}${topic} · ${channel.members.length} member(s)${mine}`;
    });
    return asText(lines.join('\n') || 'No channels yet.');
  },

  // ---- channel membership ----

  create_channel(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const channel = hub.createChannel({ name: args.name, topic: args.topic, createdBy: agent.id });
    hub.joinChannel(agent.id, channel.id);
    return asText(`Joined #${channel.name}.`);
  },

  join_channel(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const channel = requireChannel(hub, args.channel);
    hub.joinChannel(agent.id, channel.id);
    return asText(`Joined #${channel.name}. ${channel.members.size} member(s).`);
  },

  leave_channel(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const channel = requireChannel(hub, args.channel);
    hub.leaveChannel(agent.id, channel.id);
    return asText(`Left #${channel.name}.`);
  },

  // ---- messaging ----

  send_message(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const channel = requireChannel(hub, args.channel);

    // Posting to a channel you are not in is allowed but silently one-way,
    // so join first — otherwise replies never reach wait_for_messages.
    if (!channel.members.has(agent.id)) hub.joinChannel(agent.id, channel.id);

    const message = hub.postMessage({
      channelId: channel.id,
      authorId: agent.id,
      text: args.text,
      threadRootId: args.thread_id || null,
    });

    return asText(`Sent to #${channel.name} as seq ${message.seq}.`);
  },

  dm(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const peer = hub.resolveAgent(stripSigil(args.agent));
    if (!peer) throw new Error(`no agent with handle "${stripSigil(args.agent)}".`);

    const channel = hub.getOrCreateDm(agent.id, peer.id);
    const message = hub.postMessage({ channelId: channel.id, authorId: agent.id, text: args.text });
    return asText(`DM sent to @${peer.handle} as seq ${message.seq}.`);
  },

  read_messages(args, context) {
    const { hub } = context;
    ensureIdentity(context);
    const channel = requireChannel(hub, args.channel);

    const messages = hub.readMessages(channel.id, {
      limit: args.limit,
      sinceSeq: args.since_seq ?? null,
    });
    return asText(formatTranscript(messages, { header: `#${channel.name}` }));
  },

  async search_messages(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);

    const from = args.from ? stripSigil(args.from) : null;
    if (from && !hub.getAgentByHandle(from)) {
      throw new Error(`no agent with handle "${from}". Call list_agents to see who is here.`);
    }

    const channel = args.channel ? requireChannel(hub, args.channel) : null;
    const hits = await hub.search({
      query: args.query,
      channelId: channel?.id || null,
      fromHandle: from,
      limit: args.limit || 25,
      viewerId: agent.id,
    });

    if (!hits.length) {
      return asText(
        `Nothing matched "${args.query}"${channel ? ` in #${channel.name}` : ''}` +
          `${from ? ` from @${from}` : ''}.`
      );
    }

    // Oldest-first in the output even though the search ranks newest-first, so
    // a run of hits from one conversation reads in the order it happened.
    const ordered = [...hits].sort((a, b) => a.seq - b.seq);
    return asText(
      formatTranscript(ordered, { header: `${hits.length} match(es) for "${args.query}"` })
    );
  },

  async wait_for_messages(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);

    const timeoutMs = (args.timeout_seconds || TIMEOUTS.waitForMessagesDefaultMs / 1000) * 1000;
    const messages = await hub.waitForMessages(agent.id, {
      channels: args.channels?.map(stripSigil) || null,
      timeoutMs,
    });

    if (!messages.length) {
      return asText(
        `No new messages within ${Math.round(timeoutMs / 1000)}s. ` +
          `This is normal — call wait_for_messages again to keep listening.`
      );
    }
    return asText(formatTranscript(messages, { header: `${messages.length} new message(s)` }));
  },

  async ask(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const { channel, targetAgent } = resolveTarget(hub, agent, args.target);

    if (!channel.members.has(agent.id)) hub.joinChannel(agent.id, channel.id);

    const { replies } = await hub.ask({
      channelId: channel.id,
      authorId: agent.id,
      text: args.text,
      timeoutMs: (args.timeout_seconds || TIMEOUTS.askDefaultMs / 1000) * 1000,
      fromAgentId: targetAgent?.id || null,
    });

    if (!replies.length) {
      const who = targetAgent ? `@${targetAgent.handle}` : `#${channel.name}`;
      return asText(
        `Sent, but ${who} did not reply in time. The message is posted — ` +
          `call wait_for_messages later to pick up a late answer.`
      );
    }
    return asText(formatTranscript(replies));
  },

  // ---- groups ----

  list_groups(_args, context) {
    const { hub } = context;
    ensureIdentity(context);

    const groups = hub.listGroups();
    if (!groups.length) {
      return asText('No groups yet. The human organizes the roster into groups from the console.');
    }

    // Groups work like roles: an agent holds as many as apply, and each grants
    // permissions to everyone in it.
    const lines = groups.map((group) => {
      const granted = Object.entries(group.permissions || {})
        .filter(([, value]) => value)
        .map(([name]) => name);
      const permissions = granted.length ? `  grants: ${granted.join(', ')}` : '';
      const members = group.members.length ? group.members.map((m) => '@' + m).join(', ') : 'empty';
      return `${group.name} — ${members}${permissions}`;
    });

    const ungrouped = hub.listAgents().filter((agent) => !agent.groups.length);
    if (ungrouped.length) {
      lines.push(`No group — ${ungrouped.map((a) => '@' + a.handle).join(', ')}`);
    }
    return asText(lines.join('\n'));
  },

  // ---- delegated work ----

  assign_task(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);

    const target = hub.resolveAgent(stripSigil(args.agent));
    if (!target) {
      throw new Error(`no agent with handle "${stripSigil(args.agent)}". Call list_agents first.`);
    }
    if (target.id === agent.id) throw new Error('you cannot assign a task to yourself');

    const channel = args.channel ? hub.getChannel(stripSigil(args.channel)) : null;
    const task = hub.taskBoard.create({
      fromAgentId: agent.id,
      toAgentId: target.id,
      title: args.title,
      detail: args.detail || '',
      channelId: channel?.id || null,
    });

    return asText(
      task.status === 'approved'
        ? `Raised ${task.id} for @${target.handle}, auto-approved. They can see it now.`
        : `Raised ${task.id} for @${target.handle}. It is waiting on the human to approve it — ` +
            `@${target.handle} cannot see it yet. Check back with list_tasks rather than re-sending.`
    );
  },

  list_tasks(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);

    const scope = args.scope || 'for_me';
    const tasks = hub.taskBoard.list({
      assigneeId: scope === 'for_me' ? agent.id : null,
      assignerId: scope === 'from_me' ? agent.id : null,
      status: args.status || null,
      openOnly: !!args.open_only,
    });

    if (!tasks.length) return asText('No tasks match.');
    return asText(formatTasks(tasks));
  },

  update_task(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const task = hub.taskBoard.setStatus(args.task_id, args.status, agent.id);
    return asText(`${task.id} is now ${task.status.replace('_', ' ')}.`);
  },

  // ---- shared files ----

  list_files(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const { scope, channelId, label } = resolveFileScope(hub, agent, args);

    hub.requirePermission(agent.id, permissionFor(scope, 'read'), `read ${label} files`);

    const files = hub.files.list(scope, channelId);
    if (!files.length) return asText(`No files in ${label} yet.`);

    const lines = files.map((file) => {
      const size = file.size < 1024 ? `${file.size} B` : `${Math.round(file.size / 1024)} KB`;
      const note = file.description ? `\n    ${file.description}` : '';
      return `${file.name}  (${size}, added by @${file.addedBy})${note}`;
    });
    return asText(`${label} — ${files.length} file(s):\n${lines.join('\n')}`);
  },

  read_file(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const { scope, channelId, label } = resolveFileScope(hub, agent, args);

    hub.requirePermission(agent.id, permissionFor(scope, 'read'), `read ${label} files`);

    const file = hub.files.read(scope, channelId, args.name);
    if (file.text === null) return asText(`${file.name} — ${file.note}`);

    return asText(
      `${file.name}${file.description ? ` — ${file.description}` : ''}\n` +
        `added by @${file.addedBy}\n\n${file.text}`
    );
  },

  write_file(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const { scope, channelId, label } = resolveFileScope(hub, agent, args);

    hub.requirePermission(agent.id, permissionFor(scope, 'write'), `add files to ${label}`);

    const file = hub.files.write(scope, channelId, {
      name: args.name,
      content: args.content,
      authorId: agent.id,
      description: args.description,
    });
    return asText(`Saved ${file.name} to ${label} (${file.size} bytes).`);
  },

  delete_file(args, context) {
    const { hub } = context;
    const agent = ensureIdentity(context);
    const { scope, channelId, label } = resolveFileScope(hub, agent, args);

    hub.requirePermission(agent.id, permissionFor(scope, 'write'), `delete files from ${label}`);

    const name = hub.files.remove(scope, channelId, args.name);
    return asText(`Deleted ${name} from ${label}.`);
  },

  // ---- browser peers ----

  list_peers(_args, context) {
    const { peers } = context;
    ensureIdentity(context);

    const list = peers ? peers.list() : [];
    if (!list.length) {
      return asText('No browser peers attached. Open a claude.ai conversation in the app and lock it.');
    }

    const lines = list.map(
      (peer) => `@${peer.handle} — ${peer.state}${peer.queued ? ` (${peer.queued} queued)` : ''} · ${peer.url}`
    );
    return asText(lines.join('\n'));
  },

  cancel_turn(args, context) {
    const { peers } = context;
    ensureIdentity(context);
    if (!peers) throw new Error('no browser peer manager attached');

    const cancelled = peers.cancel(stripSigil(args.peer));
    return asText(cancelled ? `Cancelled the current turn for @${stripSigil(args.peer)}.` : 'Nothing to cancel.');
  },

  get_hub_status(_args, context) {
    const { hub, peers } = context;
    const agent = ensureIdentity(context);

    return asText({
      you: hub.publicAgent(agent),
      agents: { total: hub.agents.size, online: hub.listAgents().filter((a) => a.status === 'online').length },
      channels: hub.channels.size,
      messages: { resident: hub.messages.length, latestSeq: hub.seq },
      browserPeers: peers ? peers.list() : [],
    });
  },

  // ---- legacy aliases ----

  async talk_to_remote_claude(args, context) {
    const { peers } = context;
    const primary = peers?.getPrimary();
    if (!primary) {
      throw new Error(
        'No browser peer is locked. Open ClankerCom, navigate the browser pane to a claude.ai ' +
          'conversation, and lock it.'
      );
    }
    return handlers.ask({ target: `@${primary.handle}`, text: args.message }, context);
  },

  read_recent_messages(args, context) {
    const { peers } = context;
    const primary = peers?.getPrimary();
    if (!primary) throw new Error('No browser peer is locked.');
    return handlers.read_messages({ channel: primary.channelName, limit: args.count || 1 }, context);
  },

  get_relay_status(_args, context) {
    return handlers.get_hub_status({}, context);
  },
};

module.exports = { handlers, ensureIdentity, asText, formatTranscript };
