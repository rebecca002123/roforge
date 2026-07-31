'use strict';

// Bloxwright — a Roblox coding companion that sits next to Studio.
//
// Three moving parts: this process owns the window and the Anthropic calls,
// src/bridge.js runs a localhost server that the Studio plugin polls, and the
// renderer is a plain HTML/CSS/JS chat UI.

const { app, BrowserWindow, ipcMain, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./src/store');
const claude = require('./src/claude');
const bridge = require('./src/bridge');
const studioDetect = require('./src/studio-detect');
const claudecode = require('./src/claudecode');
const compat = require('./src/openai');

let win = null;

// Must match PLUGIN_VERSION in plugin/Bloxwright.server.lua. Studio caches plugins
// until it reloads them, so an updated app can easily be talking to last
// version's plugin — better to say so than to fail a build halfway through.
const PLUGIN_PROTOCOL = 3;

/**
 * What the UI needs to describe the Studio link: whether the plugin is talking
 * to us, whether it's the version this app speaks to, and — separately —
 * whether Studio is even running. That last part is what stops the app saying
 * "offline" at someone staring at an open Studio.
 */
async function studioState() {
  const status = bridge.status();
  return {
    ...status,
    studioRunning: await studioDetect.isStudioRunning(),
    pluginStale: Boolean(status.connected && (status.pluginVersion || 1) < PLUGIN_PROTOCOL),
  };
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // Default to the right-hand half of the screen: this app is meant to live
  // beside Studio, not on top of it.
  const width = Math.min(560, Math.floor(workArea.width * 0.42));
  const height = Math.min(920, workArea.height - 40);

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 20,
    minWidth: 420,
    minHeight: 480,
    frame: false,
    backgroundColor: '#0b0d13',
    backgroundMaterial: 'acrylic', // Win11 glass; ignored elsewhere
    show: false,
    title: 'Bloxwright',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (store.settings().alwaysOnTop) win.setAlwaysOnTop(true);
  });

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; });
}

function pushToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(async () => {
  const s = store.settings();
  const started = await bridge.start(s.bridgePort);
  if (!started.ok) console.error('[bloxwright] bridge failed to start:', started.error);

  bridge.emitter.on('status', async () => pushToRenderer('studio:status', await studioState()));
  bridge.emitter.on('result', (r) => pushToRenderer('studio:result', r));

  // Written at startup, not just per turn, so the config is always on disk for
  // inspection and so a manual `claude --mcp-config` run works too.
  try {
    claudecode.writeMcpConfig(__dirname, process.execPath);
  } catch (err) {
    console.error('[bloxwright] could not write the MCP config', err);
  }

  removeLegacyPlugins();
  refreshInstalledPlugin();

  createWindow();

  // Summon the window without reaching for the taskbar mid-build.
  globalShortcut.register('Control+Alt+B', () => {
    if (!win) return createWindow();
    if (win.isVisible() && win.isFocused()) win.hide();
    else { win.show(); win.focus(); }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge.stop();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge.stop();
});

// --- window chrome -------------------------------------------------------

ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:close', () => { if (win) win.close(); });
ipcMain.handle('win:toggle-pin', () => {
  if (!win) return false;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  store.updateSettings({ alwaysOnTop: next });
  return next;
});

// --- settings ------------------------------------------------------------

ipcMain.handle('settings:get', () => store.settings());
ipcMain.handle('settings:update', (_e, patch) => store.updateSettings(patch));
ipcMain.handle('settings:set-key', async (_e, key) => {
  const trimmed = (key || '').trim();
  if (!trimmed) { store.setApiKey(null); return { ok: true, cleared: true }; }
  const check = await claude.verifyKey(trimmed);
  if (check.ok) store.setApiKey(trimmed);
  return check;
});

// --- OpenAI-compatible engine -------------------------------------------

ipcMain.handle('compat:providers', () => compat.PROVIDERS);

/** Saved without verifying: several of these providers have no cheap probe,
 *  and the model list / test button below is the honest check. */
ipcMain.handle('settings:set-alt-key', (_e, key) => {
  store.setAltKey((key || '').trim() || null);
  return { ok: true };
});

ipcMain.handle('compat:models', (_e, { baseUrl, key }) => compat.listModels({
  baseUrl,
  apiKey: (key || '').trim() || store.getAltKey(),
}));

ipcMain.handle('compat:test', (_e, { baseUrl, key, model }) => compat.verify({
  baseUrl,
  apiKey: (key || '').trim() || store.getAltKey(),
  model,
}));

// --- conversations -------------------------------------------------------

ipcMain.handle('chat:list', () => store.listConversations());
ipcMain.handle('chat:get', (_e, id) => store.getConversation(id));
ipcMain.handle('chat:new', () => store.createConversation());
ipcMain.handle('chat:delete', (_e, id) => { store.deleteConversation(id); return store.listConversations(); });
ipcMain.handle('chat:rename', (_e, { id, title }) => { store.renameConversation(id, title); return store.listConversations(); });

let activeConversation = null;

ipcMain.handle('chat:send', async (event, { conversationId, text, buildMode }) => {
  const settings = store.settings();
  const engine = settings.engine;
  const apiKey = store.getApiKey();

  if (engine === 'claude-code' && !claudecode.isInstalled()) {
    return { ok: false, error: 'Claude Code is not installed on this machine. Install it, or pick a different engine in settings.' };
  }
  if (engine === 'api' && !apiKey) return { ok: false, error: 'no-key' };
  if (engine === 'openai') {
    if (!settings.altBaseUrl) return { ok: false, error: 'no-key' };
    if (!settings.altModel) {
      return { ok: false, error: 'No model chosen yet — pick one in Settings under “Runs on”.' };
    }
    const preset = compat.PROVIDERS[settings.provider];
    if (preset && !preset.keyless && !store.getAltKey()) return { ok: false, error: 'no-key' };
  }

  const studio = bridge.status();
  if (buildMode && studio.connected && (studio.pluginVersion || 1) < PLUGIN_PROTOCOL) {
    return {
      ok: false,
      error: 'Roblox Studio is still running an older Bloxwright plugin that cannot build for you. '
        + 'Restart Studio to load the current one, then try again.',
    };
  }
  if (buildMode && !bridge.isConnected()) {
    return {
      ok: false,
      error: 'Build mode needs Roblox Studio connected — open Studio with the Bloxwright plugin, or switch Build off to just chat.',
    };
  }

  const convo = store.appendMessage(conversationId, { role: 'user', content: text });
  if (!convo) return { ok: false, error: 'Conversation not found.' };

  const s = settings;
  const onEvent = (evt) => event.sender.send('chat:event', { conversationId, ...evt });
  activeConversation = conversationId;
  try {
    let result;
    if (engine === 'openai') {
      result = await (buildMode ? compat.build : compat.send)({
        baseUrl: s.altBaseUrl,
        apiKey: store.getAltKey(),
        model: s.altModel,
        messages: convo.messages,
        studioContext: bridge.contextBlock(),
        showThinking: s.showThinking,
        onEvent,
      });
    } else if (engine === 'claude-code') {
      // Claude Code keeps its own conversation state, so it gets this turn's
      // text and a session id — not our stored history.
      result = await claudecode.send({
        prompt: text,
        sessionId: convo.ccSessionId,
        buildMode,
        studioContext: bridge.contextBlock(),
        appDir: __dirname,
        execPath: process.execPath,
        onEvent,
      });
      store.setSessionId(conversationId, result.sessionId);
    } else {
      result = await (buildMode ? claude.build : claude.send)({
        apiKey,
        messages: convo.messages,
        studioContext: bridge.contextBlock(),
        effort: s.effort,
        showThinking: s.showThinking,
        onEvent,
      });
    }

    // Tool blocks are dropped from stored history (they'd be orphaned without
    // their results), so the actions are folded into the message as prose —
    // readable on reload, and still context for the next turn.
    let stored = result.text || '';
    if (result.actions && result.actions.length) {
      const lines = result.actions.map((a) => `- ${a.ok ? '✅' : '❌'} ${a.label}`).join('\n');
      stored = `${stored}\n\n**Changes made in Studio**\n${lines}`.trim();
    }
    // Keep partial text from a stopped stream — a half answer is usually still
    // worth reading, and binning it wastes tokens the user already paid for.
    if (stored) store.appendMessage(conversationId, { role: 'assistant', content: stored });
    return { ok: true, ...result, text: stored, title: store.getConversation(conversationId).title };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  } finally {
    activeConversation = null;
  }
});

ipcMain.handle('chat:stop', () => claude.abort() || claudecode.abort() || compat.abort());


function friendlyError(err) {
  if (!err) return 'Unknown error.';

  // The OpenAI-compatible engine already words its own failures — an
  // unreachable Ollama needs "start Ollama", not "check your API key".
  if (err.offline) return err.message;

  // The SDK's .message on a 4xx is the raw JSON body. Dig out the human part
  // so the user gets a sentence rather than a wall of braces.
  const apiMessage = (err.error && err.error.error && err.error.error.message)
    || String(err.message || err);

  if (/credit balance is too low/i.test(apiMessage)) {
    return 'Your Anthropic API account is out of credit, so Claude could not be reached. '
      + 'Add credits at console.anthropic.com under Plans & Billing. This is pay-as-you-go '
      + 'API billing — a Claude Pro or Max subscription does not fund it. '
      + 'Anything already built in your place is untouched; top up and ask me to carry on.';
  }
  if (err.status === 401) return 'Your API key was rejected. Re-enter it in settings.';
  if (err.status === 403) return 'That API key is not allowed to use this model.';
  if (err.status === 429) return 'Rate limited by the API. Wait a moment and try again.';
  if (err.status === 529 || err.status >= 500) return 'The API is having trouble right now. Try again shortly.';
  if (err.name === 'APIConnectionError') return 'Could not reach the API — check your connection.';
  if (err.status === 400) return apiMessage;
  return apiMessage;
}

// --- Studio bridge -------------------------------------------------------

ipcMain.handle('studio:status', () => studioState());
ipcMain.handle('studio:insert', (_e, job) => bridge.enqueueScript(job));

/**
 * Insert a catalog asset by id. Unlike a script insert this waits for Studio's
 * answer: half of these fail for reasons only the user can fix (the asset is
 * private, the id was a bundle), and "sent" would be a lie.
 */
ipcMain.handle('studio:insert-asset', async (_e, { assetId, path, assetKind }) => {
  if (!bridge.isConnected()) {
    return { ok: false, error: 'Roblox Studio is not connected — open it and click the Bloxwright button on the Plugins tab.' };
  }
  const status = bridge.status();
  if ((status.pluginVersion || 1) < PLUGIN_PROTOCOL) {
    return { ok: false, error: 'Studio is running an older Bloxwright plugin that cannot insert assets. Reinstall it from Settings and restart Studio.' };
  }
  return bridge.runJob({
    kind: 'asset',
    assetId: Number(assetId),
    path: path || 'Workspace',
    assetKind: assetKind || null,
  });
});

// Where Studio looks for local plugins on Windows.
function studioPluginsDir() {
  const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(local, 'Roblox', 'Plugins');
}

const PLUGIN_FILE = 'Bloxwright.server.lua';
/** What this app was called before. Its plugin polls the same port, so leaving
 *  one behind means two plugins racing for the same jobs — half the inserts
 *  would vanish into a Studio window that isn't the one you're looking at. */
const LEGACY_PLUGIN_FILES = ['RoForge.server.lua'];
const bundledPlugin = () => path.join(__dirname, 'plugin', PLUGIN_FILE);

/** Remove plugins this app installed under a previous name. Ours to clean up;
 *  anything we didn't put there is left alone. */
function removeLegacyPlugins() {
  for (const name of LEGACY_PLUGIN_FILES) {
    const stale = path.join(studioPluginsDir(), name);
    try {
      if (!fs.existsSync(stale)) continue;
      fs.unlinkSync(stale);
      console.log(`[bloxwright] removed the old ${name} — restart Studio to unload it`);
    } catch (err) {
      console.error(`[bloxwright] could not remove ${name}`, err);
    }
  }
}

/**
 * Keep an already-installed plugin in step with the app. Only ever *updates* a
 * copy that's already there — installing one unasked would be putting code in
 * someone's Studio without being invited.
 */
function refreshInstalledPlugin() {
  const dest = path.join(studioPluginsDir(), PLUGIN_FILE);
  try {
    if (!fs.existsSync(dest)) return;
    const bundled = fs.readFileSync(bundledPlugin());
    if (fs.readFileSync(dest).equals(bundled)) return;
    fs.writeFileSync(dest, bundled);
    console.log('[bloxwright] updated the installed Studio plugin — restart Studio to load it');
  } catch (err) {
    console.error('[bloxwright] could not refresh the Studio plugin', err);
  }
}

/**
 * Copy the bundled plugin into Studio's plugins folder. Reading through
 * fs works inside the packaged asar; copyFile does not reliably, so this
 * reads then writes.
 */
ipcMain.handle('studio:install-plugin', () => {
  const source = bundledPlugin();
  const dir = studioPluginsDir();
  const dest = path.join(dir, PLUGIN_FILE);
  try {
    const contents = fs.readFileSync(source);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, contents);
    removeLegacyPlugins();
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), path: dest };
  }
});

ipcMain.handle('studio:open-plugins-folder', () => {
  const dir = studioPluginsDir();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});
