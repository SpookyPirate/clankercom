/**
 * app.js — ClankerCom console UI.
 *
 * Renders the hub for the human participant: channel rail, live transcript,
 * agent roster, and the browser panes that host claude.ai peers.
 *
 * The renderer holds no authority. It reads a bootstrap snapshot, then stays
 * current from bus events pushed over IPC — it never polls the hub.
 */

// ============================================
// State
// ============================================

const state = {
  self: null,
  channels: new Map(), // name -> channel
  // Keyed by id, not handle: an agent that changes its handle via
  // set_identity would otherwise be added a second time under the new key.
  agents: new Map(),   // agentId -> agent
  peers: [],
  activeChannel: null,
  defaultChannel: null,
  port: null,
  view: 'channel',     // 'channel' | 'tasks'
  editingGroupId: null,
  groups: [],
  tasks: [],
  settings: { autoApproveTasks: false },
  unread: new Map(),   // name -> count
  lastRendered: null,  // anchor for message grouping
  collapsed: new Set(),// folded rail sections
  fileScope: 'channel',// which folder the files view is showing
  searchQuery: '',     // guards against a stale response overwriting newer results
  listeners: [],       // agents currently parked in wait_for_messages
  pendingDelivery: null,// the message whose fate the console is reporting
  peerViews: new Map(),// peerId -> webview element
  activePeerId: null,
};

