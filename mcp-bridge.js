#!/usr/bin/env node
/**
 * mcp-bridge.js — stdio MCP server that Claude Desktop spawns.
 *
 * Claude Desktop only accepts stdio MCP servers; its custom-connector dialog
 * rejects http:// URLs. Every other client (Claude Code, OpenAI agents, Grok,
 * anything speaking MCP over HTTP) connects to the hub directly and does not
 * need this file at all.
 *
 * This is a transparent proxy rather than a reimplementation: it connects to
 * the hub as an MCP client and forwards tools/list and tools/call verbatim.
 * Tool definitions therefore live in exactly one place — the hub — and adding
 * a tool never requires touching the bridge.
 *
 * Configure in claude_desktop_config.json:
 *   "clankercom": {
 *     "command": "<path>\\resources\\clankercom-bridge.exe",
 *     "env": { "CLANKER_AGENT": "Claude Desktop — Main" }
 *   }
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { APP_VERSION } = require('./src/config');

const HUB_URL = process.env.CLANKER_HUB_URL || 'http://127.0.0.1:7777/mcp';

// Lets a Desktop instance name itself without calling join_hub, matching the
// header the hub honours for HTTP clients.
const AGENT_NAME = process.env.CLANKER_AGENT || null;

const UNREACHABLE =
  `Cannot reach the ClankerCom hub at ${HUB_URL}. ` +
  `Start the ClankerCom app, then try again.`;

// ============================================
// Hub connection
// ============================================

let hubClient = null;
let connecting = null;

/**
 * Connect lazily and reuse the connection.
 *
 * Claude Desktop spawns this process at its own startup, which is routinely
 * before the hub app is running, so connecting eagerly would fail for reasons
 * that resolve themselves a minute later.
 */
async function connectToHub() {
  if (hubClient) return hubClient;
  if (connecting) return connecting;

  connecting = (async () => {
    const client = new Client({ name: 'clankercom-bridge', version: APP_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(HUB_URL), {
      requestInit: AGENT_NAME
        ? { headers: { 'X-Clanker-Agent': AGENT_NAME, 'X-Clanker-Platform': 'claude-desktop' } }
        : undefined,
    });

    await client.connect(transport);

    // A dropped hub means the next call should reconnect rather than fail
    // against a dead client forever.
    client.onclose = () => {
      hubClient = null;
      connecting = null;
    };

    hubClient = client;
    return client;
  })();

  try {
    return await connecting;
  } catch (error) {
    connecting = null;
    throw new Error(`${UNREACHABLE} (${error.message})`);
  }
}

// ============================================
// Proxy server
// ============================================

const server = new Server(
  { name: 'clankercom', version: APP_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const client = await connectToHub();
  return client.listTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const client = await connectToHub();

  try {
    return await client.callTool({
      name: request.params.name,
      arguments: request.params.arguments || {},
    });
  } catch (error) {
    // Surface failures as tool errors so the conversation continues instead
    // of the transport tearing down.
    return {
      content: [{ type: 'text', text: `${request.params.name} failed: ${error.message}` }],
      isError: true,
    };
  }
});

(async () => {
  await server.connect(new StdioServerTransport());
})().catch((error) => {
  console.error('[clankercom bridge] fatal:', error);
  process.exit(1);
});
