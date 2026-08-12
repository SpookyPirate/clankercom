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

// The hub binds loopback only, and deliberately offers no host override.
// There is no auth layer because there is no network exposure; a flag that
// binds beyond loopback would silently turn an unauthenticated control
// surface into a network service.
const HUB_HOST = '127.0.0.1';

/**
 * Preferred port. CLANKER_PORT overrides the default for anyone running a
 * second hub against a separate data directory, or working around a port
 * conflict without editing config.
 */
function resolvePort() {
  const raw = process.env.CLANKER_PORT;
  if (raw === undefined || raw === '') return { port: 7777, explicit: false };

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[ClankerCom] CLANKER_PORT="${raw}" is not a valid port. Using 7777.`);
    return { port: 7777, explicit: false };
  }
  return { port, explicit: true };
}

const { port: DEFAULT_PORT, explicit: PORT_IS_EXPLICIT } = resolvePort();

// A default port that is taken gets scanned past — a second instance should
// start rather than die on EADDRINUSE. An explicitly requested port is not
// scanned past: silently binding a different one would leave every client
// configured for the requested port unable to connect.
const PORT_SCAN_LIMIT = 20;

// Every hub starts with this channel and every agent is auto-joined to it,
// so a freshly connected agent always has somewhere to talk.
const DEFAULT_CHANNEL = 'general';

/**
 * The brief every channel starts with.
 *
 * A channel with no standing context is where agents pile on: each one receives
 * the same message, none of them knows the others did, and all of them answer.
 * Shipping an empty box and hoping the human fills it in guarantees the default
 * experience is the bad one — so the default says the one thing that matters
 * most, and the human edits it rather than composing from nothing.
 */
const DEFAULT_CHANNEL_BRIEF =
  'Everyone in this channel receives every message, so not every message is yours to answer. ' +
  'Reply when you were genuinely asked, when the work is plainly yours, or when you know ' +
  'something the others do not. Stay quiet when another agent is better placed, when the point ' +
  'has already been made, or when you would only be agreeing. Being named is not always a ' +
  'question, and not being named is not always an excuse. One good answer beats five.';

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
  // Standing channel context. Long enough for real house rules, short enough
  // that every agent can be handed it on arrival without drowning its context.
  maxBriefLength: 2_000,
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
  PORT_IS_EXPLICIT,
  PORT_SCAN_LIMIT,
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_BRIEF,
  KNOWN_PLATFORMS,
  AGENT_KINDS,
  TIMEOUTS,
  LIMITS,
};
