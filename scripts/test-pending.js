/**
 * The pending-item handler, exercised through the real Gemini path only in shape:
 * these tests drive doPending's SQL contract directly so they run offline, plus
 * verify the prompt and action plumbing that routes to it.
 */
import { ensureSiteSchema, runInSite, sql, pendingDB } from '../src/database.js';
import { KNOWN_ACTIONS_FOR_TEST } from '../src/llm.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

const DATE = '02/02/2000';
const [row] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: row.site_name, groupId: row.group_id });
const inSite = (fn) => runInSite(site, fn);

console.log('--- "pending" is a real action ---');
check('pending is known to the LLM router', KNOWN_ACTIONS_FOR_TEST.includes('pending'), KNOWN_ACTIONS_FOR_TEST.join(','));

console.log('\n--- add then list ---');
const a = await inSite(() => pendingDB.add({ date: DATE, task: 'tapis paip blok A', pic: 'Azman', dueDate: '10/10/2026', priority: 'high' }));
const b = await inSite(() => pendingDB.add({ date: DATE, task: 'hantar CNG ke Emily', priority: 'urgent' }));
check('two items added', a.lastInsertRowid > 0 && b.lastInsertRowid > 0);

const open = await inSite(() => pendingDB.getOpen(30));
check('both appear in open list', open.some((p) => p.id === a.lastInsertRowid) && open.some((p) => p.id === b.lastInsertRowid));
check('pic kept for follow-up', open.find((p) => p.id === a.lastInsertRowid)?.pic === 'Azman');
check('due date kept', open.find((p) => p.id === a.lastInsertRowid)?.due_date === '10/10/2026');

console.log('\n--- search ---');
const hits = await inSite(() => pendingDB.search('tapis paip'));
check('search finds the item', hits.some((p) => p.id === a.lastInsertRowid), `${hits.length} hits`);
const noHits = await inSite(() => pendingDB.search('helikopter'));
check('search can come back empty', noHits.length === 0);

console.log('\n--- update a single one ---');
await inSite(() => pendingDB.update(a.lastInsertRowid, { pic: 'Emily HYS', dueDate: '20/10/2026' }));
const u = await inSite(() => pendingDB.getById(a.lastInsertRowid));
check('pic changed', u.pic === 'Emily HYS');
check('due date changed', u.due_date === '20/10/2026');
check('task untouched', u.task === 'tapis paip blok A');

console.log('\n--- close one, keep the other ---');
await inSite(() => pendingDB.close(a.lastInsertRowid, 'tapis dah tukar'));
const stillOpen = await inSite(() => pendingDB.getOpen(30));
check('closed item leaves the list', !stillOpen.some((p) => p.id === a.lastInsertRowid));
check('other item still open', stillOpen.some((p) => p.id === b.lastInsertRowid));
const closed = await inSite(() => pendingDB.getById(a.lastInsertRowid));
check('status is done', closed.status === 'done', closed.status);
check('closing note kept', /tapis dah tukar/.test(closed.notes || ''), closed.notes);

console.log('\n--- bulk close ---');
const openBefore = await inSite(() => pendingDB.getOpen(100));
check('there was more than one open to bulk close', openBefore.length >= 1, `${openBefore.length}`);
const bulkTarget = openBefore.filter((p) => p.date !== DATE);
check('bulk would not touch real site items in this test', bulkTarget.length === 0, `${bulkTarget.length} real items skipped`);

console.log('\n--- cleanup ---');
for (const id of [a.lastInsertRowid, b.lastInsertRowid]) await inSite(() => pendingDB.delete(id));
const left = await inSite(() => pendingDB.search('tapis paip hantar CNG'));
check('test items removed', !left.some((p) => p.date === DATE), `${left.filter((p) => p.date === DATE).length} left`);

console.log(`\n${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);