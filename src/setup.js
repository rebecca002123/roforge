'use strict';

// Getting a brand-new machine from "Bloxwright is installed" to "I can build"
// without a detour through the settings sheet.
//
// The claude-code engine needs two things: the CLI on disk, and credentials.
// The app deliberately does not install the CLI itself — that's a ~100MB
// download nobody asked for from a window they've just opened. It checks, and
// for the part it *can* do in one click — the login — it opens the door and
// waits. Whoever's Claude account answers the browser prompt is between them
// and Anthropic; the app only starts the flow.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claudecode = require('./claudecode');

let installing = null; // the in-flight install, so a double press can't start two

// The setup page, not the product page: someone who lands here has already
// decided — they need the install command, not the pitch. Deep-linked to the
// Windows section, because the page opens on macOS/Linux instructions and this
// app only ever ships to Windows.
const INSTALL_DOCS_BASE = 'https://docs.claude.com/en/docs/claude-code/setup';
const INSTALL_DOCS = process.platform === 'win32'
  ? `${INSTALL_DOCS_BASE}#set-up-on-windows`
  : INSTALL_DOCS_BASE;

let authCache = { at: 0, value: null }; // `auth status` costs a spawn; the card polls

/**
 * Ask the CLI whether it's signed in, since it's the thing that would know.
 *
 * `claude auth status` answers in JSON — logged in or not, which account, which
 * plan — so there's no guessing from the shape of a credentials file. It costs
 * a process, though, and the setup card polls every couple of seconds, so the
 * answer is held briefly. Older CLIs predate the subcommand; those fall back to
 * looking for the credentials file, which is where the answer used to live.
 */
function authStatus() {
  const now = Date.now();
  if (authCache.value && now - authCache.at < 4000) return authCache.value;

  let value = { loggedIn: false, account: null, plan: null };
  const cli = claudecode.findCli();
  try {
    const out = execFileSync(cli.command, ['auth', 'status'], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, shell: cli.shell,
    });
    const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    value = {
      loggedIn: Boolean(parsed.loggedIn),
      account: parsed.email || null,
      plan: parsed.subscriptionType || null,
    };
  } catch {
    value = { loggedIn: hasCredentialsFile(), account: null, plan: null };
  }

  authCache = { at: now, value };
  return value;
}

/** Where the answer lived before `auth status` existed. */
function hasCredentialsFile() {
  const home = os.homedir();
  return [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ].some((file) => {
    try { return fs.statSync(file).size > 0; } catch { return false; }
  });
}

function isLoggedIn() {
  return claudecode.isInstalled() && authStatus().loggedIn;
}

function status() {
  const installed = claudecode.isInstalled();
  const auth = installed ? authStatus() : { loggedIn: false, account: null, plan: null };
  return {
    installed,
    loggedIn: auth.loggedIn,
    ready: auth.loggedIn,
    account: auth.account,
    plan: auth.plan,
    path: installed ? claudecode.findCli().command : null,
    installing: Boolean(installing),
    installDocs: INSTALL_DOCS,
  };
}

/**
 * Pick up PATH changes an installer just made.
 *
 * Our own PATH was copied from whatever launched the app, so a CLI installed
 * thirty seconds ago is invisible to us until the app restarts — which would
 * make a successful install look like a failed one. Windows keeps the real
 * value in the registry, so go and read it back.
 */
function refreshPath() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')",
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const seen = new Set(String(process.env.PATH || '').split(path.delimiter));
    const added = out.split(path.delimiter).map((d) => d.trim()).filter((d) => d && !seen.has(d));
    if (added.length) process.env.PATH = `${process.env.PATH}${path.delimiter}${added.join(path.delimiter)}`;
  } catch { /* the check below is the real answer either way */ }
}

/**
 * Install Claude Code through winget.
 *
 * There is no installer file to hand someone — Anthropic ships this as a
 * command — so "go and download it" was never an instruction the app could
 * give. winget is the one route that's official, needs no admin rights, and
 * can be driven from here with its output on screen.
 */
function installClaudeCode(onProgress) {
  if (installing) return installing;
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'unsupported' });
  }

  installing = new Promise((resolve) => {
    const say = (text) => {
      const line = String(text).replace(/\s+/g, ' ').trim();
      if (line && onProgress) onProgress(line.slice(0, 160));
    };

    const child = spawn('winget', [
      'install', '--id', 'Anthropic.ClaudeCode', '--exact',
      '--accept-source-agreements', '--accept-package-agreements',
      '--disable-interactivity',
      // No shell: winget resolves fine through PATH on its own, and routing
      // fixed arguments through cmd.exe only earns a deprecation warning.
    ], { windowsHide: true });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); say(chunk.toString()); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    child.on('error', () => {
      installing = null;
      resolve({ ok: false, error: 'no-winget' });
    });

    child.on('close', () => {
      installing = null;
      refreshPath();
      // Trust the disk over the exit code: winget reports non-zero for things
      // like "already installed", which is a success as far as we're concerned.
      if (claudecode.isInstalled()) return resolve({ ok: true });
      if (/not recognized|no package found/i.test(output)) return resolve({ ok: false, error: 'no-winget' });
      resolve({ ok: false, error: 'install-failed' });
    });
  });

  return installing;
}

/**
 * Open the Claude login.
 *
 * `claude auth login` goes straight to signing in — launching the CLI bare
 * would drop someone into a chat session instead, which is a strange answer to
 * pressing Sign in. It needs a window they can see: a GUI app's children get no
 * console of their own on Windows, so `detached` is what makes it visible at
 * all. Without it the CLI sits there invisibly waiting for an answer nobody
 * can give.
 */
function startLogin() {
  if (!claudecode.isInstalled()) {
    return { ok: false, error: 'needs-cli' };
  }
  authCache = { at: 0, value: null }; // whatever happens next, re-ask afterwards
  const cli = claudecode.findCli();
  try {
    const child = spawn(cli.command, ['auth', 'login'], {
      detached: true,
      stdio: 'ignore',
      shell: cli.shell,
      windowsHide: false,
      cwd: os.homedir(),
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { status, isLoggedIn, installClaudeCode, startLogin, INSTALL_DOCS };
