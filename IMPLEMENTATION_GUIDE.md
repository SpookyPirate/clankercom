# Implementation Guide for Claude Code

You are implementing **Claude Intercom**, a standalone Electron application that bridges two Claude instances via MCP. Read `README.md` first for the full design rationale.

## Your job

Build the application exactly as specified in the files below. Do not redesign the architecture — it was worked through deliberately. If you spot bugs in the provided code, fix them. If you spot ambiguity, prefer the simpler interpretation.

## Build order

Follow this order. Each step has a verification check before moving on.

### Step 1: Scaffold

```bash
mkdir claude-intercom && cd claude-intercom
npm init -y
npm install electron express
mkdir src
```

Edit `package.json` to match the provided `package.json` file in this handoff (set `"main": "main.js"`, add the `"start"` script, set the Electron version).

**Verify:** `npx electron --version` runs without error.

### Step 2: Drop in the source files

Copy these files from the handoff verbatim into the project:

- `main.js` → project root
- `preload.js` → project root
- `index.html` → project root
- `renderer.js` → project root
- `src/relay.js`
- `src/injected.js`
- `src/mcp-server.js`

Do NOT modify them on the first pass. Get the unmodified version running first.

**Verify:** Run `npm start`. The app window opens with the sidebar on the left and claude.ai loading in the right pane.

### Step 3: Verify the webview attaches

The DevTools log in the renderer should print `webview attached`. The sidebar status should read `⚪ Idle — navigate to a conversation`.

**Verify:** Log into claude.ai inside the webview. Navigate to any conversation. The URL bar shows `/chat/<uuid>`.

### Step 4: Verify the lock

Click **Lock to current conversation**.

Expected behavior:
- Status pill turns green: `🟢 Locked: <chat-id>`
- Log line: `locked to https://claude.ai/chat/...`
- Console (main process) prints `MCP on :7777`
- Lock button disabled, Unlock button enabled

**If lock fails:** check that you navigated to a `/chat/` URL, not the conversation list at `/`.

### Step 5: Verify the MCP endpoint manually

Without Claude Desktop yet, hit the MCP server with curl to confirm it works:

```bash
curl -X POST http://localhost:7777/mcp \
  -H "Content-Type: application/json" \
  -d '{"id":1,"method":"tools/list"}'
```

Expected response: JSON with `result.tools` listing `talk_to_remote_claude` and `get_relay_status`.

```bash
curl -X POST http://localhost:7777/mcp \
  -H "Content-Type: application/json" \
  -d '{"id":2,"method":"tools/call","params":{"name":"talk_to_remote_claude","arguments":{"message":"Say the word PONG and nothing else."}}}'
```

Expected: after ~3-10 seconds, response contains the assistant's reply. Watch the webview — you should see "Say the word PONG and nothing else." appear in the input and get sent.

**If selectors are stale and the message doesn't send:** see `TROUBLESHOOTING.md` for how to inspect the webview DOM and update `SELECTORS` in `src/injected.js`.

### Step 6: Connect Claude Desktop (via stdio bridge)