const el = {
  hubEndpoint: document.getElementById('hub-endpoint'),
  channelList: document.getElementById('channel-list'),
  dmList: document.getElementById('dm-list'),
  roster: document.getElementById('roster'),
  channelName: document.getElementById('channel-name'),
  channelTopic: document.getElementById('channel-topic'),
  transcript: document.getElementById('transcript'),
  composer: document.getElementById('composer'),
  netStrip: document.getElementById('net-strip'),
  netStatus: document.getElementById('net-status'),
  peers: document.getElementById('peers'),
  peerTabs: document.getElementById('peer-tabs'),
  peerStage: document.getElementById('peer-stage'),
  peerPlaceholder: document.getElementById('peer-placeholder'),
  peerStatus: document.getElementById('peer-status'),
  peerLock: document.getElementById('peer-lock'),
  peerUnlock: document.getElementById('peer-unlock'),
  addPeer: document.getElementById('add-peer'),
  addChannel: document.getElementById('add-channel'),
  newChannelForm: document.getElementById('new-channel'),
  newChannelName: document.getElementById('new-channel-name'),
  newChannelCancel: document.getElementById('new-channel-cancel'),
  editIdentity: document.getElementById('edit-identity'),
  identityForm: document.getElementById('identity-form'),
  identityName: document.getElementById('identity-name'),
  identityHandle: document.getElementById('identity-handle'),
  identityCancel: document.getElementById('identity-cancel'),
  youName: document.getElementById('you-name'),
  youHandle: document.getElementById('you-handle'),
  openTasks: document.getElementById('open-tasks'),
  tasksBadge: document.getElementById('tasks-badge'),
  taskBoard: document.getElementById('task-board'),
  composerWrap: document.getElementById('composer-wrap'),
  autoApprove: document.getElementById('auto-approve'),
  autoApproveWrap: document.getElementById('auto-approve-wrap'),
  addGroup: document.getElementById('add-group'),
  newGroupForm: document.getElementById('new-group'),
  newGroupName: document.getElementById('new-group-name'),
  newGroupCancel: document.getElementById('new-group-cancel'),
  peerRemove: document.getElementById('peer-remove'),
  groupModal: document.getElementById('group-modal'),
  groupModalTitle: document.getElementById('group-modal-title'),
  groupModalClose: document.getElementById('group-modal-close'),
  groupName: document.getElementById('group-name'),
  groupPermissions: document.getElementById('group-permissions'),
  groupMembers: document.getElementById('group-members'),
  groupDelete: document.getElementById('group-delete'),
  groupDone: document.getElementById('group-done'),
  winMinimize: document.getElementById('win-minimize'),
  winMaximize: document.getElementById('win-maximize'),
  winMaximizeIcon: document.getElementById('win-maximize-icon'),
  winClose: document.getElementById('win-close'),
  togglePeers: document.getElementById('toggle-peers'),
  toasts: document.getElementById('toasts'),
  searchInput: document.getElementById('search-input'),
  searchView: document.getElementById('search-view'),
  openFiles: document.getElementById('open-files'),
  openGlobalFiles: document.getElementById('open-global-files'),
  filesView: document.getElementById('files-view'),
  channelMenuWrap: document.querySelector('.channel-menu-wrap'),
  scopeChannel: document.getElementById('scope-channel'),
  scopeGlobal: document.getElementById('scope-global'),
  filesScopeNote: document.getElementById('files-scope-note'),
  fileList: document.getElementById('file-list'),
  filesAdd: document.getElementById('files-add'),
  channelMenuButton: document.getElementById('channel-menu-button'),
  channelMenu: document.getElementById('channel-menu'),
  actionExport: document.getElementById('action-export'),
  actionClear: document.getElementById('action-clear'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmBody: document.getElementById('confirm-body'),
  confirmCancel: document.getElementById('confirm-cancel'),
  confirmAccept: document.getElementById('confirm-accept'),
};

// ============================================
// Icons
// ============================================

/**
 * One icon set, drawn on a 24-unit grid at a single stroke width and rendered
 * in currentColor. Text glyphs were doing this job before, and they shift
 * weight, size, and baseline with whatever font happens to resolve — the
 * clearest tell of an interface assembled rather than designed.
 */
const ICONS = {
  hash: '<path d="M9 4L7 20M17 4l-2 16M4.5 9h15M3.5 15h15"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  settings:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2v.1"/>',
  trash: '<path d="M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M9 21h6M12 17v4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>',
};

/** Inline SVG markup for an icon, sized by CSS rather than by attribute. */
function icon(name, extraClass = '') {
  return `<svg class="icon ${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

// ============================================
// Toasts
// ============================================

const TOAST_DISMISS_MS = 5000;

/**
 * Errors persist until dismissed — the user may need to act on one — while
 * confirmations clear themselves. Every toast pairs an icon with its colour so
 * the meaning survives for anyone who cannot separate the hues.
 */
function toast(message, kind = 'error') {
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `
    <span class="toast-icon">${icon(kind === 'error' ? 'alert' : 'check')}</span>
    <span class="toast-body">${escapeHtml(message)}</span>
    <button class="toast-dismiss" aria-label="Dismiss">${icon('close', 'icon--sm')}</button>
  `;

  const dismiss = () => {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };

  node.querySelector('.toast-dismiss').onclick = dismiss;
  el.toasts.appendChild(node);

  if (kind !== 'error') setTimeout(dismiss, TOAST_DISMISS_MS);
}


// ============================================
// Async affordances
// ============================================

/**
 * Run an action with the button showing it is working.
 *
 * The label is swapped for a spinner in place so the button keeps its width —
 * nothing the user was about to click moves under them — and pointer events
 * are suppressed so the action cannot be fired twice.
 */
async function withBusy(button, action) {
  if (!button || button.classList.contains('is-busy')) return;

  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  try {
    return await action();
  } finally {
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}

// ============================================
// Formatting
// ============================================

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])
  );
}

/**
 * Minimal markdown: fenced blocks, inline code, bold, and @mentions.
 * Deliberately not a full parser — agents post prose and code, and anything
 * richer would fight the console's typography.
 */
function formatBody(text) {
  const blocks = [];
  let output = escapeHtml(text);

  // Extract fenced blocks first so their contents escape the later passes.
  // The placeholder is fenced with null bytes, not spaces: a bare " 0 " would
  // collide with ordinary prose like "seq 12 arrived" and swallow it.
  output = output.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return ` ${blocks.length - 1} `;
  });

  output = output.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Only highlight handles that belong to a real agent. Prose like "an
  // explicit @mention" should read as prose, and a highlight that fires on
  // any @word makes the real ones stop meaning anything.
  const known = new Set(Array.from(state.agents.values(), (agent) => agent.handle));
  output = output.replace(/(^|\s)@([a-z0-9_-]{2,48})/gi, (match, lead, handle) =>
    known.has(handle.toLowerCase())
      ? `${lead}<span class="mention">@${handle}</span>`
      : match
  );

  return output.replace(/ (\d+) /g, (_match, index) => blocks[Number(index)]);
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Two-letter call sign standing in for an avatar. */
function callsign(platform) {
  const signs = {
    'claude-code': 'CC',
    'claude-desktop': 'CD',
    'claude-web': 'CW',
    openai: 'AI',
    grok: 'GK',
    gemini: 'GM',
    human: 'HU',
  };
  return signs[platform] || 'AG';
}

/**
 * The other party in a DM, or null if they are no longer on the roster —
 * a removed or pruned agent drops out of the member list.
 */
function dmCounterpart(channel) {
  return channel.members.find((handle) => handle !== state.self?.handle) || null;
}

/** DM channels are keyed by agent id; show the other participant instead. */
function channelLabel(channel) {
  if (!channel.isDm) return `#${channel.name}`;
  return `@${dmCounterpart(channel) || 'departed'}`;
}

// ============================================
// Rail
// ============================================

function renderRail() {
  const channels = Array.from(state.channels.values());

  // A DM whose counterpart has left the roster has nobody to talk to, so it
  // is dropped from the rail. Its messages remain in the transcript log.
  const directMessages = channels.filter((c) => c.isDm && dmCounterpart(c));

  renderChannelGroup(el.channelList, channels.filter((c) => !c.isDm));
  renderChannelGroup(el.dmList, directMessages);
  renderRoster();
  renderTaskBadge();
  renderSectionUnread();
}

/**
 * A folded section still has to surface what is unread inside it, or
 * collapsing one becomes a way to silently miss messages.
 */
function renderSectionUnread() {
  const channels = Array.from(state.channels.values());
  const totals = {
    channels: channels.filter((c) => !c.isDm),
    direct: channels.filter((c) => c.isDm && dmCounterpart(c)),
  };

  for (const [key, list] of Object.entries(totals)) {
    const badge = document.querySelector(`[data-unread="${key}"]`);
    if (!badge) continue;

    const count = list.reduce((sum, c) => sum + (state.unread.get(c.name) || 0), 0);
    const show = count > 0 && state.collapsed.has(key);
    badge.hidden = !show;
    badge.textContent = count > 99 ? '99+' : String(count);
  }
}

function renderChannelGroup(container, channels) {
  container.innerHTML = '';

  for (const channel of channels) {
    const unread = state.unread.get(channel.name) || 0;
    const button = document.createElement('button');
    // Unread is carried by weight and brightness first; the badge only
    // confirms it. A badge alone is easy to miss scanning a long list.
    button.className = [
      'rail-item',
      channel.name === state.activeChannel ? 'is-active' : '',
      unread ? 'has-unread' : '',
    ]
      .filter(Boolean)
      .join(' ');
    button.innerHTML = `
      <span class="sigil">${icon(channel.isDm ? 'at' : 'hash')}</span>
      <span class="label">${escapeHtml(channelLabel(channel).replace(/^[#@]/, ''))}</span>
      ${unread ? `<span class="unread">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
    button.onclick = () => selectChannel(channel.name);
    container.appendChild(button);
  }

  if (!channels.length) {
    container.innerHTML = '<div class="rail-empty">Nothing here yet.</div>';
  }
}

const PRESENCE_RANK = { online: 0, away: 1, offline: 2 };

function byPresenceThenName(a, b) {
  return (PRESENCE_RANK[a.status] - PRESENCE_RANK[b.status]) || a.handle.localeCompare(b.handle);
}

/**
 * The roster is sectioned by group. Groups are roles, so an agent holding two
 * of them appears under both — that is the honest rendering, and it is the
 * only way to see a group's actual membership at a glance.
 */
function renderRoster() {
  el.roster.innerHTML = '';

  const agents = Array.from(state.agents.values()).sort(byPresenceThenName);
  if (!agents.length) {
    el.roster.innerHTML = '<div class="rail-empty">No agents have joined yet.</div>';
    return;
  }

  for (const group of state.groups) {
    const members = agents.filter((agent) => agent.groupIds?.includes(group.id));
    el.roster.appendChild(renderGroupHeading(group, members.length));
    for (const agent of members) el.roster.appendChild(renderRosterRow(agent));
  }

  const ungrouped = agents.filter((agent) => !agent.groupIds?.length);
  if (state.groups.length && ungrouped.length) {
    const heading = document.createElement('div');
    heading.className = 'group-heading';
    heading.innerHTML = `<span>No group</span><span class="count">${ungrouped.length}</span>`;
    el.roster.appendChild(heading);
  }
  for (const agent of ungrouped) el.roster.appendChild(renderRosterRow(agent));
}

/**
 * A group heading opens its settings rather than exposing a control inline.
 * Group configuration is expected to grow well past one toggle, and the rail
 * has no room to grow into.
 */
function renderGroupHeading(group, memberCount) {
  const heading = document.createElement('div');
  heading.className = 'group-heading';

  const label = document.createElement('span');
  label.textContent = group.name;

  const meta = document.createElement('span');
  meta.className = 'count';
  const granted = Object.values(group.permissions || {}).filter(Boolean).length;
  meta.textContent = granted ? `${memberCount} · ${granted} granted` : String(memberCount);

  const settings = document.createElement('button');
  settings.className = 'icon-button';
  settings.innerHTML = icon('settings');
  settings.setAttribute('aria-label', `${group.name} settings`);
  settings.onclick = () => openGroupModal(group.id);

  const right = document.createElement('span');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = 'var(--s2)';
  right.append(meta, settings);

  heading.append(label, right);
  return heading;
}

function renderRosterRow(agent) {
  const row = document.createElement('div');
  row.className = 'roster-row';

  const button = document.createElement('button');
  button.className = `roster-item${agent.status === 'offline' ? ' is-offline' : ''}`;
  button.setAttribute('role', 'listitem');
  // The status word belongs in the accessible name too, not only in the dot.
  button.title = `${agent.displayName} (@${agent.handle}) — ${agent.status}${
    agent.description ? `
${agent.description}` : ''
  }`;

  // The self-chosen name leads, the @mention handle sits beneath it — a reader
  // needs the name to know who this is and the handle to reply.
  button.innerHTML = `
    <span class="dot ${agent.status}"></span>
    <span class="roster-name">${escapeHtml(agent.displayName)}</span>
    <span class="callsign">${callsign(agent.platform)}</span>
    <span class="roster-handle">@${escapeHtml(agent.handle)}</span>
  `;
  button.onclick = () => openDirectMessage(agent.handle);

  const actions = document.createElement('div');
  actions.className = 'roster-actions';
  const menuButton = document.createElement('button');
  menuButton.className = 'icon-button';
  menuButton.innerHTML = icon('more');
  menuButton.setAttribute('aria-label', `Manage ${agent.displayName}`);
  menuButton.onclick = (event) => {
    event.stopPropagation();
    toggleRosterMenu(agent, row);
  };
  actions.appendChild(menuButton);

  row.append(button, actions);
  return row;
}

/** One menu open at a time, rendered beneath the agent it belongs to. */
function toggleRosterMenu(agent, row) {
  const existing = row.querySelector('.roster-menu');
  document.querySelectorAll('.roster-menu').forEach((menu) => menu.remove());
  if (existing) return;

  const menu = document.createElement('div');
  menu.className = 'roster-menu';

  const groupList = state.groups.length
    ? state.groups
        .map((group) => {
          const isMember = agent.groupIds?.includes(group.id);
          return `<button class="menu-item${isMember ? ' is-current' : ''}" data-group="${group.id}">
                    <span class="menu-check">${isMember ? icon('check', 'icon--sm') : ''}</span>
                    <span>${escapeHtml(group.name)}</span>
                  </button>`;
        })
        .join('')
    : '<div class="menu-label">No groups yet — create one with + above</div>';

  menu.innerHTML = `
    <div class="menu-label">Groups</div>
    ${groupList}
    <div class="menu-divider"></div>
    <button class="menu-item is-danger" data-remove="1">
      <span class="menu-check">${icon('trash', 'icon--sm')}</span>
      <span>Remove from roster</span>
    </button>
  `;

  for (const button of menu.querySelectorAll('[data-group]')) {
    button.onclick = async () => {
      const groupId = button.dataset.group;
      const isMember = agent.groupIds?.includes(groupId);
      try {
        await window.clanker.setGroupMembership(agent.id, groupId, !isMember);
        menu.remove();
      } catch (error) {
        toast(error.message);
      }
    };
  }

  menu.querySelector('[data-remove]').onclick = async () => {
    try {
      await window.clanker.removeAgent(agent.id);
    } catch (error) {
      toast(error.message);
    }
  };

  row.after(menu);
}

// ============================================
// Transcript
// ============================================

// Messages closer together than this from one author read as a single turn.
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether a message continues the one before it. Repeating an author's name
 * and call sign for every line turns a conversation into a column of stamps;
 * collapsing the header lets it read as someone talking.
 */
function continuesPrevious(message, previous) {
  if (!previous || message.kind === 'system' || previous.kind === 'system') return false;
  if (message.authorHandle !== previous.authorHandle) return false;
  return message.ts - previous.ts < GROUPING_WINDOW_MS;
}

function renderMessage(message, previous) {
  const wrapper = document.createElement('div');
  const isSelf = message.authorHandle === state.self?.handle;
  const isContinuation = continuesPrevious(message, previous);

  wrapper.className = [
    'message',
    message.kind === 'system' ? 'is-system' : '',
    isContinuation ? 'is-continuation' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const head =
    message.kind === 'system' || isContinuation
      ? ''
      : `<div class="message-head">
           <span class="message-author${isSelf ? ' is-self' : ''}">${escapeHtml(message.authorDisplayName || message.authorHandle)}</span>
           <span class="message-handle">@${escapeHtml(message.authorHandle)}</span>
           <span class="callsign">${callsign(message.authorPlatform)}</span>
           <span class="message-time">${formatTime(message.ts)}</span>
         </div>`;

  wrapper.innerHTML = `
    <div class="message-seq">${message.seq}</div>
    <div>${head}<div class="message-body">${formatBody(message.text)}</div></div>
  `;
  return wrapper;
}

/** Day label for a separator: Today and Yesterday by name, then the date. */
function dayLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function renderDaySeparator(timestamp) {
  const divider = document.createElement('div');
  divider.className = 'day-separator';
  divider.innerHTML = `<span>${escapeHtml(dayLabel(timestamp))}</span>`;
  return divider;
}

function appendMessage(message, { scroll = true } = {}) {
  const nearBottom =
    el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 120;

  // Without a dated divider, a bare "9:14 AM" is ambiguous across the whole
  // history and readers consistently misjudge how old something is.
  const previous = state.lastRendered;
  const crossedDay =
    !previous || new Date(previous.ts).toDateString() !== new Date(message.ts).toDateString();
  if (crossedDay) el.transcript.appendChild(renderDaySeparator(message.ts));

  el.transcript.appendChild(renderMessage(message, crossedDay ? null : previous));
  state.lastRendered = message;

  // Only auto-scroll when already reading the live edge, so scrolling back
  // through history is not yanked away by incoming traffic.
  if (scroll && nearBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
}

/**
 * An empty channel is an invitation to act. Until an agent connects there is
 * nothing for the hub to do, so the default channel offers the command that
 * fixes that rather than a bare "no messages" notice.
 */
function renderEmptyState(channel) {
  const hasRemoteAgents = Array.from(state.agents.values()).some((agent) => agent.kind !== 'human');

  const connectHint =
    channel.name === state.defaultChannel && !hasRemoteAgents
      ? `<p>No agents have connected yet. Point one at the hub:</p>
         <pre><code>claude mcp add --transport http clankercom http://127.0.0.1:${state.port}/mcp</code></pre>
         <p>Any MCP client works the same way. Claude Desktop needs the bundled bridge instead — see the README.</p>`
      : '<p>Send the first message, or @mention an agent to bring them in.</p>';

  el.transcript.innerHTML = `
    <div class="empty-state">
      <strong>Nothing on ${escapeHtml(channelLabel(channel))} yet.</strong>
      ${connectHint}
    </div>`;
}

async function loadTranscript(channelName) {
  const channel = state.channels.get(channelName);
  if (!channel) return;

  const messages = await window.clanker.readChannel(channelName, 150);
  el.transcript.innerHTML = '';

  if (!messages.length) {
    state.lastRendered = null;
    renderEmptyState(channel);
    return;
  }

  state.lastRendered = null;
  for (const message of messages) appendMessage(message, { scroll: false });
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

// ============================================
// Channel selection
// ============================================

async function selectChannel(channelName) {
  const channel = state.channels.get(channelName);
  if (!channel) return;

  if (state.view === 'search') {
    el.searchInput.value = '';
    state.searchQuery = '';
  }

  if (state.pendingDelivery?.channelName !== channelName) state.pendingDelivery = null;

  state.activeChannel = channelName;
  setView('channel');
  state.unread.set(channelName, 0);

  el.channelName.textContent = channelLabel(channel);
  el.channelTopic.textContent = channel.topic || '';
  el.composer.placeholder = `Message ${channelLabel(channel)}…`;

  renderRail();
  await loadTranscript(channelName);
}

async function openDirectMessage(handle) {
  if (handle === state.self?.handle) return;
  const channel = await window.clanker.openDm(handle);
  state.channels.set(channel.name, channel);
  renderRail();
  await selectChannel(channel.name);
}

// ============================================
// Net strip
// ============================================

/** Reflect any peer that currently holds a channel. */
function renderNetStrip() {
  const transmitting = state.peers.filter((peer) => peer.state === 'typing' || peer.state === 'streaming');

  if (!transmitting.length) {
    el.netStrip.classList.remove('is-live');
    const online = Array.from(state.agents.values()).filter((a) => a.status === 'online').length;
    const listening = state.listeners.length;

    el.netStatus.textContent = listening
      ? `${listening} listening · ${online} online`
      : `net idle · ${online} online · nobody listening`;
    return;
  }

  el.netStrip.classList.add('is-live');
  el.netStatus.textContent = transmitting
    .map((peer) => `@${peer.handle} ${peer.state}`)
    .join(' · ');
}

// ============================================
// Composer
// ============================================

async function sendCurrentMessage() {
  const text = el.composer.value.trim();
  if (!text || !state.activeChannel) return;

  el.composer.value = '';
  resizeComposer();

  try {
    trackDelivery(await window.clanker.send(state.activeChannel, text));
  } catch (error) {
    el.composer.value = text;
    toast(`Could not send: ${error.message}`);
  }
}

function resizeComposer() {
  el.composer.style.height = 'auto';
  el.composer.style.height = `${Math.min(200, el.composer.scrollHeight)}px`;
}

el.composer.addEventListener('input', resizeComposer);
el.composer.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCurrentMessage();
  }
});

// ============================================
// Browser peers
// ============================================

function addPeerView() {
  const view = document.createElement('webview');
  view.setAttribute('src', 'https://claude.ai/');
  // One shared partition so every peer reuses the same claude.ai login.
  view.setAttribute('partition', 'persist:clanker');
  view.setAttribute('allowpopups', '');
  el.peerStage.appendChild(view);
  el.peerPlaceholder.style.display = 'none';

  view.addEventListener('dom-ready', async () => {
    // dom-ready fires on every navigation; register the peer only once.
    if (view.dataset.peerId) return;

    try {
      const { id } = await window.clanker.addPeer(view.getWebContentsId());
      view.dataset.peerId = id;
      state.peerViews.set(id, view);
      await refreshPeers();
      selectPeer(id);
    } catch (error) {
      el.peerStatus.textContent = `could not attach peer: ${error.message}`;
    }
  });
}

function selectPeer(peerId) {
  state.activePeerId = peerId;
  for (const [id, view] of state.peerViews) view.hidden = id !== peerId;
  renderPeerTabs();
  renderPeerControls();
}

function renderPeerTabs() {
  el.peerTabs.innerHTML = '';

  for (const peer of state.peers) {
    const tab = document.createElement('button');
    tab.className = `peer-tab${peer.id === state.activePeerId ? ' is-active' : ''}`;
    tab.innerHTML = `<span class="dot ${peer.locked ? 'online' : ''}"></span>${escapeHtml(peer.handle)}`;
    tab.onclick = () => selectPeer(peer.id);
    el.peerTabs.appendChild(tab);
  }

  el.peerTabs.appendChild(el.addPeer);
}

function renderPeerControls() {
  const peer = state.peers.find((candidate) => candidate.id === state.activePeerId);

  if (!peer) {
    el.peerStatus.textContent = 'No peer selected';
    el.peerStatus.classList.remove('is-locked');
    el.peerLock.disabled = true;
    el.peerUnlock.disabled = true;
    el.peerRemove.disabled = true;
    return;
  }

  el.peerStatus.textContent = peer.locked
    ? `locked · ${peer.displayName || peer.title || peer.url}`
    : 'open a conversation, then lock it';
  el.peerStatus.classList.toggle('is-locked', peer.locked);
  el.peerLock.disabled = peer.locked;
  el.peerUnlock.disabled = !peer.locked;
  el.peerRemove.disabled = false;
}

/** Detach a peer entirely: its relay, its pane, and its roster entry. */
async function removeActivePeer() {
  const peerId = state.activePeerId;
  if (!peerId) return;

  await window.clanker.removePeer(peerId);

  const view = state.peerViews.get(peerId);
  view?.remove();
  state.peerViews.delete(peerId);

  await refreshPeers();
  const next = state.peers[0];
  if (next) selectPeer(next.id);
  else {
    state.activePeerId = null;
    el.peerPlaceholder.style.display = '';
    renderPeerControls();
  }
}

async function refreshPeers() {
  state.peers = await window.clanker.listPeers();
  renderPeerTabs();
  renderPeerControls();
  renderNetStrip();
}

el.addPeer.onclick = addPeerView;

el.peerLock.onclick = () =>
  withBusy(el.peerLock, async () => {
    if (!state.activePeerId) return;
    try {
      await window.clanker.lockPeer(state.activePeerId);
      await refreshPeers();
    } catch (error) {
      toast(error.message);
    }
  });

el.peerUnlock.onclick = async () => {
  if (!state.activePeerId) return;
  await window.clanker.unlockPeer(state.activePeerId);
  await refreshPeers();
};

el.peerRemove.onclick = async () => {
  try {
    await removeActivePeer();
  } catch (error) {
    el.peerStatus.textContent = `Could not remove the peer: ${error.message}`;
  }
};

el.togglePeers.onclick = () => {
  const collapsed = el.peers.classList.toggle('is-collapsed');
  el.togglePeers.textContent = collapsed ? 'Show browser' : 'Hide browser';
  el.togglePeers.setAttribute('aria-expanded', String(!collapsed));
};

// ============================================
// Channel creation
// ============================================

// An inline themed form rather than a native prompt, which cannot be styled
// and would break out of the console.
function toggleNewChannelForm(show) {
  el.newChannelForm.hidden = !show;
  el.addChannel.setAttribute('aria-expanded', String(show));
  if (show) {
    el.newChannelName.value = '';
    el.newChannelName.focus();
  }
}

el.addChannel.onclick = () => toggleNewChannelForm(el.newChannelForm.hidden);
el.newChannelCancel.onclick = () => toggleNewChannelForm(false);

el.newChannelName.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleNewChannelForm(false);
});

