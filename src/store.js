'use strict';

// Conversations + settings on disk. The API key is encrypted with Electron's
// safeStorage (DPAPI on Windows) so it isn't sitting in plaintext JSON next to
// the chat history.

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = () => path.join(app.getPath('userData'), 'roforge.json');

const DEFAULTS = {
  apiKey: null, // base64 of an encrypted buffer, or { plain: "..." } if unavailable
  engine: 'claude-code', // 'api' = Anthropic API credits, 'claude-code' = your Claude subscription
  effort: 'xhigh', // low | medium | high | xhigh | max
  showThinking: true,
  buildMode: false, // let Claude act on the place directly, rather than just answering
  alwaysOnTop: false,
  bridgePort: 8095,
  conversations: [], // [{ id, title, createdAt, updatedAt, messages: [{role, content}] }]
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  if (!cache) return;
  try {
    fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[store] write failed', err);
  }
}

function setApiKey(key) {
  const s = load();
  if (!key) {
    s.apiKey = null;
  } else if (safeStorage.isEncryptionAvailable()) {
    s.apiKey = safeStorage.encryptString(key).toString('base64');
  } else {
    // No OS keyring (rare on Windows). Store it, but mark it so we can warn.
    s.apiKey = { plain: key };
  }
  save();
}

function getApiKey() {
  const s = load();
  if (!s.apiKey) return null;
  if (typeof s.apiKey === 'object') return s.apiKey.plain || null;
  try {
    return safeStorage.decryptString(Buffer.from(s.apiKey, 'base64'));
  } catch {
    // Key was encrypted under a different OS user/profile — treat as unset
    // rather than crashing every request.
    return null;
  }
}

function settings() {
  const s = load();
  return {
    hasKey: Boolean(getApiKey()),
    keyIsPlaintext: typeof s.apiKey === 'object',
    engine: s.engine,
    effort: s.effort,
    showThinking: s.showThinking,
    buildMode: s.buildMode,
    alwaysOnTop: s.alwaysOnTop,
    bridgePort: s.bridgePort,
  };
}

function updateSettings(patch) {
  const s = load();
  for (const k of ['engine', 'effort', 'showThinking', 'buildMode', 'alwaysOnTop', 'bridgePort']) {
    if (patch[k] !== undefined) s[k] = patch[k];
  }
  save();
  return settings();
}

// --- conversations -------------------------------------------------------

function listConversations() {
  return load().conversations.map(({ id, title, createdAt, updatedAt }) => ({
    id, title, createdAt, updatedAt,
  }));
}

function getConversation(id) {
  return load().conversations.find((c) => c.id === id) || null;
}

function createConversation() {
  const s = load();
  const now = Date.now();
  const convo = { id: `c${now}${Math.floor(Math.random() * 1000)}`, title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
  s.conversations.unshift(convo);
  save();
  return convo;
}

function appendMessage(id, message) {
  const convo = getConversation(id);
  if (!convo) return null;
  convo.messages.push(message);
  convo.updatedAt = Date.now();
  // First user line names the chat — a sidebar of "New chat" ×12 is useless.
  if (convo.title === 'New chat' && message.role === 'user') {
    convo.title = message.content.replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat';
  }
  save();
  return convo;
}

/** Claude Code keeps its own conversation; we just remember which one. */
function setSessionId(id, sessionId) {
  const convo = getConversation(id);
  if (convo && sessionId) { convo.ccSessionId = sessionId; save(); }
}

function deleteConversation(id) {
  const s = load();
  s.conversations = s.conversations.filter((c) => c.id !== id);
  save();
}

function renameConversation(id, title) {
  const convo = getConversation(id);
  if (convo) { convo.title = title; save(); }
}

module.exports = {
  settings, updateSettings, setApiKey, getApiKey,
  listConversations, getConversation, createConversation,
  appendMessage, setSessionId, deleteConversation, renameConversation,
};
