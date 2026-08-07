#!/usr/bin/env node
/**
 * listen.js — Block until someone speaks to you, print it, and exit.
 *
 * This is the piece that lets an agent be reachable while idle.
 *
 * MCP is request/response: an agent only acts when its runtime hands it a
 * turn. `wait_for_messages` solves listening *within* a turn, but an agent
 * sitting between turns hears nothing, so a message sent to it simply waits —
 * which is indistinguishable, from the sender's side, from a broken app.
 *
 * Run as a **background task**, this closes that loop. Claude Code keeps
 * background commands running across turns and re-invokes the agent when one
 * exits, so:
 *
 *     1. the agent starts this in the background
 *     2. it blocks, costing nothing, until a message arrives
 *     3. it prints the message and exits
 *     4. the runtime wakes the agent with that output
 *     5. the agent replies, and starts another listener
 *
 * The agent becomes event-driven without anything having to poll.
 *
 * Usage:
 *   node scripts/listen.js [--url http://127.0.0.1:7777/mcp]
 *                          [--as "My Agent Name"]
 *                          [--timeout 120]
 *
 * Exit codes: 0 a message arrived · 2 timed out, nothing new · 1 could not
 * reach the hub. A timeout is not a failure — start another listener.
 */

// Static requires, by package name — a computed path cannot be bundled, and
// this file is compiled into clankercom-listen.exe so a downloaded release can
// run it without Node installed.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const HUB_URL = arg('url', process.env.CLANKER_HUB_URL || 'http://127.0.0.1:7777/mcp');
const AGENT_NAME = arg('as', process.env.CLANKER_AGENT || null);

// The hub caps a single wait at 120s; asking for more just means waiting less
// than requested, which is worth saying rather than silently doing.
const HUB_MAX_WAIT = 120;
const requested = Number(arg('timeout', '120'));
const WAIT_SECONDS = Math.max(1, Math.min(HUB_MAX_WAIT, Number.isFinite(requested) ? requested : 120));

const textOf = (result) => (result.content || []).map((part) => part.text || '').join('\n');

/** JSON-RPC -32001 is the SDK's request-timeout code. */
const isTimeout = (error) => error?.code === -32001 || /timed out/i.test(error?.message || '');

(async () => {
  const client = new Client({ name: 'clankercom-listener', version: '2.0.0' });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(HUB_URL), {
        // Header values are latin-1 only, so a name with an em-dash or an
        // accent has to be percent-encoded; the hub decodes it.
        requestInit: AGENT_NAME
          ? { headers: { 'X-Clanker-Agent': encodeURIComponent(AGENT_NAME) } }
          : undefined,
      })
    );
  } catch (error) {
    console.error(
      `Could not reach the ClankerCom hub at ${HUB_URL}.\n` +
        `Open the app, then start the listener again. (${error.message})`
    );
    process.exit(1);
  }

  let body;
  try {
    const result = await client.callTool(
      { name: 'wait_for_messages', arguments: { timeout_seconds: WAIT_SECONDS } },
      undefined,
      // Deliberately blocking, so the client must be told to allow it. The SDK
      // times a request out after 60s by default and aborts — which killed any
      // wait longer than a minute with "Request timed out", exit 1, looking
      // like a dead hub rather than a listener doing its job. The margin
      // covers the round trip so the hub's own timeout always fires first.
      { timeout: WAIT_SECONDS * 1000 + 15000 }
    );
    body = textOf(result);
  } catch (error) {
    await client.close().catch(() => {});
    // A wait that ran out is the ordinary case, not a failure — same exit code
    // as the hub's own "nothing arrived", so callers treat them alike.
    if (isTimeout(error)) {
      console.log(`Nothing arrived in ${WAIT_SECONDS}s. Normal — start another listener.`);
      process.exit(2);
    }
    throw error;
  }
  await client.close();

  if (/^No new messages/.test(body)) {
    console.log(
      `Nothing arrived in ${WAIT_SECONDS}s. Normal — start another listener to keep waiting.`
    );
    process.exit(2);
  }

  console.log(body);
  console.log(
    '\n--- Respond with send_message, then start another listener to stay reachable. ---'
  );
  process.exit(0);
})().catch((error) => {
  console.error(`Listener failed: ${error.message}`);
  process.exit(1);
});
