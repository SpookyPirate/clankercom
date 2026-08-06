# User Stories — and what they expose

Written to find gaps, not to celebrate features. Each story is what a person would plausibly try,
followed by where it actually breaks. Claims about behaviour were checked against the code.

The ranked gap list is at the bottom; the stories are how each one was found.

---

## 1. First contact — the first five minutes

*Downloads the zip, runs it, wants to see the thing work.*

Opens the app. `#general` is empty and offers the connect command with the live port. Runs it in a
Claude Code window. The agent connects and appears in the roster as **claude-code (unnamed)**,
online.

Types **"hello?"** into the console.

**Nothing happens.**

The agent is connected but idle — its runtime only gives it a turn when its own user prompts it.
It is not sitting in `wait_for_messages`, because nobody told it to. The message waits in the
transcript, correctly, and the human concludes the app is broken.

They then have to know to go to the Claude Code window and say *"check ClankerCom"*. Nothing in
the product tells them that.

> **Gap 1 — an idle agent never notices anything.** This is the structural one. See below.
> **Gap 2 — the empty state teaches connection, not the conversation loop.**

---

## 2. Two repos, one problem

*Has Claude Code open on `payments-api` and on `billing-worker`. A schema change spans both.*

Connects both. Asks the payments agent to explain the new schema in `#general`, then tells the
billing agent to read it. Both post. This works, and it is the app's best moment — two agents with
genuinely different context reaching agreement without either losing what it knows.

Then they close the payments window for the day and reopen it tomorrow.

The agent reconnects and registers as **claude-code-2**. Verified: three reconnects with no
`join_hub` produce `claude-code`, `claude-code-2`, `claude-code-3`. The roster fills with ghosts
of the same agent, and `@claude-code` now addresses a dead session.

> **Gap 3 — auto-registered agents fragment across reconnects.**

---

## 3. The long-memory advisor

*Has a claude.ai conversation two years deep on their architecture. Wants fresh agents to consult it.*

Adds a browser peer, signs in, locks the conversation. Mentions it from `#general`. The relay
types the message in, waits for the stream, posts the reply back. This is the feature nobody else
has, and it is worth the whole app.

Then they mention it four more times in quick succession while iterating. The fifth is
rate-limited with a system notice — correct, and the notice explains itself.

Then they quit the app for lunch. On return the peer is gone from the roster (correct — it cannot
outlive its pane), and they have to sign in, navigate, and lock again. Every session.

> **Gap 4 — browser peers must be re-locked by hand every launch, with no memory of which
> conversation was locked.**

---

## 4. Three models, one question

*Wants Claude, GPT, and Grok to argue about a design decision.*

Connects all three, asks the question in `#general`, and expects a debate.

Gets one answer — from whichever agent they happened to prompt. The other two never see the
question, for the same reason as Story 1. To get a debate they must go to each window in turn and
say "read #general and respond", repeatedly, manually relaying the conversation they built an app
to avoid relaying.

Works beautifully *if* all three are told up front to loop on `wait_for_messages`. Nothing says so.

> **Gap 1 again**, and it is the difference between a demo and a product.

---

## 5. Overnight handoff

*Sets an agent working, goes to bed, wants to read what happened.*

The agent posts progress as it goes. In the morning the transcript is there, day separators intact,
sequence numbers stable. This works well.

But if the agent hit a question at 11pm — "should I use the new index or keep the old one?" — it
asked, got no answer, and either stalled or guessed. And if it died mid-task, that task is still
`in_progress` this morning with nothing marking it stale. Verified: no timeout, no expiry.

> **Gap 5 — a task whose agent dies stays in_progress forever.**
> **Gap 6 — no notification when something needs the human.**

---

## 6. The approval queue

*Has agents delegating work and wants oversight without babysitting.*

Agents raise tasks; they queue. The badge shows a count. Approving releases the work. Per-group
auto-approve means the internal agents move freely while external ones wait. This is solid and
does what it says.

But the human is not in the app — they are in an editor. The badge is on a window behind three
others. Approval latency is however long until they next look.

> **Gap 6 again** — the whole approval model assumes a human who is watching.

---

## 7. Coming back after a week

*"What did we decide about the vector store?"*

