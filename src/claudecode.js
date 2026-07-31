'use strict';

// The subscription route. Instead of calling the Anthropic API with a key
// (pay-as-you-go credits), drive the Claude Code CLI already installed on this
// machine, which runs on the user's Claude subscription.
//
// Studio tools reach it through MCP: we write a config pointing at
// mcp/server.js, and Claude Code calls those tools exactly as the app's own
// agent loop would.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bridge = require('./bridge');
const { CORE, BUILD_MODE } = require('./prompt');

const TOOL_NAMES = [
  'create_script', 'create_instance', 'set_properties', 'delete_instance', 'list_tree',
].map((t) => `mcp__bloxwright__${t}`);

let child = null;

/**
 * Where npm put the CLI.
 *
 * Strongly prefer the native `claude.exe` over the `claude.cmd` shim: a .cmd
 * has to go through cmd.exe, whose command line caps at 8191 characters, and
 * the Roblox system prompt alone blows past that ("The command line is too
 * long."). Spawned directly, the limit is CreateProcess's 32767.
 */
function findCli() {
  const home = os.homedir();
  const candidates = [
    { command: path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), shell: false },
    { command: path.join(home, 'AppData', 'Local', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), shell: false },
    { command: path.join(home, '.local', 'bin', 'claude.exe'), shell: false },
    { command: path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'), shell: true },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.command)) return candidate;
  }
  return { command: 'claude', shell: false }; // let PATH resolve it
}

function isInstalled() {
  const cli = findCli();
  return cli.command === 'claude' ? true : fs.existsSync(cli.command);
}

/**
 * A scratch directory to run Claude Code in. Without this it would inherit the
 * app's working directory — the install folder — and any file it touched would
 * land there.
 */
function workspaceDir() {
  const dir = path.join(os.tmpdir(), 'bloxwright-workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The MCP config handed to Claude Code. The server runs under the packaged
 * app's own Electron binary in node mode, so there's no dependency on a system
 * node install.
 */
function writeMcpConfig(appDir, execPath) {
  const serverScript = path.join(appDir, 'mcp', 'server.js').replace('app.asar', 'app.asar.unpacked');
  const config = {
    mcpServers: {
      bloxwright: {
        command: execPath,
        args: [serverScript],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          BLOXWRIGHT_PORT: String(bridge.jobPort()),
          BLOXWRIGHT_TOKEN: bridge.jobToken(),
        },
      },
    },
  };
  const file = path.join(os.tmpdir(), 'bloxwright-mcp.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/**
 * Run one turn through Claude Code.
 *
 * @returns {Promise<{text, actions, sessionId, aborted}>}
 */
function send({ prompt, sessionId, buildMode, studioContext, appDir, execPath, onEvent }) {
  return new Promise((resolve, reject) => {
    const cli = findCli();
    const mcpConfig = writeMcpConfig(appDir, execPath);

    // Claude Code has its own system prompt (it's a coding agent); ours is
    // appended so it knows Roblox, and in build mode, that it has hands.
    const extraPrompt = buildMode
      ? `${CORE}\n\n${BUILD_MODE}\n\nYour Studio tools are the mcp__bloxwright__* tools.`
      : `${CORE}\n\nYou are answering in a chat window, not editing files on disk.`;

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'opus',
      '--append-system-prompt', extraPrompt,
      '--mcp-config', mcpConfig,
      '--permission-mode', 'acceptEdits',
    ];
    if (buildMode) args.push('--allowedTools', TOOL_NAMES.join(','));
    // Without a session to resume, Claude Code starts fresh; with one, the
    // conversation carries over exactly as it would in the terminal.
    if (sessionId) args.push('--resume', sessionId);

    const argLength = args.join(' ').length;
    if (argLength > 30000) {
      // Shouldn't happen with the static prompt, but a silent truncation by
      // Windows would be far more confusing than an honest failure.
      return reject(new Error(`Prompt too large to launch Claude Code (${argLength} characters).`));
    }

    child = spawn(cli.command, args, {
      shell: cli.shell,
      cwd: workspaceDir(),
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    onEvent({ type: 'status', text: 'Starting Claude Code…' });

    let text = '';
    let newSessionId = sessionId || null;
    const actions = [];
    let stderr = '';
    let buffer = '';
    let aborted = false;
    let announced = false;

    // Studio context rides in on stdin rather than as an argument: stdin has
    // no length limit, and the place snapshot grows with the user's game.
    child.stdin.write(studioContext ? `${studioContext}

${prompt}` : prompt);
    child.stdin.end();

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === 'system' && event.session_id) {
          newSessionId = event.session_id;
          // Only once: later system events would otherwise stamp "Thinking…"
          // over whatever the model is actually doing right now.
          if (!announced) { announced = true; onEvent({ type: 'status', text: 'Thinking…' }); }
        } else if (event.type === 'stream_event' && event.event) {
          const inner = event.event;
          if (inner.type === 'content_block_delta' && inner.delta) {
            if (inner.delta.type === 'text_delta') {
              text += inner.delta.text;
              onEvent({ type: 'text', text: inner.delta.text });
            } else if (inner.delta.type === 'thinking_delta') {
              onEvent({ type: 'thinking', text: inner.delta.thinking });
            }
          }
        } else if (event.type === 'assistant' && event.message) {
          for (const block of event.message.content || []) {
            if (block.type !== 'tool_use') continue;
            const label = describeCall(block.name, block.input || {});
            // Every tool, not just the Studio ones — Claude Code spends much of
            // a build reading and planning with its own tools, and hiding that
            // makes a working agent look like a hung one.
            if (String(block.name).startsWith('mcp__bloxwright__')) {
              actions.push({ label, ok: true });
            }
            onEvent({ type: 'tool-start', id: block.id, label });
          }
        } else if (event.type === 'user' && event.message) {
          for (const block of event.message.content || []) {
            if (block.type !== 'tool_result') continue;
            const ok = !block.is_error;
            if (actions.length) actions[actions.length - 1].ok = ok;
            onEvent({ type: 'tool-end', id: block.tool_use_id, ok });
            onEvent({ type: 'status', text: 'Working…' });
          }
        } else if (event.type === 'result') {
          if (!text && typeof event.result === 'string') text = event.result;
        }
      }
    });

    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      child = null;
      reject(new Error(`Could not start Claude Code (${cli.command}): ${err.message}`));
    });

    child.on('close', (code) => {
      child = null;
      if (aborted) return resolve({ text, actions, sessionId: newSessionId, aborted: true });
      if (code !== 0 && !text) {
        return reject(new Error(stderr.trim() || `Claude Code exited with code ${code}.`));
      }
      resolve({ text, actions, sessionId: newSessionId, aborted: false });
    });
  });
}