el.newChannelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.newChannelName.value.trim();
  if (!name) return;

  try {
    const channel = await window.clanker.createChannel(name);
    state.channels.set(channel.name, channel);
    toggleNewChannelForm(false);
    renderRail();
    await selectChannel(channel.name);
  } catch (error) {
    toast(`Could not create the channel: ${error.message}`);
  }
});

// ============================================
// Window controls
// ============================================

// Maximize and restore need different glyphs, so the icon is swapped rather
// than the button relabelled.
const MAXIMIZE_ICON = '<rect x="0.5" y="0.5" width="9" height="9" />';
const RESTORE_ICON =
  '<rect x="0.5" y="2.5" width="7" height="7" /><path d="M2.5 2.5V0.5h7v7h-2" />';

function renderWindowState(maximized) {
  el.winMaximizeIcon.innerHTML = maximized ? RESTORE_ICON : MAXIMIZE_ICON;
  el.winMaximize.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
}

el.winMinimize.onclick = () => window.clanker.minimize();
el.winClose.onclick = () => window.clanker.closeWindow();
el.winMaximize.onclick = async () => renderWindowState(await window.clanker.toggleMaximize());

// Snapping and double-click-to-maximize happen in the OS, so the button state
// has to follow the window rather than only its own clicks.
window.clanker.on('window:state', ({ maximized }) => renderWindowState(maximized));

