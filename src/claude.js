'use strict';

// Talking to Claude. Streaming, because a full Luau file at xhigh effort is a
// long response and a non-streaming request would sit on an idle socket.

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystem, BUILD_MODE } = require('./prompt');
const tools = require('./tools');

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 32000;
/** Ceiling on build-mode rounds, so a confused run stops instead of grinding. */
const MAX_TOOL_ROUNDS = 60;
/** How many past turns to resend. Enough for a working session, bounded so a
 *  months-old chat doesn't quietly cost a fortune to continue. */
const HISTORY_TURNS = 40;

let client = null;
let clientKey = null;
let active = null; // the in-flight stream, so the Stop button has something to hit

function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

function isAbort(err) {
  return Boolean(err) && (err.name === 'APIUserAbortError' || /aborted/i.test(String(err.message || '')));
}

function toApiMessages(messages) {
  return messages
    .filter((m) => m.content && m.content.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Stream one assistant turn.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {Array}  opts.messages      full conversation so far, ending with the user turn
 * @param {string} opts.studioContext optional live Studio snapshot
 * @param {string} opts.effort        low | medium | high | xhigh | max
 * @param {boolean} opts.showThinking surface summarised reasoning to the UI
 * @param {(evt: object) => void} opts.onEvent
 * @returns {Promise<{text: string, usage: object|null, stopReason: string|null}>}
 */
async function send({ apiKey, messages, studioContext, effort, showThinking, onEvent }) {
  const anthropic = getClient(apiKey);

  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystem(studioContext),
    // Adaptive is the default on Opus 5; naming it keeps the intent obvious.
    // `display` is what decides whether the thinking pane has anything in it —
    // the default is "omitted", which streams empty thinking blocks.
    thinking: { type: 'adaptive', display: showThinking ? 'summarized' : 'omitted' },
    output_config: { effort: effort || 'xhigh' },
    messages: toApiMessages(messages),
  };

  // Opus 5's safety classifiers can decline a request outright. Server-side
  // fallbacks re-serve it on the recommended model in the same call instead of
  // handing the user a dead turn.
  const withFallback = {
    ...params,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };

  let text = '';
  let stream;
  try {
    stream = anthropic.beta.messages.stream(withFallback);
  } catch (err) {
    stream = null;
  }

  const consume = async (s) => {
    active = s;
    text = '';
    for await (const event of s) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          text += event.delta.text;
          onEvent({ type: 'text', text: event.delta.text });
        } else if (event.delta.type === 'thinking_delta') {
          onEvent({ type: 'thinking', text: event.delta.thinking });
        }
      } else if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        onEvent({ type: 'thinking-start' });
      } else if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        onEvent({ type: 'text-start' });
      }
    }
    return s.finalMessage();
  };

  let final;
  try {
    final = await consume(stream);
  } catch (err) {
    if (isAbort(err)) return { text, usage: null, stopReason: 'aborted', aborted: true };
    // The beta fallback surface may not be enabled on every account. If that's
    // what failed — rather than the request itself — retry once plainly, so a
    // hardening feature never costs the user their answer.
    const msg = String((err && err.message) || '');
    if (!(err && err.status === 400 && /fallback|beta/i.test(msg))) throw err;
    try {
      final = await consume(anthropic.messages.stream(params));
    } catch (retryErr) {
      if (isAbort(retryErr)) return { text, usage: null, stopReason: 'aborted', aborted: true };
      throw retryErr;
    }
  } finally {
    active = null;
  }

  if (final.stop_reason === 'refusal') {
    const detail = final.stop_details && final.stop_details.explanation;
    return {
      text: text || `Claude declined this request${detail ? `: ${detail}` : '.'}`,
      usage: final.usage || null,
      stopReason: 'refusal',
    };
  }

  return { text, usage: final.usage || null, stopReason: final.stop_reason || null };
}

/**
 * Build mode: the same conversation, but Claude has hands. It streams text as
 * usual, and whenever it asks for a tool we run it inside the open place and
 * hand back what happened, until it stops asking and reports.
 *
 * The manual loop (rather than the SDK tool runner) is here so every tool call
 * can be surfaced in the transcript as it happens — a ten-minute silent build
 * is indistinguishable from a hang.
 */
async function build({ apiKey, messages, studioContext, effort, showThinking, onEvent }) {
  const anthropic = getClient(apiKey);
  const system = buildSystem(studioContext, BUILD_MODE);
  const convo = toApiMessages(messages);

  const actions = [];
  let finalText = '';
  let rounds = 0;
  let aborted = false;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      thinking: { type: 'adaptive', display: showThinking ? 'summarized' : 'omitted' },
      output_config: { effort: effort || 'xhigh' },
      tools: tools.TOOLS,
      messages: convo,
    });

    active = stream;
    let turnText = '';
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            turnText += event.delta.text;
            onEvent({ type: 'text', text: event.delta.text });
          } else if (event.delta.type === 'thinking_delta') {
            onEvent({ type: 'thinking', text: event.delta.thinking });
          }
        }
      }
    } catch (err) {
      active = null;
      if (isAbort(err)) { aborted = true; break; }
      throw err;
    }

    const final = await stream.finalMessage();
    active = null;

    if (turnText) finalText = turnText;

    if (final.stop_reason === 'refusal') {
      finalText = turnText || 'Claude declined this request.';
      break;
    }

    convo.push({ role: 'assistant', content: final.content });

    const calls = final.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) break; // it's done building and has reported back

    const results = [];
    for (const call of calls) {
      onEvent({ type: 'tool-start', name: call.name, label: tools.describe(call.name, call.input) });
      const result = await tools.execute(call.name, call.input);
      actions.push({ name: call.name, label: tools.describe(call.name, call.input), ok: result.ok });
      onEvent({
        type: 'tool-end',
        name: call.name,
        label: tools.describe(call.name, call.input),
        ok: result.ok,
        detail: result.ok ? (result.message || '') : (result.error || 'failed'),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: tools.resultText(result),
        is_error: !result.ok,
      });
    }
    convo.push({ role: 'user', content: results });
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

/** Cheap credential check for the settings pane. */
async function verifyKey(apiKey) {
  try {
    const anthropic = new Anthropic({ apiKey });
    await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    return { ok: true };
  } catch (err) {
    if (err && err.status === 401) return { ok: false, error: 'That key was rejected (401).' };
    if (err && err.status === 403) return { ok: false, error: 'That key lacks permission for Opus 5 (403).' };
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { send, build, abort, verifyKey, MODEL };
