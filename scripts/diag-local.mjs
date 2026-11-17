// End-to-end check of the LOCAL brain: loads llm.js, asks qwen3:8b a real site
// message and prints the decision + timing. Read-only, writes nothing to the DB.
//   node scripts/diag-local.mjs
import { askGemini, isConfigured, llmStatus } from '../src/llm.js';

console.log('configured:', isConfigured());
console.log('status    :', llmStatus());

const cases = [
  ['record material', '4 pallet cement tadi supplier federal masuk stor A'],
  ['view progress', 'tengok progress harini'],
  ['idle question', 'ape khabar bos'],
  ['attendance', 'azman, zarif dan kudin masuk kerja pagi tadi'],
  ['view issues', 'ada open issue ?'],
  ['record issue', 'ada leak dekat roof, urgent'],
  ['record progress (must NOT coerce)', 'tambah progress: kat D1 dah siap, wire siap semua'],
  ['view material', 'nak tengok material masuk hari ni'],
  ['record material (2 lines)', '4 pallet cement dan 1 pallet sand brick'],
];

for (const [label, text] of cases) {
  const t = Date.now();
  const d = await askGemini({
    userText: text,
    context: [],
    hasPendingPhoto: false,
    pendingPhotoCount: 0,
    recordSnapshot: '',
  });
  console.log(
    `\n[${label}] ${Date.now() - t}ms  action=${d.action} model=${d.model || '-'}`
  );
  console.log('  reply :', d.reply);
  console.log('  record:', d.record ? JSON.stringify(d.record) : null);
}
