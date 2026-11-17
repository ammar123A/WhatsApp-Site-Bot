/**
 * Prove the filing index really exists in every site schema and that a row can
 * be written, searched, linked and removed. Writes only its own test row and
 * always deletes it at the end.
 */
import * as db from '../src/database.js';

const SITES = [
  { siteName: 'Myself Group', groupId: '120363429870294483@g.us' },
  { siteName: 'AE WORKS', groupId: '120363422956016150@g.us' },
  { siteName: 'SiteMate', groupId: '120363412164633402@g.us' },
];

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

for (const s of SITES) {
  console.log(`\n${s.siteName}`);
  const site = await db.ensureSiteSchema(s);
  console.log(`  schema ${site.schema}`);

  await db.runInSite(site, async () => {
    const cols = await db.sql`
      select column_name from information_schema.columns
      where table_schema = ${site.schema} and table_name = 'site_files'
      order by column_name`;
    check('site_files table exists', cols.length > 0);
    const names = cols.map((c) => c.column_name);
    for (const want of ['id', 'date', 'category', 'bucket', 'path', 'link_type', 'link_id']) {
      check(`has ${want}`, names.includes(want), names.join(','));
    }
  });
}

// One real round trip in the first site only.
console.log('\nWRITE / SEARCH / LINK / DELETE (Myself Group only)');
await db.runInSite(await db.ensureSiteSchema(SITES[0]), async () => {
  const res = await db.filesDB.add({
    date: '03/10/2026',
    category: 'drawings',
    bucket: 'site-drawings',
    path: 'Myself Group/03-10-2026/TEST-DRAWING-AS-BUILT.pdf',
    originalName: 'TEST-DRAWING-AS-BUILT.pdf',
    mimetype: 'application/pdf',
    sizeBytes: 1234,
    classifiedBy: 'filename says drawing',
    sender: 'tester',
    caption: 'test row',
  });
  const id = res.lastInsertRowid;
  check('row has an id', !!id, String(id));

  const got = await db.filesDB.getById(id);
  check('read back by id', got && got.id === id);
  check('category stored', got.category === 'drawings');
  check('path stored', got.path.includes('TEST-DRAWING-AS-BUILT.pdf'));

  const found = await db.filesDB.search('AS-BUILT');
  check('found by name search', found.some((f) => f.id === id));

  const byDate = await db.filesDB.getByDate('03/10/2026');
  check('found by date', byDate.some((f) => f.id === id));

  await db.filesDB.link(id, 'material', 8);
  const linked = await db.filesDB.getByLink('material', 8);
  check('linked to a record', linked.some((f) => f.id === id));

  await db.filesDB.delete(id);
  const gone = await db.filesDB.getById(id);
  check('cleaned up', !gone);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);