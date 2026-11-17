// Photo batching: 1-minute window, per group, attach-all to one record.
// Pure in-memory test - no DB writes, no WhatsApp.
import {
  addToBatch, getPhotoBatch, getPhotoBatchSize, getPhotoBatchPaths,
  attachPendingPhotos, clearPhotoBatch, batchWindowMs,
} from '../src/handlers/photos.js';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
}

const G1 = '111@g.us';
const G2 = '222@g.us';
const WINDOW = batchWindowMs(G1);
check('window is 1 minute', WINDOW, 60 * 1000);

const T = 1_000_000;
const p = n => ({ path: `photos/${n}.jpg`, filename: `${n}.jpg`, dir: `2026-09-30_${n}` });

// The burst window is measured against real time, so a test that seeds fake
// timestamps has to read back against the same clock. `now` tracks the newest
// photo seeded so far, which is "immediately after that photo arrived".
let now = T;
function add(scope, saved, at) {
  addToBatch(scope, saved, at);
  now = at;
}

console.log('\n--- 5 photos sent straight = ONE batch of 5 ---');
for (let i = 1; i <= 5; i++) add(G1, p(i), T + i * 3000); // 3s apart
check('batch size', getPhotoBatchSize(G1, now), 5);
check('all 5 paths kept', getPhotoBatchPaths(G1, now).length, 5);
check('paths are distinct', new Set(getPhotoBatchPaths(G1, now)).size, 5);

console.log('\n--- after 1 minute, new photo starts a NEW batch ---');
add(G1, p(6), T + 5 * 3000 + WINDOW + 1000);
check('old batch dropped, new batch has 1', getPhotoBatchSize(G1, now), 1);
check('new batch holds only photo 6', getPhotoBatchPaths(G1, now)[0], 'photos/6.jpg');

console.log('\n--- the window is measured from the PREVIOUS photo, not the first ---');
clearPhotoBatch(G1);
add(G1, p(1), T);
add(G1, p(2), T + WINDOW - 1000);      // 1s before expiry -> joins
check('photo 2 joined (within 1 min of photo 1)', getPhotoBatchSize(G1, now), 2);
add(G1, p(3), T + WINDOW + 60_000);    // 61s after photo 2 -> new batch
check('photo 3 started a new batch', getPhotoBatchSize(G1, now), 1);
check('only photo 3 remains', getPhotoBatchPaths(G1, now)[0], 'photos/3.jpg');

console.log('\n--- exactly 1 min later still counts as the same burst ---');
clearPhotoBatch(G1);
add(G1, p(1), T);
add(G1, p(2), T + WINDOW);             // exactly 60000ms, not "more than"
check('same batch at exactly 1 min', getPhotoBatchSize(G1, now), 2);

console.log('\n--- groups never share photos ---');
clearPhotoBatch(G1);
clearPhotoBatch(G2);
add(G1, p(1), T);
add(G1, p(2), T + 1000);
add(G2, p(9), T + 2000);
check('group1 has 2', getPhotoBatchSize(G1, now), 2);
check('group2 has 1', getPhotoBatchSize(G2, now), 1);
check('group2 batch is only its own photo', getPhotoBatchPaths(G2, now)[0], 'photos/9.jpg');

console.log('\n--- attach drains only that group ---');
const attached = [];
const fakeTable = { updatePhotos: async (id, paths) => { attached.push({ id, paths }); return { changes: 1 }; } };
check('group2 batch not touched', await attachPendingPhotos(fakeTable, 5, G1, now), 2);
check('paths written to record', attached[0].paths.length, 2);
check('group1 drained after attach', getPhotoBatchSize(G1, now), 0);
check('group2 still has its photo', getPhotoBatchSize(G2, now), 1);

console.log('\n--- attach on empty batch is a safe no-op ---');
check('returns 0', await attachPendingPhotos(fakeTable, 6, G1, now), 0);
check('no second DB call', attached.length, 1);

console.log('\n--- failed attach keeps the batch (user can retry) ---');
clearPhotoBatch(G1);
add(G1, p(1), T);
const badTable = { updatePhotos: async () => ({ changes: 0 }) };
check('returns 0 on missing record', await attachPendingPhotos(badTable, 999, G1, now), 0);
check('batch preserved for retry', getPhotoBatchSize(G1, now), 1);

console.log('\n--- batch is capped ---');
clearPhotoBatch(G1);
for (let i = 0; i < 30; i++) add(G1, p(i), T + i * 100);
check('capped at 20', getPhotoBatchSize(G1, now), 20);
check('keeps the newest 20', getPhotoBatchPaths(G1, now).at(-1), 'photos/29.jpg');

console.log('\n--- getPhotoBatch returns a copy, oldest first ---');
clearPhotoBatch(G1);
add(G1, p(1), T);
add(G1, p(2), T + 1000);
const b = getPhotoBatch(G1, now);
const expectedOrder = b.map(x => x.path);
const sorted = [...b].sort((a, c) => a.msgTime - c.msgTime).map(x => x.path);
check('ordered oldest -> newest', JSON.stringify(b.map(x => x.path)), JSON.stringify(sorted));
b.push({ path: 'fake' });
check('returned copy, not live state', getPhotoBatchSize(G1, now), 2);
check('original order preserved', JSON.stringify(getPhotoBatchPaths(G1, now)), JSON.stringify(expectedOrder));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