const BUILTIN_LABELS = {
  Read: (i) => `read ${short(i.file_path)}`,
  Write: (i) => `write ${short(i.file_path)}`,
  Edit: (i) => `edit ${short(i.file_path)}`,
  Bash: (i) => `run ${String(i.command || '').slice(0, 48)}`,
  Glob: (i) => `find ${i.pattern || ''}`,
  Grep: (i) => `search ${i.pattern || ''}`,
  TodoWrite: () => 'update the plan',
  Task: (i) => `delegate: ${String(i.description || 'subtask').slice(0, 40)}`,
  WebSearch: (i) => `search the web: ${String(i.query || '').slice(0, 40)}`,
  WebFetch: (i) => `fetch ${short(i.url)}`,
};

function short(value) {
  const text = String(value || '');
  return text.length > 44 ? `…${text.slice(-43)}` : text;
}

function describeCall(name, input) {
  const raw = String(name);
  if (!raw.startsWith('mcp__bloxwright__')) {
    const builtin = BUILTIN_LABELS[raw];
    return builtin ? builtin(input || {}) : raw;
  }
  const tool = raw.replace('mcp__bloxwright__', '');
  switch (tool) {
    case 'create_script': return `${input.script_type || 'Script'} → ${input.path}`;
    case 'create_instance': return `${input.class_name} → ${input.path}`;
    case 'set_properties': return `set properties on ${input.path}`;
    case 'delete_instance': return `delete ${input.path}`;
    case 'list_tree': return `read ${input.path}`;
    default: return tool;
  }
}

function abort() {
  if (child) {
    // Windows needs the whole tree: `claude.cmd` is a shim, so killing it
    // leaves the actual node process running and the turn never ends.
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
      } else {
        child.kill();
      }
    } catch { /* already gone */ }
    child = null;
    return true;
  }
  return false;
}

module.exports = { send, abort, isInstalled, findCli, writeMcpConfig };
