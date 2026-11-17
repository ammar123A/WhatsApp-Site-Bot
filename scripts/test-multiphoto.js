// Standalone test for multi-photo schema + helpers (no WhatsApp connection needed)
//
// Two fixes over the original:
//  - pinned to one site schema and wrapped in runInSite, so it cannot read or
//    write another group's data (unscoped calls silently hit public)
//  - sql.end() at the end, otherwise the postgres pool keeps the process alive
//    forever and the run looks like a hang
import { ensureSiteSchema, runInSite, sql, progressDB, materialsDB, issuesDB } from '../src/database.js';
import { getRecordPhotos, replyWithPhoto } from '../src/utils.js';

let failed = false;
const ok = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed = true;
};

const [row] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: row.site_name, groupId: row.group_id });
const inSite = (fn) => runInSite(site, fn);

// 1. photos column exists on all three tables
for (const [label, db] of [['progress', progressDB], ['materials', materialsDB], ['issues', issuesDB]]) {
  const rows = await inSite(() => db.getRecent(1));
  ok(`${label}.photos column readable`, rows.length === 0 || 'photos' in rows[0]);
}

// 2. updatePhotos + read back round-trip, on our own probe row so real site
//    photos are never touched.
const probe = await inSite(() =>
  progressDB.add({ date: '01/01/2026', category: 'Test', description: 'multiphoto test', percentage: 0 })
);
const targetId = probe.lastInsertRowid;
await inSite(() => progressDB.updatePhotos(targetId, ['data/photos/2026-09-24/a.jpg', 'data/photos/2026-09-24/b.jpg']));
const after = await inSite(() => progressDB.getById(targetId));
ok('updatePhotos stores JSON array', typeof after.photos === 'string' && after.photos.includes('a.jpg') && after.photos.includes('b.jpg'));
ok(
  'getRecordPhotos parses photos JSON',
  JSON.stringify(getRecordPhotos(after)) === JSON.stringify(['data/photos/2026-09-24/a.jpg', 'data/photos/2026-09-24/b.jpg']),
  JSON.stringify(getRecordPhotos(after))
);
ok('two photos on one record', getRecordPhotos(after).length === 2);

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

await inSite(() => progressDB.delete(targetId));
const gone = await inSite(() => progressDB.getById(targetId));
ok('probe row cleaned up', gone == null);

if (!failed) console.log('\nAll multi-photo tests passed.');
else {
  console.log('\nSome tests FAILED.');
  process.exitCode = 1;
}
await sql.end();