Claude Desktop's "Add custom connector" dialog rejects `http://` URLs, even for localhost. Use the stdio MCP path instead: Desktop spawns `mcp-bridge.js`, which forwards calls to the Electron app over loopback HTTP.

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add a `claude-intercom` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "claude-intercom": {
      "command": "node",
      "args": ["<absolute path to>/mcp-bridge.js"]
    }
  }
}
```

Fully restart Claude Desktop (Quit, then reopen — closing the window isn't enough). Start a new conversation. Confirm the model can see and call `talk_to_remote_claude`.

**Verify end-to-end:** Ask Desktop Claude to "Use the Claude Intercom tool to ask the other Claude what its favorite color is." Watch the message appear in the webview, the remote Claude respond, and the response flow back into Desktop Claude.

## Important implementation notes

### MCP transport

Two MCP-shaped surfaces exist in this project:

- `src/mcp-server.js` is a hand-rolled JSON-RPC server bound to `localhost:7777`. It's an *internal* API — useful for curl debugging and for the stdio bridge to forward against. Claude Desktop never talks to it directly.
- `mcp-bridge.js` is a proper MCP server using `@modelcontextprotocol/sdk` over stdio. It's what Claude Desktop spawns and speaks MCP with. It hardcodes the tool schemas and forwards each `tools/call` to the internal HTTP server.

This split is deliberate: the relay needs `webContents` from Electron's main process, which Claude Desktop can't spawn into. So the Electron app keeps the relay, exposes it over loopback HTTP, and the bridge — a tiny standalone process — translates between Desktop's stdio MCP and the HTTP API.

### Selectors will drift

`src/injected.js` contains a `SELECTORS` constant with claude.ai's DOM selectors. These will need updating periodically as claude.ai's UI evolves. Treat this file as the single source of truth for all DOM coupling.

Selectors as shipped (verify these against current claude.ai when you build):
- Input: `div[contenteditable="true"][translate="no"]`
- Send button: `button[aria-label="Send message"]`
- Stop button: `button[aria-label="Stop response"]` (appears during streaming)
- Assistant messages: `div.font-claude-message`

To verify/update: right-click inside the Claude Intercom webview → Inspect Element. Find the actual current selectors. Update the constant. Done.

### Streaming detection

`waitForResponse()` in `src/injected.js` uses a two-phase detection:
1. **Wait for stream to start** — the stop button appears when a response begins streaming.
2. **Wait for stream to end** — the stop button disappears AND the assistant message count has incremented.

Then it waits 500ms for any trailing tokens to settle, and reads `.innerText` of the last assistant message.

If stop button detection is unreliable, fallback strategies (in order of preference):
1. Watch for a `data-streaming` or similar attribute on the message node.
2. Poll `.innerText` length on the last message — when it stops changing for 1.5s, consider it done.
3. Watch the network panel for the SSE stream closing (requires CDP, more complex).

### ProseMirror input

claude.ai uses ProseMirror for the input editor. Naive `input.value = text` does NOT work. The shipped code uses `document.execCommand('insertText', ...)` which dispatches the events ProseMirror listens for.

If `execCommand` stops working (it's deprecated, browsers may eventually remove it), fallbacks:
1. Dispatch `InputEvent` with `inputType: 'insertText'` and the text in `data`.
2. Type character-by-character via synthetic keyboard events.
3. Find the ProseMirror view via `editorEl.pmViewDesc` and dispatch a transaction: `view.dispatch(view.state.tr.insertText(text))`.

### Locked-conversation guard

`relay.send()` checks `window.location.href` against `lockedUrl` on every call. If the user navigates away in the webview while the master Claude is mid-call, the send aborts with a clear error rather than sending to the wrong chat.

Optionally, you can also disable navigation while locked. The webview emits `will-navigate`; call `event.preventDefault()` on it when `relay.locked` is true. This is suggested as a v1.1 enhancement, not required.

### Context isolation

The preload script uses `contextBridge.exposeInMainWorld('intercom', {...})` rather than enabling `nodeIntegration: true`. This is the secure pattern. Keep it.

## Acceptance criteria

The implementation is complete when:

1. ✅ `npm start` launches the app cleanly.
2. ✅ Logging into claude.ai persists across app restarts.
3. ✅ Lock button only succeeds on a `/chat/<id>` URL.
4. ✅ Lock injects helpers and starts the MCP server.
5. ✅ Unlock stops accepting tool calls but leaves the MCP server running (so re-locking is fast).
6. ✅ `tools/list` and `tools/call` both respond correctly via curl.
7. ✅ Calling `talk_to_remote_claude` types the message into the locked conversation, waits for the full response, and returns it.
8. ✅ Trying to send while the user has navigated away returns a clear error instead of corrupting state.
9. ✅ Closing the Claude Intercom window cleanly shuts down the Express server (the app fully exits).
10. ✅ Claude Desktop can successfully add `http://localhost:7777/mcp` as a connector and call the tool end-to-end.

## What NOT to do

- ❌ Do not add Playwright. The whole point is one app, one process.
- ❌ Do not add a database. The session lives in the Electron partition.
- ❌ Do not implement multi-peer support in v1. Single locked conversation only.
- ❌ Do not try to be clever about streaming detection. The two-phase stop-button approach works; iterate only if it actually fails.
- ❌ Do not bundle Claude Desktop or claude.ai assets. Only drive them.
- ❌ Do not store the user's claude.ai cookies anywhere outside the Electron partition.

## When you're done

Run through `TESTING.md` end-to-end. If anything in the acceptance criteria fails, fix it before declaring done.
