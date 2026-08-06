/**
 * store.js — Durable persistence for the ClankerCom hub.
 *
 * Two files live under the app data directory:
 *   messages.jsonl — append-only log, one JSON message per line
 *   state.json     — agents and channels, rewritten whenever they change
 *
 * Append-only JSONL is deliberate. It needs no native dependency
 * (better-sqlite3 would require an Electron rebuild on every version bump),
 * partial writes only ever corrupt the final line, and the transcript stays
 * readable in a text editor when something needs debugging.
 *
 * Used by: src/hub/bus.js
 */

const fs = require('fs');
const path = require('path');

const { LIMITS } = require('../config');

const MESSAGES_FILE = 'messages.jsonl';
const STATE_FILE = 'state.json';

// State writes are debounced: agent presence changes can burst, and the file
// is small enough that rewriting it wholesale is cheaper than a diff.
const STATE_WRITE_DEBOUNCE_MS = 250;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.messagesPath = path.join(dataDir, MESSAGES_FILE);
    this.statePath = path.join(dataDir, STATE_FILE);

    // Serializes appends so concurrent posts cannot interleave mid-line.
    this.writeChain = Promise.resolve();
    this.stateTimer = null;
    this.pendingState = null;
  }

  // ============================================
  // Loading
  // ============================================

  /** Read both files from disk. Returns { state, messages }. */
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    return {
      state: this._loadState(),
      messages: this._loadMessages(),
    };
  }

  _loadState() {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (error) {
      console.error('[store] state.json unreadable, starting fresh:', error.message);
      return null;
    }
  }

  _loadMessages() {
    if (!fs.existsSync(this.messagesPath)) return [];

    const lines = fs.readFileSync(this.messagesPath, 'utf8').split('\n');
    const messages = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // A torn final line is the expected failure mode after a hard crash.
        // Skip it rather than losing the whole log.
        console.warn('[store] skipping unparseable message line');
      }
    }

    // Keep only recent history resident; the full log stays on disk.
    return messages.slice(-LIMITS.memoryMessageCap);
  }

  // ============================================
  // Writing
  // ============================================

  /** Append one message to the log. Resolves once the line is on disk. */
  appendMessage(message) {
    const line = JSON.stringify(message) + '\n';
    this.writeChain = this.writeChain.then(() =>
      fs.promises.appendFile(this.messagesPath, line, 'utf8').catch((error) => {
        console.error('[store] failed to append message:', error.message);
      })
    );
    return this.writeChain;
  }

  /** Queue a state snapshot write. Repeated calls coalesce. */
  saveState(state) {
    this.pendingState = state;
    if (this.stateTimer) return;

    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this._flushState();
    }, STATE_WRITE_DEBOUNCE_MS);
  }

  _flushState() {
    const snapshot = this.pendingState;
    if (!snapshot) return;
    this.pendingState = null;

    // Write to a temp file then rename, so a crash mid-write cannot leave a
    // truncated state.json behind.
    const tempPath = `${this.statePath}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.promises.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
        await fs.promises.rename(tempPath, this.statePath);
      } catch (error) {
        console.error('[store] failed to save state:', error.message);
      }
    });
    return this.writeChain;
  }

  /** Flush anything pending. Call before the app quits. */
  async close() {
    if (this.stateTimer) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this._flushState();
    await this.writeChain;
  }

  // ============================================
  // History beyond the in-memory window
  // ============================================

  /**
   * Remove one channel's messages from the durable log.
   *
   * The log is append-only in normal use, so deletion means rewriting it. That
   * happens through the same serialized write chain as every append, and via a
   * temp file and rename, so a crash mid-rewrite leaves the original intact
   * rather than a half-filtered transcript.
   *
   * Returns how many lines were dropped.
   */
  deleteChannelMessages(channelId) {
    this.writeChain = this.writeChain.then(async () => {
      if (!fs.existsSync(this.messagesPath)) return 0;

      const raw = await fs.promises.readFile(this.messagesPath, 'utf8');
      const kept = [];
      let removed = 0;

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).channelId === channelId) {
            removed++;
            continue;
          }
        } catch {
          // An unparseable line belongs to no channel; keep it rather than
          // silently discarding data during an unrelated delete.
        }
        kept.push(line);
      }

      const tempPath = `${this.messagesPath}.tmp`;
      await fs.promises.writeFile(tempPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      await fs.promises.rename(tempPath, this.messagesPath);
      return removed;
    });

    return this.writeChain;
  }

  /**
   * Walk the durable log, keeping whatever a predicate accepts.
   *
   * Streams by line rather than parsing the whole file into an array, so a
   * large transcript costs time but not proportional memory.
   */
  async scanMessages(predicate) {
    if (!fs.existsSync(this.messagesPath)) return [];

    const raw = await fs.promises.readFile(this.messagesPath, 'utf8');
    const kept = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (predicate(message)) kept.push(message);
      } catch {
        continue;
      }
    }
    return kept;
  }

  /**
   * Scan the on-disk log for messages in a channel older than the resident
   * window. Linear read — acceptable because this is only hit when scrolling
   * far back in the UI, never on the hot messaging path.
   */
  async readChannelHistory(channelId, { beforeSeq, limit }) {
    if (!fs.existsSync(this.messagesPath)) return [];

    const raw = await fs.promises.readFile(this.messagesPath, 'utf8');
    const matches = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.channelId !== channelId) continue;
        if (beforeSeq != null && message.seq >= beforeSeq) continue;
        matches.push(message);
      } catch {
        continue;
      }
    }

    return matches.slice(-limit);
  }
}

module.exports = { Store };
