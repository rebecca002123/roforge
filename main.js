'use strict';

// Bloxwright — a Roblox coding companion that sits next to Studio.
//
// Three moving parts: this process owns the window and the Anthropic calls,
// src/bridge.js runs a localhost server that the Studio plugin polls, and the
// renderer is a plain HTML/CSS/JS chat UI.

const { app, BrowserWindow, ipcMain, globalShortcut, shell, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const store = require('./src/store');
const claude = require('./src/claude');
const bridge = require('./src/bridge');
const studioDetect = require('./src/studio-detect');
const claudecode = require('./src/claudecode');
const setup = require('./src/setup');
const compat = require('./src/openai');

let win = null;

// --- startup diagnostics -------------------------------------------------
//
// This app gets handed to other people as an .exe, and a packaged Electron app
// that fails before its window exists fails *invisibly*: no terminal, no error
// dialog, just a process in Task Manager or nothing at all. "It doesn't open"
// is then unreportable and undebuggable. Everything in this section exists so
// that every startup failure leaves either a visible message or a log file the
// user can send back.

const LOG_FILE = path.join(app.getPath('userData'), 'startup.log');
/** Written after a GPU crash so the next launch skips hardware acceleration. */
const SAFE_MODE_FILE = path.join(app.getPath('userData'), 'safe-mode');

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* the log is a convenience, never a reason to fail */ }
  console.log(line.trim());
}

/** A failure the user has to be told about — they can't see the console. */
function fatal(stage, err) {
  const detail = (err && err.stack) || String(err);
  logLine(`FATAL during ${stage}: ${detail}`);
  try {
    dialog.showErrorBox(
      'Bloxwright could not start',
      `Something failed while starting up (${stage}).\n\n${detail}\n\n`
      + `A log was written to:\n${LOG_FILE}\n\nSend that file over and it can be fixed.`,
    );
  } catch { /* pre-ready, or no display — the log still has it */ }
}

// Nothing below the window creation is allowed to take the app down silently.
process.on('uncaughtException', (err) => fatal('an unexpected error', err));
process.on('unhandledRejection', (err) => logLine(`unhandled rejection: ${(err && err.stack) || err}`));

// Hardware acceleration must be turned off before the app is ready, so the
// decision is made from a marker file left by a previous crashed launch.
const safeMode = process.argv.includes('--safe') || fs.existsSync(SAFE_MODE_FILE);
if (safeMode) {
  app.disableHardwareAcceleration();
  logLine('starting in safe mode (hardware acceleration disabled)');
}

logLine(`launch: v${app.getVersion()} electron ${process.versions.electron} on ${os.platform()} ${os.release()}`);

/** Set once the window has actually been on screen, and once we're shutting
 *  down: a process being torn down reports its renderer as "crashed" too, and
 *  neither of those is the failure this recovery is for. */
let windowEverShown = false;
let quitting = false;
app.on('before-quit', () => { quitting = true; });

/**
 * A GPU process that dies takes the window with it and leaves the app running
 * with nothing on screen — the exact "it installed but never opens" report.
 * Restart once without hardware acceleration rather than sitting there blank.
 */
function recoverWithSafeMode(reason) {
  if (quitting) return;
  if (windowEverShown) {
    // The app opened fine, so hardware acceleration is not the problem and
    // relaunching would only throw away whatever the user was in the middle of.
    logLine(`${reason}, but the app had already opened — not relaunching`);
    return;
  }
  if (safeMode) { // already tried; a second relaunch would just loop
    fatal('rendering', new Error(`${reason} even with hardware acceleration disabled`));
    return;
  }
  logLine(`${reason} — relaunching in safe mode`);
  try { fs.writeFileSync(SAFE_MODE_FILE, `${new Date().toISOString()} ${reason}\n`); } catch { /* best effort */ }
  app.relaunch();
  app.exit(0);
}

