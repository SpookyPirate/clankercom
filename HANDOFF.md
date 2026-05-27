# HANDOFF.md — For Claude Code

Read these files in this order, then build the project per `IMPLEMENTATION_GUIDE.md`.

1. **README.md** — What Claude Intercom is, why it exists, the architecture.
2. **IMPLEMENTATION_GUIDE.md** — Step-by-step build instructions with verification checks at each stage.
3. **TESTING.md** — Acceptance test checklist. Run through this before declaring done.
4. **TROUBLESHOOTING.md** — Reference for when things break (now or later).

## Files to drop in verbatim

These are complete, working source files. Do not refactor on the first pass. Build the unmodified version, verify it works, THEN improve.

- `package.json`
- `main.js`
- `preload.js`
- `index.html`
- `renderer.js`
- `mcp-bridge.js`
- `src/relay.js`
- `src/injected.js`
- `src/mcp-server.js`

## Quick reference — what each file does

| File | Role |
|------|------|
| `main.js` | Electron main process. Creates window, starts the internal HTTP server when webview attaches, wires IPC handlers. |
| `preload.js` | Secure IPC bridge. Exposes a controlled `window.intercom` API to the renderer. |
| `index.html` | UI shell — sidebar with lock/unlock buttons, status pill, log, and the claude.ai webview. |
| `renderer.js` | UI logic — wires button clicks to IPC calls, updates status, writes to log. |
| `mcp-bridge.js` | Standalone stdio MCP server Claude Desktop spawns. Forwards tool calls to `localhost:7777`. |
| `src/relay.js` | The relay. Owns the locked state, validates URL, calls into the webview to send/receive. |
| `src/injected.js` | The DOM-coupled part. Lives inside the claude.ai page. Single source of truth for selectors. |
| `src/mcp-server.js` | Internal HTTP JSON-RPC server. Exposes `talk_to_remote_claude` and `get_relay_status` for the bridge (and curl debugging). |

## The single most important thing to know

`src/injected.js` is where claude.ai's DOM gets touched. Every selector and every interaction with the page lives there. If anything UI-related breaks in the future, that's the only file you need to look at. There's a `SELECTORS` constant at the top — that's the maintenance surface.

Everything else in the codebase is structurally stable: Electron APIs, Express, HTTP, IPC. Those don't churn. The page DOM does.

## Build expectation

You should be able to:
1. `npm install`
2. `npm start`
3. Log into claude.ai in the webview
4. Navigate to a conversation, click Lock
5. Curl the MCP endpoint and successfully exchange a message round-trip
6. Add Claude Intercom to Claude Desktop as a custom connector and have the two Claudes talk

…all without modifying the provided code. If that doesn't work, the first place to look is the selectors in `src/injected.js` — claude.ai may have shifted DOM structure since this code was written.
