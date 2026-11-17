/**
 * Migrate old category-bucket objects into the site-bucket layout:
 *   <site-bucket>/<category>/<DD-MM-YYYY>/<file>
 *
 * Dry-run by default. Add --apply to copy objects and update site_files rows.
 * The old objects are intentionally retained as a recoverable backup.
 */
import * as db from '../src/database.js';
import { categoryFolderFor, siteBucketName } from '../src/fileStore.js';
import { ensureBucket, uploadPhoto, downloadPhoto } from '../src/photoStore.js';

const APPLY = process.argv.includes('--apply');
const SITES = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

function asDate(value) {
  const [dd, mm, yyyy] = String(value || '').split('/').map(Number);
  return dd && mm && yyyy ? new Date(yyyy, mm - 1, dd) : new Date();
}

async function copyObject(row, siteName) {
  const targetBucket = siteBucketName(siteName);
  const filename = String(row.path || row.original_name || '').split('/').pop();
  const folder = categoryFolderFor(siteName, row.category, asDate(row.date));
  const targetPath = `${folder}/${filename}`;

  if (!APPLY) {
    console.log(`[dry-run] #${row.id} ${row.bucket}/${row.path} -> ${targetBucket}/${targetPath}`);
    return;
  }

  const source = await downloadPhoto(row.path, row.bucket);
  if (!source) throw new Error(`download ${row.bucket}/${row.path}: object not found`);
  const bytes = Buffer.from(source.data, 'base64');
  await ensureBucket(targetBucket);
  await uploadPhoto(targetPath, bytes, row.mimetype || 'application/octet-stream', true, targetBucket);
  await db.filesDB.updateStorageLocation(row.id, targetBucket, targetPath, folder);
  console.log(`[migrated] #${row.id} -> ${targetBucket}/${targetPath}`);
}

for (const siteInfo of SITES) {
  const site = await db.ensureSiteSchema(siteInfo);
  const rows = await db.runInSite(site, () => db.filesDB.getRecent(10000));
  console.log(`\n${APPLY ? 'Migrating' : 'Planning'} ${siteInfo.siteName}: ${rows.length} file row(s)`);
  for (const row of rows) {
    await db.runInSite(site, () => copyObject(row, siteInfo.siteName));
  }
}

console.log(APPLY ? '\nMigration complete. Old objects were retained.' : '\nDry-run only. Re-run with --apply to migrate.');
