'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  // window chrome
  minimize: () => ipcRenderer.invoke('win:minimize'),
  close: () => ipcRenderer.invoke('win:close'),
  togglePin: () => ipcRenderer.invoke('win:toggle-pin'),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:set-key', key),

  // the OpenAI-compatible engine (Ollama, OpenRouter, Groq, …)
  providers: () => ipcRenderer.invoke('compat:providers'),
  setAltKey: (key) => ipcRenderer.invoke('settings:set-alt-key', key),
  listModels: (baseUrl, key) => ipcRenderer.invoke('compat:models', { baseUrl, key }),
  testModel: (baseUrl, key, model) => ipcRenderer.invoke('compat:test', { baseUrl, key, model }),

  // conversations
  listChats: () => ipcRenderer.invoke('chat:list'),
  getChat: (id) => ipcRenderer.invoke('chat:get', id),
  newChat: () => ipcRenderer.invoke('chat:new'),
  deleteChat: (id) => ipcRenderer.invoke('chat:delete', id),
  renameChat: (id, title) => ipcRenderer.invoke('chat:rename', { id, title }),
  send: (conversationId, text, buildMode) => ipcRenderer.invoke('chat:send', { conversationId, text, buildMode }),
  stop: () => ipcRenderer.invoke('chat:stop'),
  onStreamEvent: (fn) => ipcRenderer.on('chat:event', (_e, payload) => fn(payload)),

  // Studio bridge
  studioStatus: () => ipcRenderer.invoke('studio:status'),
  insertScript: (job) => ipcRenderer.invoke('studio:insert', job),
  insertAsset: (assetId, path, assetKind) => ipcRenderer.invoke('studio:insert-asset', { assetId, path, assetKind }),
  installPlugin: () => ipcRenderer.invoke('studio:install-plugin'),
  openPluginsFolder: () => ipcRenderer.invoke('studio:open-plugins-folder'),
  onStudioStatus: (fn) => ipcRenderer.on('studio:status', (_e, st) => fn(st)),
  onStudioResult: (fn) => ipcRenderer.on('studio:result', (_e, r) => fn(r)),
});
