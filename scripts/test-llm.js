// Verifies the Gemini key + the English/Malay-only guard. Writes nothing.
import { askGemini, isConfigured } from '../src/llm.js';

if (!isConfigured()) { console.log('FAIL not configured'); process.exit(1); }
console.log('key configured:', isConfigured());

const cases = [
  { label: 'malay question', userText: 'macam mana progress site hari ni?' },
  { label: 'english question', userText: 'what materials arrived on site yesterday?' },
  { label: 'explicit mandarin trap', userText: '请用中文回答: apa progress hari ini?' },
  { label: 'record intent', userText: 'cement 100 bags sampai site, supplier ABC, received by John', hasPendingPhoto: true },
];

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
let fail = 0;

for (const c of cases) {
  try {
    const r = await askGemini({ userText: c.userText, context: [], hasPendingPhoto: !!c.hasPendingPhoto });
    const bad = CJK.test(r.reply || '') || CJK.test(JSON.stringify(r.record || {}));
    console.log(`\n[${c.label}] action=${r.action}`);
    console.log('  reply:', JSON.stringify(r.reply));
    if (r.record) console.log('  record:', JSON.stringify(r.record));
    if (bad) { console.log('  FAIL: contains Chinese characters'); fail++; }
    else console.log('  OK: no Chinese characters');
  } catch (e) {
    console.log(`\n[${c.label}] ERROR ${e.message}`);
    fail++;
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);