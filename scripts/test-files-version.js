// Pure-logic tests for the structured file layer: symbol routing + version names.
// No database, no network - these are the decisions that must never drift.
import assert from 'node:assert';
import config from '../config.js';
import { parseSymbol, docNameFor, classifyFile } from '../src/fileStore.js';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++; }
};

console.log('\nSYMBOL ROUTING');

check('#claim wins and strips itself', () => {
  const r = parseSymbol('#claim DO Mac.pdf');
  assert.equal(r.symbol, '#claim');
  assert.equal(r.spec.category, 'pdf');
  assert.equal(r.spec.folder, 'Claims');
  assert.equal(r.text, 'DO Mac.pdf');
});

check('symbol mid-caption still routes', () => {
  const r = parseSymbol('Ini claim bulan Mac #claim');
  assert.equal(r.symbol, '#claim');
  assert.equal(r.text, 'Ini claim bulan Mac');
});

check('symbol is case-insensitive', () => {
  assert.equal(parseSymbol('#DWG pelan baru').symbol, '#dwg');
});

check('unknown symbol is left alone', () => {
  const r = parseSymbol('#random thing');
  assert.equal(r.symbol, null);
  assert.equal(r.text, '#random thing');
});

check('no symbol, caption untouched', () => {
  const r = parseSymbol('gambar tapak');
  assert.equal(r.symbol, null);
  assert.equal(r.text, 'gambar tapak');
});

check('every symbol points at a real bucket category', () => {
  for (const [sym, spec] of Object.entries(config.fileSymbols)) {
    assert.ok(config.fileCategories[spec.category], `${sym} -> ${spec.category} missing`);
  }
});

console.log('\nDOCUMENT NAME (version key)');

check('date prefix and separators collapse', () => {
  assert.equal(docNameFor({ filename: '02-10-2026_Pelan-Awning.pdf' }), 'pelan awning');
});

check('same name, different case/ext, same key', () => {
  assert.equal(docNameFor({ filename: 'Pelan Awning.PDF' }), 'pelan awning');
  assert.equal(docNameFor({ filename: 'pelan-awning.dwg' }), 'pelan awning');
});

check('unnamed photo has no version identity', () => {
  assert.equal(docNameFor({ filename: '' }), null);
  assert.equal(docNameFor({}), null);
});

check('time-stamp file is not a document name', () => {
  assert.equal(docNameFor({ filename: '14-05-11.jpg' }), null);
});

check('numeric-only name is not a document', () => {
  assert.equal(docNameFor({ filename: '12345.pdf' }), null);
});

console.log('\nSYMBOL BEATS CLASSIFIER');

check('#progress photo is still a photo, but routed', () => {
  const cls = classifyFile({ type: 'image', mimetype: 'image/jpeg', filename: 'a.jpg', caption: '' });
  assert.equal(cls.category, 'photos');
  assert.equal(parseSymbol('#progress tapak').spec.folder, 'Progress');
});

check('#claim on a photo forces the claim bucket', () => {
  const cls = classifyFile({ type: 'image', mimetype: 'image/jpeg', filename: 'resit.jpg', caption: '#claim' });
  // classifier alone says photo (image always wins there)
  assert.equal(cls.category, 'photos');
  // the symbol is what re-routes it, which is the whole point
  assert.equal(parseSymbol('#claim').spec.category, 'pdf');
  assert.equal(parseSymbol('#claim').spec.folder, 'Claims');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);