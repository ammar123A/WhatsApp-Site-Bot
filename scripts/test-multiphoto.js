// Standalone test for multi-photo schema + helpers (no WhatsApp connection needed)
import { progressDB, materialsDB, issuesDB } from '../src/database.js';
import { getRecordPhotos, replyWithPhoto } from '../src/utils.js';

let failed = false;
const ok = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed = true;
};

// 1. photos column exists on all three tables
for (const [label, db] of [['progress', progressDB], ['materials', materialsDB], ['issues', issuesDB]]) {
  const row = db.getRecent(1)[0];
  ok(`${label}.photos column readable`, row === undefined || 'photos' in row);
}

// 2. updatePhotos + read back round-trip (progress)
const before = progressDB.getRecent(1)[0];
let targetId;
if (before) {
  targetId = before.id;
} else {
  const ins = progressDB.add({ date: '01/01/2026', category: 'Test', description: 'multiphoto test', percentage: 0, location: null, reportedBy: null, photo: null });
  targetId = Number(ins.lastInsertRowid);
}
progressDB.updatePhotos(targetId, ['data/photos/2026-09-24/a.jpg', 'data/photos/2026-09-24/b.jpg']);
const after = progressDB.getById(targetId);
ok('updatePhotos stores JSON array', typeof after.photos === 'string' && after.photos.includes('a.jpg') && after.photos.includes('b.jpg'));
ok('getRecordPhotos parses photos JSON', JSON.stringify(getRecordPhotos(after)) === JSON.stringify(['data/photos/2026-09-24/a.jpg', 'data/photos/2026-09-24/b.jpg']));

// 3. legacy single-path photo column still works
ok('getRecordPhotos falls back to photo', JSON.stringify(getRecordPhotos({ photo: 'data/photos/x.jpg', photos: null })) === '["data/photos/x.jpg"]');
ok('getRecordPhotos empty', getRecordPhotos(null).length === 0 && getRecordPhotos({}).length === 0);

// 4. replyWithPhoto accepts callable input shapes without throwing (paths won't exist -> text path)
const mockMsg = { from: 'x@g.us', to: 'y@g.us', reply: async () => 'ok', client: { sendMessage: async () => 'sent' } };
try {
  await replyWithPhoto(mockMsg, 'hello', undefined);
  await replyWithPhoto(mockMsg, 'hello', 'data/photos/missing.jpg');
  await replyWithPhoto(mockMsg, 'hello', ['data/photos/missing-a.jpg', 'data/photos/missing-b.jpg']);
  ok('replyWithPhoto accepts string/array/undefined', true);
} catch (e) {
  ok('replyWithPhoto accepts string/array/undefined', false);
  console.log('  →', e.message);
}

if (!failed) console.log('\nAll multi-photo tests passed.');
else { console.log('\nSome tests FAILED.'); process.exitCode = 1; }