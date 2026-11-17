/**
 * Company / project knowledge for the kerani.
 *
 * Drop plain notes in `knowledge/company.md` (and optional per-topic files in the
 * same folder) and the bot folds them into every Gemini prompt. This is how the
 * site teaches the bot about ITS OWN company, clients, contracts, teams and
 * standing arrangements - the things no amount of Malaysian-site-vernacular
 * prompting can teach it.
 *
 * Rules that keep this safe to use in a live group:
 *   - It is ground TRUTH for the user, but it is NOT permission to write records.
 *     Knowledge still cannot create a progress/material/issue/attendance row, and
 *     anything that names a quantity, date, price or record id in here must not be
 *     used to fill one in.
 *   - If the knowledge contradicts what the user says right now, the LIVE message
 *     wins and the bot should say the two differ.
 *   - Plain text/markdown only, size-capped, so one huge paste cannot blow up the
 *     prompt or the API bill.
 *
 * Everything is optional: no folder / empty files and the prompt is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'knowledge');

// Enough for a real company profile plus per-project detail (site notes, workflow
// and claims steps ran past 8k and were being silently cut mid-sentence). Still
// bounded so one huge paste cannot run away with the prompt or the API bill.
const MAX_CHARS = 24000;
const MAX_FILES = 6;

// The notes are re-read on every tagged message, so they are cached - but the
// cache is keyed on the files' mtime/size. Without that, adding knowledge from
// the main PC looked like it did nothing: the folder changed, the running
// process kept serving the old text, and the only fix was a restart.
let cache = null;
let cacheStamp = '';

function stampOf(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f))
      .sort()
      .map((f) => {
        try {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${f}:gone`;
        }
      })
      .join('|');
  } catch {
    return '';
  }
}

function readNotes() {
  if (!fs.existsSync(DIR)) return '';
  const files = fs
    .readdirSync(DIR)
    // README.md documents this feature FOR the human, so it must never reach the
    // model as company knowledge - it would just burn prompt tokens and read as
    // instructions to obey.
    .filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f))
    .sort();

  const chunks = [];
  let used = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    if (used >= MAX_CHARS) break;
    let text;
    try {
      text = fs.readFileSync(path.join(DIR, file), 'utf8');
    } catch {
      continue;
    }
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) continue;
    const room = MAX_CHARS - used;
    if (text.length > room) text = `${text.slice(0, room)}\n...(truncated)`;
    chunks.push(`--- ${file} ---\n${text}`);
    used += text.length;
  }
  return chunks.join('\n\n');
}

/**
 * Cached because it is read from disk on every tagged message. `reloadKnowledge()`
 * exists so the file can be edited and picked up without a bot restart.
 */
/**
 * @param {number} maxChars cap for this caller. Groq's free tier allows 8k
 *   tokens/min for the WHOLE request, so the notes have to fit in a small slice
 *   there; Gemini and local can afford the full 24k.
 */
export function companyKnowledge(maxChars = MAX_CHARS) {
  const stamp = stampOf(DIR);
  if (cache === null || stamp !== cacheStamp) {
    cache = readNotes();
    cacheStamp = stamp;
  }
  if (!cache) return '';
  const cap = Math.max(0, Number(maxChars) || 0);
  const notes = cap && cache.length > cap ? `${cache.slice(0, cap)}\n[notes truncated]` : cache;
  return (
    `\n\nKNOWN FACTS ABOUT THIS COMPANY / PROJECT (ground truth the site told you):\n${notes}\n` +
    `Use these to answer questions about the company, contract, teams, clients and ` +
    `standing arrangements. If a fact here CONTRADICTS what the user says in this ` +
    `message, trust the live message and mention the difference. Never use these ` +
    `notes to fill in a quantity, date, price, supplier or record id for a NEW record.`
  );
}

export function reloadKnowledge() {
  cache = null;
  cacheStamp = '';
  return companyKnowledge();
}

/** For .knowledge / diagnostics: show whether notes are loaded. */
export function knowledgeStatus() {
  const notes = readNotes();
  return {
    dir: DIR,
    present: Boolean(notes),
    files: fs.existsSync(DIR)
      ? fs.readdirSync(DIR).filter((f) => /\.(md|txt)$/i.test(f) && !/^readme\./i.test(f))
      : [],
    chars: notes.length,
  };
}