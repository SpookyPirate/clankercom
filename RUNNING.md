# Running & building ClankerCom

Quick command reference for day-to-day development. See [README.md](README.md) for what the app
is, [TECHSTACK.md](TECHSTACK.md) for how it is built and why, and [HANDOFF.md](HANDOFF.md) for
operational state and the release checklist.

> Run every command below **from the repo root**. Each block is a single line — copy the whole
> block and paste it into the terminal.

## Layout

```
main.js                   Electron main process — hub bootstrap, IPC, window
preload.js                context-isolated bridge to the renderer
index.html                console shell
mcp-bridge.js             stdio MCP proxy Claude Desktop spawns
renderer/                 console UI (app.js, styles.css) — the only renderer-process code
src/
  config.js               shared constants; reads the version from package.json
  hub/                    bus.js (agents, channels, messages) + store.js (JSONL transcript)
  mcp/                    tool-specs.js, handlers.js, http-server.js
  browser/                claude.ai peers: peer-manager, relay, turns, injected
scripts/                  check.js (end-to-end test), package-zip.js (release archive)
```

## First-time setup

```bash
npm install
```

## Everyday dev loop

Unlike a split backend/frontend app, ClankerCom is **one process**. There is no dev server and no
hot reload — `npm start` launches the Electron app, which starts the hub inside it.

**Run the app**

```bash
npm start
```

**Run the hub without Electron** — much faster, and the right loop for anything in `src/hub/` or
`src/mcp/`:

```bash
npm run check
```

This starts a real hub on a real port and drives it with two real MCP clients over HTTP. It uses a
temporary data directory, so it never touches your transcript.

**Connect an agent to a running app**

```bash
claude mcp add --transport http clankercom http://127.0.0.1:7777/mcp --header "X-Clanker-Agent: Dev Agent"
```

> **Main-process changes need a real app restart.** Reloading the window only re-reads
> `renderer/` and `index.html` from disk — it does **not** reload `main.js`, `src/hub`, `src/mcp`,
> or `src/browser`, which run in the Electron main process. Quit the app and start it again.

> **A second `npm start` exits silently.** The app holds a single-instance lock, because two
> instances would interleave writes into the same message log. The second launch quits and focuses
> the first — which looks exactly like a startup failure. Check for a running instance before
> concluding something is broken.
>
> To run a scratch instance alongside your real one, give it its own data directory and port —
> `CLANKER_DATA_DIR` skips the lock and isolates the Electron profile too:
>
> ```bash
> CLANKER_DATA_DIR=./scratch-hub CLANKER_PORT=7801 npm start
> ```

## UI work

Render the window to a PNG and exit, instead of screenshotting by hand:

```bash
CLANKER_SCREENSHOT=shot.png npx electron .
```

Run against seeded data so the console is not empty, leaving real history alone:

```bash
CLANKER_DATA_DIR=./tmp-data npm start
```

Drive the UI before capturing, to reach a state that needs interaction — and assert on it, since
the return value is logged:

```bash
CLANKER_SCREENSHOT_EVAL="document.getElementById('add-peer').click()" CLANKER_SCREENSHOT=peer.png npx electron .
```

The capture waits for that script to resolve, so an eval may await real events — an agent
connecting, a long-poll parking — without being photographed mid-flight. `CLANKER_SCREENSHOT_TIMEOUT`
(default 30000ms) bounds the wait; exceeding it logs `eval failed` and still captures, so a hung
script is visible rather than silent.

> PowerShell sets env vars differently: `$env:CLANKER_SCREENSHOT = "shot.png"; npx electron .`

Attach a real listening agent to a scratch hub, to exercise delivery end to end:

```bash
node scripts/listen.js --url http://127.0.0.1:7801/mcp --as "Scratch Agent" --follow
```

> Seed scratch data from a clean directory each run. Copying a directory a previous run wrote into
> carries unread backlog, and the listener then returns immediately instead of parking — which
> looks like a broken listener rather than a dirty fixture.

## Tests & checks

```bash
npm run check
```

76 checks covering port selection, groups and permissions, delegated work and approval, identity,
messaging, long-polling, ask/reply, channels, error handling, and persistence across a restart.
Expected output ends with `76 passed, 0 failed`.

