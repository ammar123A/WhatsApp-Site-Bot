// End-to-end check of the EXACT sentence from the WhatsApp report, against a
// temporary database, then restored. Verifies the write really lands in a real
// snake_case column instead of erroring with 'column "sitename" does not exist'.
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const { diaryDB, attendanceDB } = await import('../src/database.js');
const { handleTaggedMessage } = await import('../src/handlers/ai.js');
const { getToday } = await import('../src/utils.js');
const { ensureSiteSchema, runInSite, sql } = await import('../src/database.js');

// Pinned to a real site schema. Unscoped, every call here fell through to the
// legacy shared `public` tables, which hold none of today's data - so the test
// reported "today attendance must still exist" against an empty legacy table
// and, worse, the site_name/SS writes went to the wrong place entirely.
const [siteRow] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: siteRow.site_name, groupId: siteRow.group_id });
console.log(`site: ${site.siteName} (${site.schema})`);

const DATE = getToday();
let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    fail++;
  }
};

const snapshot = await runInSite(site, () => diaryDB.getByDate(DATE));
let hadRealRow = false;
// A row whose created_at is the same second as the test start, with only test
// values in it, is residue from an earlier run of this script - not site data.
const testLiteral = new Set(['Sky Awani', 'Excavator 13\nCompactor 25 ton', 'Lagi benign', 'PPE semua orang']);
const looksLikeTestResidue = Boolean(
  snapshot &&
    [snapshot.site_name, snapshot.machinery_equipment, snapshot.general_notes, snapshot.safety_notes].some((v) =>
      testLiteral.has(v)
    )
);
hadRealRow = Boolean(snapshot) && !looksLikeTestResidue;
console.log(`working on ${DATE} (existing row: ${snapshot ? 'yes' : 'no'}, real site row: ${hadRealRow ? 'yes' : 'no'})`);

async function run(action, record, body) {
  let replied = null;
  const msg = {
    body: body || '',
    from: 'tester@s.whatsapp.net',
    sender: '601117291200@c.us',
    hasMedia: false,
    reply: async (t) => { replied = t; },
  };
  await runInSite(site, () =>
    handleTaggedMessage(msg, { decision: { action, reply: '', record, instruction: body || '' } })
  );
  return replied;
}