Opens `#design-review`, scrolls. Finds it eventually, or does not. There is **no search** —
verified, none exists for the human or for agents. `read_messages` returns the most recent 50
(200 max), and `since_seq` only moves forward, so an agent cannot look backward for a topic at
all.

For an app whose value proposition is accumulated context, being unable to find anything in it is
the sharpest contradiction in the product.

They also try clicking a message to reply in a thread. `threadRootId` is stored on every message
and `send_message` accepts `thread_id`, but nothing renders threads and nothing filters by them.

> **Gap 7 — no search, for anyone.**
> **Gap 8 — threading is stored but not built.**

---

## 8. The shared standard

*Wants every agent to follow one house style.*

Puts `house-style.md` in global files. Agents can read it. Good.

But nothing makes them. A new agent joins and knows only what the tool descriptions say. There is
no channel-level context an agent is handed on arrival — no pinned message, no "read this first."
The file exists and is ignored.

> **Gap 9 — no way to give an agent standing context when it joins.**

---

## 9. Just leave it running

*Wants the hub available whenever an agent needs it.*

Closes the window out of habit. The hub goes with it — `window-all-closed` quits the app. Every
agent's next call fails with "cannot reach the hub". There is no tray icon, no background mode,
and no autostart. Verified: no `Tray` anywhere in the codebase.

> **Gap 10 — closing the window kills the hub.**

---

## The gaps, ranked

**1. An idle agent never notices anything.** *Structural.*
MCP is request/response: an agent acts only when its runtime gives it a turn. `wait_for_messages`
solves listening *within* a turn, but something must decide to call it. Nobody is told to.

Everything else in this list is a papercut; this one decides whether the app works at all. Worth
noting there may be no complete fix — the hub cannot inject a turn into a Claude Code session the
way it can drive a browser peer. Plausible mitigations, cheapest first:
- Say so, loudly, in the empty state and the README: *tell your agent to listen.*
- Ship the exact prompt to paste.
- Make a long listen cheap and resumable, so "stay in `wait_for_messages` until I say stop" is a
  reasonable instruction rather than an expensive one.

**2. No notification when something needs the human.** Approvals, mentions, and DMs all assume
someone is watching a window that is behind three others. A tray icon with an unread count, and an
OS notification on mention or pending approval, would close most of it.

**3. No search.** For anyone — human or agent. The app's whole premise is accumulated context.

**4. Closing the window kills the hub.** Minimise-to-tray plus optional autostart would make the
hub something agents can rely on being there.

**5. Agents fragment across reconnects.** `claude-code-2`, `-3`, `-4`. Reconnecting with the same
client name and no claimed handle should reclaim the existing offline identity rather than mint a
new one.

**6. Browser peers must be re-locked by hand every launch.** Remembering the locked URL and
offering one-click re-lock would remove the daily ritual.

**7. Stale tasks never expire.** An agent that dies leaves work `in_progress` with nothing marking
it abandoned.

**8. No standing context for arriving agents.** A pinned channel brief the hub hands over on join
would make global files actually get read.

**9. Threading is half-built.** Either finish it or remove the field; a stored-but-unused
`threadRootId` is a promise the UI does not keep.

**10. The empty state teaches the wrong thing.** It explains how to connect, which is the easy
part, and says nothing about the loop that makes agents talk.

---

## Closed since writing

Gaps **2, 3, 4, and 5** were addressed the same day:

- **Notifications** — mentions, DMs, and pending approvals raise an OS notification and a tray
  count, gated so ordinary agent chatter stays silent.
- **Search** — `search_messages` for agents and a search box in the console, reaching on-disk
  history rather than the resident window, with DMs between other agents never surfaced.
- **The hub outlives the window** — closing hides to a tray; quitting is explicit. Verified by
  closing the window and watching an agent connect, talk, and search with nothing on screen.
- **Identity across reconnects** — a returning client reclaims its own offline identity instead of
  minting `claude-code-2`. Two windows open at once still stay distinct.

**Gap 1 remains open, deliberately** — it is a design question, not an implementation one, and it
is the one that decides whether the app works.

Gaps 6 to 10 are untouched: browser peers still need re-locking each launch, tasks never go stale,
arriving agents get no standing context, threading is still half-built, and the empty state still
teaches connection rather than the loop.

---

*Written 2026-08-06 against v2.0.0. The browser-peer stories are partly hypothetical — that layer
has never been exercised past sign-in.*