// ============================================
// Delivery status
// ============================================

/**
 * Tell the human what happened to the message they just sent.
 *
 * Sending into a hub where every agent is idle looked identical to sending
 * into an attentive one — the message simply sat there, and silence reads as a
 * frozen application rather than as nobody listening. This says which it is,
 * and when nobody is listening it says what to do about it.
 *
 * Every state below is a fact the hub actually knows. Nothing is inferred:
 * "read" means an agent was genuinely handed the message, and "replying" comes
 * from a browser peer's real relay phase.
 */
function renderDelivery() {
  document.querySelector('.delivery')?.remove();

  const pending = state.pendingDelivery;
  if (!pending || state.view !== 'channel' || pending.channelName !== state.activeChannel) return;

  const row = document.createElement('div');
  const replying = state.peers.find(
    (peer) => peer.state === 'typing' || peer.state === 'streaming'
  );

  const online = Array.from(state.agents.values()).filter(
    (agent) => agent.status === 'online' && agent.kind !== 'human'
  ).length;

  let tone = '';
  let text;
  let hint = '';

  if (pending.seenBy.length) {
    tone = 'is-seen';
    text = `Read by ${pending.seenBy.map((handle) => '@' + handle).join(', ')}`;
    if (replying) text += ` · @${replying.handle} is replying…`;
  } else if (replying) {
    text = `@${replying.handle} is replying…`;
  } else if (online) {
    // Connected but not parked in wait_for_messages. The message is safely
    // stored and the agent will see it — but only once its own runtime gives
    // it a turn, which nothing here can force.
    tone = 'is-waiting';
    text = `Queued · ${online} agent${online === 1 ? '' : 's'} connected, none listening yet`;
    hint = 'Tell your agent to check ClankerCom, or have it run a listener to stay reachable.';
  } else {
    tone = 'is-unheard';
    text = 'Sent — but no agents are connected';
    hint = 'Connect one with the command in an empty channel. See the README.';
  }

  row.className = `delivery ${tone}`.trim();
  row.innerHTML = `
    <span class="delivery-pulse" aria-hidden="true"></span>
    <span>${escapeHtml(text)}</span>
    ${hint ? `<span class="delivery-hint">${escapeHtml(hint)}</span>` : ''}
  `;
  el.transcript.appendChild(row);
}

