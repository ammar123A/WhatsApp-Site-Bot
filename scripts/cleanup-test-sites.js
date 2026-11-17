// Drops leftover TEST site schemas (names starting with site_seq_test_site_ or
// site_isolation_site_) that a crashed test run can leave behind.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

const rows = await db.sql`
  select schema_name from information_schema.schemata
  where schema_name like 'site\_%'
    and (schema_name like 'site\_seq\_test\_site\_%'
      or schema_name like 'site\_isolation\_site\_%')
`;

if (!rows.length) {
  console.log('no leftover test schemas');
  process.exit(0);
}

for (const { schema_name: name } of rows) {
  await db.sql`drop schema if exists ${db.sql(name)} cascade`;
  await db.sql`delete from public.sites where schema_name = ${name}`;
  console.log('dropped', name);
}
process.exit(0);