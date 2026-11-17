// Compares candidate local models on the REAL production path (askGemini ->
// askLocal), same prompt + anchor + view coercion. Nothing is logged to the
// dataset (LOG_TRAINING_DATA=false) and nothing touches the DB.
//   OLLAMA_MODELS=qwen3:4b LOG_TRAINING_DATA=false node scripts/bench-models.mjs
import { askGemini, isConfigured } from '../src/llm.js';

const cases = [
  ['greeting (want chat)', 'hello'],
  ['greeting malay (want chat)', 'ape khabar bos'],
  ['view progress (want view)', 'tengok progress harini'],
  ['view issues (want view)', 'ada open issue ?'],
  ['record material (want material)', '4 pallet cement tadi supplier federal masuk stor A'],
  ['material 2 lines (want material items)', '4 pallet cement dan 1 pallet sand brick'],
  ['attendance (want attendance)', 'azman, zarif dan kudin masuk kerja pagi tadi'],
  ['record issue (want issue)', 'ada leak dekat roof, urgent'],
  ['record progress (want progress)', 'tambah progress: kat D1 dah siap, wire siap semua'],
];

console.log('configured:', isConfigured());
let pass = 0;
for (const [label, text] of cases) {
  const t = Date.now();
  const d = await askGemini({
    userText: text, context: [], hasPendingPhoto: false, pendingPhotoCount: 0, recordSnapshot: '',
  });
  const ms = Date.now() - t;
  console.log(`\n[${label}] ${ms}ms action=${d.action}`);
  console.log('  reply :', (d.reply || '').slice(0, 120));
  console.log('  record:', d.record ? JSON.stringify(d.record).slice(0, 160) : null);
}