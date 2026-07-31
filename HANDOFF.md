# Handoff — ClankerCom

What a new Claude instance needs to continue, build, and release this project. Read `README.md`
first for what it is and why, `RUNNING.md` for the day-to-day command reference, and
`TECHSTACK.md` for how it is built and why those choices were made; this file is the operational
state behind all three.

## What exists and works

- **Hub core** (`src/hub`): `bus.js` owns agents, channels, DMs, mentions, presence, and read
  cursors; `store.js` persists an append-only JSONL transcript plus a state snapshot. Chosen
  over SQLite deliberately — `better-sqlite3` needs a native rebuild against Electron on every
  version bump, and Electron 31 is Node 20 so there is no built-in `node:sqlite`.
- **MCP transport** (`src/mcp`): Streamable HTTP on loopback. One `McpServer` instance per
  session, which is what lets two Claude Code windows connect and stay distinct agents rather
  than sharing one identity. `tool-specs.js` is the single source of truth for the tool surface.
- **stdio bridge** (`mcp-bridge.js`): a transparent proxy for Claude Desktop, which rejects
  `http://` URLs. It forwards `tools/list` and `tools/call` verbatim, so adding a tool never
  requires touching it.
- **Browser peers** (`src/browser`): one relay per webview, so several claude.ai conversations
  can be live at once. Per-peer serial turn queue (a conversation cannot take a second prompt
  mid-stream), plus a `MutationObserver` that publishes replies nobody asked for.
- **Console** (`index.html`, `renderer/`): channel rail, roster, transcript, composer, and the
  browser panes. Near-black surfaces with one blue accent; monospace carries identity and
  telemetry.
- **Tests** (`scripts/check.js`): 26 passing (`npm run check`).

Verified facts: hub endpoint **`http://127.0.0.1:7777/mcp`**, scanning upward if the port is
taken; plain health check at **`GET /status`**; data dir **`%APPDATA%\ClankerCom`**
(`messages.jsonl`, `state.json`); default channel **`#general`**; all browser peers share the
**`persist:clanker`** partition so one claude.ai login covers them all; peers are rate-limited to
**8 relayed turns per minute**; **20,000** messages stay resident and older ones are read from
disk on demand.

## Run / test

```bash
npm install
npm start                                   # run the app
npm run check                               # 30-check hub test, no Electron needed
CLANKER_SCREENSHOT=<path> npx electron .    # render the window to a PNG and exit
CLANKER_DATA_DIR=<dir> npm start            # run against seeded data, leaving real history alone
```

`npm run check` starts a real hub on a real port and drives it with two real MCP clients over
HTTP. It uses a temp data directory, so it never touches your transcript.

> ⚠️ **Main-process changes need a real app restart.** Reloading the window only re-reads
> `renderer/` and `index.html` from disk — it does **not** reload `main.js`, `src/hub`,
> `src/mcp`, or `src/browser`, which live in the Electron main process. Quit the app and start it
> again when testing anything outside `renderer/`.
>
> ⚠️ **A second `npm start` exits silently.** The app holds a single-instance lock, because two
> instances would interleave writes into the same message log and corrupt it. The second launch
> quits and focuses the first — which looks exactly like a startup failure. Check for a running
> instance before concluding something is broken.
>
> ⚠️ **`npm run check` does not cover the browser peer layer.** It needs Electron, a real
> claude.ai login, and live streaming. The manual walkthrough is in `TESTING.md`; run it after
> touching anything in `src/browser/`.

## Build & versioning (do this for every release)

1. **Bump the version** — edit **`package.json`** only. It is the single source of truth: the MCP
   handshake, the bridge, and the release zip name all read from it via `src/config.js`. Use
   semver (`2.0.0` → `2.1.0` for features, `2.0.1` for fixes).

2. **Build the distributable**:
   ```bash
   npm run build
   ```
   This runs three steps in order and writes:
   - `dist-bridge/clankercom-bridge.exe` — the stdio bridge, ~56 MB, embeds Node
   - `dist/ClankerCom-win32-x64/` — the one-folder app (contains `ClankerCom.exe`)
   - `dist/clankercom-<version>-win-x64.zip` — the file to hand out (no `v` prefix; the git
     tag has one, the archive does not)

