/**
 * Does the AI actually get told the truth about photos?
 *
 * The original bug: asked "boleh bagi gambar progress?", the bot answered "takde
 * gambar baru" while photos were sitting in the DB - because the model only ever
 * saw recent chat TEXT. This asserts the snapshot we now build contains those
 * records and their photo counts, which is what the prompt tells the model to
 * trust.
 */
import { buildRecordSnapshot } from '../src/recordContext.js';
import { ensureSiteSchema, runInSite, sql, progressDB } from '../src/database.js';
import { getRecordPhotos } from '../src/utils.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

// Pinned to one site: the snapshot must be built inside a site scope, or the
// query layer falls back to the shared public tables and reads another group's
// records.
const [siteRow] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: siteRow.site_name, groupId: siteRow.group_id });
const snap = await buildRecordSnapshot(site);

console.log('--- scope is required ---');
let threwOnMissingSite = false;
try {
  await buildRecordSnapshot(null);
} catch {
  threwOnMissingSite = true;
}
check('buildRecordSnapshot() with no site throws instead of leaking', threwOnMissingSite);

console.log('--- snapshot shape ---');
check('non-empty', snap.trim().length > 0);
check('mentions PROGRESS section', /RECENT PROGRESS/.test(snap));
check('mentions MATERIAL section', /RECENT MATERIAL/.test(snap));
check('mentions ISSUE section', /RECENT ISSUE/.test(snap));
check('mentions ATTENDANCE section', /TODAY ATTENDANCE/.test(snap));
check('no CJK', !/[\u4e00-\u9fff]/.test(snap));
check('bounded (not a data dump)', snap.length < 4000, `${snap.length} chars`);

console.log('\n--- photos reported for records that have them ---');
const recent = await runInSite(site, () => progressDB.getRecent(5));
const withPhotos = recent.filter((r) => getRecordPhotos(r).length > 0);

for (const r of withPhotos) {
  const n = getRecordPhotos(r).length;
  const found = snap.includes(`#${r.id} `) && new RegExp(`\\[${n} photo`).test(
    snap.split('\n').find((l) => l.includes(`#${r.id} `)) || ''
  );
  check(`progress #${r.id} shows [${n} photo(s)]`, found);
}
console.log(`  (${withPhotos.length}/${recent.length} recent progress records have photos)`);

// The specific failure from the bug report: photos exist, so the snapshot must
// NOT let anyone conclude "takde gambar".
const anyPhotoMentioned = /\[\d+ photo\(s\)\]/.test(snap);
check('snapshot surfaces at least one photo count', anyPhotoMentioned || withPhotos.length === 0);

console.log(`\n--- snapshot preview ---\n${snap.slice(0, 700)}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);