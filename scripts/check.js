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
const net = require('net');
const os = require('os');
const path = require('path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { Store } = require('../src/hub/store');
const { Hub } = require('../src/hub/bus');
const { safeName } = require('../src/hub/files');
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

// ============================================
// Port selection
// ============================================

/**
 * CLANKER_PORT behaviour. Makes no assumption about which ports are free
 * beyond the one high port it squats itself — a developer's own hub is very
 * often already on 7777, and a test that assumes otherwise fails for the
 * wrong reason.
 */
async function verifyPortSelection() {
  console.log('port selection');

  const freePort = await findFreePort();

  const honoured = await bootAndBind(String(freePort));
  check(`honours an explicit free port (${freePort})`, honoured.port === freePort, `got ${honoured.port}`);

  const squatter = await squat(freePort);
  const refused = await bootAndBind(String(freePort));
  check(
    'refuses an explicit port that is taken rather than silently scanning',
    !!refused.error && /already in use/.test(refused.error.message),
    refused.port ? `silently bound ${refused.port}` : refused.error?.message
  );
  squatter.close();

  const garbage = await bootAndBind('banana');
  check(
    'an invalid CLANKER_PORT falls back to default scanning',
    !garbage.error && garbage.port >= 7777,
    garbage.error?.message || `got ${garbage.port}`
  );

  const unset = await bootAndBind(null);
  check(
    'unset CLANKER_PORT binds the default or scans past a conflict',
    !unset.error && unset.port >= 7777,
    unset.error?.message || `got ${unset.port}`
  );
}

/** Ask the OS for a port, then release it. */
function findFreePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1');
    probe.on('listening', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function squat(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(port, '127.0.0.1');
    server.on('listening', () => resolve(server));
    server.on('error', reject);
  });
}

/** Boot a throwaway hub under a given CLANKER_PORT and report what it bound. */
async function bootAndBind(portValue) {
  if (portValue === null) delete process.env.CLANKER_PORT;
  else process.env.CLANKER_PORT = portValue;

  // config.js reads the environment at load time, so both it and its
  // dependents have to be re-required for a new value to take effect.
  for (const moduleName of ['../src/config', '../src/mcp/http-server']) {
    delete require.cache[require.resolve(moduleName)];
  }
  const { createHubServer: freshServer } = require('../src/mcp/http-server');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-port-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  try {
    const { httpServer, port } = await freshServer({ hub, peers: null }).listen();
    await new Promise((resolve) => httpServer.close(resolve));
    return { port };
  } catch (error) {
    return { error };
  } finally {
    await store.close();
  }
}

// ============================================
// Channel placement and scoped listening
// ============================================

/**
 * Splitting agents across workstreams so they do not overhear each other.
 *
 * Two mechanisms, and the distinction matters: `X-Clanker-Channel` decides
 * where an agent *is*, while the `channels` argument to wait_for_messages
 * decides what it *listens to* without changing membership. The header has to
 * stay optional — an agent that omits it must land in the default channel
 * exactly as before, or every existing setup changes meaning.
 */
