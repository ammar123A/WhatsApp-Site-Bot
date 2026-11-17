// Focused test for the "edit Project SS operator" bug: the bot promised an edit
// but never did one, because `ss` was not an editable type at all.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    fail++;
  }
}

// --- Static checks on the source ------------------------------------------------
const src = readFileSync(join(root, 'src/handlers/ai.js'), 'utf8');

check('ss is routed to the date-based editor, not the id-based one', () => {
  assert.match(src, /wantsSS[\s\S]*?doEditSS/);
  assert.match(src, /if \(type === 'ss'\) return doEditSS/);
});

check('operator + operators both map to the diary operators column', () => {
  assert.match(src, /operator:\s*'operators'/);
  assert.match(src, /operators:\s*'operators'/);
});

check('every writable diary section has a human label', () => {
  for (const key of ['operators', 'weather', 'machinery', 'machinery_equipment', 'site_name', 'general_notes', 'safety_notes']) {
    assert.match(src, new RegExp(`${key}:\\s*'[^']+'`), `missing label for ${key}`);
  }
});

check('add/remove/replace verbs are all recognised', () => {
  assert.match(src, /SS_ADD_WORDS/);
  assert.match(src, /SS_REMOVE_WORDS/);
  assert.match(src, /const SS_LIST_SECTIONS/);
});

