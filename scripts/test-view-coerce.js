// Pure-logic tests for the view/attach request guards used by the local brain.
// No LLM, no DB - just regex/correctness.
//   node scripts/test-view-coerce.js
import { looksLikeViewOnly, coerceViewIntent, attachHint, coerceAttachIntent } from '../src/llm.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${g}\n    want ${w}`); }
};

// --- looksLikeViewOnly ---
const views = [
  'tengok progress harini',
  'nak tengok progress',
  'ada open issue ?',
  'list issue',
  'tunjuk material masuk',
  'check attendance semalam',
  'senarai semua issue',
  'kasi tengok gambar',
  'ada pending ?',
];
for (const v of views) check(`view-only true: "${v}"`, looksLikeViewOnly(v), true);

const writes = [
  'tambah progress: kat D1 dah siap',
  '4 pallet cement masuk stor A',
  'update progress gali dekat slope',
  'azman dan kudin masuk kerja pagi',
  'siap wire semua hari ni',
  '20 bag simen dari supplier federal',
  '1 lori pasir masuk site',
];
for (const w of writes) check(`view-only false: "${w}"`, looksLikeViewOnly(w), false);

// --- coerceViewIntent ---
check('coerce progress->view(issue)',
  coerceViewIntent('ada open issue ?', { action: 'chat', reply: 'x' }),
  { action: 'view', reply: '', record: { what: 'issue', status: 'open', date: null } });

check('coerce chat->view(progress)',
  coerceViewIntent('tengok progress harini', { action: 'progress', reply: 'x' }),
  { action: 'view', reply: '', record: { what: 'progress', date: null } });

check('coerce material view keeps model reply, missing what filled',
  coerceViewIntent('nak tengok material masuk hari ni', { action: 'view', reply: 'r', record: null }),
  { action: 'view', reply: 'r', record: { what: 'material' } });

check('view with no verb still fills what from the noun ("material ?")',
  coerceViewIntent('material ?', { action: 'view', reply: 'which one?', record: null }),
  { action: 'view', reply: 'which one?', record: { what: 'material' } });

check('view with no noun stays untouched',
  coerceViewIntent('show me', { action: 'view', reply: 'which one?', record: null }), null);

check('no coerce when action already view + what set',
  coerceViewIntent('tengok progress harini', { action: 'view', reply: 'r', record: { what: 'ss' } }), null);

check('no coerce on a record write',
  coerceViewIntent('4 pallet cement masuk stor A', { action: 'material', reply: 'r', record: {} }), null);

check('no coerce on idle chat',
  coerceViewIntent('ape khabar bos', { action: 'chat', reply: 'halo' }), null);

check('no coerce on progress update',
  coerceViewIntent('tambah progress: D1 siap', { action: 'progress', reply: 'r', record: { name: 'D1' } }), null);

// --- "pada issue" must not read as "ada issue" (an attach request, not a view) ---
check('view-only false: "sikat gambar ni pada issue 3"',
  looksLikeViewOnly('kerani sikat gambar ni pada issue 3'), false);
check('view-only true: "ada issue apa?"',
  looksLikeViewOnly('ada issue apa?'), true);

// --- attach intent ---
check('attachHint progress', attachHint('kerani attach lima gambar tu dalam satu progress'), { target: 'progress' });
check('attachHint issue + id', attachHint('kerani sikat gambar ni pada issue 3'), { target: 'issue', id: 3 });
check('attachHint material', attachHint('kerani tampal gambar tu dalam satu material'), { target: 'material' });
check('attachHint none (no photo)', attachHint('tengok progress'), null);
check('attachHint none (no target)', attachHint('tampal gambar tu'), null);
check('attachHint none (no verb)', attachHint('gambar dalam issue 3'), null);

check('coerce chat->attach(progress)',
  coerceAttachIntent('kerani attach lima gambar tu dalam satu progress', { action: 'chat', reply: 'x' }),
  { action: 'attach', reply: '', record: { target: 'progress' } });
check('coerce chat->attach(issue,id)',
  coerceAttachIntent('kerani sikat gambar ni pada issue 3', { action: 'view', reply: 'x', record: { what: 'issue' } }),
  { action: 'attach', reply: '', record: { what: 'issue', target: 'issue', id: 3 } });
check('no attach coerce on plain record',
  coerceAttachIntent('4 pallet cement masuk stor A', { action: 'material', reply: 'r' }), null);
check('no attach coerce when already attach',
  coerceAttachIntent('kerani attach gambar dalam progress', { action: 'attach', reply: 'r' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);