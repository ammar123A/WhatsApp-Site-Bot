// Progress report format + reporter auto-detect (pure, no DB).
import { buildProgressMessage, getRecordPhotos, getSenderName, parseArgs } from '../src/utils.js';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

console.log('--- progress report is simple now ---');
const out = buildProgressMessage([
  { id: 7, category: 'Site Update', description: 'pasang paip atas bumbung dah siap', percentage: 50, location: 'Blok A', reported_by: 'Azman', photos: JSON.stringify(['a.jpg', 'b.jpg']) },
  { id: 8, category: 'Site Update', description: 'cat dinding siap', percentage: 0, location: null, reported_by: 'Ali', photo: 'c.jpg', photos: null },
]);
console.log(out);

check('no percentage shown', out.includes('%'), false);
check('no [Category] tag', /\[Site Update\]/.test(out), false);
check('no "Average Progress"', /Average/i.test(out), false);
check('description shown', out.includes('pasang paip atas bumbung dah siap'), true);
check('location shown', out.includes('Blok A'), true);
check('reporter shown', out.includes('Azman'), true);
check('2 photos counted', out.includes('2 photos'), true);
check('legacy single photo counted', out.includes('1 photo'), true);
check('no fake location line for entry 2', (out.match(/📍/g) || []).length, 1);

console.log('\n--- reporter auto-detect ---');
check('notifyName preferred', getSenderName({ _data: { notifyName: 'Azman', pushname: 'az123' } }), 'Azman');
check('pushname fallback', getSenderName({ _data: { notifyName: '', pushname: 'Ali' } }), 'Ali');
check('no name -> null', getSenderName({ _data: {} }), null);
check('no _data -> null', getSenderName({}), null);
check('whitespace trimmed', getSenderName({ _data: { notifyName: '  spaced  ' } }), 'spaced');

console.log('\n--- photo column handling ---');
check('JSON array parsed', getRecordPhotos({ photos: '["a","b"]' }).length, 2);
check('legacy photo column', getRecordPhotos({ photo: 'c.jpg' }).length, 1);
check('photos wins over photo', getRecordPhotos({ photos: '["a"]', photo: 'b.jpg' }).length, 1);
check('nothing -> empty', getRecordPhotos({}).length, 0);

console.log('\n--- new .addprogress args ---');
const a = parseArgs('.addprogress\nDescription: siap\nLocation: Blok A', 1);
check('description parsed', a.description, 'siap');
check('location parsed', a.location, 'Blok A');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);