app.on('child-process-gone', (_e, details) => {
  logLine(`child process gone: ${details.type} (${details.reason})`);
  if (details.type === 'GPU' && details.reason !== 'clean-exit') recoverWithSafeMode('the GPU process crashed');
});

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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((err) => fatal('loading the interface', err));

  // `show: false` avoids a flash of empty window, but it means a renderer that
  // never becomes ready leaves a running app with nothing on screen. Show it
  // either way — a half-painted window is still something the user can act on,
  // and it is infinitely better than an invisible one.
  let shown = false;
  const reveal = (why) => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;
    windowEverShown = true;
    logLine(`showing the window (${why})`);
    win.show();
    if (store.settings().alwaysOnTop) win.setAlwaysOnTop(true);
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  setTimeout(() => reveal('fallback timer — the renderer never reported ready'), 5000);

  win.webContents.on('did-fail-load', (_e, code, description) => {
    logLine(`the interface failed to load: ${description} (${code})`);
    reveal('load failed');
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logLine(`render process gone: ${details.reason}`);
    if (details.reason === 'crashed' || details.reason === 'oom') recoverWithSafeMode('the window crashed');
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

/** Run a startup step that must never be able to stop the window appearing. */
function step(name, fn) {
  try {
    return fn();
  } catch (err) {
    logLine(`startup step "${name}" failed: ${(err && err.stack) || err}`);
    return null;
  }
}

app.whenReady().then(async () => {
  // The window comes first. Everything after it is optional groundwork — the
  // Studio bridge, the plugin, the MCP config — and none of it is a reason for
  // the user to be left staring at a taskbar icon that does nothing.
  try {
    createWindow();
  } catch (err) {
    fatal('opening the window', err);
    return;
  }

  const s = step('read settings', () => store.settings()) || {};

  const started = await bridge.start(s.bridgePort).catch((err) => ({ ok: false, error: String(err) }));
  if (!started.ok) logLine(`the Studio bridge failed to start: ${started.error}`);

  bridge.emitter.on('status', async () => pushToRenderer('studio:status', await studioState()));
  bridge.emitter.on('result', (r) => pushToRenderer('studio:result', r));

  // Written at startup, not just per turn, so the config is always on disk for
  // inspection and so a manual `claude --mcp-config` run works too.
  step('write the MCP config', () => claudecode.writeMcpConfig(__dirname, process.execPath));

  step('remove legacy plugins', removeLegacyPlugins);
  step('refresh the Studio plugin', refreshInstalledPlugin);

  // Summon the window without reaching for the taskbar mid-build. Another app
  // may already own this combination, which is not worth failing over.
  step('register the shortcut', () => {
    const ok = globalShortcut.register('Control+Alt+B', () => {
      if (!win) return createWindow();
      if (win.isVisible() && win.isFocused()) win.hide();
      else { win.show(); win.focus(); }
    });
    if (!ok) logLine('Ctrl+Alt+B is taken by another app — the shortcut is unavailable');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // The safe-mode marker deliberately stays put once set. Clearing it here
  // would mean a machine whose GPU crashes every launch does the crash-and-
  // relaunch dance forever; software rendering is a little slower and always
  // opens. Delete the file to try the GPU again.
  if (safeMode) logLine(`still in safe mode — delete ${SAFE_MODE_FILE} to re-enable the GPU`);

  logLine('startup complete');
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

// --- first-run setup ------------------------------------------------------

ipcMain.handle('setup:status', () => setup.status());

ipcMain.handle('setup:install', async () => {
  const res = await setup.installClaudeCode((line) => pushToRenderer('setup:progress', line));
  return { ...res, status: setup.status() };
});

ipcMain.handle('setup:login', () => {
  const res = setup.startLogin();
  return { ...res, status: setup.status() };
});

ipcMain.handle('setup:open-docs', () => {
  shell.openExternal(setup.INSTALL_DOCS);
  return { ok: true };
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

  // Both halves matter and they fail differently: no CLI is something the app
  // can fix in a click, no login is something only the user can do. Answering
  // with a code rather than a sentence lets the renderer open the right one.
  if (engine === 'claude-code') {
    const st = setup.status();
    if (!st.installed) return { ok: false, error: 'needs-setup', stage: 'install' };
    if (!st.loggedIn) return { ok: false, error: 'needs-setup', stage: 'login' };
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
