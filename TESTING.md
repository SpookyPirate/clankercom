# Testing checklist

Walk through this end-to-end before declaring the build done. Each item should pass.

## Phase 1: App launches cleanly

- [ ] `npm install` completes without errors.
- [ ] `npm start` opens the Claude Intercom window.
- [ ] Sidebar shows "📻 Claude Intercom" header, status pill, Lock/Unlock buttons, and empty log.
- [ ] Right pane loads `claude.ai` (you may see the login page or your usual dashboard).
- [ ] Console (main process) does not show errors.

## Phase 2: Session persistence

- [ ] Log into claude.ai inside the webview.
- [ ] Close the Claude Intercom window completely.
- [ ] Reopen with `npm start`.
- [ ] You should still be logged in (no re-login prompt). Confirms the `persist:intercom` partition works.

## Phase 3: Lock guard

- [ ] On the claude.ai home page (URL is `https://claude.ai/`), click Lock.
- [ ] Expected: error message saying you need to navigate to a specific conversation. Status pill turns red.
- [ ] Navigate to any existing conversation (URL becomes `https://claude.ai/chat/<uuid>`).
- [ ] Click Lock.
- [ ] Expected: status pill turns green, shows truncated chat ID. Log shows "locked to <url>". Console shows "MCP server listening on http://localhost:7777/mcp".

## Phase 4: MCP endpoint

With the relay locked, in a separate terminal:

```bash
curl -s http://localhost:7777/mcp | jq
```
- [ ] Returns service info JSON (status 200).

```bash
curl -s -X POST http://localhost:7777/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | jq
```
- [ ] Returns `result.serverInfo.name == "claude-intercom"`.

```bash
curl -s -X POST http://localhost:7777/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq
```
- [ ] Lists `talk_to_remote_claude` and `get_relay_status`.

```bash
curl -s -X POST http://localhost:7777/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_relay_status","arguments":{}}}' | jq
```
- [ ] Returns status JSON showing `locked: true` and the URL.

## Phase 5: Round-trip via curl

With the relay locked to a conversation:

```bash
curl -s -X POST http://localhost:7777/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"talk_to_remote_claude","arguments":{"message":"Reply with the single word PONG and nothing else."}}}' | jq
```

- [ ] Watch the Claude Intercom webview. The message should appear in the input field and be sent.
- [ ] Within ~10 seconds, curl returns a result containing "PONG".
- [ ] Claude Intercom sidebar log shows the relay was busy and then completed.

## Phase 6: Guards

- [ ] While the relay is mid-call, click in the webview and navigate to a different chat.
- [ ] Send another curl tool call.
- [ ] Expected: error mentioning the locked URL doesn't match current URL. Relay state remains locked but the tool call fails cleanly.

## Phase 7: Unlock / re-lock

- [ ] Click Unlock.
- [ ] Status pill returns to idle.
- [ ] Send a tool call via curl. Expected: error "Claude Intercom is not locked to a conversation."
- [ ] Navigate to another chat in the webview. Click Lock. Verify the new URL is captured.

## Phase 8: Claude Desktop integration

Claude Desktop's custom-connector dialog rejects `http://` URLs, so Claude Intercom registers as a local stdio MCP server via `claude_desktop_config.json` instead. Claude Desktop spawns `mcp-bridge.js`, which forwards tool calls over loopback HTTP to the Electron app.

Edit `%APPDATA%\Claude\claude_desktop_config.json` and add a `claude-intercom` entry under `mcpServers`. If you installed from a release zip, point at the bundled bridge exe:

```json
{
  "mcpServers": {
    "claude-intercom": {
      "command": "<install path>\\resources\\claude-intercom-bridge.exe"
    }
  }
}
```

If you're developing from source, point at the JS file instead:

```json
"claude-intercom": {
  "command": "node",
  "args": ["<repo path>\\mcp-bridge.js"]
}
```

If you already have other entries under `mcpServers`, add `claude-intercom` alongside them.

- [ ] Save the config and fully restart Claude Desktop (quit and reopen, not just close the window).
- [ ] Make sure Claude Intercom is running and locked to a conversation.
- [ ] Start a new Claude Desktop conversation.
- [ ] Verify the model can see the tool (ask "what tools do you have available?"). You should see `talk_to_remote_claude` and `get_relay_status`.
- [ ] Ask the model to use it: "Use the Claude Intercom tool to ask the other Claude to introduce itself."
- [ ] Watch the message flow through the webview and the response come back to Desktop Claude.
- [ ] Try a longer exchange — three or four back-and-forth turns.

### Manual stdio smoke test (optional, for debugging)

If Claude Desktop doesn't see the tools, sanity-check the bridge directly. With the Electron app running and locked:

```bash
node mcp-bridge.js
```

Then paste these one line at a time and press Enter — each should produce a JSON response:

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_relay_status","arguments":{}}}
```

If `tools/list` returns both tools but `get_relay_status` errors with "Cannot reach the Claude Intercom app," the bridge is fine — the Electron app just isn't running or didn't successfully bind to `:7777`.

## Phase 9: Shutdown

- [ ] Close the Claude Intercom window.
- [ ] Console shows "MCP server closed".
- [ ] `curl http://localhost:7777/mcp` from a terminal should now fail (connection refused).
- [ ] No orphaned Electron processes.

## If anything fails

See `TROUBLESHOOTING.md` for diagnostic steps and common fixes.
