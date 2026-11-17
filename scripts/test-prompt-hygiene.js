// Scans the system prompt for editing artefacts.
//
// The prompt is one long template literal, so a stray non-English token or an
// unfinished edit marker inside it would silently reach the model - and the CJK
// guard only checks the OUTPUT, never the instruction.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = readFileSync(join(root, 'src/llm.js'), 'utf8');

const start = src.indexOf('const SYSTEM_PROMPT');
const end = src.indexOf('const KNOWN_ACTIONS');
const prompt = src.slice(start, end);

let bad = 0;
const fail = (m) => { console.log('FAIL  ' + m); bad++; };
const pass = (m) => console.log('PASS  ' + m);

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
if (CJK.test(prompt)) {
  const hit = prompt.match(new RegExp('.{0,40}' + CJK.source + '.{0,40}'));
  fail('prompt contains CJK: ' + JSON.stringify(hit && hit[0]));
} else {
  pass('no CJK inside the prompt');
}

// Unfinished editing markers, e.g. `...? no ->` left over from drafting.
const artefact = /"?\s*no\s*(->|>|â€”)/gi;
const hits = prompt.match(artefact);
if (hits) fail(`unfinished edit markers left in prompt (${hits.length}): ${JSON.stringify(hits.slice(0, 5))}`);
else pass('no unfinished edit markers');

// Any non-ASCII that is not CJK and not an intentional punctuation/emoji mark.
const ALLOWED_NON_ASCII = new Set(['…', '—', '→', '·', '📸', '🏗️', '✅']);
const odd = [...prompt].filter(
  (c) => c.charCodeAt(0) > 127 && !CJK.test(c) && !ALLOWED_NON_ASCII.has(c)
);
if (odd.length) fail(`unexpected non-ascii characters: ${JSON.stringify([...new Set(odd)].join(''))}`);
else pass('no unexpected non-ascii characters');

console.log('');
console.log(`prompt: ${prompt.split('\n').length} lines, ${prompt.length} chars, ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