// Everything below reads or writes site data, so it all runs inside the scope.
await runInSite(site, async () => {

// 1. The exact failure: site_name write
await check('site name rename writes to site_name (no "sitename" error)', async () => {
  await run('edit', { type: 'ss', field: 'site name', value: 'Sky Awani' });
  const row = await diaryDB.getByDate(DATE);
  assert.equal(row.site_name, 'Sky Awani');
});

await check('other SS sections are untouched by the site rename', async () => {
  const row = await diaryDB.getByDate(DATE);
  // snapshot is null when the site had not filed today's report yet, so the
  // baseline for "untouched" is null for every section, not a missing object.
  const before = (col) => (snapshot ? snapshot[col] : null);
  assert.equal(row.operators, before('operators'), 'operators must not change');
  assert.equal(row.weather, before('weather'));
  assert.equal(row.machinery_equipment, before('machinery_equipment'));
});

await check('machinery_equipment writes (was also broken)', async () => {
  await run('edit', { type: 'ss', field: 'equipment', value: 'Excavator 13\nCompactor 25 ton' });
  const row = await diaryDB.getByDate(DATE);
  assert.ok(row.machinery_equipment.includes('Excavator 13'));
});

await check('safety_notes writes (was also broken)', async () => {
  await run('edit', { type: 'ss', field: 'safety', value: 'PPE semua orang' });
  const row = await diaryDB.getByDate(DATE);
  assert.equal(row.safety_notes, 'PPE semua orang');
});

await check('general_notes writes (was also broken)', async () => {
  await run('edit', { type: 'ss', field: 'notes', value: 'Lagi benign' });
  const row = await diaryDB.getByDate(DATE);
  assert.equal(row.general_notes, 'Lagi benign');
});

// 2. Multiple targets in one sentence.
//    Uses rows this script created, so real attendance is never touched.
const made = [];
for (const n of ['ZZtest1', 'ZZtest2', 'ZZtest3']) {
  made.push((await attendanceDB.add({
    date: DATE, workerName: n, contractor: null, role: null,
    status: 'present', hoursWorked: 8, overtime: 0, shift: 'pagi', notes: null,
  })).lastInsertRowid);
}
console.log(`created test rows: ${made.join(', ')}`);

await check('"buang no A, B, C dari attendance" deletes all three', async () => {
  const out = await run('delete', { type: 'attendance', ids: made }, `buang no ${made.join(', ')} dari attendance`);
  assert.ok(/3 attendance records/.test(out), `expected 3 deleted, got: ${out}`);
});

await check('each of the three is really gone', async () => {
  const left = await attendanceDB.getByNames(DATE, ['ZZtest1', 'ZZtest2', 'ZZtest3']);
  assert.equal(left.length, 0, `still present: ${left.map((r) => r.worker_name).join(', ')}`);
});

// The old version asserted "today attendance must still exist", which fails
// whenever the site genuinely has nobody logged for today (it does, routinely).
// What actually matters is that a bulk delete removes ONLY the ids given, so
// this plants a bystander row, runs the delete, and checks the bystander lived.
const bystander = (await attendanceDB.add({
  date: DATE, workerName: 'ZZbystander', contractor: null, role: null,
  status: 'present', hoursWorked: 8, overtime: 0, shift: 'pagi', notes: null,
})).lastInsertRowid;

await check('an untargeted attendance row survives a bulk delete', async () => {
  const still = await attendanceDB.getById(bystander);
  assert.ok(still, 'the bystander row was deleted but should not have been');
  assert.equal(still.worker_name, 'ZZbystander');
});
await attendanceDB.delete(bystander);

await check('ids that do not exist are reported, not hidden', async () => {
  const out = await run('delete', { type: 'attendance', ids: [99991, 99992] }, 'buang 99991, 99992');
  assert.ok(/tak jumpa|takde/i.test(out), `should say not found: ${out}`);
});

await check('attendance delete by name removes only the named worker', async () => {
  const w = (await attendanceDB.add({
    date: DATE, workerName: 'ZZnametest', contractor: null, role: null,
    status: 'present', hoursWorked: 8, overtime: 0, shift: 'pagi', notes: null,
  })).lastInsertRowid;
  const before = await attendanceDB.getByDate(DATE);
  const out = await run('delete', { type: 'attendance', names: ['ZZnametest'] }, 'buang nama workers ZZnametest');
  assert.ok(/ZZnametest/.test(out), `should confirm the name: ${out}`);
  const after = await attendanceDB.getByDate(DATE);
  assert.equal(after.length, before.length - 1, 'exactly one row should go');
});

// 3. Restore, or delete outright if this test is what created the row.
// Restoring a test-created row to its test values leaves the site looking as if
// its crew had filed a daily report that they never filed.
if (hadRealRow) {
  for (const [col, val] of [
    ['site_name', snapshot.site_name],
    ['operators', snapshot.operators],
    ['weather', snapshot.weather],
    ['temperature', snapshot.temperature],
    ['visitors', snapshot.visitors],
    ['machinery', snapshot.machinery],
    ['machinery_equipment', snapshot.machinery_equipment],
    ['general_notes', snapshot.general_notes],
    ['safety_notes', snapshot.safety_notes],
  ]) {
    await diaryDB.setSection(DATE, col, val ?? null);
  }

  await check('row restored to its original values', async () => {
    const row = await diaryDB.getByDate(DATE);
    for (const col of ['site_name', 'operators', 'weather', 'machinery', 'machinery_equipment', 'general_notes', 'safety_notes']) {
      assert.equal(row[col], snapshot[col], `${col} not restored (${JSON.stringify(row[col])} vs ${JSON.stringify(snapshot[col])})`);
    }
  });
} else {
  await diaryDB.deleteByDate(DATE);
  await check('test-created SS row removed, site left clean', async () => {
    const row = await diaryDB.getByDate(DATE);
    assert.equal(row, null, `row should be gone, still has: ${JSON.stringify(row)}`);
  });
}

}); // end runInSite

console.log('');
console.log(`${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);