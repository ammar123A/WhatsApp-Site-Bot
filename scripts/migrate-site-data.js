// One-off: move the records from the old SHARED tables (public.progress,
// public.issues, ...) into the site schema that owns them.
//
// Nothing is deleted - public.* is left exactly as it is, so this can be undone.
// Which group the data came from is passed in, because guessing would file the
// history under the wrong site.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

const SITE_NAME = process.argv[2] || 'Myself Group';
const GROUP_ID = process.argv[3] || '120363429870294483@g.us';

if (!process.argv[2]) {
  console.log('usage: node scripts/migrate-site-data.js "<site name>" "<group id>"');
  console.log('Example (the group the records were created in):');
  console.log('  node scripts/migrate-site-data.js "Myself Group" "120363429870294483@g.us"');
  process.exit(1);
}

console.log(`target site : ${SITE_NAME}`);
console.log(`group id    : ${GROUP_ID}\n`);

const before = await db.sql`
  select
    (select count(*) from public.progress)   as progress,
    (select count(*) from public.materials)  as materials,
    (select count(*) from public.issues)     as issues,
    (select count(*) from public.work_orders) as work_orders,
    (select count(*) from public.attendance) as attendance,
    (select count(*) from public.diary)      as diary,
    (select count(*) from public.milestones) as milestones
`;
console.log('rows in the shared tables right now:', before[0]);

const { schema, copied } = await db.migratePublicTablesToSite({ siteName: SITE_NAME, groupId: GROUP_ID });
console.log(`\nmigrated into schema: ${schema}\n`);
for (const c of copied) console.log(`  ${c.table.padEnd(12)} ${c.copied} row(s)`);

const after = await db.sql`
  select
    (select count(*) from public.progress) as progress,
    (select count(*) from public.issues) as issues,
    (select count(*) from public.attendance) as attendance,
    (select count(*) from public.diary) as diary
`;
console.log('\nshared tables after the move (should be unchanged):', after[0]);

console.log('\npublic.* is untouched - nothing was deleted.');
console.log(`Other sites now start empty. Every site schema is listed in public.sites.`);
process.exit(0);