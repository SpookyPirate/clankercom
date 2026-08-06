/**
 * http-server.js — MCP Streamable HTTP endpoint for the ClankerCom hub.
 *
 * Any MCP client that can point at an HTTP URL connects here directly:
 *   claude mcp add --transport http clankercom http://127.0.0.1:7777/mcp
 *
 * Claude Desktop is the exception — it only accepts stdio servers — so it goes
 * through mcp-bridge.js, which forwards to this same endpoint.
 *
 * Each MCP session gets its own McpServer instance. That is what lets two
 * Claude Code windows connect simultaneously and be recognised as two distinct
 * agents rather than one shared identity.
 *
 * Binds loopback only. There is no auth layer because there is no network
 * exposure; DNS-rebinding protection guards against a browser on this machine
 * being used to reach the endpoint from a hostile page.
 *
 * Used by: main.js
 */

const { randomUUID } = require('crypto');
const express = require('express');

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

const {
  APP_NAME,
  APP_VERSION,
  HUB_HOST,
  DEFAULT_PORT,
  PORT_IS_EXPLICIT,
  PORT_SCAN_LIMIT,
} = require('../config');
const { TOOL_SPECS } = require('./tool-specs');
const { handlers } = require('./handlers');

// Header an agent can set to claim a handle without calling join_hub, e.g.
//   claude mcp add --transport http clankercom <url> --header "X-Clanker-Agent: reviewer"
const AGENT_HEADER = 'x-clanker-agent';
const PLATFORM_HEADER = 'x-clanker-platform';

/**
 * Read a header value that may carry a name we cannot send as-is.
 *
 * HTTP header values are ByteString — latin-1 only — so a client cannot put a
 * name like "Research — Vector Stores" in a header at all; the request throws
 * before it leaves. That is a real trap, because names with dashes and accents
 * are exactly what the naming convention asks agents to choose.
 *
 * Percent-encoded values are therefore decoded here, so a client can send
 * `Research%20%E2%80%94%20Vector%20Stores` and arrive with the name intact.
 * A value that is not percent-encoded passes through untouched.
 */
function decodeHeader(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed escapes mean it was never percent-encoded; take it literally.
    return value;
  }
}

