'use strict';

// The Studio bridge. Roblox Studio plugins can make outbound HTTP requests but
// nothing can dial *into* Studio, so the plugin long-polls us: every tick it
// POSTs a snapshot of the open place and collects any pending jobs.
//
// Bound to 127.0.0.1 only — this accepts instructions to write scripts into
// the user's game, and there is no reason for it to be reachable from the LAN.

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const emitter = new EventEmitter();

// Jobs submitted over HTTP (by the MCP server, when Claude Code is doing the
// building) must prove they came from us. The plugin's own endpoints don't
// need this — they only ever read the queue — but /job writes code into the
// user's game, and "it's only on localhost" is not an access control policy.
const JOB_TOKEN = crypto.randomBytes(24).toString('hex');

let server = null;
let port = 8095;

/** Jobs waiting for the plugin to collect. */
let queue = [];
/** Jobs handed out but not yet acknowledged, so we can report failures. */
const inFlight = new Map();
/** Jobs whose caller is awaiting a result (the agent's tool calls). */
const waiting = new Map();

const JOB_TIMEOUT_MS = 45000;

/** Last snapshot the plugin sent us, and when. */
let snapshot = null;
let lastSeen = 0;

const CONNECTED_WINDOW_MS = 8000; // two missed polls at the plugin's 3s cadence

function isConnected() {
  return Date.now() - lastSeen < CONNECTED_WINDOW_MS;
}

function status() {
  return {
    connected: isConnected(),
    port,
    place: snapshot ? snapshot.place : null,
    pluginVersion: snapshot ? snapshot.version : null,
    selection: snapshot ? snapshot.selection : [],
    pending: queue.length + inFlight.size,
  };
}

let jobSeq = 0;
function newId() {
  jobSeq += 1;
  return `j${Date.now().toString(36)}${jobSeq}`;
}

/**
 * Queue a script for insertion, fire-and-forget. Used by the manual
 * "Send to Studio" button, which reports via the `result` event.
 */
function enqueueScript({ path, type, source }) {
  const job = {
    id: newId(),
    kind: 'script',
    path: String(path || 'ServerScriptService/BloxwrightScript'),
    type: String(type || 'Script'),
    source: String(source || ''),
  };
  queue.push(job);
  emitter.emit('status', status());
  return job;
}

/**
 * Queue a job and wait for Studio to report back. This is what turns the
 * bridge into something an agent can act through: the model needs to know
 * whether its last edit landed before deciding what to do next.
 */
function runJob(job) {
  return new Promise((resolve) => {
    if (!isConnected()) {
      resolve({ ok: false, error: 'Roblox Studio is not connected to Bloxwright.' });
      return;
    }
    const id = newId();
    const timer = setTimeout(() => {
      waiting.delete(id);
      inFlight.delete(id);
      resolve({ ok: false, error: 'Studio did not respond within 45 seconds.' });
    }, JOB_TIMEOUT_MS);

    waiting.set(id, { resolve, timer });
    queue.push({ ...job, id });
    emitter.emit('status', status());
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) { data = ''; req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/ping') {
    // Deliberately does NOT count as a heartbeat: /poll is the plugin's real
    // pulse, and anything else hitting this shouldn't be able to make the UI
    // claim Studio is connected.
    return send(res, 200, { ok: true, app: 'bloxwright' });
  }

  if (url.pathname === '/poll' && req.method === 'POST') {
    const body = await readBody(req);
    lastSeen = Date.now();
    snapshot = {
      version: Number(body.version) || 1,
      place: typeof body.place === 'string' ? body.place : null,
      selection: Array.isArray(body.selection) ? body.selection.slice(0, 20) : [],
      tree: Array.isArray(body.tree) ? body.tree.slice(0, 200) : [],
      at: lastSeen,
    };

    const jobs = queue;
    queue = [];
    for (const job of jobs) inFlight.set(job.id, job);
    emitter.emit('status', status());
    return send(res, 200, { jobs });
  }

  // Job submission from the MCP server, i.e. Claude Code acting on the place.
  if (url.pathname === '/job' && req.method === 'POST') {
    if (req.headers['x-bloxwright-token'] !== JOB_TOKEN) {
      return send(res, 403, { ok: false, error: 'bad token' });
    }
    const job = await readBody(req);
    emitter.emit('tool-start', job);
    const result = await runJob(job);
    emitter.emit('tool-end', { job, result });
    return send(res, 200, result);
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    const body = await readBody(req);
    lastSeen = Date.now();
    const job = inFlight.get(body.id);
    inFlight.delete(body.id);

    const result = {
      id: body.id,
      ok: Boolean(body.ok),
      error: body.error || null,
      message: body.message || null,
      data: body.data !== undefined ? body.data : null,
      path: body.path || (job && job.path) || null,
    };

    const pending = waiting.get(body.id);
    if (pending) {
      waiting.delete(body.id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    } else {
      // Only surface unawaited jobs as toasts; an agent's tool calls are
      // reported in the transcript instead.
      emitter.emit('result', result);
    }
    emitter.emit('status', status());
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not found' });
}

function start(desiredPort) {
  return new Promise((resolve) => {
    port = desiredPort || port;
    stop();
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[bridge]', err);
        try { send(res, 500, { error: String(err && err.message) }); } catch { /* socket gone */ }
      });
    });
    server.on('error', (err) => {
      console.error('[bridge] listen failed', err);
      emitter.emit('error', err);
      resolve({ ok: false, error: String(err.message) });
    });
    server.listen(port, '127.0.0.1', () => resolve({ ok: true, port }));
  });
}

function stop() {
  if (server) { try { server.close(); } catch { /* already closed */ } server = null; }
}

/**
 * A compact description of the open place for the model. Kept short on
 * purpose — this rides on every request, and a full instance dump would cost
 * more than it's worth.
 */
function contextBlock() {
  if (!isConnected() || !snapshot) return null;
  const lines = ['<studio_context>', 'Roblox Studio is connected. The user has this place open right now.'];
  if (snapshot.place) lines.push(`Place: ${snapshot.place}`);
  if (snapshot.selection.length) {
    lines.push('Currently selected in the Explorer:');
    for (const s of snapshot.selection) lines.push(`  - ${s.path} (${s.className})`);
  } else {
    lines.push('Nothing is selected in the Explorer.');
  }
  if (snapshot.tree.length) {
    lines.push('Existing scripts in the place:');
    for (const s of snapshot.tree) lines.push(`  - ${s.path} (${s.className})`);
  }
  lines.push('</studio_context>');
  return lines.join('\n');
}

module.exports = {
  start, stop, status, enqueueScript, runJob, contextBlock, emitter, isConnected,
  jobToken: () => JOB_TOKEN,
  jobPort: () => port,
};
