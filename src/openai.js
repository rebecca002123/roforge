'use strict';

// The third engine: any server that speaks the OpenAI chat-completions API.
//
// This is what makes RoForge usable by someone with no Anthropic account at
// all. One protocol covers a lot of ground:
//
//   Ollama      — models running on their own PC. Free forever, no key, no
//                 account, works offline.
//   OpenRouter  — hundreds of hosted models behind one key, several of them
//                 free, the rest pay-as-you-go with no subscription.
//   Groq        — a generous free tier, and the fastest hosted inference going.
//   Gemini      — Google's free tier, via its OpenAI-compatible endpoint.
//   Custom      — anything else with a /v1/chat/completions.
//
// Deliberately written against `fetch` rather than the `openai` package: the
// wire format is small, and every provider bends it slightly differently, so
// having the parsing in view here is worth more than the SDK's convenience.
//
// The Anthropic path in src/claude.js is untouched by any of this.

const { buildSystem, BUILD_MODE } = require('./prompt');
const tools = require('./tools');

/** Ceiling on build-mode rounds, matching the Anthropic path. */
const MAX_TOOL_ROUNDS = 60;
const HISTORY_TURNS = 40;

/**
 * The presets the settings pane offers. `keyless` is the important flag: it's
 * what lets someone run this with no account anywhere.
 */
const PROVIDERS = {
  ollama: {
    label: 'Ollama — free, runs on this PC',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyless: true,
    hint: 'Install Ollama, run `ollama pull qwen2.5-coder:14b`, and pick the model below. Nothing leaves your machine and there is nothing to pay.',
  },
  openrouter: {
    label: 'OpenRouter — free & paid models, one key',
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: 'Free key at openrouter.ai/keys. Models ending in “:free” cost nothing; the rest are pay-as-you-go with no subscription.',
  },
  groq: {
    label: 'Groq — free tier, very fast',
    baseUrl: 'https://api.groq.com/openai/v1',
    hint: 'Free key at console.groq.com/keys. Daily limits apply, but no card is needed.',
  },
  gemini: {
    label: 'Google Gemini — free tier',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    hint: 'Free key at aistudio.google.com/apikey.',
  },
  custom: {
    label: 'Something else (OpenAI-compatible)',
    baseUrl: '',
    hint: 'Any server exposing /chat/completions — LM Studio, llama.cpp, vLLM, Together, DeepSeek, a company gateway.',
  },
};

let active = null; // in-flight AbortController, so Stop has something to hit

function trimUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function headers(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  // OpenRouter attributes requests by these; harmless everywhere else.
  h['http-referer'] = 'https://roforgeapp.github.io';
  h['x-title'] = 'RoForge';
  return h;
}

/**
 * Turn a failed response — or a dead socket — into something worth reading.
 * "fetch failed" in front of someone whose Ollama simply isn't running is a
 * dead end; naming the likely cause isn't.
 */
async function toError(res, baseUrl) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = (json.error && (json.error.message || json.error)) || json.message || body;
    } catch {
      detail = body;
    }
  } catch { /* body already consumed or empty */ }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);

  const err = new Error(detail.slice(0, 600) || `HTTP ${res.status}`);
  err.status = res.status;
  err.baseUrl = baseUrl;
  return err;
}

function networkError(err, baseUrl) {
  const local = /127\.0\.0\.1|localhost/.test(baseUrl);
  const wrapped = new Error(
    local
      ? `Nothing is answering on ${baseUrl}. If that's Ollama, start it (run \`ollama serve\`, or just open the Ollama app) and try again.`
      : `Could not reach ${baseUrl} — check the address and your connection.`,
  );
  wrapped.cause = err;
  wrapped.offline = true;
  return wrapped;
}

