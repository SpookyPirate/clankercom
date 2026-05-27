// src/injected.js — runs INSIDE the claude.ai page context.
//
// Everything DOM-coupled lives here. When claude.ai's UI changes, this is
// the only file you should need to touch. Selectors are at the top.

(() => {
  if (window.__intercom) {
    // Already injected. Replace gracefully.
    delete window.__intercom;
  }

  // ============================================================
  //   SELECTORS — UPDATE HERE when claude.ai UI drifts
  // ============================================================
  const SELECTORS = {
    // ProseMirror editor for the message input
    input: 'div[contenteditable="true"][translate="no"]',
    // The Send button visible when input has content
    sendButton: 'button[aria-label="Send message"]',
    // Each assistant message bubble
    assistantMessage: 'div.font-claude-response',
    // Outer wrapper for any message turn (user or assistant)
    messageTurn: '[data-test-render-count]',
  };

  // Tag prepended to every outgoing message so the receiving Claude can tell
  // relayed messages apart from its user's own input.
  const MESSAGE_PREFIX = '[Message from another Claude instance]:\n\n';

  const TIMEOUTS = {
    sendButtonReady: 5_000,
    streamStart: 15_000,
    streamEnd: 300_000, // 5 min hard cap — bump if you regularly get longer responses
    stableMs: 1500,     // text must be unchanged this long to consider streaming done
    pollMs: 250,        // how often to poll the message text
  };

  // ----- helpers -----

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(predicate, timeoutMs, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const val = predicate();
      if (val) return val;
      await sleep(intervalMs);
    }
    throw new Error(`timeout after ${timeoutMs}ms`);
  }

  // ----- public API -----

  const api = {
    snapshotMessageCount() {
      return $$(SELECTORS.assistantMessage).length;
    },

    async sendMessage(text) {
      const input = $(SELECTORS.input);
      if (!input) throw new Error(`input not found (selector: ${SELECTORS.input})`);

      input.focus();

      // Clear any existing content
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      const payload = MESSAGE_PREFIX + text;

      // Insert via execCommand — this dispatches the right events for ProseMirror.
      // If this stops working, see the fallback strategies in IMPLEMENTATION_GUIDE.md.
      const ok = document.execCommand('insertText', false, payload);
      if (!ok) {
        // Fallback: dispatch a synthetic InputEvent
        const evt = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: payload,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(evt);
      }

      // Give ProseMirror a tick to register and enable the send button
      await waitFor(() => {
        const btn = $(SELECTORS.sendButton);
        return btn && !btn.disabled;
      }, TIMEOUTS.sendButtonReady);

      $(SELECTORS.sendButton).click();
    },

    async waitForResponse(priorCount) {
      // Phase 1: wait for the new assistant message bubble to appear.
      await waitFor(() => {
        return $$(SELECTORS.assistantMessage).length > priorCount;
      }, TIMEOUTS.streamStart);

      // Phase 2: poll the last message's text until it stops changing for
      // TIMEOUTS.stableMs. This avoids depending on any "stop button" selector
      // (which has been a fragile maintenance point). Only requires the
      // assistantMessage selector to keep working.
      const lastMessageText = () => {
        const msgs = $$(SELECTORS.assistantMessage);
        const last = msgs[msgs.length - 1];
        return last ? last.innerText : '';
      };

      let lastText = '';
      let lastChangedAt = Date.now();
      const deadline = Date.now() + TIMEOUTS.streamEnd;

      while (Date.now() < deadline) {
        const current = lastMessageText();
        if (current !== lastText) {
          lastText = current;
          lastChangedAt = Date.now();
        } else if (Date.now() - lastChangedAt >= TIMEOUTS.stableMs && current.length > 0) {
          return current.trim();
        }
        await sleep(TIMEOUTS.pollMs);
      }

      throw new Error(`response did not settle within ${TIMEOUTS.streamEnd}ms`);
    },

    readRecentMessages(count) {
      const n = Math.max(1, Math.min(20, (count | 0) || 1));
      const turns = Array.from(document.querySelectorAll(SELECTORS.messageTurn));
      if (!turns.length) return [];
      return turns.slice(-n).map((el) => {
        const isAssistant = !!el.querySelector(SELECTORS.assistantMessage);
        let text = el.innerText.trim();
        // claude.ai prepends an accessibility prefix to each turn's innerText;
        // strip it so the caller gets just the message body.
        text = text.replace(/^(You said:|Claude responded:)\s*/i, '');
        return { role: isAssistant ? 'assistant' : 'user', text };
      });
    },

    // Diagnostic — useful from DevTools when debugging selectors
    _debug() {
      const msgs = $$(SELECTORS.assistantMessage);
      const last = msgs[msgs.length - 1];
      return {
        url: window.location.href,
        hasInput: !!$(SELECTORS.input),
        hasSendBtn: !!$(SELECTORS.sendButton),
        msgCount: msgs.length,
        lastMsgPreview: last ? last.innerText.slice(0, 100) : null,
        selectors: SELECTORS,
      };
    },
  };

  // Freeze to prevent accidental mutation from console
  window.__intercom = Object.freeze(api);

  // Marker so external code can detect injection
  console.log('[intercom] helpers injected. Run window.__intercom._debug() in DevTools to inspect.');
})();
