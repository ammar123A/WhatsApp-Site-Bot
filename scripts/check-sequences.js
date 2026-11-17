// Reports each table's identity sequence vs its real max(id).
// The gap between them is what causes "duplicate key value violates unique
// constraint issues_pkey" on the next insert.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

const TABLES = ['progress', 'materials', 'issues', 'work_orders', 'attendance', 'diary', 'milestones'];
const sites = await db.listSiteSchemas();
if (!sites.length) console.log('no site schemas yet');

let broken = 0;
for (const site of sites) {
  console.log(`\n${site.site_name}  (${site.schema_name})`);
  for (const t of TABLES) {
    const r = await db.sql.unsafe(`
      select
        (select coalesce(max(id), 0) from "${site.schema_name}"."${t}") as max_id,
        (select last_value from "${site.schema_name}"."${t}_id_seq") as next_id
    `);
    const maxId = r[0].max_id;
    const nextId = r[0].next_id;
    const ok = nextId > maxId;
    if (!ok) broken++;
    console.log(`  ${t.padEnd(12)} max id ${String(maxId).padEnd(5)} next ${String(nextId).padEnd(6)} ${ok ? 'ok' : '<-- WILL COLLIDE'}`);
  }
}

console.log(`\n${broken} table(s) would collide on the next insert.`);
process.exit(0);