/**
 * Company knowledge must reach the prompt, and must NOT be able to write records.
 */
import fs from 'node:fs';
import path from 'node:path';
import { companyKnowledge, knowledgeStatus, reloadKnowledge } from '../src/knowledge.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

const DIR = path.join(process.cwd(), 'knowledge');
const PROBE = path.join(DIR, '_probe.md');

console.log('--- empty state ---');
reloadKnowledge();
const before = companyKnowledge();
check('no knowledge dir notes -> empty prompt block', before === '' || reloadKnowledge() === '' || !companyKnowledge().includes('Bina Murni'));

console.log('\n--- notes get injected ---');
fs.writeFileSync(
  PROBE,
  '# Probe\nMain work: civil & structural, Klang Valley.\nMandur: Azman.\nDO must be checked before signing.',
  'utf8'
);
const injected = reloadKnowledge();
check('injected into prompt', injected.includes('civil & structural'), injected.slice(0, 120));
check('keeps the filename', injected.includes('_probe.md'));
check('marks it ground truth', /GROUND TRUTH|KNOWN FACTS/i.test(injected));
check('tells model live message wins', /contradicts/i.test(injected));
check('forbids using notes to fill records', /never use these notes to fill/i.test(injected));

console.log('\n--- reload picks up edits without restart ---');
fs.appendFileSync(PROBE, '\nExtra: spare pump kept at store.', 'utf8');
check('second reload sees the edit', reloadKnowledge().includes('spare pump'));

console.log('\n--- caps ---');
fs.writeFileSync(PROBE, 'x'.repeat(20000), 'utf8');
const huge = reloadKnowledge();
const body = huge.split('--- _probe.md ---')[1] || '';
// Cap was raised from 8k to 24k when the site notes overflowed 8k mid-sentence.
check('truncated to the cap', body.length <= 26000, `${body.length} chars`);
check('marks truncation', /truncated/i.test(huge));

console.log('\n--- status reporting ---');
const st = knowledgeStatus();
check('reports dir', st.dir === DIR);
check('lists files', st.files.includes('_probe.md'));
check('counts chars', st.chars > 0);

fs.unlinkSync(PROBE);
reloadKnowledge();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);