/** Watch the message just sent, until somebody reads it or the topic moves on. */
function trackDelivery(message) {
  state.pendingDelivery = {
    id: message.id,
    seq: message.seq,
    channelName: message.channelName,
    // An agent parked in wait_for_messages is handed the message during the
    // send itself, so its receipt is emitted before this row exists. The hub
    // reports that delivery in the reply instead of us missing the event.
    seenBy: message.deliveredTo || [],
  };
  renderDelivery();
}

// ============================================
// Search
// ============================================

const SEARCH_DEBOUNCE_MS = 220;
let searchTimer = null;

/** Wrap the matched term so a reader can see *why* a result matched. */
function highlight(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;

  const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(pattern, '<span class="search-hit">$1</span>');
}

async function runSearch(query) {
  state.searchQuery = query;

  if (!query.trim()) {
    if (state.view === 'search') setView('channel');
    return;
  }

  setView('search');
  el.searchView.innerHTML = '<div class="empty-state">Searching…</div>';

  let hits = [];
  try {
    hits = await window.clanker.search(query);
  } catch (error) {
    toast(`Search failed: ${error.message}`);
    return;
  }

  // A late response from a query the user has already moved past would
  // otherwise overwrite the results they are actually looking at.
  if (state.searchQuery !== query) return;

  if (!hits.length) {
    el.searchView.innerHTML = `
      <div class="empty-state">
        <strong>Nothing matched “${escapeHtml(query)}”.</strong>
        <p>Search covers every channel you can see, including history older than the
        window kept in memory. Direct messages between other agents are never searched.</p>
      </div>`;
    return;
  }

  el.searchView.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'task-group-heading';
  heading.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
  el.searchView.appendChild(heading);

  for (const message of hits) {
    const result = document.createElement('button');
    result.className = 'search-result';
    result.innerHTML = `
      <div class="search-result-head">
        <span class="search-result-channel">#${escapeHtml(message.channelName)}</span>
        <span class="message-author">${escapeHtml(message.authorDisplayName || message.authorHandle)}</span>
        <span class="message-time">${formatTime(message.ts)}</span>
        <span class="message-seq">${message.seq}</span>
      </div>
      <div class="search-result-body">${highlight(message.text, query)}</div>
    `;
    // Landing in the conversation is the point of finding it.
    result.onclick = () => selectChannel(message.channelName);
    el.searchView.appendChild(result);
  }
}

el.searchInput.addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value;
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
});

el.searchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  el.searchInput.value = '';
  runSearch('');
  el.searchInput.blur();
});

// ============================================
// Confirm dialog
// ============================================

/**
 * A themed confirm, resolving true or false.
 *
 * Destructive actions must never be gated by a browser dialog: it ignores the
 * theme, cannot be styled, and looks like a different application.
 */
function confirmAction({ title, body, confirmLabel = 'Confirm' }) {
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  el.confirmAccept.textContent = confirmLabel;
  el.confirmModal.hidden = false;
  el.confirmAccept.focus();

  return new Promise((resolve) => {
    const finish = (answer) => {
      el.confirmModal.hidden = true;
      el.confirmAccept.onclick = null;
      el.confirmCancel.onclick = null;
      el.confirmModal.onclick = null;
      resolve(answer);
    };
    el.confirmAccept.onclick = () => finish(true);
    el.confirmCancel.onclick = () => finish(false);
    el.confirmModal.onclick = (event) => {
      if (event.target === el.confirmModal) finish(false);
    };
  });
}

// ============================================
// Shared files
// ============================================

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function openFiles(scope) {
  state.fileScope = scope;
  setView('files');
}

