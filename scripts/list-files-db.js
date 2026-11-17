/**
 * Show what the site_files index actually contains, per site. Answers "is there
 * a row for that .bin, or is the object orphaned in storage?".
 *
 *   node scripts/list-files-db.js
 */
import * as db from '../src/database.js';

const SITES = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

for (const s of SITES) {
  const site = await db.ensureSiteSchema(s);
  const rows = await db.runInSite(site, () => db.filesDB.getRecent(100));
  console.log(`\n=== ${s.siteName} (${site.schema}) — ${rows.length} row(s) ===`);
  if (!rows.length) {
    console.log('  (empty)');
    continue;
  }
  for (const r of rows) {
    console.log(
      `  #${r.id}  ${String(r.category).padEnd(9)} ${String(r.mimetype || '(no mime)').padEnd(26)} ${r.path}`,
    );
    if (r.linked_type) console.log(`        linked -> ${r.linked_type} #${r.linked_id}`);
  }
}
console.log();