/**
 * Remove leftover auto-saved probe files from Supabase Storage and the site_files
 * index. Deletes BOTH the object and its row so nothing half-removed is left.
 *
 *   node scripts/purge-files.js            -> delete file.bin and any ZZ-CHECK-*
 *   node scripts/purge-files.js --all      -> delete every site_files row + object
 *   node scripts/purge-files.js drawings  -> only that category
 */
import * as db from '../src/database.js';
import config from '../config.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const onlyCategory = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry');

const SITES = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

/**
 * Junk = our own probe files, plus anything still named .bin.
 *
 * Check the path too, not just original_name: rows created while the mimetype
 * was missing stored no original_name at all, so a name-only test walked right
 * past them.
 */
function isJunk(row) {
  const name = String(row.original_name || '');
  const path = String(row.path || '');
  if (all) return true;
  if (name === 'file.bin' || name.startsWith('ZZ-CHECK-')) return true;
  if (path.includes('ZZ-CHECK-')) return true;
  return /\.bin$/i.test(name) || /\.bin$/i.test(path);
}

async function deleteObject(bucket, key) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
  });
  return res.ok || res.status === 404;
}

let removedRows = 0;
let removedObjects = 0;
let failed = 0;

for (const s of SITES) {
  const site = await db.ensureSiteSchema(s);
  const rows = await db.runInSite(site, async () => {
    const allRows = await db.filesDB.getRecent(500);
    if (onlyCategory) return allRows.filter((r) => r.category === onlyCategory);
    return allRows;
  });

  const targets = rows.filter(isJunk);
  if (!targets.length) {
    console.log(`${s.siteName}: nothing to purge`);
    continue;
  }

  for (const row of targets) {
    const label = `#${row.id} ${row.category} ${row.path}`;
    if (DRY) {
      console.log(`  [dry] would delete ${label}`);
      continue;
    }
    const objOk = await deleteObject(row.bucket, row.path);
    if (!objOk) {
      failed++;
      console.error(`  ✗ object not deleted: ${label}`);
      continue;
    }
    await db.runInSite(site, () => db.filesDB.delete(row.id));
    removedObjects++;
    removedRows++;
    console.log(`  ✓ deleted ${label}`);
  }
}

console.log(`\n${removedRows} row(s) + ${removedObjects} object(s) removed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);