async function verifyChannelPlacement() {
  console.log('\nchannel placement');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-channels-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const server = createHubServer({ hub, peers: null });
  const { httpServer, port } = await server.listen();
  const url = `http://127.0.0.1:${port}/mcp`;

  const connect = async (name, channel) => {
    const headers = { 'X-Clanker-Agent': name };
    if (channel) headers['X-Clanker-Channel'] = channel;
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
    );
    await call(client, 'list_channels'); // first tool call settles identity
    return client;
  };

  try {
    const apiOne = await connect('api-1', 'api-work');
    const apiTwo = await connect('api-2', 'api-work');
    const uiOne = await connect('ui-1', 'ui-work');
    await connect('plain-agent');

    check('the header creates and joins the named channel', hub.getChannel('api-work')?.members.size === 2, hub.getChannel('api-work')?.members.size);
    check('a second workstream stays separate', hub.getChannel('ui-work')?.members.size === 1);
    check(
      'a named channel replaces the default placement',
      !hub.getAgentByHandle('api-1').channels.has(hub.getChannel('general').id)
    );
    check(
      'an agent that sends no header still lands in the default channel',
      hub.getAgentByHandle('plain-agent').channels.has(hub.getChannel('general').id)
    );

    // Nobody hears the other workstream.
    const apiWaiting = call(apiTwo, 'wait_for_messages', { timeout_seconds: 6 });
    const uiWaiting = call(uiOne, 'wait_for_messages', { timeout_seconds: 6 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await call(apiOne, 'send_message', { channel: 'api-work', text: 'API team only.' });

    check('the other workstream hears its own message', (await apiWaiting).includes('API team only'));
    check('the unrelated workstream hears nothing', (await uiWaiting).includes('No new messages'));

    // Scoped listening: a member of a channel can still decline to hear it.
    await call(apiTwo, 'join_channel', { channel: 'general' });
    const scoped = call(apiTwo, 'wait_for_messages', {
      timeout_seconds: 6,
      channels: ['api-work'],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await call(apiOne, 'send_message', { channel: 'general', text: 'Noise nobody wants.' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await call(apiOne, 'send_message', { channel: 'api-work', text: 'The wanted one.' });

    const heard = await scoped;
    check('scoped listening ignores a channel the agent is in', !heard.includes('Noise nobody wants'), heard);
    check('scoped listening still wakes on the named channel', heard.includes('The wanted one'), heard);
  } finally {
    hub.releaseWaiters();
    await server.closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await store.close();
  }
}

// ============================================
// Several agents in one room
// ============================================

/**
 * A channel is a broadcast, not a queue, and the console has to say so.
 *
 * Read receipts were always per-agent, but only the first reader was reported —
 * so "Read by @alpha" looked like a group message had been handled while three
 * others had not seen it. The audience captured at post time is the denominator
 * that fixes it. The rest of this covers what an agent is told about the room,
 * which is what stops six agents all answering the same question.
 */
async function verifySharedRoom() {
  console.log('\nseveral agents in one room');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-room-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const server = createHubServer({ hub, peers: null });
  const { httpServer, port } = await server.listen();
  const url = `http://127.0.0.1:${port}/mcp`;

  const connect = async (name) => {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { 'X-Clanker-Agent': name } },
      })
    );
    await call(client, 'list_channels');
    return client;
  };

  try {
    const human = hub.registerAgent({ name: 'operator', kind: 'human', platform: 'human' });
    hub.joinChannel(human.id, hub.getChannel('general').id);

    const alpha = await connect('alpha');
    const bravo = await connect('bravo');
    await connect('charlie');

    // ---- everyone receives it; nobody consumes it ----
    const waiting = [alpha, bravo].map((client) =>
      call(client, 'wait_for_messages', { timeout_seconds: 6 })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const posted = hub.postMessage({
      channelId: hub.getChannel('general').id,
      authorId: human.id,
      text: 'Anyone know about the index, @bravo?',
    });
    const heard = await Promise.all(waiting);
    check('a channel message reaches every parked agent', heard.every((r) => r.includes('index')));

    // ---- the audience is the denominator the console was missing ----
    check(
      'a post records the audience it went to',
      ['alpha', 'bravo', 'charlie'].every((handle) => posted.audience.includes(handle)),
      posted.audience
    );
    check('the author is not part of their own audience', !posted.audience.includes('operator'));
    check(
      'read receipts accumulate per agent rather than latching on the first',
      Array.from(posted.seenBy).length === 2,
      Array.from(posted.seenBy || [])
    );

    // ---- a reader does not consume the message for anyone else ----
    const late = await call(await connect('charlie'), 'read_messages', { channel: 'general', limit: 3 });
    check('an agent reading later still sees the message', late.includes('index'));

    // ---- what an agent is told about the room ----
    check('the transcript names who else is present', late.includes('Also here:'), late);
    check(
      'a named agent is told the message is for it',
      (await call(bravo, 'read_messages', { channel: 'general', limit: 1 })).includes('names you specifically')
    );
    check(
      'an unnamed agent is told the message is not for it',
      (await call(alpha, 'read_messages', { channel: 'general', limit: 1 })).includes('not you')
    );

    // ---- standing context, set once ----
    await call(alpha, 'set_channel_brief', {
      channel: 'general',
      brief: 'Schema questions only.',
    });
    const arriving = await connect('delta');
    const welcome = await call(arriving, 'join_channel', { channel: 'general' });
    check('an arriving agent is handed the channel brief', welcome.includes('Schema questions only'), welcome);
    check('the brief also rides along with transcripts', (await call(bravo, 'read_messages', { channel: 'general', limit: 1 })).includes('Schema questions only'));

    await call(alpha, 'set_channel_brief', { channel: 'general', brief: '' });
    check('a brief can be cleared', !hub.getChannel('general').brief);
  } finally {
    hub.releaseWaiters();
    await server.closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await store.close();
  }
}

// ============================================
// Pausing the net
// ============================================

/**
 * The human can leave the room; the conversation cannot leave itself.
 *
 * Pausing holds delivery rather than refusing sends. Blocking a send would
 * make agents treat a deliberate pause as a failure — retrying, or deciding
 * the conversation is over — and would lose whatever they were saying. Holding
 * stops the exchange just as effectively, since nobody is woken and so nobody
 * replies, and loses nothing.
 */
async function verifyPause() {
  console.log('\npausing the net');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-pause-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const talker = hub.registerAgent({ name: 'talker' });
  const listener = hub.registerAgent({ name: 'listener' });
  const general = hub.getChannel('general').id;
  hub.joinChannel(talker.id, general);
  hub.joinChannel(listener.id, general);

  const parked = hub.waitForMessages(listener.id, { timeoutMs: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 150));

  hub.setPaused(true);
  const first = hub.postMessage({ channelId: general, authorId: talker.id, text: 'held one' });
  const second = hub.postMessage({ channelId: general, authorId: talker.id, text: 'held two' });

  check('a paused hub delivers to nobody', !first.deliveredTo.length && !second.deliveredTo.length, {
    first: first.deliveredTo,
    second: second.deliveredTo,
  });
  check('the messages are still stored', hub.messages.length === 2);
  check('the human can see how much is held', hub.heldCount() === 2, hub.heldCount());

  let settled = false;
  parked.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('a parked agent stays parked rather than being told nothing happened', !settled);

  // ---- resume delivers everything, in order ----
  hub.setPaused(false);
  const released = await parked;
  check('resuming releases what was held', released.map((m) => m.seq).join() === `${first.seq},${second.seq}`, released.map((m) => m.seq));
  check('nothing is held once resumed', hub.heldCount() === 0);

  // ---- and normal delivery works again ----
  const again = hub.waitForMessages(listener.id, { timeoutMs: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const live = hub.postMessage({ channelId: general, authorId: talker.id, text: 'after resume' });
  check('live delivery resumes', live.deliveredTo.includes('listener'), live.deliveredTo);
  check('and the agent receives it', (await again).some((m) => m.seq === live.seq));

  // ---- the pause survives a restart, because forgetting it would be worse ----
  hub.setPaused(true);
  await store.close();
  const reopened = new Store(dataDir);
  const restored = new Hub(reopened);
  restored.load();
  check('a paused hub is still paused after a restart', restored.settings.paused === true);
  await reopened.close();
}

// ============================================
// Speaking must not skip what you have not read
// ============================================

/**
 * The worst bug this hub has had, found by an agent auditing which sequence
 * numbers its listener had actually returned and finding three missing.
 *
 * postMessage advanced the author's read cursor to their own message, as "the
 * author is implicitly caught up on their own message". What that actually
 * meant was that speaking marked you as having read everything said while you
 * were composing. Anything that arrived in that window fell behind the cursor
 * and no later wait ever returned it — silent, permanent loss, in the one part
 * of the app that must not lose anything.
 */
async function verifySpeakingDoesNotSkip() {
  console.log('\nspeaking does not skip unread messages');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-cursor-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const listener = hub.registerAgent({ name: 'listener' });
  const talker = hub.registerAgent({ name: 'talker' });
  const general = hub.getChannel('general').id;
  hub.joinChannel(listener.id, general);
  hub.joinChannel(talker.id, general);

  // Caught up to here.
  listener.cursor = hub.postMessage({ channelId: general, authorId: talker.id, text: 'read' }).seq;

  // Two arrive while the listener is composing a reply.
  const first = hub.postMessage({ channelId: general, authorId: talker.id, text: 'while composing' });
  const second = hub.postMessage({ channelId: general, authorId: talker.id, text: 'also while composing' });

  const own = hub.postMessage({ channelId: general, authorId: listener.id, text: 'my reply' });
  check('posting does not advance your own read position past unread messages', listener.cursor < first.seq, {
    cursor: listener.cursor,
    unreadFrom: first.seq,
  });

  const delivered = await hub.waitForMessages(listener.id, { timeoutMs: 800 });
  const seqs = delivered.map((message) => message.seq);
  check('messages that arrived while composing are still delivered', seqs.includes(first.seq) && seqs.includes(second.seq), seqs);
  check('your own message is not returned to you', !seqs.includes(own.seq), seqs);

  const again = await hub.waitForMessages(listener.id, { timeoutMs: 300 });
  check('a second wait does not repeat them', again.length === 0, again.map((m) => m.seq));

  await store.close();
}

// ============================================
// The human is the operator, not a managed agent
// ============================================

/**
 * The console used to offer to sort the human into agent groups and remove them
 * from their own roster — UI describing a multi-human product that does not
 * exist, aimed at the one account that cannot be removed.
 *
 * Taking it out of the UI is not enough on its own: agents still have to see
 * the human in the room and be able to @mention them, and the rules belong in
 * the hub rather than in whichever screen happened to expose them.
 */
async function verifyHumanIsNotAnAgent() {
  console.log('\nthe human is the operator');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-human-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const human = hub.registerAgent({ name: 'operator', kind: 'human', platform: 'human' });
  const agent = hub.registerAgent({ name: 'worker' });

  // ---- still visible to agents ----
  check('agents still see the human in the roster', hub.listAgents().some((a) => a.handle === 'operator'));

  const agentMade = hub.createChannel({ name: 'agent-made', createdBy: agent.id });
  hub.joinChannel(agent.id, agentMade.id);
  check(
    'a channel an agent creates still contains the human',
    agentMade.members.has(human.id),
    'otherwise agents are told nobody else is in a room the human is reading'
  );

  const posted = hub.postMessage({
    channelId: agentMade.id,
    authorId: agent.id,
    text: 'question for @operator',
  });
  check('a mention of the human still parses', posted.mentions.includes('operator'));
  check(
    'the human is not counted in the delivery audience',
    !posted.audience.includes('operator'),
    'humans generate no read receipts, so counting them would make "read by 1 of 2" unreachable'
  );

  // ---- but not managed like one ----
  let removalRefused = false;
  try {
    hub.removeAgent(human.id);
  } catch (error) {
    removalRefused = /cannot be removed/.test(error.message);
  }
  check('the human cannot be removed from the roster', removalRefused);
  check('the human survived the attempt', !!hub.getAgent(human.id));

  const group = hub.createGroup({ name: 'Writers' });
  let groupingRefused = false;
  try {
    hub.setGroupMembership(human.id, group.id, true);
  } catch (error) {
    groupingRefused = /apply to agents/.test(error.message);
  }
  check('the human cannot be put in an agent group', groupingRefused);
  check('the human already has every permission', hub.can(human.id, 'writeGlobalFiles'));

  // ---- a self-DM is a channel nothing can ever be delivered to ----
  let selfDmRefused = false;
  try {
    hub.getOrCreateDm(human.id, human.id);
  } catch (error) {
    selfDmRefused = /with yourself/.test(error.message);
  }
  check('a direct message to yourself is refused', selfDmRefused);
  check(
    'no self-DM channel was left behind',
    !Array.from(hub.channels.values()).some((c) => c.isDm && c.members.size < 2)
  );

  // ---- agents are still managed normally ----
  hub.setGroupMembership(agent.id, group.id, true);
  check('an agent can still be grouped', hub.publicAgent(agent).groups.length === 1);
  check('an agent can still be removed', !!hub.removeAgent(agent.id));

  await store.close();
}

// ============================================
// Deleting a channel
// ============================================

/**
 * A channel could be cleared but never removed, so a hub accumulated every
 * experiment forever. Deletion takes the transcript and the shared folder with
 * it, because leaving either behind orphans files nothing can reach.
 */
async function verifyChannelDeletion() {
  console.log('\ndeleting a channel');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-delete-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const agent = hub.registerAgent({ name: 'worker' });
  const channel = hub.createChannel({ name: 'scratch' });
  hub.joinChannel(agent.id, channel.id);
  hub.postMessage({ channelId: channel.id, authorId: agent.id, text: 'temporary' });
  hub.files.write('channel', channel.id, { name: 'notes.md', content: 'x', authorId: agent.id });

  const result = await hub.deleteChannel('scratch');
  check('deleting reports what went', result.removedMessages === 1, result);
  check('the channel is gone', !hub.getChannel('scratch'));
  check('members no longer belong to it', !agent.channels.has(channel.id));
  check('its messages go with it', !hub.messages.some((m) => m.channelId === channel.id));
  check('its shared files go with it', hub.files.list('channel', channel.id).length === 0);

  // The default channel is recreated on load, so deleting it would appear to
  // work and quietly undo itself on the next launch.
  let refusedDefault = false;
  try {
    await hub.deleteChannel('general');
  } catch (error) {
    refusedDefault = /cannot be deleted/.test(error.message);
  }
  check('the default channel is refused rather than silently restored', refusedDefault);

  await store.close();

  // Deletion has to be durable, not just resident.
  const reopened = new Store(dataDir);
  const restored = new Hub(reopened);
  restored.load();
  check('the deletion survives a restart', !restored.getChannel('scratch'));
  check('the default channel is still there', !!restored.getChannel('general'));
  await reopened.close();
}

// ============================================
// Session reaping
// ============================================

/**
 * A client that vanishes without a DELETE must not stay online forever.
 *
 * `transport.onclose` only fires on explicit termination, but the ordinary
 * shape of an agent is a short-lived process that connects, works, and exits.
 * Those sessions accumulated indefinitely and their agents stayed green, so
 * the roster reported a crowd that had long since left — and the delivery
 * status counted those phantoms when telling the human how many agents were
 * connected.
 *
 * Runs on its own hub: reaping closes every session, which would pull the
 * transport out from under any client the rest of the suite still holds.
 */
async function verifySessionReaping() {
  console.log('\nsession reaping');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-sessions-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const server = createHubServer({ hub, peers: null });
  const { httpServer, port } = await server.listen();
  const url = `http://127.0.0.1:${port}/mcp`;

  // Keeps the transport, so a client can be made to vanish the way a killed
  // process does — socket gone, no DELETE, nothing to notify the server.
  const attach = async (name) => {
    const client = new Client({ name, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { 'X-Clanker-Agent': name } },
    });
    await client.connect(transport);
    await call(client, 'list_channels');
    return transport;
  };

  try {
    const staying = await attach('staying');
    const leaving = await attach('leaving');

    check('live clients hold sessions', server.sessionCount() === 2, server.sessionCount());
    check(
      'agents are online while connected',
      hub.listAgents().filter((a) => a.status === 'online').length === 2
    );

    // Far past the idle limit, but both clients are alive: a connected client
    // holds its server-to-client stream open, and reaping it would disconnect
    // an agent that is behaving correctly.
    const future = Date.now() + 6 * 60 * 1000;
    check('a live client is never reaped, however long it is quiet', server.sweepIdleSessions(future).length === 0);
    check('both agents stay online', hub.listAgents().filter((a) => a.status === 'online').length === 2);

    // Now one goes away the way a process exiting does.
    await leaving.close();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const reaped = server.sweepIdleSessions(future);
    check('a vanished client is reaped', reaped.length === 1, `${reaped.length} reaped`);
    check('the surviving session is untouched', server.sessionCount() === 1, server.sessionCount());

    const online = hub.listAgents().filter((a) => a.status === 'online').map((a) => a.handle);
    check('the vanished agent goes offline', !online.includes('leaving'), online);
    check('the live agent stays online', online.includes('staying'), online);

    await staying.close();
  } finally {
    hub.releaseWaiters();
    await server.closeAllSessions();
    await new Promise((resolve) => httpServer.close(resolve));
    await store.close();
  }
}

// ============================================
// Groups, permissions, and delegated work
// ============================================

/**
 * Exercised directly against the hub rather than over MCP: these are model
 * rules, and testing them here keeps the failure message pointed at the rule
 * that broke rather than at a transport layer.
 */
async function verifyGroupsAndTasks() {
  console.log('\ngroups, permissions, and tasks');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-tasks-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const human = hub.registerAgent({ name: 'Operator', kind: 'human', platform: 'human' });
  const trusted = hub.registerAgent({ name: 'Trusted Agent', platform: 'claude-code' });
  const watched = hub.registerAgent({ name: 'Watched Agent', platform: 'openai' });

  // ---- groups behave like roles ----
  const research = hub.createGroup({ name: 'Research' });
  const deploy = hub.createGroup({ name: 'Deploy' });

  hub.setGroupMembership(trusted.id, research.id, true);
  hub.setGroupMembership(trusted.id, deploy.id, true);
  check(
    'an agent can hold several groups at once',
    hub.publicAgent(trusted).groups.length === 2,
    JSON.stringify(hub.publicAgent(trusted).groups)
  );

  hub.setGroupMembership(trusted.id, deploy.id, false);
  check('a group can be removed without touching the others', hub.publicAgent(trusted).groups.length === 1);

  // ---- permissions add up ----
  check('tasks need approval by default', !hub.canAutoApprove(trusted.id));

  hub.setGroupPermission(research.id, 'autoApproveTasks', true);
  check('a permissive group grants auto-approval', hub.canAutoApprove(trusted.id));
  check('an agent outside that group is unaffected', !hub.canAutoApprove(watched.id));

  hub.setGroupMembership(trusted.id, deploy.id, true);
  check(
    'holding a restrictive group does not cancel a permissive one',
    hub.canAutoApprove(trusted.id),
    'permissions must add, never subtract'
  );

  hub.updateSettings({ autoApproveTasks: true });
  check('the master switch covers everyone', hub.canAutoApprove(watched.id));
  hub.updateSettings({ autoApproveTasks: false });

  // ---- the approval gate ----
  const gated = hub.taskBoard.create({
    fromAgentId: watched.id,
    toAgentId: trusted.id,
    title: 'Check the deploy logs',
  });
  check('work from an unpermitted agent waits for approval', gated.status === 'pending_approval');

  let blocked = null;
  try {
    hub.taskBoard.setStatus(gated.id, 'in_progress', trusted.id);
  } catch (error) {
    blocked = error.message;
  }
  check('an unapproved task cannot be started', /needs approval/.test(blocked || ''), blocked);

  const auto = hub.taskBoard.create({
    fromAgentId: trusted.id,
    toAgentId: watched.id,
    title: 'Summarize findings',
  });
  check('work from a permitted agent skips the queue', auto.status === 'approved');
  check('an auto-approved task records how it was cleared', auto.decidedBy === 'auto');

  // ---- lifecycle ----
  hub.taskBoard.decide(gated.id, { approved: true, byAgentId: human.id });
  check('approval releases the task', hub.taskBoard.get(gated.id).status === 'approved');

  hub.taskBoard.setStatus(gated.id, 'in_progress', trusted.id);
  hub.taskBoard.setStatus(gated.id, 'done', trusted.id);
  const finished = hub.taskBoard.get(gated.id);
  check('the assignee can carry a task to done', finished.status === 'done' && !!finished.completedAt);

  let outsider = null;
  try {
    hub.taskBoard.setStatus(auto.id, 'done', human.id);
  } catch (error) {
    outsider = error.message;
  }
  check('an uninvolved agent cannot close someone else\'s task', /only the agent/.test(outsider || ''), outsider);

  check(
    'tasks are listed for the agent they are assigned to',
    hub.taskBoard.list({ assigneeId: watched.id }).some((task) => task.id === auto.id)
  );

  // ---- removal preserves history ----
  const before = hub.readMessages('general', { limit: 50 }).length;
  hub.removeAgent(watched.id);
  check('a removed agent leaves the roster', hub.getAgentByHandle('watched-agent') === null);
  check(
    'removing an agent leaves the transcript intact',
    hub.readMessages('general', { limit: 50 }).length === before,
    'messages carry a denormalized author precisely so this holds'
  );

  // ---- groups survive a restart ----
  await store.close();
  const reopened = new Store(dataDir);
  const restored = new Hub(reopened);
  restored.load();

  check('groups survive a restart', restored.listGroups().length === 2);
  check(
    'group permissions survive a restart',
    restored.resolveGroup('Research')?.permissions?.autoApproveTasks === true
  );
  check(
    'group membership survives a restart',
    restored.canAutoApprove(restored.getAgentByHandle('trusted-agent').id)
  );
  check('tasks survive a restart', restored.taskBoard.list().length === 2);
  await reopened.close();
}

// ============================================
// Shared files, clearing, and export
// ============================================

async function verifyFilesAndHistory() {
  console.log('\nfiles, permissions, clearing, and export');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-files-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const human = hub.registerAgent({ name: 'Operator', kind: 'human', platform: 'human' });
  const agent = hub.registerAgent({ name: 'Filing Agent', platform: 'claude-code' });
  const general = hub.getChannel('general');
  hub.joinChannel(agent.id, general.id);

  // ---- the security boundary ----
  // Agents choose filenames, so nothing they can name may escape its folder.
  const escapes = [
    '../../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\secrets.txt',
    '/etc/passwd',
    'notes.md/../../../evil.sh',
  ];
  const scopeRoot = path.resolve(dataDir, 'files', 'channels', general.id);
  const contained = escapes.every((name) => {
    try {
      const resolved = path.resolve(hub.files.pathOf('channel', general.id, name));
      return resolved.startsWith(scopeRoot + path.sep);
    } catch {
      return true; // outright rejection is also containment
    }
  });
  check('no filename can escape its folder', contained, escapes.join(' | '));
  check(
    'legitimate names survive sanitising',
    safeName('report v2 (final).csv') === 'report v2 (final).csv'
  );

  // ---- permissions ----
  check('reading shared files is allowed by default', hub.can(agent.id, 'readChannelFiles'));
  check('writing shared files is not', !hub.can(agent.id, 'writeChannelFiles'));
  check('the human is never gated', hub.can(human.id, 'writeGlobalFiles'));

  const writers = hub.createGroup({ name: 'Writers' });
  hub.setGroupMembership(agent.id, writers.id, true);
  check('a new group does not strip the read default', hub.can(agent.id, 'readChannelFiles'));

  hub.setGroupPermission(writers.id, 'writeChannelFiles', true);
  check('granting write through a group works', hub.can(agent.id, 'writeChannelFiles'));
  check('a channel grant does not leak into global', !hub.can(agent.id, 'writeGlobalFiles'));

  // ---- storage ----
  hub.files.write('channel', general.id, {
    name: 'notes.md',
    content: '# Shared notes',
    authorId: agent.id,
    description: 'scratch',
  });
  hub.files.write('global', null, { name: 'charter.md', content: 'be excellent', authorId: human.id });

  check('a channel file lands in its channel', hub.files.list('channel', general.id).length === 1);
  check('scopes are separate', hub.files.list('global', null)[0]?.name === 'charter.md');
  check(
    'text files read back intact',
    hub.files.read('channel', general.id, 'notes.md').text === '# Shared notes'
  );

  hub.files.remove('channel', general.id, 'notes.md');
  check('deleting removes it from the listing', hub.files.list('channel', general.id).length === 0);

  // ---- export ----
  for (let index = 0; index < 4; index++) {
    hub.postMessage({ channelId: general.id, authorId: agent.id, text: `line ${index}` });
  }
  const markdown = await hub.exportChannelMarkdown('general');
  check('the export names its participants', markdown.includes('@filing-agent'));
  check('the export groups by day', /### \w+day/.test(markdown));
  check('the export carries the messages', markdown.includes('line 3'));

  // ---- clearing ----
  const removed = await hub.clearChannel('general');
  check('clearing reports what it removed', removed >= 4, `removed ${removed}`);
  check('the channel is empty in memory', hub.readMessages('general', { limit: 50 }).length === 0);

  await store.close();

  const reopened = new Store(dataDir);
  const restored = new Hub(reopened);
  restored.load();

  // The durable log is the copy that matters — a memory-only clear would put
  // every "deleted" message back on the next launch.
  check(
    'cleared messages do not come back after a restart',
    restored.readMessages('general', { limit: 50 }).length === 0
  );
  check('clearing a channel leaves global files alone', restored.files.list('global', null).length === 1);
  await reopened.close();
}

// ============================================
// Identity across reconnects
// ============================================

/**
 * A closed and reopened editor window should come back as itself. Before this,
 * every reconnect minted claude-code-2, -3, -4 beside its own ghosts.
 */
async function verifyReconnectIdentity() {
  console.log('\nidentity across reconnects');

  const { handlers } = require('../src/mcp/handlers');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clankercom-identity-'));
  const store = new Store(dataDir);
  const hub = new Hub(store);
  hub.load();

  const mcpHandles = () =>
    hub.listAgents().filter((agent) => agent.kind === 'mcp').map((agent) => agent.handle);

  const connect = (id, clientName) => {
    const context = { hub, peers: null, session: { id, clientInfo: { name: clientName } } };
    handlers.whoami({}, context);
    return context;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const context = connect(`s${attempt}`, 'claude-code');
    hub.setAgentStatus(context.session.agentId, 'offline');
  }
  check(
    'a reconnecting client reclaims its own identity',
    mcpHandles().length === 1 && mcpHandles()[0] === 'claude-code',
    mcpHandles().join(', ')
  );

  // Two windows open at once are two agents, and the live one is never taken.
  const first = connect('a', 'claude-code');
  const second = connect('b', 'claude-code');
  check(
    'two concurrent clients stay distinct',
    mcpHandles().length === 2 && mcpHandles().includes('claude-code-2'),
    mcpHandles().join(', ')
  );
  check('a live holder is never displaced', hub.getAgent(first.session.agentId).handle === 'claude-code');

  // A handle claimed on purpose is not reclaimable, even once offline.
  handlers.join_hub({ name: 'Payments API Migration' }, second);
  hub.setAgentStatus(second.session.agentId, 'offline');
  connect('c', 'payments-api-migration');
  check(
    'a deliberately claimed handle is never stolen',
    hub.getAgent(second.session.agentId).handle === 'payments-api-migration',
    mcpHandles().join(', ')
  );

  await store.close();
}

async function main() {
  await verifyPortSelection();
  await verifyReconnectIdentity();
  await verifyChannelPlacement();
  await verifySharedRoom();
  await verifyPause();
  await verifySpeakingDoesNotSkip();
  await verifyHumanIsNotAnAgent();
  await verifyChannelDeletion();
  await verifySessionReaping();
  await verifyGroupsAndTasks();
  await verifyFilesAndHistory();

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

  // ---- the sender is told who the message actually reached ----
  // Waking a waiter removes it from the pool, so a listener count sampled
  // after the send is always zero. The console reported "nobody is listening"
  // for messages that had just been delivered; the answer has to come back
  // with the post itself.
  const parked = call(research, 'wait_for_messages', { timeout_seconds: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));

  check('a parked agent is reported as listening', hub.listeners().includes('research-agent'), hub.listeners());

  const delivered = hub.postMessage({
    channelId: hub.getChannel('general').id,
    authorId: hub.getAgentByHandle('clankercom-lead-agent').id,
    text: 'Delivery receipt check.',
  });
  await parked;

  check(
    'a post reports the listeners it woke',
    delivered.deliveredTo.includes('research-agent'),
    delivered.deliveredTo
  );
  check('waking a listener empties the listener pool', hub.listeners().length === 0, hub.listeners());

  const undelivered = hub.postMessage({
    channelId: hub.getChannel('general').id,
    authorId: hub.getAgentByHandle('clankercom-lead-agent').id,
    text: 'Nobody is parked for this one.',
  });
  check(
    'a post nobody was waiting on reports no delivery',
    undelivered.deliveredTo.length === 0,
    undelivered.deliveredTo
  );


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

  // ---- reconnecting by header must not overwrite an established profile ----
  const headerClient = new Client({ name: 'claude-code', version: '1.0.0' });
  await headerClient.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { 'X-Clanker-Agent': 'ClankerCom Lead Agent' } },
    })
  );
  const afterHeader = hub.getAgentByHandle('clankercom-lead-agent');
  check(
    'reconnecting by header keeps the platform set at join_hub',
    afterHeader?.platform === 'claude-code',
    `platform is now "${afterHeader?.platform}"`
  );

  // HTTP header values are latin-1 only, so a name with an em-dash cannot be
  // sent literally — the client throws before the request leaves. Percent
  // encoding is the way through, and the hub decodes it.
  const encodedName = new Client({ name: 'x', version: '1.0.0' });
  await encodedName.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { 'X-Clanker-Agent': encodeURIComponent('Research — Vector Stores') },
      },
    })
  );
  check(
    'a percent-encoded header name arrives intact',
    hub.getAgentByHandle('research-vector-stores')?.displayName === 'Research — Vector Stores',
    hub.getAgentByHandle('research-vector-stores')?.displayName
  );
  await encodedName.close();

  const headerPlatform = new Client({ name: 'x', version: '1.0.0' });
  await headerPlatform.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { 'X-Clanker-Agent': 'Header Named Agent', 'X-Clanker-Platform': 'grok' },
      },
    })
  );
  check(
    'X-Clanker-Platform is honoured on connect',
    hub.getAgentByHandle('header-named-agent')?.platform === 'grok',
    `platform is "${hub.getAgentByHandle('header-named-agent')?.platform}"`
  );
  await headerClient.close();
  await headerPlatform.close();

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

  // A browser peer cannot outlive its webview, so restoring one would leave a
  // roster entry that looks reachable and silently swallows every mention.
  hub.registerAgent({ name: 'Ghost Peer', kind: 'browser', platform: 'claude-web' });
  await store.close();

  const reloaded = new Store(dataDir);
  const afterRestart = new Hub(reloaded);
  afterRestart.load();

  check(
    'browser peers do not survive a restart',
    afterRestart.getAgentByHandle('ghost-peer') === null,
    'a detached browser peer came back in the roster'
  );
  check(
    'a pruned peer is removed from its channels too',
    !afterRestart
      .publicChannel(afterRestart.getChannel('general'))
      .members.includes('ghost-peer')
  );
  check(
    'pruning a peer leaves other agents alone',
    afterRestart.agents.size >= 2,
    `${afterRestart.agents.size} agents remain`
  );

  await reloaded.close();
}

main().catch((error) => {
  console.error('\ncheck crashed:', error);
  process.exit(1);
});
