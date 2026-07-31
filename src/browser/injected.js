/**
 * injected.js — Runs INSIDE the claude.ai page context.
 *
 * Every piece of DOM coupling in ClankerCom lives here. When claude.ai ships a
 * redesign, this is the only file that should need editing, and the SELECTORS
 * block at the top is the whole maintenance surface.
 *
 * Two responsibilities:
 *   1. Driven turns  — type a message, wait for the streamed reply to settle.
 *   2. Observed turns — watch for assistant messages nobody asked for, so a
 *      remote Claude can speak on its own initiative rather than only when
 *      polled. Events queue here and the relay drains them.
 *
 * The main process cannot receive pushes from page context, so observation is
 * a queue the relay polls rather than a callback.
 *
 * Used by: src/browser/relay.js
 */

(() => {
  if (window.__clanker) {
    // Re-injected after a navigation. Tear the old observer down first so we
    // do not end up with two watching the same DOM.
    try { window.__clanker.stopObserving(); } catch { /* nothing to stop */ }
    delete window.__clanker;
  }

  // ============================================
  //   SELECTORS — UPDATE HERE when claude.ai UI drifts
  // ============================================
  const SELECTORS = {
    // ProseMirror editor for the message input
    input: 'div[contenteditable="true"][translate="no"]',
    // The Send button, visible once the input has content
    sendButton: 'button[aria-label="Send message"]',
    // Each assistant message bubble
    assistantMessage: 'div.font-claude-response',
    // Outer wrapper for any turn, user or assistant
    messageTurn: '[data-test-render-count]',
  };

  const TIMEOUTS = {
    sendButtonReady: 5_000,
    streamStart: 20_000,
    streamEnd: 600_000, // 10 min hard cap on a single driven turn
    stableMs: 1_500,    // text unchanged this long counts as finished
    pollMs: 250,
    // The observer is more patient than a driven turn: nobody is blocked on
    // it, and declaring an unsolicited message finished too early truncates it.
    observerStableMs: 2_500,
  };

  const MAX_QUEUED_EVENTS = 50;

  // ============================================
  // Internal state
  // ============================================

  let driving = false;        // true while the relay is running a turn
  let cancelToken = 0;        // bumped to abort an in-flight wait
  let observer = null;
  let observerTimer = null;
  let lastObservedText = '';
  const events = [];

  // ============================================
  // Helpers
  // ============================================

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(predicate, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(intervalMs);
    }
    throw new Error(`timed out after ${timeoutMs}ms`);
  }

  function lastAssistantText() {
    const messages = $$(SELECTORS.assistantMessage);
    const last = messages[messages.length - 1];
    return last ? last.innerText : '';
  }

  /** claude.ai prefixes turn text for screen readers; callers want the body. */
  function stripAccessibilityPrefix(text) {
    return text.replace(/^(You said:|Claude responded:)\s*/i, '');
  }

  function pushEvent(event) {
    events.push({ ...event, at: Date.now() });
    // Bound the queue so a long disconnection cannot grow it without limit.
    while (events.length > MAX_QUEUED_EVENTS) events.shift();
  }

  // ============================================
  // Observation — unsolicited messages
  // ============================================

  /**
   * Emit an event when the newest assistant message settles, but only if the
   * relay is not driving a turn. Anything the relay sent is already accounted
   * for by waitForResponse, so reporting it again would double-post.
   */
  function handleMutation() {
    if (driving) return;

    clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      const text = lastAssistantText().trim();
      if (!text || text === lastObservedText) return;
      lastObservedText = text;
      pushEvent({ type: 'unsolicited-assistant-message', text });
    }, TIMEOUTS.observerStableMs);
  }

  // ============================================
  // Public API
  // ============================================

  const api = {
    version: 2,

    /** The relay brackets every driven turn with this to silence the observer. */
    setDriving(value) {
      driving = !!value;
      if (!driving) {
        // Adopt the just-finished reply as the baseline so the observer does
        // not immediately report it as unsolicited.
        lastObservedText = lastAssistantText().trim();
      }
      return driving;
    },

    snapshotMessageCount() {
      return $$(SELECTORS.assistantMessage).length;
    },

    /** Abort any in-flight waitForResponse in this page. */
    cancel() {
      cancelToken++;
      return cancelToken;
    },

    async sendMessage(text, prefix = '') {
      const input = $(SELECTORS.input);
      if (!input) throw new Error(`input not found (selector: ${SELECTORS.input})`);

      input.focus();

      // Clear whatever is sitting in the composer.
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      const payload = prefix + text;

      // execCommand dispatches the events ProseMirror actually listens for.
      // A synthetic InputEvent is the fallback if the browser drops support.
      const inserted = document.execCommand('insertText', false, payload);
      if (!inserted) {
        input.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: payload,
            bubbles: true,
            cancelable: true,
          })
        );
      }

      await waitFor(() => {
        const button = $(SELECTORS.sendButton);
        return button && !button.disabled;
      }, TIMEOUTS.sendButtonReady);

      $(SELECTORS.sendButton).click();
    },

    /**
     * Wait for the reply that follows a driven send.
     *
     * Streaming completion is detected by polling the text until it stops
     * changing, rather than by watching for a stop button. That deliberately
     * depends on one selector instead of two — the stop button has
     * historically been the more volatile of the pair.
     */
    async waitForResponse(priorCount) {
      const token = cancelToken;
      const cancelled = () => token !== cancelToken;

      await waitFor(
        () => cancelled() || $$(SELECTORS.assistantMessage).length > priorCount,
        TIMEOUTS.streamStart
      );
      if (cancelled()) throw new Error('cancelled');

      let lastText = '';
      let lastChangedAt = Date.now();
      const deadline = Date.now() + TIMEOUTS.streamEnd;

      while (Date.now() < deadline) {
        if (cancelled()) throw new Error('cancelled');

        const current = lastAssistantText();
        if (current !== lastText) {
          lastText = current;
          lastChangedAt = Date.now();
        } else if (current.length > 0 && Date.now() - lastChangedAt >= TIMEOUTS.stableMs) {
          return current.trim();
        }
        await sleep(TIMEOUTS.pollMs);
      }

      throw new Error(`response did not settle within ${TIMEOUTS.streamEnd}ms`);
    },

    readRecentMessages(count) {
      const limit = Math.max(1, Math.min(50, (count | 0) || 1));
      const turns = Array.from($$(SELECTORS.messageTurn));
      if (!turns.length) return [];

      return turns.slice(-limit).map((turn) => ({
        role: turn.querySelector(SELECTORS.assistantMessage) ? 'assistant' : 'user',
        text: stripAccessibilityPrefix(turn.innerText.trim()),
      }));
    },

    startObserving() {
      if (observer) return true;

      const root = document.querySelector('main') || document.body;
      observer = new MutationObserver(handleMutation);
      observer.observe(root, { childList: true, subtree: true, characterData: true });

      // Treat whatever is already on screen as seen, so attaching the observer
      // does not immediately replay the last reply.
      lastObservedText = lastAssistantText().trim();
      return true;
    },

    stopObserving() {
      if (observerTimer) clearTimeout(observerTimer);
      if (observer) observer.disconnect();
      observer = null;
      observerTimer = null;
      return true;
    },

    /** Hand over queued events and clear the queue. Polled by the relay. */
    drainEvents() {
      return events.splice(0, events.length);
    },

    /** Snapshot for DevTools when diagnosing selector drift. */
    _debug() {
      const messages = $$(SELECTORS.assistantMessage);
      const last = messages[messages.length - 1];
      return {
        url: window.location.href,
        driving,
        observing: !!observer,
        queuedEvents: events.length,
        hasInput: !!$(SELECTORS.input),
        hasSendButton: !!$(SELECTORS.sendButton),
        messageCount: messages.length,
        lastMessagePreview: last ? last.innerText.slice(0, 120) : null,
        selectors: SELECTORS,
      };
    },
  };

  window.__clanker = Object.freeze(api);
  console.log('[clankercom] helpers injected. Run window.__clanker._debug() to inspect.');
})();
