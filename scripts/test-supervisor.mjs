// Checks the supervisor persona: technical answers, honest "takde data", and
// that record-taking still works. Read-only, logs nothing to the dataset.
//   LOG_TRAINING_DATA=false node scripts/test-supervisor.mjs
import { askGemini } from '../src/llm.js';
import { knowledgeStatus } from '../src/knowledge.js';

const ks = knowledgeStatus();
console.log(`knowledge: ${ks.chars} chars from ${ks.files.join(', ')}\n`);

const cases = [
  ['TECH drainage', 'macam mana nak buat longkang air hujan dekat tepi jalan ni?'],
  ['TECH sewerage', 'paip sewerage 900mm dah align, invert level kena check ke?'],
  ['TECH retaining wall', 'nak buat retaining wall 3m dekat tepi jalan, gabion atau concrete?'],
  ['NO DATA (gravel qty)', 'berapa banyak gravel dah masuk bulan ni?'],
  ['NO DATA (progress)', 'progress kat blok B dah sampai mana?'],
  ['GREETING', 'hello boss'],
  ['RECORD material', '3 pallet gravel dah masuk site'],
  ['RECORD issue', 'longkang dekat Jalan Melur pecah, airistik laluan'],
];

for (const [label, text] of cases) {
  const t = Date.now();
  const d = await askGemini({
    userText: text, context: [], hasPendingPhoto: false, pendingPhotoCount: 0,
    recordSnapshot: '',
  });
  console.log(`\n[${label}] ${Date.now() - t}ms action=${d.action}`);
  console.log('  reply :', d.reply);
  if (d.record) console.log('  record:', JSON.stringify(d.record).slice(0, 200));
}