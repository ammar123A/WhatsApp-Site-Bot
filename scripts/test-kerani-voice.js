// Checks the kerani VOICE, using the real model: casual, short, warm, no CJK,
// and never slipping into software wording ("record created successfully").
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { askGemini, isConfigured } = await import(pathToFileURL(join(root, 'src/llm.js')).href);

if (!isConfigured()) {
  console.log('SKIP  no GEMINI_API_KEY');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const SOFTWARE_TALK = /record created|successfully|updated the database|as an ai|i have (recorded|saved|updated)|error occurred|system/i;

const CASES = [
  ['wah panas gila hari ni boss', 'chat'],
  ['excavator E13 rosak petang ni', 'issue'],
  ['lori tq 4 pallet sampai stor A', 'material'],
  ['petak A slab dah pour', 'progress'],
  ['tq banyak boss', 'chat'],
];

for (const [text, want] of CASES) {
  let d;
  try {
    d = await askGemini({ userText: text, context: [], hasPendingPhoto: false, pendingPhotoCount: 0 });
  } catch (e) {
    console.log(`FAIL  LLM error :: ${text}\n      ${e.message}`);
    fail++;
    continue;
  }

  const reply = d.reply || '';
  const problems = [];
  if (d.action !== want) problems.push(`action want ${want} got ${d.action}`);
  if (CJK.test(reply)) problems.push('reply has CJK');
  if (SOFTWARE_TALK.test(reply)) problems.push('software wording');
  if (reply.split('\n').length > 6) problems.push('too long (not chat-like)');
  if (reply.length > 600) problems.push(`too long (${reply.length} chars)`);

  if (problems.length) {
    console.log(`FAIL  ${text}\n      ${problems.join(' | ')}\n      reply: ${reply.slice(0, 120).replace(/\n/g, ' ')}`);
    fail++;
  } else {
    console.log(`PASS  [${d.action}] ${text}\n      "${reply.slice(0, 120).replace(/\n/g, ' ')}"`);
    pass++;
  }
  await new Promise((r) => setTimeout(r, 2500));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);