async function request(path, { baseUrl, apiKey, body, signal, method = 'POST' }) {
  const url = `${trimUrl(baseUrl)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: headers(apiKey),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw networkError(err, trimUrl(baseUrl));
  }
  if (!res.ok) throw await toError(res, trimUrl(baseUrl));
  return res;
}

// --- streaming -----------------------------------------------------------

/** Yield the payload of each `data:` line of an SSE body. */
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}

/**
 * Stream one assistant turn and accumulate whatever it produced: visible text,
 * reasoning (providers spell it two different ways), and tool calls.
 *
 * Tool-call arguments arrive as JSON fragments spread across deltas and keyed
 * by `index`, so they have to be stitched before they can be parsed.
 */
async function streamTurn({ baseUrl, apiKey, model, messages, toolDefs, showThinking, onEvent }) {
  const controller = new AbortController();
  active = controller;

  const body = {
    model,
    messages,
    stream: true,
  };
  if (toolDefs && toolDefs.length) body.tools = toolDefs;

  let res;
  try {
    res = await request('/chat/completions', { baseUrl, apiKey, body, signal: controller.signal });
  } catch (err) {
    active = null;
    throw err;
  }

  let text = '';
  let finishReason = null;
  let usage = null;
  let sawText = false;
  let sawThinking = false;
  const calls = new Map(); // index -> { id, name, args }

  try {
    for await (const data of sseData(res)) {
      if (!data || data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // a keep-alive comment or a truncated frame; nothing to do
      }
      if (chunk.usage) usage = chunk.usage;

      // Some gateways report errors mid-stream rather than as a failed request.
      if (chunk.error) {
        const err = new Error(chunk.error.message || String(chunk.error));
        err.status = chunk.error.status || 502;
        throw err;
      }

      const choice = (chunk.choices || [])[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      // Reasoning: `reasoning_content` on DeepSeek-style servers, `reasoning`
      // on OpenRouter. Both are optional and most models emit neither.
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning && showThinking) {
        if (!sawThinking) { sawThinking = true; onEvent({ type: 'thinking-start' }); }
        onEvent({ type: 'thinking', text: reasoning });
      }

      if (delta.content) {
        if (!sawText) { sawText = true; onEvent({ type: 'text-start' }); }
        text += delta.content;
        onEvent({ type: 'text', text: delta.content });
      }

      for (const tc of delta.tool_calls || []) {
        const idx = tc.index === undefined ? 0 : tc.index;
        const entry = calls.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function && tc.function.name) entry.name += tc.function.name;
        if (tc.function && tc.function.arguments) entry.args += tc.function.arguments;
        calls.set(idx, entry);
      }
    }
  } finally {
    active = null;
  }

  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, c], i) => ({ id: c.id || `call_${idx}_${i}`, name: c.name, args: c.args }));

  return { text, toolCalls, finishReason, usage };
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
}

/**
 * `buildSystem` returns Anthropic content blocks (it carries cache_control
 * markers). Chat-completions wants one plain string, so flatten it — the
 * prompt text is identical, only the envelope differs.
 */
function systemText(studioContext, mode) {
  return buildSystem(studioContext, mode)
    .map((b) => b.text)
    .filter(Boolean)
    .join('\n\n');
}

function toApiMessages(messages) {
  return messages
    .filter((m) => m.content && m.content.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Our Anthropic-shaped tool definitions, in OpenAI's clothing. */
function toolDefinitions() {
  return tools.TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** Arguments arrive as a JSON string, and small models do mangle it. */
function parseArgs(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Trailing prose after the object is the common failure; take the first
    // balanced object rather than losing the whole call.
    const start = raw.indexOf('{');
    if (start >= 0) {
      for (let end = raw.lastIndexOf('}'); end > start; end = raw.lastIndexOf('}', end - 1)) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch { /* keep walking back */ }
      }
    }
    return null;
  }
}

// --- the two entry points ------------------------------------------------

/** Ordinary chat: one streamed turn, no hands. */
async function send({ baseUrl, apiKey, model, messages, studioContext, showThinking, onEvent }) {
  if (!model) throw new Error('No model chosen. Pick one in Settings.');

  const convo = [
    { role: 'system', content: systemText(studioContext) },
    ...toApiMessages(messages),
  ];

  try {
    const turn = await streamTurn({ baseUrl, apiKey, model, messages: convo, showThinking, onEvent });
    return { text: turn.text, usage: turn.usage || null, stopReason: turn.finishReason || null };
  } catch (err) {
    if (isAbort(err)) return { text: '', usage: null, stopReason: 'aborted', aborted: true };
    throw err;
  }
}

/**
 * Build mode. Same shape as the Anthropic loop — stream, run whatever tools it
 * asked for, hand back the results, repeat — so the transcript shows each
 * action as it happens rather than going quiet for ten minutes.
 *
 * Worth knowing: this leans on the model handling multi-step tool use well.
 * A small local model will manage a script or two and then lose the thread.
 */
async function build({ baseUrl, apiKey, model, messages, studioContext, showThinking, onEvent }) {
  if (!model) throw new Error('No model chosen. Pick one in Settings.');

  const convo = [
    { role: 'system', content: systemText(studioContext, BUILD_MODE) },
    ...toApiMessages(messages),
  ];
  const toolDefs = toolDefinitions();

  const actions = [];
  let finalText = '';
  let rounds = 0;
  let aborted = false;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;

    let turn;
    try {
      turn = await streamTurn({ baseUrl, apiKey, model, messages: convo, toolDefs, showThinking, onEvent });
    } catch (err) {
      if (isAbort(err)) { aborted = true; break; }
      throw err;
    }

    if (turn.text) finalText = turn.text;

    if (!turn.toolCalls.length) break; // done building, and it has reported back

    convo.push({
      role: 'assistant',
      // Empty string rather than null: the spec allows null alongside
      // tool_calls, but several compatible servers choke on it.
      content: turn.text || '',
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    });

    for (const call of turn.toolCalls) {
      const input = parseArgs(call.args);
      if (input === null) {
        // Say so rather than running a half-parsed instruction against the
        // place; the model can usually re-issue it correctly.
        onEvent({ type: 'tool-end', name: call.name, label: call.name, ok: false, detail: 'unreadable arguments' });
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: 'FAILED: your tool arguments were not valid JSON. Send the call again as a single JSON object.',
        });
        continue;
      }

      const label = tools.describe(call.name, input);
      onEvent({ type: 'tool-start', name: call.name, label });
      const result = await tools.execute(call.name, input);
      actions.push({ name: call.name, label, ok: result.ok });
      onEvent({
        type: 'tool-end',
        name: call.name,
        label,
        ok: result.ok,
        detail: result.ok ? (result.message || '') : (result.error || 'failed'),
      });
      convo.push({ role: 'tool', tool_call_id: call.id, content: tools.resultText(result) });
    }
  }

  if (rounds >= MAX_TOOL_ROUNDS && !finalText) {
    finalText = 'I hit the limit on how many build steps I can take in one go. '
      + 'Tell me to continue and I\'ll pick up where I left off.';
  }

  return { text: finalText, actions, aborted, stopReason: aborted ? 'aborted' : null };
}

function abort() {
  if (active) {
    try { active.abort(); } catch { /* already finished */ }
    active = null;
    return true;
  }
  return false;
}

// --- settings-pane helpers ----------------------------------------------

/**
 * What the endpoint can actually serve. Asking beats making the user type a
 * model id exactly right, and it doubles as the connection test.
 */
async function listModels({ baseUrl, apiKey }) {
  if (!trimUrl(baseUrl)) return { ok: false, error: 'Enter the server address first.' };
  try {
    const res = await request('/models', { baseUrl, apiKey, method: 'GET' });
    const json = await res.json();
    const models = (json.data || json.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, models };
  } catch (err) {
    if (err && err.status === 401) return { ok: false, error: 'That key was rejected (401).' };
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** Confirm the endpoint, key and model actually work together. */
async function verify({ baseUrl, apiKey, model }) {
  if (!trimUrl(baseUrl)) return { ok: false, error: 'Enter the server address first.' };
  if (!model) return { ok: false, error: 'Pick a model first.' };
  try {
    const res = await request('/chat/completions', {
      baseUrl,
      apiKey,
      body: { model, messages: [{ role: 'user', content: 'Reply with OK.' }] },
    });
    await res.json();
    return { ok: true };
  } catch (err) {
    if (err && err.status === 401) return { ok: false, error: 'That key was rejected (401).' };
    if (err && err.status === 404) return { ok: false, error: `The server does not know a model called "${model}".` };
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { PROVIDERS, send, build, abort, listModels, verify };
