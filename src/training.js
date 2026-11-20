import { appendFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Collects (prompt -> decision) pairs so the bot's own traffic becomes a
// fine-tuning dataset. qwen3:8b already follows the schema, but it learned that
// from generic data; feeding it real site messages with the real SYSTEM_PROMPT
// is what makes it good at THIS job - Malaysian Manglish, the 14 actions, and
// the site's own vocabulary (SS, cube test, pallet, ready-mix).
//
// One row per LLM call, JSONL so it can be streamed and appended to without
// ever rewriting the file:
//   {"ts":..,"prompt":..,"output":..,"action":..,"reply":..,"valid":true}
//
// "prompt" is the exact user turn that was sent (chat history + site snapshot),
// "output" is the exact JSON the model produced. That is the instruction/response
// pair an SFT job needs. The SYSTEM_PROMPT is constant and lives in llm.js, so it
// is written once as a sidecar instead of being duplicated in every row.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const TRAINING_DIR = join(ROOT, 'training');
export const DATASET_PATH = join(TRAINING_DIR, 'dataset.jsonl');
export const SYSTEM_PROMPT_PATH = join(TRAINING_DIR, 'system-prompt.txt');

let ensured = false;
async function ensureDirs() {
  if (ensured) return;
  await mkdir(TRAINING_DIR, { recursive: true });
  ensured = true;
}

/** Store the system prompt once, so rows stay small. Idempotent. */
export async function writeSystemPrompt(text) {
  try {
    await ensureDirs();
    if (existsSync(SYSTEM_PROMPT_PATH)) return;
    await writeFile(SYSTEM_PROMPT_PATH, text, 'utf8');
  } catch (err) {
    console.warn(`[training] could not write system prompt: ${err.message}`);
  }
}

/**
 * Append one sample. Never throws: the bot must keep answering even if the
 * dataset disk is full or read-only.
 *
 * @param {object} s
 * @param {string} s.prompt  the user turn sent to the model
 * @param {string} s.output  the raw text the model returned
 * @param {string} [s.action] decided action
 * @param {string} [s.reply]  reply actually sent
 * @param {string} [s.model]
 * @param {boolean} [s.valid] false = parse/schema failure (kept as a negative)
 */
// People paste keys into the group. The dataset must never keep them.
const SECRET = /\b(?:csk-|gsk_|sk-|xi-|AIza|eyJ)[A-Za-z0-9._-]{16,}|(?<=postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(?=@)/g;
export const redactSecrets = (text) => String(text).replace(SECRET, '[redacted]');

export async function logSample({ prompt, output, action = null, reply = null, model = null, valid = true, elapsedMs = null }) {
  try {
    if (typeof prompt !== 'string' || prompt.length === 0) return;
    await ensureDirs();
    const row = {
      ts: new Date().toISOString(),
      valid: Boolean(valid),
      model,
      action,
      elapsedMs,
      prompt: redactSecrets(prompt),
      output: redactSecrets(String(output || '').slice(0, 8000)),
      reply: reply == null ? null : redactSecrets(String(reply).slice(0, 1000)),
    };
    await appendFile(DATASET_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  } catch (err) {
    console.warn(`[training] sample not logged: ${err.message}`);
  }
}
