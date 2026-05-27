#!/usr/bin/env node
// mcp-bridge.js — stdio MCP server that Claude Desktop spawns.
//
// Claude Desktop's custom-connector dialog rejects http:// URLs, so we can't
// point it directly at the Electron app's local HTTP server. Instead, Claude
// Desktop runs this script over stdio (configured in claude_desktop_config.json),
// and this script forwards tool calls to the Electron app's internal HTTP API
// on localhost:7777.
//
// Run by Claude Desktop. You shouldn't need to invoke it manually except for
// debugging — see TESTING.md for the manual smoke test.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const RELAY_URL = process.env.CLAUDE_INTERCOM_URL || 'http://127.0.0.1:7777/mcp';

async function callRelay(name, args) {
  let res;
  try {
    res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach the Claude Intercom app at ${RELAY_URL}. ` +
      `Open Claude Intercom and lock it to a conversation, then try again.`
    );
  }
  if (!res.ok) {
    throw new Error(`Claude Intercom returned HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || 'relay returned an error');
  }
  return json.result;
}

const server = new McpServer({
  name: 'claude-intercom',
  version: '1.0.0',
});

server.registerTool(
  'talk_to_remote_claude',
  {
    description:
      'Send a message to the other Claude instance via the Claude Intercom relay. ' +
      'The message is typed into the locked claude.ai conversation, and the full ' +
      'response (after streaming completes) is returned synchronously. ' +
      'The relay automatically prepends "[Message from another Claude instance]:" ' +
      'to your message so the remote Claude can tell it apart from its user\'s ' +
      'own input — you do not need to add that yourself.',
    inputSchema: {
      message: z.string().min(1).describe('The message to send to the remote Claude.'),
    },
  },
  async ({ message }) => callRelay('talk_to_remote_claude', { message })
);

server.registerTool(
  'read_recent_messages',
  {
    description:
      'Read the most recent messages from the locked claude.ai conversation. ' +
      'Useful for catching up on context before starting a new exchange, or ' +
      'checking what was last said. Returns an array of { role, text } objects ' +
      'ordered oldest to newest. Default count is 1 (just the most recent message).',
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
  async ({ count }) => callRelay('read_recent_messages', count !== undefined ? { count } : {})
);

server.registerTool(
  'get_relay_status',
  {
    description:
      'Check whether Claude Intercom is locked to a conversation and what the ' +
      'current state of the relay is.',
    inputSchema: {},
  },
  async () => callRelay('get_relay_status', {})
);

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((err) => {
  console.error('[claude-intercom bridge] fatal:', err);
  process.exit(1);
});
