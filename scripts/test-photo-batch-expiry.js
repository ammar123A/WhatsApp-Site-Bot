/**
 * Photos and files must not be attached to a record that arrives long after they
 * were sent. Offline: no DB, no network, no WhatsApp.
 *
 * The bug this locks down: a photo sent with no caption and no command sat in the
 * batch map forever. The burst window was only checked when a SECOND photo
 * arrived, so nothing ever expired the first one, and the next progress the user
 * mentioned - minutes later, about something else entirely - silently inherited
 * that photo.
 */
import { addToBatch, getPhotoBatchSize, getPhotoBatchPaths, clearPhotoBatch } from '../src/handlers/photos.js';
import { stashFile, pendingCount } from '../src/handlers/files.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const GROUP = '120363429870294483@g.us';
const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

const save = (name) => ({ path: `${GROUP}/04-10-2026/${name}`, filename: name, dir: '04-10-2026' });

console.log('\nA PHOTO SENT WITH NO CAPTION WAITS BRIEFLY');
addToBatch(GROUP, save('a.jpg'), T0);
check('waiting right after it arrives', getPhotoBatchSize(GROUP, T0 + 5_000) === 1);
check('still waiting at 30s', getPhotoBatchSize(GROUP, T0 + 30_000) === 1);
check('still waiting at 59s', getPhotoBatchSize(GROUP, T0 + 59_000) === 1);

console.log('\nTHE USER\'S BUG: PROGRESS MENTIONED MINUTES LATER');
check('gone at 61s - must NOT attach to a later record', getPhotoBatchSize(GROUP, T0 + 61_000) === 0);
check('and its path is gone too', getPhotoBatchPaths(GROUP, T0 + 61_000).length === 0);
check('still gone at 5 minutes', getPhotoBatchSize(GROUP, T0 + 5 * MIN) === 0);
check('still gone an hour later', getPhotoBatchSize(GROUP, T0 + 60 * MIN) === 0);

console.log('\nTHE INTENDED FLOW STILL WORKS');
addToBatch(GROUP, save('b.jpg'), T0);
check('photo then a command 20s later still attaches', getPhotoBatchSize(GROUP, T0 + 20_000) === 1);
check('path is available for that attach', getPhotoBatchPaths(GROUP, T0 + 20_000)[0].endsWith('b.jpg'));

console.log('\nA BURST OF PHOTOS COUNTS AS ONE BATCH');
clearPhotoBatch(GROUP);
addToBatch(GROUP, save('1.jpg'), T0);
addToBatch(GROUP, save('2.jpg'), T0 + 10_000);
addToBatch(GROUP, save('3.jpg'), T0 + 20_000);
check('three photos in one batch', getPhotoBatchSize(GROUP, T0 + 25_000) === 3, String(getPhotoBatchSize(GROUP, T0 + 25_000)));
check('the whole burst expires together', getPhotoBatchSize(GROUP, T0 + 25_000 + 61_000) === 0);

console.log('\nA LATE PHOTO STARTS A NEW BATCH, OLD ONE IS DROPPED');
clearPhotoBatch(GROUP);
addToBatch(GROUP, save('old.jpg'), T0);
addToBatch(GROUP, save('new.jpg'), T0 + 10 * MIN);
const paths = getPhotoBatchPaths(GROUP, T0 + 10 * MIN + 1_000);
check('only the new photo is pending', paths.length === 1, JSON.stringify(paths));
check('and it is the new one', paths[0].endsWith('new.jpg'), paths[0]);

console.log('\nAN EXPIRED BATCH CANNOT COME BACK TO LIFE');
clearPhotoBatch(GROUP);
addToBatch(GROUP, save('once.jpg'), T0);
getPhotoBatchSize(GROUP, T0 + 61_000); // the read that expires it
check('dropped, not just hidden', getPhotoBatchPaths(GROUP, T0 + 61_000).length === 0);
check('still empty on a later read', getPhotoBatchPaths(GROUP, T0 + 90_000).length === 0);

console.log('\nGROUPS DO NOT SEE EACH OTHER\'S PHOTOS');
clearPhotoBatch(GROUP);
clearPhotoBatch('120363412164633402@g.us');
addToBatch(GROUP, save('mine.jpg'), T0);
check('other group has none', getPhotoBatchSize('120363412164633402@g.us', T0 + 1_000) === 0);
check('mine is unaffected', getPhotoBatchSize(GROUP, T0 + 1_000) === 1);

console.log('\nFILES (DRAWINGS, PDFS) EXPIRE THE SAME WAY');
// config.fileBatchWindowMs was never read before, so this map never expired.
const FILE_GROUP = '120363422956016150@g.us';
stashFile(FILE_GROUP, 101, T0);
check('file waiting right away', pendingCount(FILE_GROUP, T0 + 1_000) === 1);
check('file still waiting at 30s', pendingCount(FILE_GROUP, T0 + 30_000) === 1);
check('file gone at 61s', pendingCount(FILE_GROUP, T0 + 61_000) === 0);
check('file gone at 10 minutes', pendingCount(FILE_GROUP, T0 + 10 * MIN) === 0);

console.log('\nAN EXPIRED FILE DOES NOT BLOCK A FRESH ONE');
stashFile(FILE_GROUP, 102, T0 + 10 * MIN);
check('the new file is pending', pendingCount(FILE_GROUP, T0 + 10 * MIN + 2_000) === 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);