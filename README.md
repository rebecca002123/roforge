# RoForge

A Roblox coding companion for Windows. It's a chat window you talk to the same
way you'd talk to Claude — except it only ever thinks about Roblox, and it can
drop the scripts it writes straight into your open place in Studio.

It's a normal installed Windows app: launch it from the Start Menu or the
desktop shortcut. No terminal involved.

## What it runs on

Three options, in Settings under **Runs on**:

- **Your Claude subscription** (default) — RoForge drives the Claude Code CLI
  already installed on this PC, so there are no per-token API charges. The
  Studio tools reach it through an MCP server (`mcp/server.js`) that proxies to
  the app's local bridge, so build mode works exactly the same way.
- **Anthropic API key** — calls the API directly with your own key, billed as
  pay-as-you-go credits. A Claude Pro/Max subscription does *not* fund this;
  it's a separate balance at console.anthropic.com. The key is encrypted with
  Windows DPAPI and never leaves the machine except in requests to Anthropic.
- **Any other model** — anything speaking the OpenAI chat-completions API
  (`src/openai.js`), which is what makes RoForge usable with no Anthropic
  account at all. Presets for **Ollama** (models on your own PC: free, offline,
  no key), **OpenRouter**, **Groq** and **Google Gemini** (all with free
  tiers), plus a custom address for LM Studio, llama.cpp, vLLM or a company
  gateway. Settings asks the endpoint which models it has rather than making
  you type an id.

The `effort` setting only applies on the API path; Claude Code manages its own,
and OpenAI-compatible servers have no equivalent.

Build mode leans on the model handling multi-step tool use. Claude and the
larger hosted models manage it; a small local model will usually write a script
or two and then lose the thread. Ordinary chat is fine on anything.

## Installing / rebuilding

```
npm install
npm run dist     # builds dist/RoForge-Setup-<version>.exe
```

Run that installer and RoForge lands in
`%LOCALAPPDATA%\Programs\RoForge` with desktop and Start Menu shortcuts, plus
an entry in Add or Remove Programs. It's a per-user install, so it never asks
for admin. Your key and chat history live in `%APPDATA%\RoForge` and survive
reinstalls and upgrades.

`npm start` still runs it straight from source when you're changing the code.

> **Build gotcha on Windows:** electron-builder's signing bundle contains macOS
> symlinks, which Windows refuses to create without Developer Mode, and the
> build fails while extracting it. Since we don't code-sign, seed the cache
> without the macOS half once and the build works from then on:
>
> ```
> cd %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
> 7za x -snld -y <any>.7z -owinCodeSign-2.6.0 -xr!darwin
> ```

## Build mode

Toggle **Build in Studio** next to the composer, ask for a game, and it builds
it — no clicking, no pasting. Claude gets five tools that run inside your open
place: `create_script`, `create_instance`, `set_properties`, `delete_instance`
and `list_tree`. It looks at what's there, plans, builds in dependency order,
reads the place back to check its work, then reports.

Each action appears in the transcript as it happens, so a long build isn't a
blank wait, and every one is a single `Ctrl+Z` in Studio.

It's told to build a *playable* thing rather than a pile of scripts: server
logic, remotes with validated arguments, leaderstats, actual geometry to stand
on, a ScreenGui where one is needed. Smallest complete version first, depth
after.

Build mode needs Studio connected and running a current plugin — the app checks
the plugin's protocol version and will tell you to restart Studio rather than
half-build against an old one. Turn the toggle off to go back to ordinary chat
where you insert code yourself.

## What it is

- **A Roblox specialist, not a general chatbot.** The system prompt is a
  Roblox engineer: modern Luau (`task.wait`, typed modules, no deprecated
  globals), the client/server boundary, remotes, DataStores, replication, and
  the debugging habits that go with them. It writes whole files, never
  fragments, because a half script is a broken script.
- **Model:** Claude Opus 5, streaming, extra-high effort by default (tune it in
  Settings — lower effort is faster and cheaper for quick questions).
- **Live Studio context.** When the plugin is connected, the assistant knows
  your place name, what you've selected in the Explorer, and which scripts
  already exist — so it targets real containers instead of invented ones.
- **Send to Studio.** Every complete script comes tagged with where it belongs
  (`ServerScriptService/CoinService`, `ModuleScript`). One click inserts it,
  as a single undoable action.

Press `Ctrl+Alt+R` anywhere to show or hide the window. It opens down the
right-hand side of the screen, sized to sit beside Studio rather than over it.

## Connecting Roblox Studio

1. Settings → **Install plugin into Roblox Studio**. It copies the plugin into
   `%LOCALAPPDATA%\Roblox\Plugins` for you.
2. Restart Studio, then click the **RoForge** button on the Plugins tab.

The chip in the title bar turns green and shows your place name.

Studio will ask for two permissions the first time:

- **Script injection** — required. Without it the plugin can create a script
  but not write its source.
- **HTTP requests** — if the plugin logs that it can't reach the app, enable
  *Allow HTTP Requests* under Game Settings → Security.

### How the connection works

Nothing can dial into Studio from outside, so the plugin polls instead: every
3 seconds it POSTs a small snapshot of the place to `127.0.0.1:8095` and
collects any pending inserts. The server is bound to loopback only — it accepts
instructions to write scripts into your game, so it has no business being
reachable from the network.

Placement rules the plugin enforces:

- Only real place containers (`ServerScriptService`, `ReplicatedStorage`,
  `StarterPlayer`, …) are accepted; anything else is refused rather than
  guessed at. Missing intermediate folders are created.
- `path=selection` puts the script inside whatever you have selected.
- An existing script of the same name is **updated**, not duplicated. If the
  class changed (a `LocalScript` where a `Script` belongs) it's replaced —
  leaving the wrong class in place would just silently never run.
- Every insert is one `Ctrl+Z`.

## Layout

```
build-icon.js        draws build/icon.png from scratch (no image deps)
main.js              window, IPC, app lifecycle
preload.js           the renderer's only door to the main process
src/prompt.js        the Roblox system prompt — the actual product
src/claude.js        streaming Anthropic calls, abort, key verification
src/claudecode.js    the same, driven through the local Claude Code CLI
src/openai.js        any OpenAI-compatible server (Ollama, OpenRouter, …)
src/bridge.js        localhost server the Studio plugin polls
src/store.js         conversations + encrypted key on disk
renderer/            chat UI, markdown + Luau highlighting
plugin/              the Studio-side Luau plugin
```

## Notes

- Requests opt into server-side fallbacks, so if Opus 5's safety classifiers
  decline a prompt the API re-serves it on the recommended model instead of
  handing you a dead turn. If your account doesn't have that beta, the app
  quietly retries without it rather than failing the message.
- Conversation history is capped at the last 40 turns per request, so a
  long-running chat doesn't quietly get expensive to continue.
- Stopping a stream keeps whatever had already arrived — a partial answer is
  usually still worth reading, and you paid for those tokens.
