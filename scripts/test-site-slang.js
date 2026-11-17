// Live comprehension test: does the bot actually understand how site people
// really type? Every case below is real Malaysian site shorthand that used to
// be ambiguous, plus the honesty cases where it must NOT invent a record.
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

// [message, expectation]
const CASES = [
  // --- progress: work done, said the way a site actually says it
  ['petak A slab dah pour petanque siap', 'progress'],
  ['gali dah up 1.2m', 'progress'],
  ['drain blk C siap', 'progress'],
  ['scoring up second lift', 'progress'],

  // --- material: delivery, with the local word for cement
  ['lori tq 4 pallet sampai', 'material'],
  ['DO 2311 masuk', 'material'],
  ['baki simen 20 bag', 'material'],
  ['stok batu crusher ada 5 m3', 'material'],
  ['barang dah sampai', 'material'],
  ['cement 4 bag sampai site', 'material'],
  ['dumper dihantar petang tadi', 'material'],

  // --- progress: WORK being done, never mistaken for a delivery.
  // These are the phrases that used to get filed as material submissions.
  ['tengah install paip', 'progress'],
  ['susun batu ikat batu dah siap', 'progress'],
  ['orang tengah pahat dinding', 'progress'],
  ['tukang cat tengah kerja kat blok B', 'progress'],
  ['konkrit dituang petang tadi', 'progress'],

  // --- issue: something wrong, with local wording
  ['paip atas bumbung bocor', 'issue'],
  ['excavator E13 rosak tak boleh guna', 'issue'],
  ['orang tak pakai topi kat laluan tu', 'issue'],

  // --- attendance
  ['azman sarino masuk pagi', 'attendance'],

  // --- existing record operations must NOT become new records
  ['tutup issue 5', 'resolve'],
  ['tukar qty material 12 jadi 20', 'edit'],
  ['buang no 3, 4, 5 dari progress', 'delete'],
  ['buang nama workers abu, ali', 'delete'],

  // --- Project SS section edits
  ['tukar nama site flora hijauan tu jadi Sky Awani', 'edit'],
  ['tambah nama arif dalam bahagian operator', 'edit'],
  ['buang abu dari visitor', 'edit'],

  // --- questions are not saves
  ['ada apa masalah sekarang', 'view'],
  ['beri progress hari ni', 'view'],
  ['macam mana ni site', 'chat'],
  ['dah siap ke?', 'chat'],

  // --- honesty: cannot do these, must not fabricate a record
  ['claim bulan lepas berapa', 'chat'],
  ['gambar rajah tu mana', 'chat'],
  ['buka fail pdf ni', 'chat'],
];

for (const [text, want] of CASES) {
  let got = null;
  let note = '';
  try {
    const d = await askGemini({ userText: text, context: [], hasPendingPhoto: false, pendingPhotoCount: 0 });
    got = d.action;
    note = (d.reply || '').slice(0, 70).replace(/\n/g, ' ');
  } catch (e) {
    note = 'ERROR ' + e.message;
  }
  if (got === want) {
    console.log(`PASS  [${got}] ${text}`);
    pass++;
  } else {
    console.log(`FAIL  want ${want}, got ${got} :: ${text}\n      "${note}"`);
    fail++;
  }
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);