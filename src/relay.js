// src/relay.js — drives the webview to send/receive messages

const fs = require('fs');
const path = require('path');

function loadInjectedScript() {
  return fs.readFileSync(path.join(__dirname, 'injected.js'), 'utf8');
}

class Relay {
  constructor(webContents) {
    this.wc = webContents;
    this.locked = false;
    this.lockedUrl = null;
    this.busy = false;
  }

  async _currentUrl() {
    return this.wc.executeJavaScript('window.location.href');
  }

  async lock() {
    const url = await this._currentUrl();
    if (!/^https:\/\/claude\.ai\/chat\/[0-9a-f-]+/i.test(url)) {
      throw new Error(
        'Navigate to a specific conversation (URL must look like https://claude.ai/chat/<id>) before locking.'
      );
    }

    // Inject helpers fresh — handles cases where the page reloaded
    await this.wc.executeJavaScript(loadInjectedScript());

    // Sanity-check the helpers landed
    const ok = await this.wc.executeJavaScript('typeof window.__intercom === "object"');
    if (!ok) throw new Error('helper injection failed — check src/injected.js');

    this.locked = true;
    this.lockedUrl = url;
    return url;
  }

  unlock() {
    this.locked = false;
    this.lockedUrl = null;
  }

  async readRecentMessages(count) {
    if (!this.locked) throw new Error('Claude Intercom is not locked to a conversation.');
    const url = await this._currentUrl();
    if (url !== this.lockedUrl) {
      throw new Error(
        `Claude Intercom was locked to ${this.lockedUrl} but the webview is now on ${url}. ` +
        `Unlock and re-lock to the intended conversation.`
      );
    }
    const helpersAlive = await this.wc.executeJavaScript('typeof window.__intercom === "object"');
    if (!helpersAlive) {
      await this.wc.executeJavaScript(loadInjectedScript());
    }
    const n = Number.isFinite(count) ? count : 1;
    return this.wc.executeJavaScript(`window.__intercom.readRecentMessages(${JSON.stringify(n)})`);
  }

  async discoverMessageStructure() {
    return this.wc.executeJavaScript(`(() => {
      const els = Array.from(document.querySelectorAll('[data-test-render-count]'));
      return JSON.stringify(els.slice(-6).map(el => ({
        tag: el.tagName,
        className: typeof el.className === 'string' ? el.className.slice(0, 100) : '',
        hasFontClaudeResponse: !!el.querySelector('.font-claude-response'),
        directChildCount: el.children.length,
        textPreview: el.innerText.slice(0, 80).replace(/\\s+/g, ' '),
      })), null, 2);
    })()`);
  }

  async discoverSelectors() {
    const script = `(() => {
      const candidates = [
        'div.font-claude-message',
        'div.font-claude-response',
        '[data-test-render-count]',
        '[data-testid*="message"]',
        '[class*="claude-message"]',
        '[class*="font-claude"]',
        '[class*="message-content"]',
      ];
      const counts = {};
      for (const sel of candidates) {
        try { counts[sel] = document.querySelectorAll(sel).length; }
        catch (e) { counts[sel] = 'ERR'; }
      }
      const main = document.querySelector('main') || document.body;
      const textRich = Array.from(main.querySelectorAll('div'))
        .filter(d => d.innerText && d.innerText.length > 40 && d.children.length < 15)
        .slice(-5)
        .map(d => ({
          className: d.className,
          dataAttrs: Array.from(d.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value),
          preview: d.innerText.slice(0, 80).replace(/\\n/g, ' '),
        }));
      return JSON.stringify({ url: location.href, counts, textRich }, null, 2);
    })()`;
    return this.wc.executeJavaScript(script);
  }

  async send(message) {
    if (!this.locked) throw new Error('Claude Intercom is not locked to a conversation.');
    if (this.busy) throw new Error('Claude Intercom is already mid-turn. Wait for it to finish.');

    // Guard: still on the locked conversation?
    const url = await this._currentUrl();
    if (url !== this.lockedUrl) {
      throw new Error(
        `Claude Intercom was locked to ${this.lockedUrl} but the webview is now on ${url}. ` +
        `Unlock and re-lock to the intended conversation.`
      );
    }

    // Re-inject helpers if the page navigated within the SPA and lost them
    const helpersAlive = await this.wc.executeJavaScript('typeof window.__intercom === "object"');
    if (!helpersAlive) {
      await this.wc.executeJavaScript(loadInjectedScript());
    }

    this.busy = true;
    try {
      const priorCount = await this.wc.executeJavaScript(
        'window.__intercom.snapshotMessageCount()'
      );

      await this.wc.executeJavaScript(
        `window.__intercom.sendMessage(${JSON.stringify(message)})`
      );

      const response = await this.wc.executeJavaScript(
        `window.__intercom.waitForResponse(${priorCount})`
      );

      return response;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Relay };
