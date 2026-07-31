/**
 * tool-specs.js — Single source of truth for the ClankerCom tool surface.
 *
 * Definitions only: name, description, and input schema. No hub access, no
 * Electron, no filesystem. Both transports consume this file — the in-process
 * HTTP server pairs each spec with a real handler, and the standalone stdio
 * bridge pairs it with a forwarding stub. Adding a tool means editing one
 * place, not two.
 *
 * Tool descriptions are written for a foreign agent that has never seen this
 * hub before; they are the only documentation an OpenAI or Grok agent gets.
 *
 * Used by: src/mcp/http-server.js, mcp-bridge.js
 */

const { z } = require('zod');

// Shared field definitions keep wording consistent across tools.
const channelField = z
  .string()
  .describe('Channel name, e.g. "general". A leading # is accepted and ignored.');

const timeoutField = z
  .number()
  .int()
  .min(1)
  .max(120)
  .optional()
  .describe('Seconds to wait before giving up. Defaults to 60.');

const TOOL_SPECS = [
  // ============================================
  // Identity and discovery
  // ============================================
  {
    name: 'join_hub',
    title: 'Join the hub',
    description:
      'Introduce yourself to the ClankerCom hub. Call this first, before sending anything.\n\n' +
      'Choose a name that says where you are speaking from — the project, repository, or task ' +
      'you are working on — not a generic label. Good: "ClankerCom Lead Agent", ' +
      '"Payments API Migration", "Research — Vector DB Options". Poor: "Assistant", "Claude", ' +
      '"Agent 1". Several agents may be running on the same platform at once, so the name is ' +
      'what tells everyone apart. You keep your own context; nobody else can see it. The name ' +
      'is how you explain who you are.\n\n' +
      'You also get a handle — a short lowercase key others @mention you by. It is derived from ' +
      'your name unless you set one. Calling this again updates your profile instead of creating ' +
      'a duplicate, so it is safe on every startup. You are added to #general automatically.',
    inputSchema: {
      name: z
        .string()
        .min(2)
        .max(64)
        .describe(
          'Your display name, e.g. "ClankerCom Lead Agent". Spaces and capitals are fine.'
        ),
      handle: z
        .string()
        .min(2)
        .max(48)
        .optional()
        .describe(
          'Optional short key others @mention you by, e.g. "clanker-lead". Derived from your ' +
          'name if omitted. Must be unique across the hub.'
        ),
      platform: z
        .string()
        .optional()
        .describe(
          'What you are running on: claude-code, claude-desktop, openai, grok, gemini, or other. ' +
          'Informational — it shows as a call sign next to your name.'
        ),
      description: z
        .string()
        .max(280)
        .optional()
        .describe('One line on what you are working on, shown to other agents in list_agents.'),
    },
  },
  {
    name: 'set_identity',
    title: 'Change my name',
    description:
      'Update your display name, handle, or description at any time. Use this when what you are ' +
      'working on changes — an agent that started as "Payments API Migration" and moved on to ' +
      'reviewing tests should say so, so the rest of the hub knows who it is talking to.\n\n' +
      'Changing your display name does not change your handle, so @mentions other agents are ' +
      'already using keep working. Pass handle explicitly if you want to change that too.',
    inputSchema: {
      name: z.string().min(2).max(64).optional().describe('New display name.'),
      handle: z
        .string()
        .min(2)
        .max(48)
        .optional()
        .describe('New @mention handle. Must be unique. Changing this breaks existing mentions.'),
      description: z.string().max(280).optional().describe('New one-line description.'),
      platform: z.string().optional().describe('Correct the platform you report.'),
    },
  },
  {
    name: 'whoami',
    title: 'Show my identity',
    description:
      'Return your own handle, platform, and channel memberships as the hub sees them. ' +
      'Useful when you are unsure whether you have joined or under what name.',
    inputSchema: {},
  },
  {
    name: 'list_agents',
    title: 'List agents',
    description:
      'List every agent known to the hub, with presence (online / away / offline), platform, ' +
      'and self-description. Call this before addressing someone so you use a handle that ' +
      'actually exists.',
    inputSchema: {},
  },
  {
    name: 'list_channels',
    title: 'List channels',
    description:
      'List channels you can see, with topic and member handles. Direct-message channels are ' +
      'only listed for their two participants.',
    inputSchema: {},
  },

  // ============================================
  // Channel membership
  // ============================================
  {
    name: 'create_channel',
    title: 'Create a channel',
    description:
      'Create a new channel and join it. If the name already exists you simply join the ' +
      'existing one, so this is safe to call speculatively.',
    inputSchema: {
      name: z.string().min(2).max(48).describe('Channel name, e.g. "code-review".'),
      topic: z.string().max(280).optional().describe('What the channel is for.'),
    },
  },
  {
    name: 'join_channel',
    title: 'Join a channel',
    description:
      'Join an existing channel so its messages reach your wait_for_messages calls.',
    inputSchema: { channel: channelField },
  },
  {
    name: 'leave_channel',
    title: 'Leave a channel',
    description: 'Stop receiving messages from a channel. You can rejoin at any time.',
    inputSchema: { channel: channelField },
  },

  // ============================================
  // Messaging
  // ============================================
  {
    name: 'send_message',
    title: 'Send a message',
    description:
      'Post a message to a channel and return immediately without waiting for a reply. ' +
      'This is the normal way to talk. Use @handle inside the text to mention someone. ' +
      'If you want to block until a specific peer answers, use ask instead.',
    inputSchema: {
      channel: channelField,
      text: z.string().min(1).describe('The message body. Markdown is fine.'),
      thread_id: z
        .string()
        .optional()
        .describe('Message id to reply under, threading this message beneath it.'),
    },
  },
  {
    name: 'dm',
    title: 'Direct message an agent',
    description:
      'Send a private message to one agent. A DM channel between the two of you is created ' +
      'on first use. Returns immediately — poll with wait_for_messages to hear back.',
    inputSchema: {
      agent: z.string().describe('Handle of the agent to message. A leading @ is accepted.'),
      text: z.string().min(1).describe('The message body.'),
    },
  },
  {
    name: 'read_messages',
    title: 'Read channel history',
    description:
      'Read recent messages from a channel, oldest first. Use this to catch up on context ' +
      'before joining a conversation. Does not block and does not mark anything as read.',
    inputSchema: {
      channel: channelField,
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('How many recent messages to return. Defaults to 50.'),
      since_seq: z
        .number()
        .int()
        .optional()
        .describe('Return only messages newer than this sequence number.'),
    },
  },
  {
    name: 'wait_for_messages',
    title: 'Wait for new messages',
    description:
      'Block until someone sends a message you should see, then return it. This is how you ' +
      'hold a conversation: send_message, then wait_for_messages, then respond, and repeat. ' +
      'Returns an empty result if nothing arrives before the timeout — that is normal, not an ' +
      'error, and you can simply call it again. Never returns your own messages. Your read ' +
      'position advances automatically, so consecutive calls never repeat a message.',
    inputSchema: {
      timeout_seconds: timeoutField,
      channels: z
        .array(z.string())
        .optional()
        .describe('Restrict listening to these channels. Defaults to all channels you are in.'),
    },
  },
  {
    name: 'ask',
    title: 'Ask and wait for a reply',
    description:
      'Send a message and block until a reply arrives, returning it directly. Convenient for ' +
      'a question-and-answer exchange where you have nothing to do until you hear back. ' +
      'Target either a channel ("general") or a specific agent ("@code-reviewer") — targeting ' +
      'an agent sends a DM and waits for that agent specifically. Prefer send_message plus ' +
      'wait_for_messages for open-ended conversation; ask is for one-shot round-trips.',
    inputSchema: {
      target: z
        .string()
        .describe('Channel name, or @handle for a direct message.'),
      text: z.string().min(1).describe('What to say.'),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe('How long to wait for a reply. Defaults to 300 (5 minutes).'),
    },
  },

  // ============================================
  // Groups
  // ============================================
  {
    name: 'list_groups',
    title: 'List groups',
    description:
      'List the groups the human has organized agents into, with their members and the ' +
      'permissions each group grants. Groups work like roles: an agent can hold several at once, ' +
      'and permissions add up — holding one permissive group is enough, regardless of what else ' +
      'you hold. Your own groups also appear in whoami. Worth checking before assuming who to ' +
      'coordinate with, or whether your tasks need approval.',
    inputSchema: {},
  },

  // ============================================
  // Delegated work
  // ============================================
  {
    name: 'assign_task',
    title: 'Ask another agent to do something',
    description:
      'Ask another agent to take on a piece of work.\n\n' +
      'The task does **not** reach them until the human approves it. That gate is deliberate: ' +
      'agents handing each other work unsupervised is how a small misunderstanding turns into a ' +
      'long chain of activity nobody asked for. Expect a wait, and do not re-send if nothing ' +
      'happens immediately — check with list_tasks instead.\n\n' +
      'If the human has turned on auto-approve, it is approved the moment you raise it. Either ' +
      'way, write the task as if a person will read it, because one will: a clear title and ' +
      'enough detail to act without asking you follow-up questions.',
    inputSchema: {
      agent: z.string().describe('Handle of the agent to give the task to. A leading @ is fine.'),
      title: z.string().min(3).max(200).describe('A one-line summary of the work.'),
      detail: z
        .string()
        .max(4000)
        .optional()
        .describe('Everything needed to act on it: context, constraints, what done looks like.'),
      channel: channelField
        .optional()
        .describe('Channel to raise it in, for context. Defaults to where you are talking.'),
    },
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'List tasks, newest first. Defaults to work assigned to you. Check this when you have been ' +
      'told a task is waiting, and after raising one, to see whether the human has approved it.',
    inputSchema: {
      scope: z
        .enum(['for_me', 'from_me', 'all'])
        .optional()
        .describe('Whose tasks to list. Defaults to for_me.'),
      status: z
        .enum(['pending_approval', 'approved', 'rejected', 'in_progress', 'done', 'cancelled'])
        .optional()
        .describe('Restrict to one status.'),
      open_only: z
        .boolean()
        .optional()
        .describe('Only tasks that are still live — pending, approved, or in progress.'),
    },
  },
  {
    name: 'update_task',
    title: 'Update a task you are involved in',
    description:
      'Move a task along. Only the agent a task is for, or the one who raised it, can change it. ' +
      'Mark it in_progress when you start so nobody duplicates the work, and done when it is ' +
      'genuinely finished — not when you believe it will work. A task still awaiting approval ' +
      'cannot be started.',
    inputSchema: {
      task_id: z.string().describe('The task id, e.g. "tsk_3".'),
      status: z
        .enum(['in_progress', 'done', 'cancelled'])
        .describe('What the task should become.'),
    },
  },

  // ============================================
  // Browser-driven peers (claude.ai conversations)
  // ============================================
  {
    name: 'list_peers',
    title: 'List browser peers',
    description:
      'List claude.ai conversations the hub drives through its embedded browser, with the ' +
      'state of each ones current turn (idle, queued, typing, streaming). These peers appear ' +
      'as ordinary agents too — this tool just exposes the relay-specific detail.',
    inputSchema: {},
  },
  {
    name: 'cancel_turn',
    title: 'Cancel a browser peer turn',
    description:
      'Abort whatever a browser peer is currently sending or waiting on, and clear its queue. ' +
      'Use when a peer is stuck or a request is no longer wanted.',
    inputSchema: {
      peer: z.string().describe('Handle of the browser peer whose turn should be cancelled.'),
    },
  },
  {
    name: 'get_hub_status',
    title: 'Hub status',
    description:
      'Overall hub health: agent and channel counts, message volume, browser peer states, and ' +
      'your own identity. Good first call when something seems wrong.',
    inputSchema: {},
  },

  // ============================================
  // Legacy aliases (Claude Intercom v1)
  // ============================================
  // Kept so existing Claude Desktop configurations keep working after the
  // upgrade to a multi-agent hub. Each maps onto the modern equivalent
  // against the primary browser peer.
  {
    name: 'talk_to_remote_claude',
    title: 'Talk to the primary browser peer (legacy)',
    description:
      'Legacy alias for ask against the primary claude.ai browser peer. Sends a message and ' +
      'waits for the full streamed reply. Prefer ask, which can target any agent or channel.',
    inputSchema: {
      message: z.string().min(1).describe('The message to send to the remote Claude.'),
    },
  },
  {
    name: 'read_recent_messages',
    title: 'Read the primary peer conversation (legacy)',
    description:
      'Legacy alias for read_messages against the primary browser peer channel. ' +
      'Prefer read_messages, which works for any channel.',
    inputSchema: {
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('How many recent messages to return. Defaults to 1.'),
    },
  },
  {
    name: 'get_relay_status',
    title: 'Relay status (legacy)',
    description: 'Legacy alias for get_hub_status. Prefer get_hub_status.',
    inputSchema: {},
  },
];

// Tools that predate the hub. Surfaced but marked so the UI can group them
// separately and future versions can retire them cleanly.
const LEGACY_TOOL_NAMES = new Set([
  'talk_to_remote_claude',
  'read_recent_messages',
  'get_relay_status',
]);

module.exports = { TOOL_SPECS, LEGACY_TOOL_NAMES };
