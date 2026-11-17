import config from '../config.js';

// The local brain: Ollama serving a Qwen model on this machine.
//
// Why local instead of an API: the Gemini free tier returns 429 after ~20
// requests, so replies took 8-17s and often came back as "tak dapat faham".
// qwen3:8b sits in the RTX 4060 (6.2GB of its 8GB) and answers a full
// SYSTEM_PROMPT prompt in ~0.3-1.5s once it is warm - measured, not guessed.
//
// The request parameters are each load-bearing:
//  - format: "json"    forces the model to emit bare JSON, so the action schema
//                      never arrives wrapped in prose or a preamble.
//  - think: false      qwen3 otherwise writes a hidden reasoning trace first.
//                      It costs seconds and has been seen to leak into
//                      "content", which then fails JSON parsing.
//  - keep_alive: "24h" Ollama unloads a model after 5 minutes idle by default,
//                      and the next message then pays the ~90s cold load (5.2GB
//                      from disk into VRAM). A WhatsApp bot goes idle for hours,
//                      so the model has to stay resident.
//  - options.num_ctx   the SYSTEM_PROMPT alone runs to several thousand tokens.
//                      Ollama's 4096 default silently truncates it, and a
//                      truncated system prompt means the model forgets the
//                      action list and answers with plain prose.

export function isLocalConfigured() {
  return Boolean(config.ollamaUrl);
}

/** Ask the local model. Throws on transport/HTTP failure; resolves with raw text. */
export async function chatLocal({ system, prompt, model, timeoutMs }) {
  const url = `${config.ollamaUrl}/api/chat`;
  const startedAt = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      format: 'json',
      think: false,
      keep_alive: config.ollamaKeepAlive,
      stream: false,
      options: {
        temperature: 0.2,
        num_ctx: config.ollamaNumCtx,
      },
    }),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const text = String(json?.message?.content || '');

  return {
    text,
    model: json?.model || model,
    elapsedMs: Date.now() - startedAt,
    // Ollama reports these; useful when a prompt silently blows the context.
    doneReason: json?.done_reason || '',
    promptEvalCount: json?.prompt_eval_count || 0,
    evalCount: json?.eval_count || 0,
  };
}

/**
 * Load the model into VRAM once at startup, so the FIRST real message does not
 * pay the ~90s cold load (5.2GB from disk). Fire-and-forget from the bot's
 * ready path; the keep_alive below keeps it resident afterwards.
 */
export async function warmLocal(timeoutMs = 100000) {
  try {
    const startedAt = Date.now();
    const r = await chatLocal({
      system: 'You are a warm-up probe. Reply only with the JSON {"ok":true}.',
      prompt: 'warmup',
      model: config.ollamaModels[0],
      timeoutMs,
    });
    console.log(`[brain] ${r.model} loaded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    console.warn(`[brain] warm-up failed: ${err.message}`);
    return false;
  }
}

/**
 * Models Ollama currently has pulled. Used for the startup log and for a clear
 * "model missing" message instead of a bare HTTP 404 at the worst moment.
 */
export async function listLocalModels(timeoutMs = 3000) {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json?.models || []).map(m => String(m.name || ''));
  } catch {
    return null; // null = Ollama itself is unreachable (vs [] = no models)
  }
}