function renderFileScope() {
  const isGlobal = state.fileScope === 'global';
  el.scopeChannel.classList.toggle('is-active', !isGlobal);
  el.scopeGlobal.classList.toggle('is-active', isGlobal);
  el.scopeChannel.setAttribute('aria-selected', String(!isGlobal));
  el.scopeGlobal.setAttribute('aria-selected', String(isGlobal));

  el.scopeChannel.disabled = !state.activeChannel;
  el.filesScopeNote.textContent = isGlobal
    ? 'Visible to every agent, whatever channel it is working in.'
    : `Shared by the members of #${state.activeChannel}.`;

  renderFileList();
}

async function renderFileList() {
  const scope = state.fileScope;
  const channel = scope === 'global' ? null : state.activeChannel;

  let files = [];
  try {
    files = await window.clanker.listFiles(scope, channel);
  } catch (error) {
    toast(`Could not list files: ${error.message}`);
    return;
  }

  if (!files.length) {
    el.fileList.innerHTML = `
      <div class="empty-state">
        <strong>No files here yet.</strong>
        <p>Shared reference material both you and the agents can reach — standards, results,
        anything better filed than pasted into scrollback.</p>
        <p>Agents add them with <code>write_file</code>, which needs write permission for this
        scope. You can add them here at any time.</p>
      </div>`;
    return;
  }

  el.fileList.innerHTML = '';
  for (const file of files) {
    el.fileList.appendChild(renderFileCard(file, scope, channel));
  }
}

function renderFileCard(file, scope, channel) {
  const card = document.createElement('div');
  card.className = 'file-card';

  const edited = new Date(file.updatedAt || file.addedAt).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });

  card.innerHTML = `
    <div class="file-card-head">
      ${icon('file')}
      <span class="file-card-name">${escapeHtml(file.name)}</span>
    </div>
    <div class="file-card-desc${file.description ? '' : ' is-empty'}">${
      escapeHtml(file.description || 'No description')
    }</div>
    <div class="file-card-meta">${formatBytes(file.size)} · @${escapeHtml(file.addedBy)} · ${edited}</div>
    <div class="file-card-actions">
      <button class="icon-button" data-save aria-label="Save ${escapeHtml(file.name)}">
        ${icon('download')}
      </button>
      <button class="icon-button" data-delete aria-label="Delete ${escapeHtml(file.name)}">
        ${icon('trash')}
      </button>
    </div>
  `;

  card.querySelector('[data-save]').onclick = async () => {
    try {
      const saved = await window.clanker.saveFileAs(scope, channel, file.name);
      if (saved) toast(`Saved to ${saved}`, 'ok');
    } catch (error) {
      toast(`Could not save ${file.name}: ${error.message}`);
    }
  };

  card.querySelector('[data-delete]').onclick = async () => {
    const sure = await confirmAction({
      title: `Delete ${file.name}?`,
      body: 'This removes it for everyone with access to this folder, and cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!sure) return;

    try {
      await window.clanker.deleteFile(scope, channel, file.name);
      renderFileList();
    } catch (error) {
      toast(`Could not delete ${file.name}: ${error.message}`);
    }
  };

  return card;
}

el.openFiles.onclick = () => openFiles('channel');
el.openGlobalFiles.onclick = () => openFiles('global');
el.scopeChannel.onclick = () => ((state.fileScope = 'channel'), renderFileScope());
el.scopeGlobal.onclick = () => ((state.fileScope = 'global'), renderFileScope());

el.filesAdd.onclick = () =>
  withBusy(el.filesAdd, async () => {
    const channel = state.fileScope === 'global' ? null : state.activeChannel;
    try {
      const added = await window.clanker.addFiles(state.fileScope, channel);
      if (added.length) toast(`Added ${added.length} file(s).`, 'ok');
      renderFileList();
    } catch (error) {
      toast(`Could not add files: ${error.message}`);
    }
  });

// ============================================
// Channel actions
// ============================================

function toggleChannelMenu(show) {
  el.channelMenu.hidden = !show;
  el.channelMenuButton.setAttribute('aria-expanded', String(show));
}

el.channelMenuButton.onclick = () => toggleChannelMenu(el.channelMenu.hidden);

document.addEventListener('click', (event) => {
  if (!el.channelMenu.hidden && !event.target.closest('.channel-menu-wrap')) {
    toggleChannelMenu(false);
  }
});

el.actionExport.onclick = async () => {
  toggleChannelMenu(false);
  try {
    const saved = await window.clanker.exportChannel(state.activeChannel);
    if (saved) toast(`Transcript exported to ${saved}`, 'ok');
  } catch (error) {
    toast(`Could not export: ${error.message}`);
  }
};

el.actionClear.onclick = async () => {
  toggleChannelMenu(false);
  const channel = state.activeChannel;

  const sure = await confirmAction({
    title: `Clear #${channel}?`,
    body:
      'Every message in this channel is deleted permanently, for everyone. Files in the ' +
      'channel folder are kept. Export the transcript first if you want a copy.',
    confirmLabel: 'Clear history',
  });
  if (!sure) return;

  try {
    const removed = await window.clanker.clearChannel(channel);
    toast(`Cleared ${removed} message${removed === 1 ? '' : 's'} from #${channel}.`, 'ok');
  } catch (error) {
    toast(`Could not clear #${channel}: ${error.message}`);
  }
};

// ============================================
// Group settings modal
// ============================================

/**
 * Permission copy lives here rather than in the hub: the key is the contract,
 * the wording is presentation. Adding a permission means adding an entry —
 * anything ungoverned still renders, just with its raw key as the label.
 */
const PERMISSION_COPY = {
  autoApproveTasks: {
    name: 'Approve tasks automatically',
    note: 'Work raised by members of this group reaches its assignee without waiting for you.',
  },
};

function openGroupModal(groupId) {
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group) return;

  state.editingGroupId = groupId;
  el.groupModalTitle.textContent = group.name;
  el.groupName.value = group.name;

  renderGroupPermissions(group);
  renderGroupMembers(group);

  el.groupModal.hidden = false;
  el.groupName.focus();
}

function closeGroupModal() {
  state.editingGroupId = null;
  el.groupModal.hidden = true;
}

function renderGroupPermissions(group) {
  el.groupPermissions.innerHTML = '';

  // Union of what the group holds and what the app knows about, so a
  // permission added on either side still appears.
  const keys = Array.from(
    new Set([...Object.keys(PERMISSION_COPY), ...Object.keys(group.permissions || {})])
  );

  for (const key of keys) {
    const copy = PERMISSION_COPY[key] || { name: key, note: '' };
    const row = document.createElement('div');
    row.className = 'permission-row';
    row.innerHTML = `
      <div class="permission-copy">
        <div class="permission-name">${escapeHtml(copy.name)}</div>
        ${copy.note ? `<div class="permission-note">${escapeHtml(copy.note)}</div>` : ''}
      </div>
      <label class="switch">
        <input type="checkbox" ${group.permissions?.[key] ? 'checked' : ''}>
        <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
      </label>
    `;
    row.querySelector('input').onchange = async (event) => {
      try {
        await window.clanker.setGroupPermission(group.id, key, event.target.checked);
      } catch (error) {
        toast(error.message);
      }
    };
    el.groupPermissions.appendChild(row);
  }
}

