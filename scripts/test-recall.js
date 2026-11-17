/**
 * Keyword recall must find OLD records, not just the recent ones.
 *
 * Before this, the bot only ever saw the last few records, so "pasti issue
 * paip" or "cari progress blok A" answered "takde" while the record sat there
 * months old. Also guards the site scope: an unscoped call used to fall back to
 * the shared public tables and read another site's data.
 */
import { buildRecordSnapshot, recallRecords, keywords } from '../src/recordContext.js';
import { ensureSiteSchema, runInSite, sql, pendingDB, progressDB } from '../src/database.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

// Pin to SiteMate, the busiest site, so there is something to find.
const [row] = await sql`SELECT site_name, schema_name, group_id FROM public.sites WHERE schema_name = 'site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: row.site_name, groupId: row.group_id });

// Insert an OLD, distinctive progress record so recall has to go digging.
// Written inside runInSite so it lands in SiteMate's schema, not public.
const OLD_DATE = '15/03/2026';
const seedId = (
  await runInSite(site, () =>
    progressDB.add({
      date: OLD_DATE,
      category: 'Site Update',
      description: 'kipas guardhouse zinc sheet ditukar',
      percentage: 0,
      location: 'Guardhouse',
      reportedBy: 'Rep',
    })
  )
).lastInsertRowid;

// Every write goes through runInSite so it lands in this site's schema.
const seedPending = await runInSite(site, () =>
  pendingDB.add({
    date: OLD_DATE,
    task: 'kipas guardhouse zinc sheet ditukar',
    pic: 'Azman',
    location: 'Guardhouse',
    status: 'open',
    raisedBy: 'boss hue hy',
  })
);

console.log('--- keywords: content words only ---');
check('drops stopwords', JSON.stringify(keywords('boss tolong cari paip')) === '["cari","paip"]', JSON.stringify(keywords('boss tolong cari paip')));
check('drops short words', !keywords('ok ok paip').includes('ok'));
check('keeps real terms', keywords('paip bumbung blok').includes('bumbung'));
check('caps at 5', keywords('satu dua tiga empat lima enam tujuh').length <= 5);

console.log('\n--- recall finds the OLD record by keyword ---');
const byWord = await recallRecords(site, 'kipas guardhouse zinc sheet');
check('recall block mentions MATCHING', /MATCHING/.test(byWord), byWord.slice(0, 80));
check('found the seeded progress', byWord.includes(`#${seedId}`), byWord.slice(0, 200));
check('found the pending item too', byWord.includes(`#${seedPending.lastInsertRowid}`));

console.log('\n--- recall by location ---');
const byLoc = await recallRecords(site, 'guardhouse');
check('location search works', byLoc.includes(`#${seedId}`));

console.log('\n--- no match says so plainly ---');
const miss = await recallRecords(site, 'zzzqqqnope');
check('states NO RECORD MATCHES', /NO RECORD MATCHES/.test(miss), miss.slice(0, 90));
check('tells it not to guess', /do not guess/i.test(miss));

console.log('\n--- filler words do not trigger a search ---');
const filler = await recallRecords(site, 'ok boss tq');
check('filler-only returns nothing', filler === '' || /NO RECORD MATCHES/.test(filler), JSON.stringify(filler.slice(0, 60)));

console.log('\n--- scope is enforced ---');
let threw = false;
try {
  await buildRecordSnapshot(null);
} catch {
  threw = true;
}
check('buildRecordSnapshot rejects a missing site', threw);
let recalledNoScope = '';
try {
  recalledNoScope = await recallRecords({ schema: null }, 'kipas');
} catch {
  recalledNoScope = '';
}
check('recall rejects a missing site', recalledNoScope === '');

console.log('\n--- snapshot is scoped to this site ---');
const snap = await buildRecordSnapshot(site);
check('snapshot has progress section', /RECENT PROGRESS/.test(snap));
check('snapshot stays small', snap.length < 4000, `${snap.length} chars`);

console.log('\n--- cleanup ---');
// Through the DB objects, not raw sql: only q() applies SET LOCAL search_path,
// so sql.unsafe would hit the shared public tables instead.
await runInSite(site, () => progressDB.delete(seedId));
await runInSite(site, () => pendingDB.delete(seedPending.lastInsertRowid));
const gone = await runInSite(site, () => progressDB.getById(seedId));
check('seed progress removed', gone == null, JSON.stringify(gone || null));

console.log(`\n${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);