check('only the named section is written (no full-row upsert)', () => {
  // setSection() does a targeted UPDATE, so untouched sections keep their value.
  assert.match(src, /diaryDB\.setSection\(date, column, next\)/);
  assert.ok(!/diaryDB\.upsert\(\{ date, \[column\]/.test(src), 'must not upsert the whole row');
});

check('add never duplicates an existing name', () => {
  assert.match(src, /already present/);
});

check('remove keeps every other entry', () => {
  assert.match(src, /entries\.filter\(\(e\) => !sameName/);
});

check('a name that is not there is reported, not silently added', () => {
  assert.match(src, /takde dalam \$\{label\}/);
});

check('attendance without a shift asks back', () => {
  assert.match(src, /missingShift/);
  assert.match(src, /shift mana boss\?/);
});

check('multi-item material makes one record per line', () => {
  assert.match(src, /Array\.isArray\(r\.items\)/);
  assert.match(src, /saveOneMaterial/);
  assert.match(src, /saved\.length === 1/);
});

check('bot never sends a promise it did not fulfil (chat path)', () => {
  assert.match(src, /function promisesAnAction/);
  assert.match(src, /function safeChatReply/);
  assert.match(src, /return safeChatReply\(msg, text\)/);
  assert.match(src, /Maaf boss, saya tak pasti/);
});

check('ask-back also refuses the fake confirmation', () => {
  assert.match(src, /!promisesAnAction\(modelQ\)/);
});

// --- Behaviour of the mapping + append logic, with the DB stubbed --------------
// The mapping is re-implemented so the append logic can be exercised without a
// database. check() below pins it to the real source, because a drifted copy
// here is how "column sitename does not exist" slipped through before.
const SS_FIELDS = {
  operator: 'operators', operators: 'operators', weather: 'weather',
  machinery: 'machinery', equipment: 'machinery_equipment',
  'machinery & equipment': 'machinery_equipment', machineryequipment: 'machinery_equipment',
  site: 'site_name', 'site name': 'site_name', sitename: 'site_name', notes: 'general_notes',
  'general notes': 'general_notes', safety: 'safety_notes',
  'safety notes': 'safety_notes', visitors: 'visitors',
};

check('this test copy matches the real handler mapping', () => {
  const real = src.slice(src.indexOf('const SS_FIELDS'), src.indexOf('const SS_LABELS'));
  const pairs = [...real.matchAll(/(?:'([^']+)'|(\w[\w ]*)):\s*'([a-z_]+)'/g)]
    .map((m) => [m[1] ?? m[2], m[3]]);
  for (const [key, column] of pairs) {
    assert.equal(
      SS_FIELDS[key], column,
      `copy says ${key} -> ${SS_FIELDS[key]} but the handler uses ${column}`
    );
  }
  assert.ok(pairs.length > 8, 'expected to find the mapping entries');
});

check('no mapping points at a camelCase column', () => {
  const real = src.slice(src.indexOf('const SS_FIELDS'), src.indexOf('const SS_LABELS'));
  const bad = [...real.matchAll(/:\s*'([A-Za-z_]+)'/g)].map((m) => m[1]).filter((c) => /[A-Z]/.test(c));
  assert.equal(bad.length, 0, `camelCase columns would break SQL: ${bad.join(', ')}`);
});

function oneOf(value, allowed, fallback = '') {
  const v = String(value || '').trim().toLowerCase();
  return allowed.find((a) => String(a).toLowerCase() === v) ?? fallback;
}

const SS_ADD_WORDS = /\b(tambah|tambahkan|masukkan|masuk|add|append|tampal|letak|ada|baru)\b/i;
const SS_REMOVE_WORDS = /\b(buang|keluarkan|hapus|remove|delete|takde lagi|tidak ada lagi|buangkan|separate|pecah|dah tak dalam)\b/i;
const STRIP = /^\s*(tambah|tambahkan|masukkan|masuk|add|append|tampal|letak)\b\s*/i;

const SS_LIST_SECTIONS = new Set(['operators', 'machinery', 'machinery_equipment', 'visitors']);

function splitEntries(text) {
  return String(text || '').split(/\n|;|•|\s+\/\s+|\s+(?:dan|and)\s+|,/i).map((s) => s.trim()).filter(Boolean);
}
const sameName = (a, b) =>
  String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');

check('"tambah nama Arif" maps to operators and appends', () => {
  const fieldKey = oneOf('operator', Object.keys(SS_FIELDS), '');
  assert.equal(fieldKey, 'operator');
  assert.equal(SS_FIELDS[fieldKey], 'operators');
  assert.ok(SS_ADD_WORDS.test('tambah nama arif'));
  assert.equal('tambah nama arif'.replace(STRIP, '').trim(), 'nama arif');
});

check('plain value replaces instead of appending', () => {
  assert.ok(!SS_ADD_WORDS.test('Arif'));
});

// --- list editing: add / remove / replace, one section at a time ----------------
function editListSection(before, raw, adding, removing) {
  const entries = splitEntries(before);
  const cleanValue = String(raw)
    .replace(/^\s*(tambah|tambahkan|masukkan|masuk|add|append|tampal|letak)\b\s*/i, '')
    .replace(/^\s*(buang|keluarkan|hapus|remove|delete|buangkan|separate)\b\s*/i, '')
    .replace(/\b(baru|je|only)\b\s*$/i, '')
    .trim();

  if (removing) {
    return entries.filter((e) => !sameName(e, cleanValue)).join('\n');
  }
  if (adding) {
    const added = [];
    for (const w of splitEntries(cleanValue)) {
      if (entries.some((e) => sameName(e, w)) || added.some((e) => sameName(e, w))) continue;
      entries.push(w);
      added.push(w);
    }
    return entries.join('\n');
  }
  return splitEntries(cleanValue).join('\n');
}

check('append keeps everything already in the list', () => {
  assert.equal(editListSection('Azman', 'tambah nama arif', true), 'Azman\nnama arif');
});

check('appending the same name twice does not duplicate it', () => {
  assert.equal(editListSection('Azman\nArif', 'tambah arif', true), 'Azman\nArif');
});

check('append accepts several names in one go', () => {
  assert.equal(editListSection('Azman', 'tambah arif dan zarif', true), 'Azman\narif\nzarif');
});

check('remove takes out only that name', () => {
  assert.equal(editListSection('Azman\nArif\nZarif', 'buang arif', false, true), 'Azman\nZarif');
});

check('remove ignores case and spacing', () => {
  assert.equal(editListSection('Azman\nArif', 'buang ARIF', false, true), 'Azman');
});

check('removing the last entry leaves the section empty, not broken', () => {
  assert.equal(editListSection('Arif', 'buang arif', false, true), '');
});

check('plain value replaces the whole list', () => {
  assert.equal(editListSection('Azman\nArif', 'Azman, Zarif', false), 'Azman\nZarif');
});

check('a comma-typed list is normalised to one name per line', () => {
  assert.equal(splitEntries('Azman, Arif, Zarif').join('\n'), 'Azman\nArif\nZarif');
});

check('site name change does NOT touch the operator list', () => {
  // Different column entirely - the add/remove logic must never be reached.
  assert.equal(SS_FIELDS.site, 'site_name');
  assert.equal(SS_FIELDS.operator, 'operators');
  assert.ok(!SS_LIST_SECTIONS.has('site_name'));
});

check('workers/kerani is NOT silently written to operators', () => {
  // "tambah nama arif, and workers tambah nama zarif" - only the operator part
  // may be written, and it must say so rather than quietly dropping half.
  assert.equal(oneOf('worker', Object.keys(SS_FIELDS), ''), '');
});

check('unmapped field asks instead of guessing', () => {
  assert.equal(oneOf('whatever', Object.keys(SS_FIELDS), ''), '');
});

// --- Honesty guard: the reply that caused the complaint ------------------------
function promisesAnAction(text) {
  return /\b(sudah|dah|tqk|tkq)\b[^.!]*\b(tambah|edit|update|ubah|masuk|simpan|set|record|rekod|close|tutup|delete|buang)\w*|\b(jap|sekejap|satu|sesaat|sedang)\b[^.!]*\b(edit|update|ubah|tambah|masuk)\w*|\b(letak|simpan|masukkan|edit)\s+(itu|ni|eh)\b|\bi (will|'ll)\b/i.test(
    String(text || '')
  );
}

check('"Ok jap tgh edit" is caught as a false promise', () => {
  assert.ok(promisesAnAction('Ok jap tgh edit'));
  assert.ok(promisesAnAction('Baik, saya sedang editkan sekarang'));
  assert.ok(promisesAnAction('Sudah saya tambah nama Arif'));
  assert.ok(promisesAnAction('I will update the record'));
});

check('honest replies are not blocked', () => {
  assert.ok(!promisesAnAction('Ok boss, apa boleh saya tolong?'));
  assert.ok(!promisesAnAction('Boleh boss, nama apa nak masuk dalam Operator?'));
  assert.ok(!promisesAnAction('Nak saya listkan issue yang open ke?'));
  assert.ok(!promisesAnAction('Yes boss, the drawing is in your drive'));
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);