function renderGroupMembers(group) {
  el.groupMembers.innerHTML = '';

  const agents = Array.from(state.agents.values()).sort(byPresenceThenName);
  for (const agent of agents) {
    const isMember = agent.groupIds?.includes(group.id);
    const row = document.createElement('button');
    row.className = `member-row${isMember ? ' is-member' : ''}`;
    row.innerHTML = `
      <span class="member-check">${isMember ? icon('check', 'icon--sm') : ''}</span>
      <span class="dot ${agent.status}"></span>
      <span class="member-name">${escapeHtml(agent.displayName)}</span>
      <span class="callsign">${callsign(agent.platform)}</span>
    `;
    row.onclick = async () => {
      try {
        await window.clanker.setGroupMembership(agent.id, group.id, !isMember);
        const fresh = state.groups.find((candidate) => candidate.id === group.id);
        if (fresh) renderGroupMembers(fresh);
      } catch (error) {
        toast(error.message);
      }
    };
    el.groupMembers.appendChild(row);
  }
}

el.groupModalClose.onclick = closeGroupModal;
el.groupDone.onclick = closeGroupModal;

// Clicking the backdrop dismisses, clicking the panel does not.
el.groupModal.onclick = (event) => {
  if (event.target === el.groupModal) closeGroupModal();
};

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.groupModal.hidden) closeGroupModal();
});

el.groupName.addEventListener('change', async () => {
  const name = el.groupName.value.trim();
  if (!name || !state.editingGroupId) return;
  try {
    await window.clanker.renameGroup(state.editingGroupId, name);
    el.groupModalTitle.textContent = name;
  } catch (error) {
    toast(error.message);
  }
});

el.groupDelete.onclick = async () => {
  if (!state.editingGroupId) return;
  try {
    await window.clanker.deleteGroup(state.editingGroupId);
    closeGroupModal();
  } catch (error) {
    toast(error.message);
  }
};

// ============================================
// Task board
// ============================================

const TASK_STATUS_CLASS = {
  pending_approval: 'is-pending',
  approved: 'is-active',
  in_progress: 'is-active',
  done: 'is-closed',
  rejected: 'is-closed',
  cancelled: 'is-closed',
};

/**
 * Switch the main pane, and decide what the header carries.
 *
 * Every view's control visibility is resolved here rather than toggled at the
 * call sites. Doing it piecemeal is what left channel actions — Files, export,
 * clear — sitting on the Tasks view, offering to export a channel that was not
 * open.
 */
function setView(view) {
  state.view = view;
  const isChannel = view === 'channel';
  const isTasks = view === 'tasks';
  const isFiles = view === 'files';
  const isSearch = view === 'search';

  el.transcript.hidden = !isChannel;
  el.composerWrap.hidden = !isChannel;
  el.netStrip.hidden = !isChannel;
  el.taskBoard.hidden = !isTasks;
  el.filesView.hidden = !isFiles;
  el.searchView.hidden = !isSearch;

  // Channel-scoped actions only exist where a channel is open.
  el.openFiles.hidden = !isChannel;
  el.channelMenuWrap.hidden = !isChannel;
  el.autoApproveWrap.hidden = !isTasks;
  el.filesAdd.hidden = !isFiles;

  if (isTasks) {
    el.channelName.textContent = 'Tasks';
    el.channelTopic.textContent = 'Work agents have asked each other to do';
    renderTaskBoard();
  } else if (isFiles) {
    el.channelName.textContent = 'Files';
    el.channelTopic.textContent = 'Reference material people and agents share';
    renderFileScope();
  } else if (isSearch) {
    el.channelName.textContent = 'Search';
    el.channelTopic.textContent = `Results for “${state.searchQuery}”`;
  }

  renderRail();
}

function renderTaskBoard() {
  const pending = state.tasks.filter((task) => task.status === 'pending_approval');
  const active = state.tasks.filter((task) => ['approved', 'in_progress'].includes(task.status));
  const closed = state.tasks.filter((task) =>
    ['done', 'rejected', 'cancelled'].includes(task.status)
  );

  if (!state.tasks.length) {
    el.taskBoard.innerHTML = `
      <div class="empty-state">
        <strong>No tasks yet.</strong>
        <p>Agents raise these with <code>assign_task</code>. Anything they ask of each other waits
        here for your approval, unless you have granted their group auto-approval.</p>
      </div>`;
    return;
  }

  el.taskBoard.innerHTML = '';
  appendTaskSection('Waiting on you', pending);
  appendTaskSection('In flight', active);
  appendTaskSection('Closed', closed);
}

function appendTaskSection(title, tasks) {
  if (!tasks.length) return;

  const heading = document.createElement('div');
  heading.className = 'task-group-heading';
  heading.textContent = `${title} · ${tasks.length}`;
  el.taskBoard.appendChild(heading);

  for (const task of tasks) el.taskBoard.appendChild(renderTaskCard(task));
}

function renderTaskCard(task) {
  const card = document.createElement('div');
  const isPending = task.status === 'pending_approval';
  card.className = `task-card${isPending ? ' is-pending' : ''}`;

  card.innerHTML = `
    <div class="task-head">
      <span class="task-id">${task.id}</span>
      <span class="task-status ${TASK_STATUS_CLASS[task.status] || ''}">${task.status.replace('_', ' ')}</span>
      <span class="task-route">@${escapeHtml(task.fromHandle)} → @${escapeHtml(task.toHandle)}</span>
    </div>
    <div class="task-title">${escapeHtml(task.title)}</div>
    ${task.detail ? `<div class="task-detail">${escapeHtml(task.detail)}</div>` : ''}
  `;

  if (!isPending) return card;

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const decline = document.createElement('button');
  decline.className = 'control control--ghost control--danger';
  decline.textContent = 'Decline';
  decline.onclick = () => withBusy(decline, () => decideTask(task.id, false));

  const approve = document.createElement('button');
  approve.className = 'control control--primary';
  approve.textContent = `Approve for @${task.toHandle}`;
  approve.onclick = () => withBusy(approve, () => decideTask(task.id, true));

  actions.append(decline, approve);
  card.appendChild(actions);
  return card;
}

async function decideTask(taskId, approved) {
  try {
    await window.clanker.decideTask(taskId, approved);
  } catch (error) {
    toast(`Could not update ${taskId}: ${error.message}`);
  }
}

/** The badge is the only signal that work is blocked on you, so keep it live. */
function renderTaskBadge() {
  const pending = state.tasks.filter((task) => task.status === 'pending_approval').length;
  el.tasksBadge.hidden = pending === 0;
  el.tasksBadge.textContent = pending > 99 ? '99+' : String(pending);
  el.openTasks.classList.toggle('is-active', state.view === 'tasks');
  el.openGlobalFiles.classList.toggle('is-active', state.view === 'files');
}

el.openTasks.onclick = () => setView('tasks');

el.autoApprove.onchange = async (event) => {
  try {
    state.settings = await window.clanker.setAutoApprove(event.target.checked);
  } catch (error) {
    toast(`Could not change auto-approve: ${error.message}`);
  }
};

// ============================================
// Your own identity
// ============================================

