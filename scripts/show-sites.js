// Shows what each site's own database currently holds. Read-only.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

const rows = await db.listSiteSchemas();
if (!rows.length) console.log('no site schemas yet');

const TABLES = ['progress', 'materials', 'issues', 'work_orders', 'attendance', 'diary', 'milestones'];

for (const site of rows) {
  const counts = {};
  let any = 0;
  for (const t of TABLES) {
    const res = await db.sql.unsafe(
      `select count(*)::int as c from "${site.schema_name}"."${t}"`
    );
    counts[t] = res[0].c;
    any += res[0].c;
  }
  console.log(`\n${site.site_name}`);
  console.log(`  schema : ${site.schema_name}`);
  console.log(`  group  : ${site.group_id || '-'}`);
  console.log(`  total  : ${any} record(s)`);
  for (const t of TABLES) console.log(`    ${t.padEnd(12)} ${counts[t]}`);
  console.log(any === 0 ? '  -> empty, waiting for its first record' : '');
}

// The old shared tables, still there as a backup.
const shared = {};
for (const t of TABLES) {
  const res = await db.sql.unsafe(`select count(*)::int as c from public."${t}"`);
  shared[t] = res[0].c;
}
console.log('\nold shared tables in public (untouched backup):');
console.log('  ' + JSON.stringify(shared));

process.exit(0);