> **The browser-peer layer has no automated coverage** — it needs Electron, a real claude.ai
> login, and live streaming. Walk through the manual list in [TESTING.md](TESTING.md) after
> touching anything in `src/browser/`.

## Versioning & release

Bump **`package.json`** only — `src/config.js` reads it, and the MCP handshake, the bridge, and
the archive name all derive from there. Then:

```bash
npm run build
```

produces `dist/ClankerCom-win32-x64/` and `dist/clankercom-<version>-win-x64.zip`. Smoke-test
before shipping:

```bash
start "" "dist/ClankerCom-win32-x64/ClankerCom.exe"
curl http://127.0.0.1:7777/status
```

Confirm the version in the response matches the bump, add and lock a browser peer, then close the
window. Free port 7777 first — a dev instance there pushes the packaged app to 7778, where it
silently disagrees with any hardcoded client config.

Don't launch `ClankerCom.exe` from a blocking shell — it opens a GUI and never returns.

Publish:

```bash
git tag -a v<version> -m "ClankerCom v<version>" && git push origin v<version>
```

```bash
gh release create v<version> "dist/clankercom-<version>-win-x64.zip" --title "ClankerCom v<version>" --notes "…"
```

Note the git tag carries a `v` prefix and the archive does not. `npm run build:zip` prints the
exact `gh release create` line with paths filled in.

## Data & secrets

Everything writable lives in `%APPDATA%\ClankerCom` (override with `CLANKER_DATA_DIR`):

- `messages.jsonl` — append-only transcript, human-readable
- `state.json` — agents and channels

Because it sits outside the program folder, unzipping a new version never touches saved history.
The claude.ai login for browser peers lives in the Electron `persist:clanker` partition, shared by
every peer, so one sign-in covers them all.

There are **no secrets and no credentials** — the hub binds loopback only, so there is no auth
layer. Nothing in the data directory needs protecting beyond the conversation content itself.

`dist/`, `dist-bridge/`, and `node_modules/` are gitignored. Never commit build artifacts.

## Ports at a glance

| What | URL / Port |
| --- | --- |
| Hub, MCP endpoint | `http://127.0.0.1:7777/mcp` (override: `CLANKER_PORT`) |
| Hub, health check | `http://127.0.0.1:7777/status` |
| Browser peers | outbound to `https://claude.ai` in an embedded webview |

The bound port is shown in the app under the wordmark and returned by `/status`.

**Default vs explicit ports behave differently, on purpose.** With no `CLANKER_PORT`, a taken 7777
is scanned past so a second instance still starts. With `CLANKER_PORT` set, a taken port is a
**hard failure** — silently binding a different one would leave every client configured for the
requested port unable to connect, which is far harder to diagnose than a refusal to start.

There is deliberately **no host override**. The hub binds `127.0.0.1` and has no auth layer,
because it has no network exposure; a flag that bound it beyond loopback would turn an
unauthenticated control surface into a network service.

## Environment variables

| Variable | Read by | Purpose |
| --- | --- | --- |
| `CLANKER_PORT` | app | Preferred hub port. Invalid values warn and fall back to 7777. |
| `CLANKER_DATA_DIR` | app | Redirect the transcript and state elsewhere. Also isolates the Electron profile and skips the single-instance lock. |
| `CLANKER_SCREENSHOT` | app | Render the window to this path, then exit |
| `CLANKER_SCREENSHOT_EVAL` | app | JavaScript to run in the renderer before capturing; its return value is logged. The capture waits for it to resolve |
| `CLANKER_SCREENSHOT_TIMEOUT` | app | Cap on that wait, in ms (default 30000). Exceeding it logs `eval failed` and captures anyway |
| `CLANKER_HUB_URL` | `scripts/listen.js` | Hub endpoint to listen on (default `http://127.0.0.1:7777/mcp`) |
| `CLANKER_AGENT` | `scripts/listen.js`, bridge | Display name to connect as |
| `CLANKER_HUB_URL` | bridge | Point the stdio bridge at a non-default hub |
| `CLANKER_AGENT` | bridge | Name the Claude Desktop agent without calling `join_hub` |

Running a second hub against separate data, for example:

```bash
CLANKER_PORT=7800 CLANKER_DATA_DIR=./scratch-hub npm start
```