function renderSelf() {
  if (!state.self) return;
  el.youName.textContent = state.self.displayName;
  el.youHandle.textContent = `@${state.self.handle}`;
}

function toggleIdentityForm(show) {
  el.identityForm.hidden = !show;
  el.editIdentity.setAttribute('aria-expanded', String(show));
  if (!show) return;

  el.identityName.value = state.self?.displayName || '';
  el.identityHandle.value = state.self?.handle || '';
  el.identityName.focus();
  el.identityName.select();
}

el.editIdentity.onclick = () => toggleIdentityForm(el.identityForm.hidden);
el.identityCancel.onclick = () => toggleIdentityForm(false);

for (const field of [el.identityName, el.identityHandle]) {
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleIdentityForm(false);
  });
}

el.identityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.identityName.value.trim();
  const handle = el.identityHandle.value.trim();
  if (!name && !handle) return toggleIdentityForm(false);

  try {
    // Send the handle only when it actually changed, so simply renaming
    // yourself never disturbs mentions other agents already use.
    state.self = await window.clanker.setIdentity(
      name || undefined,
      handle && handle !== state.self?.handle ? handle : undefined
    );
    state.agents.set(state.self.id, state.self);
    toggleIdentityForm(false);
    renderSelf();
    renderRoster();
  } catch (error) {
    toast(`Could not update your name: ${error.message}`);
  }
});

// ============================================
// Rail sections
// ============================================

const COLLAPSE_KEY = 'clanker.collapsedSections';

/** Which sections are folded. Remembered, per the navigation standard. */
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(state.collapsed)));
}

function applyCollapsed() {
  for (const section of document.querySelectorAll('.rail-section[data-section]')) {
    const key = section.dataset.section;
    const folded = state.collapsed.has(key);
    section.classList.toggle('is-collapsed', folded);
    section.querySelector('.rail-disclosure')?.setAttribute('aria-expanded', String(!folded));
  }
}

for (const button of document.querySelectorAll('.rail-disclosure')) {
  button.onclick = () => {
    const key = button.dataset.toggle;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    saveCollapsed();
    applyCollapsed();
    renderRail();
  };
}

// ============================================
// Group creation
// ============================================

function toggleNewGroupForm(show) {
  el.newGroupForm.hidden = !show;
  el.addGroup.setAttribute('aria-expanded', String(show));
  if (show) {
    el.newGroupName.value = '';
    el.newGroupName.focus();
  }
}

el.addGroup.onclick = () => toggleNewGroupForm(el.newGroupForm.hidden);
el.newGroupCancel.onclick = () => toggleNewGroupForm(false);

el.newGroupName.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleNewGroupForm(false);
});

el.newGroupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.newGroupName.value.trim();
  if (!name) return;

  try {
    await window.clanker.createGroup(name);
    state.groups = await window.clanker.listGroups();
    toggleNewGroupForm(false);
    renderRoster();
  } catch (error) {
    toast(`Could not create the group: ${error.message}`);
  }
});

// ============================================
// Bus subscriptions
// ============================================

window.clanker.on('hub:message', (message) => {
  if (message.channelName === state.activeChannel) {
    // Replace the empty state on the first message in a quiet channel.
    if (el.transcript.querySelector('.empty-state')) {
      el.transcript.innerHTML = '';
      state.lastRendered = null;
    }

    // Somebody answered, which is a better answer than any status line.
    if (state.pendingDelivery && message.authorHandle !== state.self?.handle) {
      state.pendingDelivery = null;
    }

    document.querySelector('.delivery')?.remove();
    appendMessage(message);
    renderDelivery();
    return;
  }

  state.unread.set(message.channelName, (state.unread.get(message.channelName) || 0) + 1);
  renderRail();
});

window.clanker.on('hub:agent', (agent) => {
  state.agents.set(agent.id, agent);
  if (agent.id === state.self?.id) {
    state.self = agent;
    renderSelf();
  }
  renderRoster();
  renderNetStrip();
});

window.clanker.on('hub:channel', (channel) => {
  state.channels.set(channel.name, channel);
  renderRail();
});

window.clanker.on('hub:peers', (peers) => {
  state.peers = peers;
  renderPeerTabs();
  renderPeerControls();
  renderNetStrip();
});

window.clanker.on('hub:agentRemoved', ({ id }) => {
  state.agents.delete(id);
  renderRoster();
  renderNetStrip();
});

window.clanker.on('hub:groups', (groups) => {
  state.groups = groups;
  renderRoster();

  // Keep an open settings modal in step with the change it just made.
  if (!state.editingGroupId) return;
  const open = groups.find((group) => group.id === state.editingGroupId);
  if (open) {
    renderGroupPermissions(open);
    renderGroupMembers(open);
  } else {
    closeGroupModal();
  }
});

window.clanker.on('hub:task', (task) => {
  const index = state.tasks.findIndex((existing) => existing.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.unshift(task);

  renderTaskBadge();
  if (state.view === 'tasks') renderTaskBoard();
});

window.clanker.on('hub:cleared', ({ name }) => {
  state.unread.set(name, 0);
  if (name === state.activeChannel) loadTranscript(name);
  renderRail();
});

window.clanker.on('hub:files', () => {
  if (state.view === 'files') renderFileList();
});

window.clanker.on('hub:listeners', (handles) => {
  state.listeners = handles;
  renderNetStrip();
  renderDelivery();
});

window.clanker.on('hub:seen', ({ id, seenBy }) => {
  if (state.pendingDelivery?.id !== id) return;
  state.pendingDelivery.seenBy = seenBy;
  renderDelivery();
});

window.clanker.on('hub:reveal', ({ channel, view }) => {
  if (view === 'tasks') return setView('tasks');
  if (channel && state.channels.has(channel)) selectChannel(channel);
});

window.clanker.on('hub:settings', (settings) => {
  state.settings = settings;
  el.autoApprove.checked = !!settings.autoApproveTasks;
});

// ============================================
// Bootstrap
// ============================================

async function start() {
  const snapshot = await window.clanker.bootstrap();

  state.self = snapshot.self;
  for (const agent of snapshot.agents) state.agents.set(agent.id, agent);
  for (const channel of snapshot.channels) state.channels.set(channel.name, channel);
  state.peers = snapshot.peers;
  state.port = snapshot.port;
  state.defaultChannel = snapshot.defaultChannel;
  state.collapsed = loadCollapsed();
  applyCollapsed();
  state.groups = snapshot.groups || [];
  state.tasks = snapshot.tasks || [];
  state.settings = snapshot.settings || state.settings;
  state.listeners = snapshot.listeners || [];

  el.autoApprove.checked = !!state.settings.autoApproveTasks;
  renderWindowState(await window.clanker.isMaximized());

  el.hubEndpoint.textContent = `127.0.0.1:${snapshot.port}/mcp`;

  renderSelf();
  renderRail();
  renderPeerTabs();
  renderPeerControls();
  renderNetStrip();
  await selectChannel(snapshot.defaultChannel);
}

start().catch((error) => {
  toast(`ClankerCom could not start: ${error.message}`);
});
