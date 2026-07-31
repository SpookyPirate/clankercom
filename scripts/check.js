/**
 * check.js — End-to-end smoke test for the ClankerCom hub.
 *
 * Starts a real hub on a real port and drives it with two real MCP clients
 * over Streamable HTTP, exercising the path an external agent actually takes:
 * join, discover, send, long-poll, ask, rename, persist.
 *
 * The hub, store, and MCP layers carry no Electron dependency, so this runs
 * under plain Node. Only the browser-peer layer needs the app itself.
 *
 * Run with: npm run check
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { Store } = require('../src/hub/store');
const { Hub } = require('../src/hub/bus');
const { createHubServer } = require('../src/mcp/http-server');

// ============================================
// Tiny assertion harness
// ============================================

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** Pull the text out of an MCP tool result. */
function textOf(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

async function connectAgent(url, name) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const call = (client, name, args = {}) =>
  client.callTool({ name, arguments: args }).then(textOf);

// ============================================
// Test run
// ============================================

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-check-'));
  console.log(`\nClankerCom hub check\ndata dir: ${dataDir}\n`);

  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const server = createHubServer({ hub, peers: null });
  const { httpServer, port } = await server.listen();
  const url = `http://127.0.0.1:${port}/mcp`;

  try {
    await runScenario(url, hub);
  } finally {
    hub.releaseWaiters();
    await server.closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await store.close();
  }

  await verifyPersistence(dataDir);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

async function runScenario(url, hub) {
  // ---- connect ----
  console.log('connection and identity');
  const lead = await connectAgent(url, 'claude-code');
  const research = await connectAgent(url, 'claude-code'); // same client name on purpose

  const tools = await lead.listTools();
  check('hub advertises its tools', tools.tools.length > 10, `got ${tools.tools.length}`);
  check(
    'wait_for_messages is advertised',
    tools.tools.some((tool) => tool.name === 'wait_for_messages')
  );

  // ---- join with distinct self-chosen names ----
  const leadJoin = await call(lead, 'join_hub', {
    name: 'ClankerCom Lead Agent',
    platform: 'claude-code',
    description: 'Building the hub.',
  });
  check('display name is kept verbatim', leadJoin.includes('ClankerCom Lead Agent'), leadJoin);
  check('handle is derived from the name', leadJoin.includes('@clankercom-lead-agent'), leadJoin);

  await call(research, 'join_hub', { name: 'Research Agent', platform: 'openai' });

  const roster = await call(lead, 'list_agents');
  check('both agents appear in the roster', roster.includes('clankercom-lead-agent') && roster.includes('research-agent'), roster);
  check(
    'two clients with one client name stay distinct',
    hub.listAgents().filter((a) => a.kind === 'mcp').length === 2
  );

  // ---- long-poll wakes on a mention ----
  console.log('\nmessaging');
  const waiting = call(research, 'wait_for_messages', { timeout_seconds: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the poll register

  await call(lead, 'send_message', {
    channel: 'general',
    text: 'Morning @research-agent — can you look at the vector store options?',
  });

  const received = await waiting;
  check('long-poll wakes on a new message', received.includes('vector store options'), received);
  check('transcript carries the sender handle', received.includes('@clankercom-lead-agent'), received);
  check('transcript carries the self-chosen name', received.includes('ClankerCom Lead Agent'), received);

  // ---- an agent never wakes on its own message ----
  const ownMessage = await call(research, 'wait_for_messages', { timeout_seconds: 2 });
  check('own messages do not wake the sender', ownMessage.includes('No new messages'), ownMessage);

  // ---- ask blocks until the peer answers ----
  const asking = call(lead, 'ask', {
    target: '@research-agent',
    text: 'Did you get that?',
    timeout_seconds: 15,
  });

  // The peer notices the DM and replies, which should release the ask.
  const dmHeard = await call(research, 'wait_for_messages', { timeout_seconds: 10 });
  check('a direct message reaches the recipient', dmHeard.includes('Did you get that?'), dmHeard);

  const dmChannel = hub
    .listChannels(hub.getAgentByHandle('research-agent').id)
    .find((channel) => channel.isDm);
  await call(research, 'send_message', { channel: dmChannel.name, text: 'Got it, on it now.' });

  const answer = await asking;
  check('ask resolves with the reply', answer.includes('Got it, on it now'), answer);

  // ---- renaming mid-conversation ----
  console.log('\nidentity changes');
  const renamed = await call(research, 'set_identity', { name: 'Research — Vector DB Options' });
  check('display name updates', renamed.includes('Research — Vector DB Options'), renamed);
  check('handle survives a display-name change', renamed.includes('unchanged'), renamed);
  check(
    'the old handle still resolves',
    hub.getAgentByHandle('research-agent') !== null
  );

  const rehandled = await call(research, 'set_identity', { handle: 'vector-research' });
  check('an explicit handle change is applied', rehandled.includes('@vector-research'), rehandled);

  // ---- channels ----
  console.log('\nchannels');
  await call(lead, 'create_channel', { name: 'Design Review', topic: 'UI decisions' });
  const channels = await call(lead, 'list_channels');
  check('channel names are slugified', channels.includes('#design-review'), channels);
  check('direct messages stay private to their participants', !channels.includes('dm:'), channels);

  const history = await call(lead, 'read_messages', { channel: 'general', limit: 10 });
  check('history reads back', history.includes('vector store options'), history);
  check('sequence numbers are exposed for resuming', /\[\d+\]/.test(history), history);

  // ---- error handling ----
  console.log('\nerror handling');
  const missing = await call(lead, 'send_message', { channel: 'nope', text: 'hello' });
  check('an unknown channel fails readably', missing.includes('no channel named'), missing);

  const takenHandle = await call(lead, 'set_identity', { handle: 'vector-research' });
  check('a duplicate handle is refused', takenHandle.includes('already taken'), takenHandle);

  await lead.close();
  await research.close();
}

/** Reload from disk into a fresh hub to prove the log survives a restart. */
async function verifyPersistence(dataDir) {
  console.log('\npersistence');
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  check('messages survive a restart', hub.messages.length > 0, `${hub.messages.length} messages`);
  check('agents survive a restart', hub.agents.size >= 2, `${hub.agents.size} agents`);
  check(
    'agents come back offline until they reconnect',
    hub.listAgents().every((agent) => agent.status === 'offline')
  );
  check('the default channel is present', hub.getChannel('general') !== null);

  await store.close();
}

main().catch((error) => {
  console.error('\ncheck crashed:', error);
  process.exit(1);
});
