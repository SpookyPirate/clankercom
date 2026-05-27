// renderer.js — UI logic (runs in the renderer process, sandboxed)

const wv = document.getElementById('wv');
const statusEl = document.getElementById('status');
const lockBtn = document.getElementById('lock');
const unlockBtn = document.getElementById('unlock');
const logEl = document.getElementById('log');

function log(msg, cls = '') {
  const line = document.createElement('div');
  const ts = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="ts">[${ts}]</span> <span class="${cls}">${escapeHtml(msg)}</span>`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setStatus(text, variant = '') {
  statusEl.className = `status ${variant}`;
  statusEl.textContent = text;
}

wv.addEventListener('dom-ready', async () => {
  try {
    const id = wv.getWebContentsId();
    await window.intercom.attach(id);
    setStatus('⚪ Idle — navigate to a conversation, then click Lock');
    log('webview attached, MCP server started on :7777', 'ok');
  } catch (e) {
    setStatus(`❌ Attach failed: ${e.message}`, 'error');
    log(`attach failed: ${e.message}`, 'err');
  }
});

wv.addEventListener('did-navigate', (e) => {
  log(`navigated: ${e.url}`);
});

wv.addEventListener('did-navigate-in-page', (e) => {
  log(`in-page nav: ${e.url}`);
});

lockBtn.onclick = async () => {
  try {
    const url = await window.intercom.lock();
    const chatId = url.split('/').pop().slice(0, 12);
    setStatus(`🟢 Locked: ${chatId}…`, 'locked');
    lockBtn.disabled = true;
    unlockBtn.disabled = false;
    log(`locked to ${url}`, 'ok');
  } catch (e) {
    setStatus(`❌ ${e.message}`, 'error');
    log(`lock failed: ${e.message}`, 'err');
  }
};

unlockBtn.onclick = async () => {
  await window.intercom.unlock();
  setStatus('⚪ Idle — navigate to a conversation, then click Lock');
  lockBtn.disabled = false;
  unlockBtn.disabled = true;
  log('unlocked', 'ok');
};

// Poll status to surface mid-call activity in the log
setInterval(async () => {
  try {
    const s = await window.intercom.status();
    if (s.busy && !logEl.lastChild?.textContent?.includes('relay busy')) {
      log('relay busy — turn in progress…');
    }
  } catch {}
}, 1000);
