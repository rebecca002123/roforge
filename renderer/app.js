'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  chatId: null,
  streaming: false,
  streamText: '',
  streamThinking: '',
  buildMode: false,
  studio: { connected: false, port: 8095, place: null },
};

// --- helpers -------------------------------------------------------------

let toastTimer = null;
function toast(message, bad) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('bad', Boolean(bad));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function atBottom() {
  const el = $('messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollDown(force) {
  if (force || atBottom()) {
    const el = $('messages');
    el.scrollTop = el.scrollHeight;
  }
}

// --- rendering -----------------------------------------------------------

function emptyState() {
  return `<div class="empty">
    <h3>What are you building?</h3>
    <p>Ask anything about your Roblox game and I'll answer like a teammate who
    knows the engine — Luau, remotes, DataStores, physics, UI, or why that one
    script keeps erroring.</p>
    <ul>
      <li>"Write me a round-based lobby system with a countdown"</li>
      <li>"Why is my RemoteEvent firing twice?"</li>
      <li>"Save player coins to a DataStore, safely"</li>
      <li>"Make a sword that does damage but can't be spammed"</li>
    </ul>
    <p>Connect the Studio plugin and scripts land straight in your open place.</p>
  </div>`;
}

function messageNode(role, html) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="role">${role === 'user' ? 'You' : 'RoForge'}</div>`
    + `<div class="bubble">${html}</div>`;
  return wrap;
}

function renderConversation(convo) {
  const box = $('messages');
  box.innerHTML = '';
  if (!convo || !convo.messages.length) {
    box.innerHTML = emptyState();
    return;
  }
  for (const m of convo.messages) {
    const html = m.role === 'user' ? window.md.escapeHtml(m.content) : window.md.render(m.content);
    box.appendChild(messageNode(m.role, html));
  }
  scrollDown(true);
}

/** The assistant bubble currently being streamed into. */
let liveNode = null;

/** Rows keyed by tool-use id, with a FIFO fallback for engines without ids. */
let actionRows = new Map();
let pendingActions = [];
let workingSince = 0;
let workingTimer = null;

function startAssistantBubble() {
  const box = $('messages');
  const node = messageNode('assistant',
    '<div class="working"><span class="spin"></span>'
    + '<span class="working-text">Starting…</span><span class="elapsed"></span></div>'
    + '<div class="thinking" hidden><span class="thinking-label">Thinking</span><span class="thinking-body"></span></div>'
    + '<div class="actions"></div><div class="stream"></div>');
  box.appendChild(node);
  liveNode = node;
  actionRows = new Map();
  pendingActions = [];

  // A ticking clock is the difference between "it's working" and "it's hung".
  workingSince = Date.now();
  clearInterval(workingTimer);
  workingTimer = setInterval(tickElapsed, 1000);
  tickElapsed();
  scrollDown(true);
}

function tickElapsed() {
  if (!liveNode) return;
  const el = liveNode.querySelector('.elapsed');
  if (!el) return;
  const seconds = Math.floor((Date.now() - workingSince) / 1000);
  el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function setWorking(text) {
  if (!liveNode) return;
  const el = liveNode.querySelector('.working-text');
  if (el) el.textContent = text;
}

/** Show a Studio action the moment it starts, so a long build isn't a blank wait. */
function addAction(label, id) {
  if (!liveNode) return;
  const row = document.createElement('div');
  row.className = 'action running';
  row.innerHTML = '<span class="mark">▸</span><span class="label"></span><span class="detail"></span>';
  row.querySelector('.label').textContent = label;
  liveNode.querySelector('.actions').appendChild(row);
  if (id) actionRows.set(id, row); else pendingActions.push(row);
  setWorking(label);
  scrollDown(false);
}

function completeAction(ok, detail, id) {
  // Tools can run in parallel, so prefer the id; fall back to arrival order.
  const row = (id && actionRows.get(id)) || pendingActions.shift();
  if (id) actionRows.delete(id);
  if (!row) return;
  row.className = `action ${ok ? 'done' : 'failed'}`;
  row.querySelector('.mark').textContent = ok ? '✓' : '✕';
  if (detail && !ok) row.querySelector('.detail').textContent = `— ${detail}`;
  scrollDown(false);
}

function updateLive() {
  if (!liveNode) return;
  const think = liveNode.querySelector('.thinking');
  const body = liveNode.querySelector('.thinking-body');
  if (state.streamThinking) {
    think.hidden = false;
    body.textContent = state.streamThinking;
    body.parentElement.scrollTop = body.parentElement.scrollHeight;
  }
  liveNode.querySelector('.stream').innerHTML = window.md.render(state.streamText);
  scrollDown(false);
}

function finishLive(text, note) {
  clearInterval(workingTimer);
  workingTimer = null;
  if (!liveNode) return;
  const think = liveNode.querySelector('.thinking');
  // Reasoning is scaffolding, not the answer — collapse it once the answer lands.
  if (think) think.remove();
  liveNode.querySelector('.bubble').innerHTML =
    (note ? `<div class="status-line${note.error ? ' error' : ''}">${window.md.escapeHtml(note.text)}</div>` : '')
    + window.md.render(text || '');
  liveNode = null;
  scrollDown(false);
}

// --- chat list -----------------------------------------------------------

async function refreshChatList() {
  const chats = await window.forge.listChats();
  const list = $('chatList');
  list.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = `chat-item${c.id === state.chatId ? ' active' : ''}`;
    item.innerHTML = `<span></span><button title="Delete">✕</button>`;
    item.querySelector('span').textContent = c.title;
    item.querySelector('span').onclick = () => openChat(c.id);
    item.querySelector('button').onclick = async (e) => {
      e.stopPropagation();
      await window.forge.deleteChat(c.id);
      if (state.chatId === c.id) {
        const remaining = await window.forge.listChats();
        if (remaining.length) openChat(remaining[0].id);
        else newChat();
      } else {
        refreshChatList();
      }
    };
    list.appendChild(item);
  }
}

async function openChat(id) {
  state.chatId = id;
  const convo = await window.forge.getChat(id);
  renderConversation(convo);
  refreshChatList();
}

async function newChat() {
  const convo = await window.forge.newChat();
  state.chatId = convo.id;
  renderConversation(convo);
  refreshChatList();
  $('input').focus();
}

// --- sending -------------------------------------------------------------

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.streaming) return;

  const settings = await window.forge.getSettings();
  if (settings.engine !== 'claude-code' && !settings.hasKey) {
    openSettings();
    toast('Add your Anthropic API key first', true);
    return;
  }

  if (!state.chatId) await newChat();

  const box = $('messages');
  if (box.querySelector('.empty')) box.innerHTML = '';
  box.appendChild(messageNode('user', window.md.escapeHtml(text)));

  input.value = '';
  input.style.height = 'auto';
  setStreaming(true);
  state.streamText = '';
  state.streamThinking = '';
  startAssistantBubble();
  scrollDown(true);

  const res = await window.forge.send(state.chatId, text, state.buildMode);
  setStreaming(false);

  if (res.ok) {
    finishLive(res.text || state.streamText,
      res.stopReason === 'aborted' ? { text: 'Stopped — here\'s what came through.' } : null);
    refreshChatList();
  } else if (res.error === 'no-key') {
    finishLive('', { text: 'No API key set.', error: true });
    openSettings();
  } else {
    finishLive(state.streamText, { text: res.error || 'Something went wrong.', error: true });
  }
}

function setStreaming(on) {
  state.streaming = on;
  $('btnSend').hidden = on;
  $('btnStop').hidden = !on;
  $('hint').textContent = on
    ? (state.buildMode ? 'Building in Studio…' : 'Working…')
    : (state.buildMode ? 'It will build this in your open place' : 'Enter to send · Shift+Enter for a new line');
}

/** Build mode is only meaningful with Studio on the other end of the bridge. */
function paintBuildToggle() {
  const btn = $('btnBuild');
  const connected = state.studio && state.studio.connected && !state.studio.pluginStale;
  btn.classList.toggle('on', state.buildMode && connected);
  btn.disabled = !connected;
  if (state.studio && state.studio.pluginStale) {
    btn.title = 'Restart Roblox Studio — it is running an older RoForge plugin that cannot build.';
    btn.classList.remove('on');
    return;
  }
  btn.title = connected
    ? (state.buildMode
      ? 'On — RoForge will create scripts and objects in your place itself.'
      : 'Off — RoForge will answer in chat and let you insert code yourself.')
    : 'Needs Roblox Studio connected.';
  if (!connected && state.buildMode) {
    // Don't leave it looking armed when it can't fire.
    btn.classList.remove('on');
  }
}

// --- Studio --------------------------------------------------------------

/**
 * Three states, because "not connected" covers two very different situations
 * and conflating them makes the app look broken when Studio is right there.
 */
function paintStudio(st) {
  state.studio = st;
  const chip = $('studioChip');
  chip.classList.toggle('live', st.connected);
  chip.classList.toggle('waiting', !st.connected && st.studioRunning);

  chip.classList.toggle('waiting', Boolean(st.pluginStale) || (!st.connected && st.studioRunning));

  if (st.connected && st.pluginStale) {
    $('studioLabel').textContent = 'Studio · plugin outdated';
    chip.title = 'Studio is running an older copy of the RoForge plugin. '
      + 'Restart Studio to pick up the current one — building needs it.';
  } else if (st.connected) {
    $('studioLabel').textContent = st.place ? `Studio · ${st.place}` : 'Studio connected';
    chip.title = `Linked on port ${st.port}`
      + (st.selection && st.selection.length ? ` · ${st.selection.length} selected in the Explorer` : '');
  } else if (st.studioRunning) {
    $('studioLabel').textContent = 'Studio open · not linked';
    chip.title = 'Roblox Studio is running but the RoForge plugin isn\'t talking to it yet.\n'
      + 'Install the plugin in Settings, then restart Studio — plugins only load at startup.';
  } else {
    $('studioLabel').textContent = 'Studio closed';
    chip.title = 'Roblox Studio isn\'t running. Open it and RoForge will link up automatically.';
  }
  paintBuildToggle();
}

async function insertBlock(btn) {
  const code = document.getElementById(btn.dataset.block);
  if (!code) return;
  if (!state.studio.connected) {
    toast('Studio isn\'t connected — see Settings for the plugin', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  await window.forge.insertScript({
    path: btn.dataset.path,
    type: btn.dataset.type,
    source: code.dataset.raw || code.textContent,
  });
  setTimeout(() => {
    if (btn.isConnected && btn.textContent === 'Sending…') {
      btn.disabled = false;
      btn.textContent = 'Send to Studio';
    }
  }, 6000);
}

// --- settings ------------------------------------------------------------

function paintEngine(engine) {
  const viaCli = engine === 'claude-code';
  // The API key and effort only mean anything on the API path; hiding them
  // keeps the sheet honest about what actually applies.
  $('apiKeyField').hidden = viaCli;
  $('effort').closest('.field').hidden = viaCli;
  $('engineHelp').textContent = viaCli
    ? 'Uses the Claude Code CLI already on this PC, so it draws on your Claude subscription instead of API credits. Studio tools reach it over MCP.'
    : 'Calls the Anthropic API directly. Billed as pay-as-you-go credits, which a Claude subscription does not cover.';
}

async function openSettings() {
  const s = await window.forge.getSettings();
  $('engine').value = s.engine || 'api';
  paintEngine($('engine').value);
  $('effort').value = s.effort;
  $('showThinking').checked = s.showThinking;
  $('portLabel').textContent = s.bridgePort;
  $('apiKey').value = '';
  $('apiKey').placeholder = s.hasKey ? '•••••••• (saved)' : 'sk-ant-…';
  const st = $('keyState');
  if (s.hasKey) {
    st.textContent = s.keyIsPlaintext
      ? 'Saved, but this machine has no secure storage — the key is stored unencrypted.'
      : 'Saved and encrypted for this Windows account.';
    st.className = s.keyIsPlaintext ? 'state-bad' : 'state-ok';
  } else {
    st.textContent = 'Needed to talk to Claude. Get one at console.anthropic.com.';
    st.className = '';
  }
  $('settingsModal').hidden = false;
}

async function saveSettings() {
  const key = $('apiKey').value.trim();
  if (key && $('engine').value === 'api') {
    const st = $('keyState');
    st.textContent = 'Checking key…';
    st.className = '';
    const res = await window.forge.setApiKey(key);
    if (!res.ok) {
      st.textContent = res.error;
      st.className = 'state-bad';
      return; // keep the sheet open so they can fix it
    }
    $('apiKey').value = '';
  }
  await window.forge.updateSettings({
    engine: $('engine').value,
    effort: $('effort').value,
    showThinking: $('showThinking').checked,
  });
  $('settingsModal').hidden = true;
  toast('Settings saved');
}

// --- wiring --------------------------------------------------------------

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('btnMin').onclick = () => window.forge.minimize();
  $('btnClose').onclick = () => window.forge.close();
  $('btnPin').onclick = async () => {
    const pinned = await window.forge.togglePin();
    $('btnPin').classList.toggle('active', pinned);
    toast(pinned ? 'Staying on top' : 'No longer on top');
  };
  $('btnChats').onclick = () => {
    const drawer = $('drawer');
    drawer.hidden = !drawer.hidden;
    $('btnChats').classList.toggle('active', !drawer.hidden);
  };
  $('btnSettings').onclick = openSettings;
  $('btnSaveSettings').onclick = saveSettings;
  $('engine').onchange = () => paintEngine($('engine').value);
  $('btnInstallPlugin').onclick = async () => {
    const st = $('pluginState');
    st.textContent = 'Installing…';
    st.className = '';
    const res = await window.forge.installPlugin();
    if (res.ok) {
      st.textContent = `Installed to ${res.path}. Restart Studio, then click RoForge on the Plugins tab.`;
      st.className = 'state-ok';
      toast('Plugin installed — restart Studio');
    } else {
      st.textContent = `Couldn't write the plugin: ${res.error}`;
      st.className = 'state-bad';
    }
  };
  $('btnOpenPluginsFolder').onclick = () => window.forge.openPluginsFolder();
  $('btnNewChat').onclick = newChat;
  $('btnSend').onclick = sendMessage;
  $('btnStop').onclick = () => window.forge.stop();
  $('btnBuild').onclick = async () => {
    state.buildMode = !state.buildMode;
    paintBuildToggle();
    setStreaming(state.streaming);
    await window.forge.updateSettings({ buildMode: state.buildMode });
    toast(state.buildMode
      ? 'Build mode on — it will make the changes itself'
      : 'Build mode off — it will answer in chat');
  };

  $('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') $('settingsModal').hidden = true;
  });

  const input = $('input');
  input.addEventListener('input', () => autosize(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Code block buttons are created by the markdown renderer, so catch them here.
  $('messages').addEventListener('click', async (e) => {
    const copy = e.target.closest('.cb-copy');
    if (copy) {
      const code = document.getElementById(copy.dataset.block);
      await navigator.clipboard.writeText(code ? (code.dataset.raw || code.textContent) : '');
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      return;
    }
    const insert = e.target.closest('.cb-insert');
    if (insert) insertBlock(insert);
  });

  window.forge.onStreamEvent((evt) => {
    if (evt.conversationId !== state.chatId) return;
    if (evt.type === 'text') {
      if (!state.streamText) setWorking('Writing…');
      state.streamText += evt.text;
      updateLive();
    } else if (evt.type === 'thinking') {
      setWorking('Thinking…');
      state.streamThinking += evt.text;
      updateLive();
    } else if (evt.type === 'status') setWorking(evt.text);
    else if (evt.type === 'tool-start') addAction(evt.label, evt.id);
    else if (evt.type === 'tool-end') completeAction(evt.ok, evt.detail, evt.id);
  });

  window.forge.onStudioStatus(paintStudio);
  window.forge.onStudioResult((r) => {
    if (r.ok) toast(`Inserted ${r.path}`);
    else toast(`Studio: ${r.error || 'insert failed'}`, true);
    for (const btn of document.querySelectorAll('.cb-insert[disabled]')) {
      btn.disabled = false;
      btn.textContent = r.ok ? 'Sent ✓' : 'Send to Studio';
    }
  });

  const settings = await window.forge.getSettings();
  $('btnPin').classList.toggle('active', settings.alwaysOnTop);
  state.buildMode = Boolean(settings.buildMode);
  paintStudio(await window.forge.studioStatus());
  setStreaming(false);
  // The status event only fires when the plugin polls; poll ourselves so the
  // chip goes stale-grey when Studio closes rather than lying about it.
  setInterval(async () => paintStudio(await window.forge.studioStatus()), 4000);

  const chats = await window.forge.listChats();
  if (chats.length) openChat(chats[0].id);
  else newChat();

  if (settings.engine !== 'claude-code' && !settings.hasKey) openSettings();
  $('input').focus();
});
