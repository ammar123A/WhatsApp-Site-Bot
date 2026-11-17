/**
 * A chat reply must not claim the bot edited something when action was "chat"
 * and nothing was written. safeChatReply() swaps those for an apology.
 *
 * This also locks down the inverse - normal, information-only replies must get
 * through. "set\w*" used to match the Malay word "setengah", so a plain progress
 * answer ("...tanah atas kasaran tu hilang setengah") was discarded and replaced
 * with "saya tak pasti nak buat apa", and the bot looked like it ignored you.
 */
import assert from 'node:assert';
import { promisesAnAction } from '../src/handlers/ai.js';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${got}, want ${want})`}`);
}

console.log('\n--- real answer from the log, must be sent ---');
check(
  'progress reply about longkang/setengah goes out',
  promisesAnAction(
    'Oi Rep, dah dengar tu. Longkang dah siap kemas tapi tanah atas kasaran tu hilang setengah'
  ),
  false
);

console.log('\n--- Malay words starting with "set" are not claims ---');
for (const t of [
  'Setakat hari ni semua siap',
  'Seterusnya kita buat baki kerja',
  'Setiap pekerja dah sampai tapak',
  'Keadaan setiausaha tak okey lagi',
  'tu separuh setengah siap',
]) check(`  "${t}"`, promisesAnAction(t), false);

console.log('\n--- genuine fake confirmations still blocked ---');
for (const t of [
  'Ok jap, tgh edit sekarang',
  'dah tambah nama Arif',
  'saya dah simpan rekod tu',
  'dah update sistem',
  'sudah tutup issue tu',
  'sekejap, nak ubah tarikh',
  'letak itu dalam sistem',
  "i'll update the record",
]) check(`  "${t}"`, promisesAnAction(t), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);