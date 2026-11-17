/**
 * Pending items must survive a restart and be searchable, and the DDL must be
 * applied to schemas that already exist.
 */
import { ensureSiteSchema, runInSite, sql, chatLogDB, pendingDB } from '../src/database.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

const DATE = '01/01/2000'; // never collides with real site data
const createdChat = [];
const createdPending = [];
const sites = (await sql`SELECT site_name, schema_name, group_id FROM public.sites ORDER BY schema_name`).filter(
  (s) => s.schema_name !== 'site_unknown_site_5951bb'
);
const site = await ensureSiteSchema({ siteName: sites[0].site_name, groupId: sites[0].group_id });
const inSite = (fn) => runInSite(site, fn);

console.log('--- schema version stamped ---');
const ver = await sql.unsafe(`SELECT value FROM "${site.schema}".schema_meta WHERE key = 'version'`);
check('version row exists', ver.length === 1);
check('version is a number >= 3', parseInt(ver[0].value, 10) >= 3, ver[0].value);

console.log('\n--- every site got the new tables ---');
for (const s of sites) {
  await ensureSiteSchema({ siteName: s.site_name, groupId: s.group_id });
  const t = await sql.unsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = '${s.schema_name}' AND table_name IN ('chat_log','pending_items','schema_meta')`
  );
  const names = t.map((r) => r.table_name).sort().join(',');
  check(`${s.site_name}: has chat_log, pending_items, schema_meta`, names === 'chat_log,pending_items,schema_meta', names);
}

console.log('\n--- chat_log round-trip ---');
const c1 = await inSite(() =>
  chatLogDB.add({
    date: DATE,
    sender: 'Rep',
    senderId: '601113021407',
    isBot: false,
    body: 'paip atas bumbung bocor dekat blok A',
    kind: 'chat',
  })
);
createdChat.push(c1.lastInsertRowid);
check('insert returns an id', c1?.lastInsertRowid > 0);

const c2 = await inSite(() =>
  chatLogDB.add({ date: DATE, sender: 'KERANI', senderId: '601117291200', isBot: true, body: 'Issue #99 dicatat', kind: 'reply' })
);
createdChat.push(c2.lastInsertRowid);

const recent = await inSite(() => chatLogDB.getRecent(50));
const mine = recent.find((r) => r.id === c1.lastInsertRowid);
check('readable back', !!mine);
check('sender kept', mine?.sender === 'Rep');
check('is_bot kept', mine?.is_bot === false);

console.log('\n--- chat_log search ---');
const hits = await inSite(() => chatLogDB.search('paip bumbung'));
check('two-word AND search finds it', hits.some((r) => r.id === c1.lastInsertRowid), `${hits.length} hits`);
check('excludes non-matching', hits.every((r) => /paip/i.test(r.body) && /bumbung/i.test(r.body)));
const none = await inSite(() => chatLogDB.search('zzzznotpresent'));
check('no match is empty', none.length === 0);

console.log('\n--- pending round-trip ---');
const p1 = await inSite(() =>
  pendingDB.add({
    date: DATE,
    task: 'tapis paip bumbung blok A',
    pic: 'Azman',
    location: 'Blok A',
    dueDate: '05/10/2026',
    status: 'open',
    priority: 'high',
    raisedBy: 'boss hue hy',
    notes: 'tapis dari paip respons dalam 2 jam',
  })
);
createdPending.push(p1.lastInsertRowid);
check('insert returns an id', p1?.lastInsertRowid > 0);

const got = await inSite(() => pendingDB.getById(p1.lastInsertRowid));
check('pic kept', got?.pic === 'Azman');
check('due_date kept', got?.due_date === '05/10/2026');
check('raised_by kept', got?.raised_by === 'boss hue hy');

const p2 = await inSite(() => pendingDB.add({ date: DATE, task: 'hantar CNG ke Emily', status: 'open', priority: 'urgent' }));
createdPending.push(p2.lastInsertRowid);
const p3 = await inSite(() => pendingDB.add({ date: DATE, task: 'tapis paip blok B', status: 'done' }));
createdPending.push(p3.lastInsertRowid);

console.log('\n--- open list excludes done, urgent first ---');
const open = await inSite(() => pendingDB.getOpen(50));
check('done excluded', !open.some((r) => r.id === p3.lastInsertRowid));
check('open items present', open.some((r) => r.id === p1.lastInsertRowid) && open.some((r) => r.id === p2.lastInsertRowid));
check(
  'urgent sorts before high',
  open.findIndex((r) => r.id === p2.lastInsertRowid) < open.findIndex((r) => r.id === p1.lastInsertRowid),
  `urgent@${open.findIndex((r) => r.id === p2.lastInsertRowid)} high@${open.findIndex((r) => r.id === p1.lastInsertRowid)}`
);

console.log('\n--- search + close + update ---');
const ph = await inSite(() => pendingDB.search('tapis paip'));
check('search finds both blocks', ph.length >= 2, `${ph.length} hits`);
await inSite(() => pendingDB.close(p1.lastInsertRowid, 'tapis dah tukar'));
const after = await inSite(() => pendingDB.getById(p1.lastInsertRowid));
check('close sets done', after?.status === 'done', after?.status);
check('close stamps closed_at', !!after?.closed_at);
check('close keeps notes', /2 jam/.test(after?.notes || ''));
check('closed leaves open list', !(await inSite(() => pendingDB.getOpen(50))).some((r) => r.id === p1.lastInsertRowid));

await inSite(() => pendingDB.update(p2.lastInsertRowid, { status: 'waiting', pic: 'Emily HYS' }));
const upd = await inSite(() => pendingDB.getById(p2.lastInsertRowid));
check('update status', upd?.status === 'waiting', upd?.status);
check('update pic', upd?.pic === 'Emily HYS');

console.log('\n--- SQL injection is not possible via field names ---');
const evil = await inSite(() => pendingDB.searchFields(['task; DROP TABLE pending_items'], 'x'));
check('bad field name ignored', Array.isArray(evil));
const stillThere = await inSite(() => pendingDB.getById(p2.lastInsertRowid));
check('table still exists after bad field', !!stillThere);

console.log('\n--- cleanup ---');
for (const id of createdChat) await inSite(() => chatLogDB.delete(id));
for (const id of createdPending) await inSite(() => pendingDB.delete(id));
// Counted with getRecent, not raw sql: only q() sets search_path, so sql.unsafe
// would look in the shared public tables and report a bogus 42P01.
const leftovers = await inSite(() => chatLogDB.search('probe paip bumbung'));
check('chat_log clean', !leftovers.some((r) => r.date === DATE), `${leftovers.length} left`);
const leftP = await inSite(() => pendingDB.search('tapis paip hantar CNG kipas'));
check(
  'pending_items clean',
  !leftP.some((r) => r.date === DATE),
  `${leftP.filter((r) => r.date === DATE).length} left`
);
console.log(`\n${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);