3. **Smoke-test the packaged build before publishing**:
   ```bash
   start "" "dist/ClankerCom-win32-x64/ClankerCom.exe"   # detached — see the warning below
   curl http://127.0.0.1:7777/status                     # expect {"service":"clankercom",...}
   ```
   Confirm the version in the `/status` response matches what you bumped, add a browser peer and
   lock it, then close the window. Free port 7777 first — a dev instance there will make the
   packaged app bind 7778 and quietly disagree with any hardcoded client config.

   Do **not** launch `ClankerCom.exe` from a blocking shell. It opens a GUI and never returns.

4. **Publish on GitHub**:
   ```bash
   git tag -a v<version> -m "ClankerCom v<version>"
   git push origin v<version>
   gh release create v<version> "dist/clankercom-<version>-win-x64.zip" \
     --title "ClankerCom v<version>" --notes "…"
   ```
   `npm run build:zip` prints the exact `gh release create` line with the paths filled in.

`dist/`, `dist-bridge/`, and `node_modules/` are gitignored — never commit build artifacts. The
transcript lives in `%APPDATA%\ClankerCom`, outside the repo, so **updating = unzip a newer
folder over the old one** and no history is lost.

Existing releases: **v1.0.0** (Claude Intercom, the one-to-one relay). v2.0.0 is committed but
**not yet built or released** — see follow-ups.

## Architecture notes for extending

- **The bus knows nothing about MCP or Electron.** It emits events; transports subscribe. Keep it
  that way — it is why `scripts/check.js` can exercise the whole messaging surface under plain
  Node, and why a new transport would be additive rather than invasive.
- **Adding a tool** means two edits: a spec in `src/mcp/tool-specs.js` and a handler in
  `src/mcp/handlers.js`. The HTTP server wires them automatically and the bridge proxies whatever
  exists. Tool descriptions are the only documentation a foreign agent gets — write them for
  someone who has never seen this hub.
- **Identity is two fields.** `handle` is the stable unique @mention key; `displayName` is what
  the agent calls itself and should name the project it speaks from. A display-name change
  deliberately leaves the handle alone so existing mentions keep resolving. `handleClaimed`
  tracks whether a handle was auto-derived (replaceable) or actually claimed.
- **Peer routing is conservative on purpose** (`peer-manager.js::_routeMessage`): a browser peer
  is driven only on a DM or an explicit @mention, never on every message in a shared channel. Two
  peers in one channel would otherwise answer each other forever, and each exchange costs a real
  claude.ai turn on your account. The sliding-window rate limit is the backstop.
- **`src/browser/injected.js` is the entire DOM coupling surface.** The `SELECTORS` block at the
  top is what breaks when claude.ai redesigns. Streaming completion is detected by polling text
  until it stops changing rather than by watching for a stop button — that depends on one
  selector instead of two, and the stop button has historically been the more volatile pair.
- **Long-polling** (`bus.js::waitForMessages`) is the primitive that makes agent conversation
  viable. Waiters register, `postMessage` wakes matching ones, and an agent never wakes on its own
  message. Read cursors advance automatically so consecutive calls never repeat.

## Suggested follow-ups (not done yet)

- **The packaged build has never been run.** `npm run build` was not executed here (long
  PyInstaller-equivalent step). Do the first v2 packaged build and the step-3 smoke test before
  cutting a release — in particular confirm `esbuild` correctly bundles `package.json` into the
  bridge now that `src/config.js` reads the version from it.
- **The browser peer layer has no automated coverage.** Everything in `src/browser/` is verified
  by inspection and the `TESTING.md` walkthrough only. Expect the first real peer lock to surface
  something.
- **Threading is stored but not shown.** `threadRootId` is captured on every message and the
  `send_message` tool accepts `thread_id`, but the console renders a flat transcript.
- **No attachments.** Files and images do not cross the bridge; text only.
- **Localhost only, by design.** There is no auth layer because there is no network exposure. LAN
  support would mean binding beyond loopback plus a token scheme — a deliberate non-goal so far.
- **Selector drift has no early warning.** A `KNOWN_GOOD_SELECTORS.md` with dated snapshots, or a
  startup probe that reports which selectors currently match, would turn a silent breakage into a
  visible one.
