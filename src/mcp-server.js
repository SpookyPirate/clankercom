// src/mcp-server.js — minimal MCP-over-HTTP server
//
// This is a hand-rolled JSON-RPC implementation that speaks the subset of MCP
// that Claude Desktop needs for a custom connector: initialize, tools/list,
// tools/call. Upgrading to @modelcontextprotocol/sdk is a future refactor;
// this gets us working without SDK version churn.

const express = require('express');

function createMcpServer(relay) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS — Claude Desktop's MCP client runs in the Desktop process, but allowing
  // localhost cross-origin is harmless and helps with curl debugging.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/debug/messages', async (_req, res) => {
    try {
      const result = await relay.discoverMessageStructure();
      res.type('application/json').send(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/debug/selectors', async (_req, res) => {
    try {
      const result = await relay.discoverSelectors();
      res.type('application/json').send(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/mcp', (_req, res) => {
    res.json({
      service: 'claude-intercom',
      version: '1.0.0',
      transport: 'jsonrpc-over-http',
      note: 'POST JSON-RPC requests to this endpoint.',
    });
  });

  app.post('/mcp', async (req, res) => {
    const { method, params, id } = req.body || {};

    const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => res.json({
      jsonrpc: '2.0', id, error: { code, message },
    });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'claude-intercom', version: '1.0.0' },
          });

        case 'tools/list':
          return reply({
            tools: [
              {
                name: 'talk_to_remote_claude',
                description:
                  'Send a message to the other Claude instance via the Claude Intercom relay. ' +
                  'The message is typed into the locked claude.ai conversation, and the ' +
                  'full response (after streaming completes) is returned synchronously. ' +
                  'The relay automatically prepends "[Message from another Claude instance]:" ' +
                  'to your message so the remote Claude can tell it apart from its user\'s ' +
                  'own input — you do not need to add that yourself.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      description: 'The message to send to the remote Claude.',
                    },
                  },
                  required: ['message'],
                },
              },
              {
                name: 'read_recent_messages',
                description:
                  'Read the most recent messages from the locked claude.ai conversation. ' +
                  'Useful for catching up on context before starting a new exchange, or ' +
                  'checking what was last said. Returns an array of { role, text } objects ' +
                  'ordered oldest to newest. Default count is 1 (just the most recent message).',
                inputSchema: {
                  type: 'object',
                  properties: {
                    count: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 20,
                      description: 'How many recent messages to return. Defaults to 1.',
                    },
                  },
                },
              },
              {
                name: 'get_relay_status',
                description:
                  'Check whether Claude Intercom is locked to a conversation and what the current ' +
                  'state of the relay is.',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          });

        case 'tools/call': {
          const { name, arguments: args = {} } = params || {};

          if (name === 'talk_to_remote_claude') {
            if (typeof args.message !== 'string' || !args.message.trim()) {
              return fail(-32602, 'message must be a non-empty string');
            }
            const response = await relay.send(args.message);
            return reply({
              content: [{ type: 'text', text: response }],
            });
          }

          if (name === 'read_recent_messages') {
            const count = Number.isFinite(args.count) ? args.count : 1;
            const messages = await relay.readRecentMessages(count);
            return reply({
              content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
            });
          }

          if (name === 'get_relay_status') {
            const status = {
              locked: relay.locked,
              url: relay.lockedUrl,
              busy: relay.busy,
            };
            return reply({
              content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
            });
          }

          return fail(-32601, `unknown tool: ${name}`);
        }

        // Common MCP methods we don't implement — return empty results gracefully
        case 'resources/list':
          return reply({ resources: [] });
        case 'prompts/list':
          return reply({ prompts: [] });
        case 'notifications/initialized':
          return reply({});

        default:
          return fail(-32601, `method not found: ${method}`);
      }
    } catch (err) {
      console.error('[intercom] tool call error:', err);
      return fail(-32000, err.message || String(err));
    }
  });

  return app;
}

module.exports = { createMcpServer };