function createHubServer({ hub, peers }) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const sessions = new Map(); // sessionId -> session record
  let boundPort = DEFAULT_PORT;

  // ============================================
  // Per-session MCP server
  // ============================================

  /**
   * Build an McpServer bound to one session's identity. Every tool from
   * tool-specs.js is registered against its handler with a shared context.
   */
  function buildServerForSession(session) {
    const server = new McpServer({ name: 'clankercom', version: APP_VERSION });
    const context = { hub, peers, session };

    for (const spec of TOOL_SPECS) {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema: spec.inputSchema,
        },
        async (args) => invokeTool(spec.name, args ?? {}, context, server)
      );
    }

    return server;
  }

  /**
   * Run a tool handler, surfacing failures as readable tool errors.
   *
   * Agents recover far better from a sentence than from a stack trace, and an
   * isError result keeps the conversation alive where a thrown transport
   * error would not.
   */
  async function invokeTool(name, args, context, server) {
    // Client identity only becomes available after initialize completes.
    if (!context.session.clientInfo) {
      context.session.clientInfo = server.server.getClientVersion() || null;
    }

    try {
      return await handlers[name](args, context);
    } catch (error) {
      // Message only: most failures here are ordinary validation ("no such
      // channel"), and stack traces for those bury real faults in noise.
      console.error(`[clankercom] tool ${name} failed: ${error.message}`);
      return {
        content: [{ type: 'text', text: `${name} failed: ${error.message}` }],
        isError: true,
      };
    }
  }

  // ============================================
  // Session lifecycle
  // ============================================

  function createSession(headers) {
    const session = {
      id: null, // assigned by the transport on initialize
      agentId: null,
      clientInfo: null,
      requestedHandle: decodeHeader(headers[AGENT_HEADER]),
      requestedPlatform: decodeHeader(headers[PLATFORM_HEADER]),
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [`${HUB_HOST}:${boundPort}`, `localhost:${boundPort}`],
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        sessions.set(sessionId, session);
        adoptRequestedIdentity(session);
      },
    });

    transport.onclose = () => closeSession(session);
    session.transport = transport;
    session.server = buildServerForSession(session);
    return session;
  }

  /** Honour X-Clanker-Agent so an agent can be named purely by config. */
  function adoptRequestedIdentity(session) {
    if (!session.requestedHandle) return;
    try {
      const agent = hub.registerAgent({
        name: session.requestedHandle,
        displayName: session.requestedHandle,
        // Only pass a platform when the header actually supplied one. An
        // agent reconnecting by header alone would otherwise have the
        // platform it established via join_hub overwritten with "other".
        platform: session.requestedPlatform || undefined,
        kind: 'mcp',
        sessionId: session.id,
      });
      session.agentId = agent.id;
    } catch (error) {
      console.error('[clankercom] could not adopt requested handle:', error.message);
    }
  }

  /** Mark the agent offline when its transport drops. */
  function closeSession(session) {
    if (session.id) sessions.delete(session.id);
    if (session.agentId) hub.setAgentStatus(session.agentId, 'offline');
  }

  // ============================================
  // Routes
  // ============================================

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? sessions.get(sessionId) : null;

    let session = existing;
    if (!session) {
      if (!isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session. Send an initialize request first.' },
          id: null,
        });
      }
      session = createSession(req.headers);
      await session.server.connect(session.transport);
    }

    await session.transport.handleRequest(req, res, req.body);
  });

  // GET opens the server-to-client SSE stream; DELETE ends the session.
  const handleSessionRequest = async (req, res) => {
    const session = sessions.get(req.headers['mcp-session-id']);
    if (!session) return res.status(404).send('Unknown session');
    await session.transport.handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  // Plain HTTP status page — handy for curl and for the bridge's reachability
  // probe. Deliberately not on /mcp, which belongs to the SSE stream.
  app.get('/status', (_req, res) => {
    res.json({
      service: 'clankercom',
      version: APP_VERSION,
      transport: 'mcp-streamable-http',
      endpoint: `http://${HUB_HOST}:${boundPort}/mcp`,
      agents: hub.agents.size,
      channels: hub.channels.size,
      sessions: sessions.size,
      latestSeq: hub.seq,
    });
  });

  // ============================================
  // Listening
  // ============================================

  /**
   * Bind the hub's port.
   *
   * With the default port, scan upward when it is taken so a second instance
   * starts cleanly instead of dying with EADDRINUSE. With an explicitly
   * requested CLANKER_PORT, fail loudly instead — quietly binding a different
   * port would leave every client configured for the requested one unable to
   * connect, which is far harder to diagnose than a refusal to start.
   */
  function listen() {
    return new Promise((resolve, reject) => {
      let attempt = 0;

      const tryPort = (port) => {
        const httpServer = app.listen(port, HUB_HOST, () => {
          boundPort = port;
          console.log(`[${APP_NAME}] hub listening on http://${HUB_HOST}:${port}/mcp`);
          resolve({ httpServer, port });
        });

        httpServer.on('error', (error) => {
          if (error.code !== 'EADDRINUSE') return reject(error);

          if (PORT_IS_EXPLICIT) {
            return reject(
              new Error(
                `CLANKER_PORT=${port} is already in use. Free it, or set a different ` +
                  `CLANKER_PORT. (Unset it to let the hub pick a free port automatically.)`
              )
            );
          }

          if (attempt < PORT_SCAN_LIMIT) {
            attempt++;
            return tryPort(port + 1);
          }

          reject(
            new Error(
              `No free port between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_SCAN_LIMIT}.`
            )
          );
        });
      };

      tryPort(DEFAULT_PORT);
    });
  }

  /** Close every live session. Called during shutdown. */
  async function closeAllSessions() {
    for (const session of Array.from(sessions.values())) {
      try {
        await session.transport.close();
      } catch {
        // A session whose socket is already gone is not an error here.
      }
    }
    sessions.clear();
  }

  return { app, listen, closeAllSessions, getPort: () => boundPort };
}

module.exports = { createHubServer };
