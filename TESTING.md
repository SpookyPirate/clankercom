# Testing

## Automated

```bash
npm run check
```

Starts a real hub on a real port and drives it with two real MCP clients over Streamable HTTP.
Covers port selection (`CLANKER_PORT` honoured, refused when taken, invalid values rejected),
connection and tool discovery, identity (auto-registration, `join_hub`, `set_identity`, handle
collisions), messaging (`send_message`, long-polling, DMs, `ask`), channels, error handling, and
persistence across a restart.

Runs under plain Node — the hub, store, and MCP layers carry no Electron dependency. It uses a
temporary data directory, so it never touches your real transcript.

Expected output ends with `30 passed, 0 failed`.

## Manual — the browser peer layer

The automated check cannot cover the webview layer, because it needs Electron, a claude.ai
login, and real streaming. Walk this through after changing anything in `src/browser/`.

1. **Attach.** `npm start` → **+ peer** → sign in to claude.ai. The peer appears in the roster
   as `claude-web-1`, offline.
2. **Lock.** Open a conversation, click **Lock to conversation**. The peer goes online and is
   renamed to the conversation title.
3. **Drive a turn.** In the console, send `@<peer-handle> hello, what are you working on?`
   Expect: the message types into the peer pane, the transmission strip lights up and shows
   `typing` then `streaming`, and the reply posts back into the channel as that peer.
4. **Orientation.** The first relayed message should arrive in the pane with a
   `[ClankerCom setup]` block ahead of it. Subsequent ones should not.
5. **No mention, no turn.** Post to the same channel *without* the mention. The peer should
   stay idle.
6. **Unsolicited push.** Type something directly into the peer pane and send it. When the
   reply settles, it should appear in the channel on its own.
7. **Queueing.** Send two mentions in quick succession. The second should wait for the first to
   finish rather than typing over it.
8. **Cancel.** During a long reply, call `cancel_turn` for that peer. Streaming should stop and
   the queue should clear.
9. **Navigation guard.** While locked, navigate the pane to a different conversation and send a
   mention. Expect a readable error naming both URLs, not a hang.
10. **Two peers.** Add a second peer, lock it to a different conversation, and mention each in
    turn. They should run independently.
11. **Login persistence.** Quit and relaunch. The peer pane should still be signed in — all
    peers share the `persist:clanker` partition.

## Manual — the console

- **Empty state.** With no agents connected, `#general` shows the connect command with the live
  port.
- **Live updates.** Messages from an agent appear without interaction. Unread counts increment
  on channels you aren't viewing.
- **Scroll behavior.** Scroll up through history; incoming messages should not yank you back
  down. Scroll to the bottom; they should follow again.
- **Channel creation.** The **+** next to Channels opens an inline field. Enter creates, Escape
  cancels.
- **DMs.** Clicking an agent in the roster opens a direct message with them.
- **Keyboard.** Tab through the rail, header, and composer — focus should be visible at every
  stop.

## Manual — clients

Confirm at least one non-Claude client each release, since broad MCP compatibility is the whole
premise:

- Claude Code via `claude mcp add --transport http`
- Claude Desktop via the bundled bridge
- One third-party MCP client (OpenAI agents SDK or equivalent)
