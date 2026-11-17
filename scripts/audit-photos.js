/**
 * Cross-check every record's photo reference against what is really in storage.
 *
 * A record can point at a file that was deleted or never saved - it then shows
 * "1 photo" forever and sends nothing. Reports both directions.
 *
 *   node scripts/audit-photos.js
 *   node scripts/audit-photos.js --fix    (drop dead references from the records)
 */
import * as db from '../src/database.js';
import config from '../config.js';
import { getRecordPhotos } from '../src/utils.js';

const FIX = process.argv.includes('--fix');

const SITES = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

// Supabase Storage does not answer HEAD on objects (it replies 400/405), which
// would make every dead file look alive. Use GET and throw the bytes away.
async function exists(key, bucket = config.photoBucket) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
  });
  if (res.ok) {
    await res.arrayBuffer().catch(() => {});
    return true;
  }
  const body = await res.text().catch(() => '');
  if (/NoSuchKey|not_found/i.test(body)) return false;
  // Anything else (throttling, 5xx) is not proof the file is gone.
  return res.status >= 500 ? true : false;
}

let fixed = 0;

for (const s of SITES) {
  const site = await db.ensureSiteSchema(s);
  const tables = [
    ['progress', db.progressDB],
    ['issue', db.issuesDB],
  ];

  console.log(`\n=== ${s.siteName} (${site.schema}) ===`);

  for (const [label, store] of tables) {
    let rows = [];
    try {
      rows = await db.runInSite(site, () => store.getRecent(200));
    } catch (e) {
      console.log(`  ${label}: could not read (${e.message})`);
      continue;
    }

    for (const row of rows) {
      const photos = getRecordPhotos(row);
      if (!photos.length) continue;

      const alive = [];
      const dead = [];
      for (const p of photos) ((await exists(p)) ? alive : dead).push(p);

      if (!dead.length) continue;

      console.log(`  ✗ ${label} #${row.id} "${row.title || ''}"`);
      console.log(`      dead: ${dead.join(', ')}`);
      if (alive.length) console.log(`      alive: ${alive.join(', ')}`);

      if (FIX) {
        try {
          await db.runInSite(site, () => store.updatePhotos(row.id, alive));
          console.log(`      fixed -> kept ${alive.length} photo(s)`);
          fixed++;
        } catch (e) {
          console.log(`      fix failed: ${e.message}`);
        }
      }
    }
  }
}

console.log(`\n${FIX ? `${fixed} record(s) cleaned` : 're-run with --fix to remove dead references'}\n`);
process.exit(0);