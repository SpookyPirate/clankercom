/**
 * relay.js — Drives one claude.ai conversation through one webview.
 *
 * A relay owns exactly one webview and one locked conversation URL. Multiple
 * relays coexist, which is what lets ClankerCom hold several claude.ai peers
 * at once rather than the single locked conversation of the original design.
 *
 * Turns are serialized through a TurnQueue: the hub can hand a relay work at
 * any rate, and the relay feeds it to the page one turn at a time because a
 * conversation cannot accept a second prompt mid-stream.
 *
 * Used by: src/browser/peer-manager.js
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { TurnQueue } = require('./turns');

// How often to collect unsolicited-message events from the page. The page
// cannot push into the main process, so observation is a drained queue.
const EVENT_POLL_MS = 1_500;

const CONVERSATION_URL_PATTERN = /^https:\/\/claude\.ai\/chat\/[0-9a-f-]+/i;

function loadInjectedScript() {
  return fs.readFileSync(path.join(__dirname, 'injected.js'), 'utf8');
}

class BrowserRelay extends EventEmitter {
  constructor(webContents, { id }) {
    super();
    this.id = id;
    this.wc = webContents;
    this.locked = false;
    this.lockedUrl = null;
    this.title = null;
    this.phase = 'idle'; // idle | typing | streaming
    this.eventTimer = null;

    this.queue = new TurnQueue({
      onCancelRunning: () => this._runInPage('window.__clanker.cancel()').catch(() => {}),
    });
  }

  // ============================================
  // Page access
  // ============================================

  /** Evaluate in page context, failing clearly if the webview is gone. */
  async _runInPage(expression) {
    if (!this.wc || this.wc.isDestroyed()) {
      throw new Error('the browser pane for this peer is no longer available');
    }
    return this.wc.executeJavaScript(expression);
  }

  async _currentUrl() {
    return this._runInPage('window.location.href');
  }

  /** Re-inject if the SPA navigated and dropped our helpers. */
  async _ensureHelpers() {
    const alive = await this._runInPage(
      'typeof window.__clanker === "object" && window.__clanker.version === 2'
    );
    if (!alive) {
      await this._runInPage(loadInjectedScript());
      await this._runInPage('window.__clanker.startObserving()');
    }
  }

  /** Refuse to act if the pane wandered off the conversation we locked. */
  async _assertStillLocked() {
    if (!this.locked) throw new Error('this peer is not locked to a conversation');

    const url = await this._currentUrl();
    if (url !== this.lockedUrl) {
      throw new Error(
        `peer was locked to ${this.lockedUrl} but the pane is now on ${url}. ` +
          `Re-lock it to the intended conversation.`
      );
    }
  }

  // ============================================
  // Lock lifecycle
  // ============================================

  /** Bind this relay to whatever conversation the pane is showing. */
  async lock() {
    const url = await this._currentUrl();
    if (!CONVERSATION_URL_PATTERN.test(url)) {
      throw new Error(
        'Navigate to a specific conversation (the URL should look like ' +
          'https://claude.ai/chat/<id>) before locking.'
      );
    }

    await this._runInPage(loadInjectedScript());
    const injected = await this._runInPage('typeof window.__clanker === "object"');
    if (!injected) throw new Error('helper injection failed — see src/browser/injected.js');

    await this._runInPage('window.__clanker.startObserving()');

    this.locked = true;
    this.lockedUrl = url;
    this.title = await this._runInPage('document.title').catch(() => null);
    this._startEventPolling();
    this._setPhase('idle');
    this.emit('locked', { id: this.id, url, title: this.title });
    return { url, title: this.title };
  }

  unlock() {
    this._stopEventPolling();
    this.queue.cancelAll('peer unlocked');
    this._runInPage('window.__clanker.stopObserving()').catch(() => {});
    this.locked = false;
    this.lockedUrl = null;
    this.emit('unlocked', { id: this.id });
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', { id: this.id, phase });
  }

  // ============================================
  // Driven turns
  // ============================================

  /**
   * Queue a message for this conversation and resolve with the reply.
   * Returns the settled assistant text once streaming finishes.
   */
  send(text, { prefix = '', turnId } = {}) {
    return this.queue.enqueue({
      id: turnId || `turn_${Date.now()}`,
      meta: { preview: text.slice(0, 80) },
      run: () => this._runTurn(text, prefix),
    });
  }

  async _runTurn(text, prefix) {
    await this._assertStillLocked();
    await this._ensureHelpers();

    // Suppress the observer for the duration: this reply is already accounted
    // for by waitForResponse, and reporting it again would double-post.
    await this._runInPage('window.__clanker.setDriving(true)');

    try {
      const priorCount = await this._runInPage('window.__clanker.snapshotMessageCount()');

      this._setPhase('typing');
      await this._runInPage(
        `window.__clanker.sendMessage(${JSON.stringify(text)}, ${JSON.stringify(prefix)})`
      );

      this._setPhase('streaming');
      return await this._runInPage(`window.__clanker.waitForResponse(${priorCount})`);
    } finally {
      await this._runInPage('window.__clanker.setDriving(false)').catch(() => {});
      this._setPhase('idle');
    }
  }

  /** Abort the running turn and drop anything queued behind it. */
  cancel() {
    const dropped = this.queue.cancelAll('cancelled by request');
    this._setPhase('idle');
    return dropped;
  }

  async readRecentMessages(count) {
    await this._assertStillLocked();
    await this._ensureHelpers();
    return this._runInPage(`window.__clanker.readRecentMessages(${JSON.stringify(count)})`);
  }

  // ============================================
  // Observation
  // ============================================

  _startEventPolling() {
    if (this.eventTimer) return;
    this.eventTimer = setInterval(() => this._pollEvents(), EVENT_POLL_MS);
  }

  _stopEventPolling() {
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.eventTimer = null;
  }

  /** Collect anything the page observer noticed since the last poll. */
  async _pollEvents() {
    if (!this.locked || this.phase !== 'idle') return;

    try {
      const events = await this._runInPage('window.__clanker.drainEvents()');
      for (const event of events || []) {
        if (event.type === 'unsolicited-assistant-message') {
          this.emit('unsolicited', { id: this.id, text: event.text });
        }
      }
    } catch (error) {
      // A navigation mid-poll is routine; only report anything else.
      if (!/no longer available|__clanker/.test(error.message)) {
        this.emit('error', { id: this.id, error });
      }
    }
  }

  /** Snapshot for the UI and for list_peers. */
  describe() {
    return {
      id: this.id,
      locked: this.locked,
      url: this.lockedUrl,
      title: this.title,
      state: this.queue.state === 'running' ? this.phase : 'idle',
      queued: this.queue.pending.length,
    };
  }

  destroy() {
    this._stopEventPolling();
    this.queue.cancelAll('peer removed');
    this.removeAllListeners();
  }
}

module.exports = { BrowserRelay, CONVERSATION_URL_PATTERN };
