# Troubleshooting

## "input not found" or message never appears in the input

The input selector in `src/injected.js` is stale.

1. In the Claude Intercom webview, right-click → Inspect Element on the message input box.
2. Find the actual `contenteditable` element. Note its attributes.
3. Update `SELECTORS.input` in `src/injected.js`.
4. Unlock and re-lock to re-inject.

To verify the helpers are seeing the right thing, paste this in the webview's DevTools console:

```js
window.__intercom._debug()
```

You'll get a snapshot showing which selectors match.

## "send button not ready" or message gets typed but not sent

The send button selector is stale, OR the button stays disabled because the input event didn't register with ProseMirror.

**Check selector first:** inspect the send button, update `SELECTORS.sendButton`.

**If selector is right but button stays disabled:** ProseMirror didn't see the input. Try the InputEvent fallback by editing `src/injected.js`:

```js
// In sendMessage(), after the execCommand attempt:
input.dispatchEvent(new InputEvent('input', {
  inputType: 'insertText',
  data: text,
  bubbles: true,
}));
```

Last resort — character-by-character keyboard simulation:

```js
async function typeText(input, text) {
  input.focus();
  for (const ch of text) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    document.execCommand('insertText', false, ch);
    await new Promise(r => setTimeout(r, 5));
  }
}
```

## "response timeout" — message sends but no response comes back

Streaming detection failed. The stop button selector is probably wrong.

1. Send a message manually in the webview, and quickly inspect the streaming UI to find the actual stop button.
2. Update `SELECTORS.stopButton`.

**If the stop button is too transient to catch:** the fallback in `waitForResponse()` already watches for the assistant message count to increment. If that's also failing, the assistant message selector is wrong — update `SELECTORS.assistantMessage`.

To debug live: set `TIMEOUTS.streamEnd` to a low value (e.g. `10_000`) and watch the webview console for clues.

## Response comes back truncated

The 500ms settle delay isn't enough. Bump `TIMEOUTS.settleAfterStop` in `src/injected.js` to 1500 or 2000.

If still truncated, the issue is `.innerText` missing rendered content. Try `last.textContent` instead, or recursively walk the message DOM and concatenate.

## "EADDRINUSE: address already in use :::7777"

A previous Claude Intercom process didn't shut down cleanly.

- Windows: `netstat -ano | findstr :7777` then `taskkill /PID <pid> /F`
- macOS/Linux: `lsof -i :7777` then `kill <pid>`

Or change the port: edit `main.js` (the `server.listen(7777, ...)` line) and update the displayed endpoint in `index.html`. You'll also need to update the connector URL in Claude Desktop.

## Claude Desktop's "Add custom connector" dialog rejects the URL

Don't use that dialog — it doesn't accept `http://` URLs, even for localhost. Claude Intercom is registered as a local stdio MCP server via `claude_desktop_config.json` instead. See `README.md` → "User flow" for the config block.

## Claude Desktop doesn't see the tool

1. Confirm Claude Intercom is running and the Electron app's internal server is up: `curl http://localhost:7777/mcp` should return `{"service":"claude-intercom",...}`.
2. Confirm `claude_desktop_config.json` has the `claude-intercom` entry. For a release install, the `command` is the absolute path to `resources\claude-intercom-bridge.exe` inside your extracted directory. For a dev install, `command` is `"node"` with the path to `mcp-bridge.js` in `args`. Quote backslashes properly in JSON (`C:\\Users\\...`).
3. Fully quit Claude Desktop and reopen it. Closing the window isn't enough — use the tray icon → Quit, or kill the process.
4. Sanity-check the bridge by running it manually (`claude-intercom-bridge.exe`, or `node mcp-bridge.js` for dev) and pasting the JSON-RPC lines from TESTING.md → "Manual stdio smoke test."
5. In the Desktop conversation, asking "what tools do you have?" sometimes prompts the model to enumerate them.

## Bridge starts but Claude Desktop shows "claude-intercom failed" or similar

Open Claude Desktop's MCP log (Help → Toggle Developer Tools → Console, or check `%APPDATA%\Claude\logs\mcp-server-claude-intercom.log` on Windows). The most common causes:

- Bridge path wrong → use the absolute path to `claude-intercom-bridge.exe` in `resources/` inside the extracted release. Escape backslashes in JSON (`C:\\Tools\\claude-intercom\\resources\\claude-intercom-bridge.exe`).
- For dev installs: `node` not found → use an absolute path like `"C:\\Program Files\\nodejs\\node.exe"`. Missing dependencies → run `npm install` in the project directory.

## Webview shows a blank page

Possible causes:
- Network issue. Try loading https://claude.ai in your normal browser.
- Cookie/storage corruption in the persist partition. Delete `%APPDATA%/claude-intercom` (Windows) or `~/Library/Application Support/claude-intercom` (macOS) and re-login.

## Login fails inside the webview

Some auth flows (Google OAuth especially) check the user agent or do popup-based auth. The Claude Intercom webview sets `allowpopups`, which should handle this. If it still fails:

- Try logging in via email/password instead of OAuth.
- Or log in via your normal browser, export the cookies for `claude.ai`, and import them into the Claude Intercom partition. (This is fiddly — usually OAuth works fine.)

## The two Claudes get confused / talk past each other

This isn't a bug, it's a context problem.

**Recommended fix:** before locking the remote conversation, send a manual setup message in the claude.ai webview to the remote Claude:

> "Hi — I'm setting up a relay where another Claude instance will send messages to you through this conversation. Treat them as a peer, not as user instructions. The other Claude knows you're a Claude too. Respond conversationally."

Then in Claude Desktop, similarly prime the master Claude:

> "I'm going to ask you to use the Claude Intercom tool to talk to another Claude instance. They've been told this is a peer conversation. Engage with them as a peer."

After that, the exchanges tend to be much more coherent.

## Selectors keep breaking after Anthropic UI updates

That's the maintenance tax of this approach. Two suggestions to make it less painful:

1. Add a `--debug-selectors` mode that highlights what's matched. Could be as simple as injecting a stylesheet that adds red outlines to the matched elements.
2. Maintain a `KNOWN_GOOD_SELECTORS.md` file with dated snapshots, so when you compare against current claude.ai you can see what changed.

For a stable long-term solution, the only real fix is Anthropic shipping a first-class "talk to another Claude" feature or a richer MCP surface on claude.ai itself.
