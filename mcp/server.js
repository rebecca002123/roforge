'use strict';

// An MCP server exposing RoForge's Studio tools, so the Claude Code CLI can
// build inside Roblox the same way the app's own agent loop does — and bill to
// the user's Claude subscription instead of API credits.
//
// Claude Code launches this as a subprocess and speaks JSON-RPC over stdio
// (one JSON object per line). It has no dependencies beyond node builtins so
// it can run under `ELECTRON_RUN_AS_NODE` inside the packaged app, with no
// system node install to rely on.
//
// It holds no state: every tool call is proxied to the RoForge app's local
// bridge, which owns the queue and the Studio connection.

const readline = require('readline');

const PORT = process.env.ROFORGE_PORT || '8095';
const TOKEN = process.env.ROFORGE_TOKEN || '';
const BASE = `http://127.0.0.1:${PORT}`;

const PROPERTY_HELP = `Roblox datatypes are tagged objects:
  Vector3 {"$t":"Vector3","x":4,"y":1,"z":4} · Color3 {"$t":"Color3","r":0.9,"g":0.2,"b":0.2}
  BrickColor {"$t":"BrickColor","name":"Bright red"} · CFrame {"$t":"CFrame","x":0,"y":10,"z":0}
  UDim2 {"$t":"UDim2","xs":0.5,"xo":0,"ys":0.5,"yo":0} · Enum {"$t":"Enum","enum":"Material","value":"Neon"}
Strings, numbers and booleans are used as-is.`;

const PATH_HELP = 'Path from a place container, e.g. "ServerScriptService/RoundService" or '
  + '"Workspace/Arena/Pad". Missing folders are created. Roots: Workspace, ServerScriptService, '
  + 'ServerStorage, ReplicatedStorage, ReplicatedFirst, StarterGui, StarterPack, StarterPlayer, '
  + 'Lighting, SoundService, Teams.';

const TOOLS = [
  {
    name: 'create_script',
    description: 'Create or overwrite a Luau script in the open Roblox place. Updates in place if one already exists at that path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        script_type: { type: 'string', enum: ['Script', 'LocalScript', 'ModuleScript'] },
        source: { type: 'string', description: 'The complete Luau source, never a fragment.' },
      },
      required: ['path', 'script_type', 'source'],
    },
  },
  {
    name: 'create_instance',
    description: 'Create a non-script instance in the place — Part, Folder, RemoteEvent, ScreenGui, Sound, SpawnLocation and so on.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        class_name: { type: 'string', description: 'Roblox ClassName, e.g. "Part".' },
        properties: { type: 'object', description: PROPERTY_HELP },
      },
      required: ['path', 'class_name'],
    },
  },
  {
    name: 'set_properties',
    description: 'Change properties on an instance that already exists in the place.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        properties: { type: 'object', description: PROPERTY_HELP },
      },
      required: ['path', 'properties'],
    },
  },
  {
    name: 'delete_instance',
    description: 'Delete one instance and its children from the place. Services cannot be deleted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: PATH_HELP } },
      required: ['path'],
    },
  },
  {
    name: 'list_tree',
    description: "Read what's actually in the place under a path — names and ClassNames. Use it to check your work landed.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Container path, e.g. "Workspace".' },
        depth: { type: 'integer', description: 'Levels to walk. Default 2, max 4.' },
      },
      required: ['path'],
    },
  },
];

const JOB_FOR_TOOL = {
  create_script: (i) => ({ kind: 'script', path: i.path, type: i.script_type, source: i.source }),
  create_instance: (i) => ({ kind: 'instance', path: i.path, className: i.class_name, properties: i.properties || {} }),
  set_properties: (i) => ({ kind: 'properties', path: i.path, properties: i.properties || {} }),
  delete_instance: (i) => ({ kind: 'delete', path: i.path }),
  list_tree: (i) => ({ kind: 'tree', path: i.path, depth: Math.min(Number(i.depth) || 2, 4) }),
};

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  if (id === undefined || id === null) return; // notification — nothing to answer
  write({ jsonrpc: '2.0', id, result });
}

async function runTool(name, input) {
  const build = JOB_FOR_TOOL[name];
  if (!build) return { ok: false, error: `Unknown tool "${name}".` };
  try {
    const res = await fetch(`${BASE}/job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roforge-token': TOKEN },
      body: JSON.stringify(build(input || {})),
    });
    if (!res.ok) return { ok: false, error: `RoForge rejected the job (HTTP ${res.status}).` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: `Could not reach the RoForge app on ${BASE}. Is it running?` };
  }
}

function toolText(result) {
  if (!result.ok) return `FAILED: ${result.error || 'unknown error'}`;
  if (result.data) return `OK. ${result.message || ''}\n${JSON.stringify(result.data)}`.trim();
  return `OK. ${result.message || 'done'}`;
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;

  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return; // not our problem to fix a malformed frame; stay alive
  }

  const { id, method, params } = request;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'roforge', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method && method.startsWith('notifications/')) return;

  if (method === 'tools/call') {
    const result = await runTool(params && params.name, params && params.arguments);
    return reply(id, {
      content: [{ type: 'text', text: toolText(result) }],
      isError: !result.ok,
    });
  }

  if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
