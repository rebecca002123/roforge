'use strict';

// The hands. In build mode Claude doesn't hand you code to paste — it calls
// these, they run inside your open place, and the result comes back so it can
// decide what to do next.
//
// Kept deliberately small: five verbs cover building a game (scripts, objects,
// tweaking objects, removing objects, looking at what's there). A bigger tool
// surface would mostly be more ways to get the same job wrong.

const bridge = require('./bridge');

const PROPERTY_HELP = `Property values are JSON. Roblox datatypes use a tagged object:
  Vector3   {"$t":"Vector3","x":4,"y":1,"z":4}
  Color3    {"$t":"Color3","r":0.9,"g":0.2,"b":0.2}   (components 0-1)
  BrickColor{"$t":"BrickColor","name":"Bright red"}
  CFrame    {"$t":"CFrame","x":0,"y":10,"z":0}
  UDim2     {"$t":"UDim2","xs":0.5,"xo":0,"ys":0.5,"yo":0}
  Enum      {"$t":"Enum","enum":"Material","value":"Neon"}
Plain strings, numbers and booleans are used as-is.`;

const PATH_HELP = `A path from a place container, e.g. "ServerScriptService/Systems/RoundService",
"ReplicatedStorage/Remotes/BuyBlob" or "Workspace/Arena/SpawnPad". Missing
folders in the middle are created for you. Valid roots: Workspace,
ServerScriptService, ServerStorage, ReplicatedStorage, ReplicatedFirst,
StarterGui, StarterPack, StarterPlayer, Lighting, SoundService, Teams.`;

const TOOLS = [
  {
    name: 'create_script',
    description:
      'Create or overwrite a script in the open place. If a script already exists at that path it is updated in place rather than duplicated. This is how you write all game code.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        script_type: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Server Script, client LocalScript, or shared ModuleScript.',
        },
        source: { type: 'string', description: 'The complete Luau source. Never a fragment.' },
      },
      required: ['path', 'script_type', 'source'],
    },
  },
  {
    name: 'create_instance',
    description:
      'Create a non-script instance — Part, Folder, RemoteEvent, ScreenGui, TextButton, Sound, SpawnLocation, Attachment, ProximityPrompt, and so on. If something already exists at the path with the same ClassName, its properties are updated instead.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HELP },
        class_name: { type: 'string', description: 'Roblox ClassName, e.g. "Part", "RemoteEvent", "ScreenGui".' },
        properties: { type: 'object', description: `Properties to set. ${PROPERTY_HELP}` },
      },
      required: ['path', 'class_name'],
    },
  },
  {
    name: 'set_properties',
    description: 'Change properties on an instance that already exists.',
    input_schema: {
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
    description:
      'Delete one instance and its children. Use sparingly — for clearing away something you created by mistake, or a default object the game replaces. Services themselves cannot be deleted.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: PATH_HELP } },
      required: ['path'],
    },
  },
  {
    name: 'list_tree',
    description:
      "Look at what's actually in the place under a path — names and ClassNames. Use it to check your work landed, to find existing objects before assuming, and to read the layout before changing it.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Container path, e.g. "Workspace" or "ReplicatedStorage/Remotes".' },
        depth: { type: 'integer', description: 'How many levels down to walk. Default 2, max 4.' },
      },
      required: ['path'],
    },
  },
];

/** Map a tool call onto a bridge job and summarise the outcome for the model. */
async function execute(name, input) {
  switch (name) {
    case 'create_script':
      return bridge.runJob({
        kind: 'script',
        path: input.path,
        type: input.script_type,
        source: input.source,
      });
    case 'create_instance':
      return bridge.runJob({
        kind: 'instance',
        path: input.path,
        className: input.class_name,
        properties: input.properties || {},
      });
    case 'set_properties':
      return bridge.runJob({ kind: 'properties', path: input.path, properties: input.properties || {} });
    case 'delete_instance':
      return bridge.runJob({ kind: 'delete', path: input.path });
    case 'list_tree':
      return bridge.runJob({ kind: 'tree', path: input.path, depth: Math.min(Number(input.depth) || 2, 4) });
    default:
      return { ok: false, error: `Unknown tool "${name}".` };
  }
}

/** What goes back to the model as the tool_result body. */
function resultText(result) {
  if (!result.ok) return `FAILED: ${result.error || 'unknown error'}`;
  if (result.data) return `OK. ${result.message || ''}\n${JSON.stringify(result.data)}`.trim();
  return `OK. ${result.message || 'done'}`;
}

/** A short human-readable line for the transcript. */
function describe(name, input) {
  switch (name) {
    case 'create_script': return `${input.script_type} → ${input.path}`;
    case 'create_instance': return `${input.class_name} → ${input.path}`;
    case 'set_properties': return `set properties on ${input.path}`;
    case 'delete_instance': return `delete ${input.path}`;
    case 'list_tree': return `read ${input.path}`;
    default: return name;
  }
}

module.exports = { TOOLS, execute, resultText, describe };
