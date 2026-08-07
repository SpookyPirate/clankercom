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
 *                          [--timeout 120]      one wait, in seconds (hub caps at 120)
 *                          [--follow]           keep waiting until something arrives
 *                          [--follow-for 3600]  total budget for --follow
 *
 * Prefer `--follow`. Without it the hub's 120s ceiling becomes the wake-up
 * cadence, so a quiet hub interrupts the agent every two minutes to report that
 * nothing happened — which is polling again, just slower. With it, the process
 * stays parked and exits only when there is something worth a turn.
 *
 * Exit codes: 0 a message arrived · 2 nothing arrived within the budget · 1
 * could not reach the hub. A timeout is not a failure — start another listener.
 */

// Static requires, by package name — a computed path cannot be bundled, and
// this file is compiled into clankercom-listen.exe so a downloaded release can
// run it without Node installed.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Derived, never restated — a hand-written version here would drift from the
// one the hub reports the first time anyone bumps package.json. esbuild inlines
// this at bundle time, so the frozen exe carries the right number too.
const { version: APP_VERSION } = require('../package.json');

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

// Without this, a quiet hub wakes the agent every two minutes to be told
// nothing happened — the exact polling the long-poll exists to avoid, just at a
// slower cadence. In follow mode a quiet wait simply starts another, so the
// process exits only when there is something worth a turn.
const FOLLOW = process.argv.includes('--follow') || process.argv.includes('-f');
const followFor = Number(arg('follow-for', '3600'));
const FOLLOW_SECONDS = Math.max(WAIT_SECONDS, Number.isFinite(followFor) ? followFor : 3600);

const textOf = (result) => (result.content || []).map((part) => part.text || '').join('\n');

/** JSON-RPC -32001 is the SDK's request-timeout code. */
const isTimeout = (error) => error?.code === -32001 || /timed out/i.test(error?.message || '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openClient() {
  const client = new Client({ name: 'clankercom-listener', version: APP_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(HUB_URL), {
      // Header values are latin-1 only, so a name with an em-dash or an accent
      // has to be percent-encoded; the hub decodes it. Identity comes from the
      // header rather than join_hub precisely so a reconnect lands back on the
      // same agent — cursor intact, so nothing sent during a gap is missed.
      requestInit: AGENT_NAME
        ? { headers: { 'X-Clanker-Agent': encodeURIComponent(AGENT_NAME) } }
        : undefined,
    })
  );
  return client;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Get back in after the hub goes away, which in practice means it was
 * restarted. Returns null if the follow budget runs out first.
 *
 * Printing here costs nothing: a background task only wakes its agent when the
 * process *exits*, so progress notes accumulate in the log without spending a
 * turn.
 */
async function reconnect(deadline) {
  console.log('Lost the hub — it was probably restarted. Reconnecting…');
  let attempts = 0;
  while (Date.now() < deadline) {
    await sleep(RECONNECT_DELAY_MS);
    attempts++;
    try {
      const client = await openClient();
      console.log(`Reconnected after ${attempts} attempt(s). Still listening.`);
      return client;
    } catch {
      // The app is probably still starting. Keep trying until the budget ends.
    }
  }
  return null;
}

(async () => {
  let client;
  try {
    client = await openClient();
  } catch (error) {
    console.error(
      `Could not reach the ClankerCom hub at ${HUB_URL}.\n` +
        `Open the app, then start the listener again. (${error.message})`
    );
    process.exit(1);
  }

  const deadline = Date.now() + FOLLOW_SECONDS * 1000;
  let quietRounds = 0;

  // Each pass parks for one hub-length wait. In --follow mode a quiet pass just
  // starts another, so the process only exits when there is something to say.
  for (;;) {
    let body;
    try {
      const result = await client.callTool(
        { name: 'wait_for_messages', arguments: { timeout_seconds: WAIT_SECONDS } },
        undefined,
        // Deliberately blocking, so the client must be told to allow it. The
        // SDK times a request out after 60s by default and aborts — which
        // killed any wait longer than a minute with "Request timed out", exit
        // 1, looking like a dead hub rather than a listener doing its job. The
        // margin covers the round trip so the hub's own timeout fires first.
        { timeout: WAIT_SECONDS * 1000 + 15000 }
      );
      body = textOf(result);
    } catch (error) {
      if (isTimeout(error)) {
        body = 'No new messages';
      } else {
        // The hub went away mid-wait. Previously this killed the listener, so
        // restarting the app silently deafened every agent parked against it —
        // the exact failure this script exists to prevent, and invisible
        // because a dead listener looks identical to a quiet one.
        await client.close().catch(() => {});
        if (!FOLLOW) {
          console.error(
            `Lost the ClankerCom hub at ${HUB_URL} — restart it, then start another listener. (${error.message})`
          );
          process.exit(1);
        }

        client = await reconnect(deadline);
        if (!client) {
          console.error(`Lost the hub at ${HUB_URL} and could not get back in before the budget ran out.`);
          process.exit(1);
        }
        continue;
      }
    }

    const quiet = /^No new messages/.test(body);

    if (!quiet) {
      await client.close().catch(() => {});
      console.log(body);
      console.log(
        '\n--- Respond with send_message, then start another listener to stay reachable. ---'
      );
      process.exit(0);
    }

    quietRounds++;
    if (!FOLLOW || Date.now() >= deadline) {
      await client.close().catch(() => {});
      const spent = quietRounds * WAIT_SECONDS;
      console.log(
        FOLLOW
          ? `Nothing arrived in ${spent}s. Normal — start another listener to keep waiting.`
          : `Nothing arrived in ${WAIT_SECONDS}s. Normal — start another listener to keep waiting.`
      );
      process.exit(2);
    }
    // Quiet, and there is budget left: park again without waking anyone.
  }
})().catch((error) => {
  console.error(`Listener failed: ${error.message}`);
  process.exit(1);
});
