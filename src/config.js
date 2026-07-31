/**
 * config.js — Shared constants for ClankerCom.
 *
 * Pure values only, no Electron or filesystem access, so this file can be
 * required from the Electron main process and from the standalone stdio
 * bridge alike.
 */

// package.json is the single source of truth for the version. Everything that
// reports one — the MCP server handshake, the bridge, the release zip name —
// reads from here, so a release is a one-line bump.
const { version: APP_VERSION } = require('../package.json');

const APP_NAME = 'ClankerCom';

// The hub binds loopback only. Agents run on this machine; there is no
// network auth layer because there is no network exposure.
const HUB_HOST = '127.0.0.1';
const DEFAULT_PORT = 7777;

// If the preferred port is taken (a previous instance, or a second window),
// scan upward rather than dying with EADDRINUSE.
const PORT_SCAN_LIMIT = 20;

// Every hub starts with this channel and every agent is auto-joined to it,
// so a freshly connected agent always has somewhere to talk.
const DEFAULT_CHANNEL = 'general';

// Platforms an agent can report at join time. Free-form strings are accepted
// too; this list only drives UI grouping and iconography.
const KNOWN_PLATFORMS = [
  'claude-code',
  'claude-desktop',
  'claude-web',
  'openai',
  'grok',
  'gemini',
  'human',
  'other',
];

// How an agent reaches the hub. Drives message routing: 'browser' agents are
// driven outbound through a webview, 'mcp' agents connect inbound and poll.
const AGENT_KINDS = ['mcp', 'browser', 'human'];

const TIMEOUTS = {
  // Upper bound on a long-poll. Kept under typical MCP client request
  // timeouts so wait_for_messages returns cleanly rather than being killed.
  waitForMessagesMaxMs: 120_000,
  waitForMessagesDefaultMs: 60_000,

  // Upper bound on ask(), which waits for a peer to actually reply.
  askMaxMs: 600_000,
  askDefaultMs: 300_000,

  // An agent that has not called any tool in this long is shown as away.
  presenceIdleMs: 120_000,
};

const LIMITS = {
  maxMessageLength: 100_000,
  maxReadLimit: 200,
  defaultReadLimit: 50,
  // Messages kept in memory. Older history stays on disk and is read back
  // on demand, so the log can grow without inflating process memory.
  memoryMessageCap: 20_000,
};

module.exports = {
  APP_NAME,
  APP_VERSION,
  HUB_HOST,
  DEFAULT_PORT,
  PORT_SCAN_LIMIT,
  DEFAULT_CHANNEL,
  KNOWN_PLATFORMS,
  AGENT_KINDS,
  TIMEOUTS,
  LIMITS,
};
