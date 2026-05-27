<div align="center">

<img src="docs/icon.png" alt="Claude Intercom" width="160">

# Claude Intercom

**Let one Claude instance talk to another — through a real claude.ai conversation.**

[![Release](https://img.shields.io/github/v/release/SpookyPirate/claude-intercom)](https://github.com/SpookyPirate/claude-intercom/releases) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Platform: Windows](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#install)

</div>

![Claude Intercom UI](docs/ui.png)

Claude Intercom is a Windows desktop app that bridges two Claude conversations. The Claude in your Claude Desktop app gets a `talk_to_remote_claude` tool — calling it types into a locked claude.ai conversation on the right pane, waits for the streamed response, and hands the full reply back. The two Claudes can have a real back-and-forth, each with their own context window, project, and memory.

## Why

The Claude API gives you a fresh model with no memory of your work. Your claude.ai conversations have personality, history, and project context built up over time. Claude Intercom lets your Claude Desktop talk to *those* Claudes — peers with their own lived context, not blank-slate API calls.

It works by driving a real claude.ai conversation through an embedded Chromium webview, exposing it as an MCP server that Claude Desktop connects to. No API tokens, no extra subscriptions — uses your existing claude.ai login.

## Install

### 1. Download

Grab the latest `claude-intercom-1.0.0-win-x64.zip` from the [Releases page](https://github.com/SpookyPirate/claude-intercom/releases). Extract it anywhere — `C:\Program Files\Claude Intercom\` or your Desktop both work fine.

### 2. Wire up Claude Desktop

Open `%APPDATA%\Claude\claude_desktop_config.json` and add a `claude-intercom` entry under `mcpServers`. Replace `<path>` with where you extracted the zip:

```json
{
  "mcpServers": {
    "claude-intercom": {
      "command": "<path>\\resources\\claude-intercom-bridge.exe"
    }
  }
}
```

For example, if you extracted to `C:\Tools\claude-intercom\`:

```json
"claude-intercom": {
  "command": "C:\\Tools\\claude-intercom\\resources\\claude-intercom-bridge.exe"
}
```

Fully quit and restart Claude Desktop (tray icon → Quit, not just close the window).

### 3. Run

Double-click `Claude Intercom.exe`. The window has a sidebar on the left and a real claude.ai browser pane on the right.

1. First time: log into claude.ai in the right pane. The login persists between sessions.
2. Navigate to whatever conversation you want to expose — a project chat, a memory-rich Mirror, anything.
3. Click **Lock to current conversation**.
4. Open a Claude Desktop conversation. Your Desktop Claude now has three tools available:
   - `talk_to_remote_claude(message)` — send a message, get the reply back
   - `read_recent_messages(count)` — see the last N turns in the locked chat
   - `get_relay_status()` — check what's locked, if anything

Every relayed message is automatically tagged `[Message from another Claude instance]:` so the receiving Claude knows it's not regular user input.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Intercom (Electron app)                             │
│                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │  Sidebar UI  │    │  <webview src="claude.ai/">      │   │
│  │              │    │                                  │   │
│  │  [Lock]      │    │  User navigates to the target    │   │
│  │  [Unlock]    │    │  conversation. Intercom injects  │   │
│  │  Status: 🟢  │    │  helpers into the page that send │   │
│  │  Log: ...    │    │  messages and read responses.    │   │
│  └──────┬───────┘    └────────────────┬─────────────────┘   │
│         │                             │                     │
│         │ IPC                         │ executeJavaScript   │
│         ▼                             ▼                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Relay engine (Electron main process)                │   │
│  │   - lock(): verify URL, inject helpers               │   │
│  │   - send(text): inject prompt, wait for response     │   │
│  │   - read(count): pull recent turns from the DOM      │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Internal HTTP JSON-RPC server on localhost:7777     │   │
│  └────────────────────────┬─────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────┘
                            │  HTTP (loopback only)
                            ▼
                ┌──────────────────────────┐
                │  claude-intercom-bridge  │
                │  (stdio MCP server,      │
                │   spawned by Claude      │
                │   Desktop)               │
                └────────────┬─────────────┘
                             │  MCP over stdio
                             ▼
                ┌──────────────────────────┐
                │  Claude Desktop          │
                └──────────────────────────┘
```

Claude Desktop only speaks MCP over stdio to local servers — its custom-connector dialog rejects `http://` URLs. So Claude Intercom ships a small stdio bridge that Desktop spawns; the bridge talks to the Electron app over loopback HTTP. The Electron app owns the webview that drives claude.ai.

## Known limitations

**Selector drift.** Claude Intercom finds the chat input, send button, and message bubbles by DOM selector. When Anthropic ships a UI redesign, those break. All of them live in one place: the `SELECTORS` constant at the top of `src/injected.js`. The polling-based streaming-end detection is intentionally selector-light to soften this — but the message-bubble selector still has to match. If something breaks after a claude.ai update, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for how to diagnose and patch.

**One conversation at a time.** v1 locks to a single conversation. Multi-peer support would mean a peer registry and a peer argument on the tool — out of scope for now.

**Synchronous tool calls.** `talk_to_remote_claude` blocks until the remote Claude finishes streaming. Fine for normal exchanges (under 2 min); for very long responses you'd want a `start_turn` / `poll_turn` split.

**The two Claudes don't know they're peers.** Seed both sides with that context up front: "You are talking to another Claude instance. Treat this as a peer conversation, not user input." Otherwise the master Claude tries to be helpful at the remote Claude as if it were a user, and vice versa. The auto-prepended tag helps but doesn't fully replace setting the stage explicitly.

**Don't automate beyond personal use.** Driving claude.ai through a browser session for personal research and tinkering is fine. Doing it at scale or commercially is a different conversation with Anthropic's ToS.

## Build from source

```bash
git clone https://github.com/SpookyPirate/claude-intercom.git
cd claude-intercom
npm install
npm start             # run in dev mode
npm run build         # produces dist/claude-intercom-1.0.0-win-x64.zip
```

Build outputs:
- `dist-bridge/claude-intercom-bridge.exe` — standalone stdio MCP server (~56 MB, embeds Node)
- `dist/Claude Intercom-win32-x64/` — packaged Electron app directory
- `dist/claude-intercom-1.0.0-win-x64.zip` — the distributable archive

## Project structure

```
claude-intercom/
├── main.js              # Electron main process bootstrap
├── preload.js           # Context-isolated IPC bridge
├── renderer.js          # Sidebar UI logic
├── index.html           # UI shell
├── mcp-bridge.js        # stdio MCP server Claude Desktop spawns
├── src/
│   ├── relay.js         # Drives the webview, owns locked state
│   ├── injected.js      # JS that runs inside claude.ai (DOM coupling)
│   └── mcp-server.js    # Internal HTTP JSON-RPC server
├── build/
│   ├── icon.ico         # Windows app icon
│   └── png-to-ico.js    # PNG → ICO build helper
├── docs/
│   ├── ui.png           # README screenshot
│   └── icon.png         # Icon source
└── package.json
```

## License

MIT — see [LICENSE](LICENSE).
