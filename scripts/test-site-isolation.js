// Live proof that two site groups are two separate databases.
//
// Creates two throwaway site schemas, writes a record into each, then checks that
// each site only ever sees its OWN record - which is exactly the bug that made a
// new site group show the old site's issues.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

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

const STAMP = 'ZZisolation' + process.pid;
const siteA = { siteName: 'Isolation Site A', groupId: 'a' + STAMP + '@g.us' };
const siteB = { siteName: 'Isolation Site B', groupId: 'b' + STAMP + '@g.us' };

const A = await db.ensureSiteSchema(siteA);
const B = await db.ensureSiteSchema(siteB);

console.log(`A -> ${A.schema}`);
console.log(`B -> ${B.schema}\n`);

check('two sites get two different schemas', () => {
  if (A.schema === B.schema) throw new Error('same schema - sites would share data');
});

await check('a new site starts EMPTY (no old site records)', async () => {
  const issues = await db.runInSite(A, () => db.issuesDB.getOpenIssues());
  if (issues.length) throw new Error(`site A already has ${issues.length} issues, expected 0`);
});

await check('writing in site A does not appear in site B', async () => {
  await db.runInSite(A, () => db.issuesDB.add({
    date: '02/10/2026',
    title: `${STAMP} issue only in A`,
    description: 'belongs to site A',
    category: 'Civil',
    priority: 'high',
    reportedBy: 'tester',
  }));
  const inB = await db.runInSite(B, () => db.issuesDB.getOpenIssues());
  if (inB.some((i) => i.title.includes(STAMP))) throw new Error('site B can see site A issues');
});

await check('site A sees its own issue', async () => {
  const inA = await db.runInSite(A, () => db.issuesDB.getOpenIssues());
  if (!inA.some((i) => i.title.includes(STAMP))) throw new Error('site A lost its own issue');
});

await check('attendance is separate too', async () => {
  await db.runInSite(B, () => db.attendanceDB.add({
    date: '02/10/2026', workerName: `${STAMP}workerB`, shift: 'pagi',
  }));
  const inA = await db.runInSite(A, () => db.attendanceDB.getByDate('02/10/2026'));
  if (inA.some((r) => String(r.worker_name).includes(STAMP))) {
    throw new Error('site A sees site B attendance');
  }
});

await check('progress is separate too', async () => {
  await db.runInSite(B, () => db.progressDB.add({
    date: '02/10/2026', category: 'Civil',
    description: `${STAMP} progress only in B`, reportedBy: 'tester',
  }));
  const inA = await db.runInSite(A, () => db.progressDB.getByDate('02/10/2026'));
  if (inA.some((p) => String(p.description).includes(STAMP))) {
    throw new Error('site A sees site B progress');
  }
});

await check('Project SS / diary is separate too', async () => {
  await db.runInSite(B, () => db.diaryDB.setSection('02/10/2026', 'site_name', 'Isolation Site B'));
  const inA = await db.runInSite(A, () => db.diaryDB.getByDate('02/10/2026'));
  if (inA && inA.site_name === 'Isolation Site B') throw new Error('site A sees site B site name');
});

await check('two sites writing at the same time do not swap databases', async () => {
  // Fire both at once: without AsyncLocalStorage they would race and both
  // writes could land in the same schema.
  await Promise.all([
    db.runInSite(A, () => db.issuesDB.add({
      date: '02/10/2026', title: `${STAMP} concurrent A`, description: 'a',
      category: 'Civil', reportedBy: 'tester',
    })),
    db.runInSite(B, () => db.issuesDB.add({
      date: '02/10/2026', title: `${STAMP} concurrent B`, description: 'b',
      category: 'Civil', reportedBy: 'tester',
    })),
  ]);
  const inA = await db.runInSite(A, () => db.issuesDB.getOpenIssues());
  const inB = await db.runInSite(B, () => db.issuesDB.getOpenIssues());
  const aOnly = inA.filter((i) => String(i.title).includes('concurrent'));
  const bOnly = inB.filter((i) => String(i.title).includes('concurrent'));
  if (aOnly.some((i) => i.title.endsWith('B'))) throw new Error('a concurrent B write landed in A');
  if (bOnly.some((i) => i.title.endsWith('A'))) throw new Error('a concurrent A write landed in B');
  if (!aOnly.some((i) => i.title.endsWith('A'))) throw new Error('A lost its concurrent write');
  if (!bOnly.some((i) => i.title.endsWith('B'))) throw new Error('B lost its concurrent write');
});

await check('no site scope means the shared public tables (old behaviour)', async () => {
  const rows = await db.progressDB.getRecent(1);
  if (!Array.isArray(rows)) throw new Error('unexpected result outside a site scope');
});

await check('inserting after rows copied with their ids does not hit issues_pkey', async () => {
  // This is the real failure: migratePublicTablesToSite copies rows WITH their id
  // values into a brand new schema. The identity sequence there still starts at
  // 1, so the next insert asks for id 1 and Postgres throws
  // "duplicate key value violates unique constraint issues_pkey".
  const site = { siteName: 'Seq Test Site', groupId: 'seq' + STAMP + '@g.us' };
  const C = await db.ensureSiteSchema(site);
  await db.sql.unsafe(`
    insert into "${C.schema}"."issues" (id, date, title, description, category, priority, status)
    values (1, '02/10/2026', '${STAMP} old issue 1', 'd', 'Civil', 'medium', 'open'),
           (2, '02/10/2026', '${STAMP} old issue 2', 'd', 'Civil', 'medium', 'open')
  `);

  // Before the fix the sequence is still at 1 - prove the collision is real.
  const before = await db.sql.unsafe(`select last_value from "${C.schema}"."issues_id_seq"`);
  if (before[0].last_value > 2) throw new Error('test setup: sequence already ahead, cannot prove the bug');

  // What the migration does after copying.
  await db.syncIdentitySequences(C.schema);

  let id;
  try {
    const res = await db.runInSite(C, () => db.issuesDB.add({
      date: '02/10/2026', title: `${STAMP} brand new`, description: 'd',
      category: 'Civil', reportedBy: 'tester',
    }));
    id = res.lastInsertRowid;
  } catch (e) {
    throw new Error(`insert after copied rows failed: ${e.message}`);
  }
  if (id <= 2) throw new Error(`expected an id above the copied rows, got ${id}`);

  await db.sql`drop schema if exists ${db.sql(C.schema)} cascade`;
  await db.sql`delete from public.sites where schema_name = ${C.schema}`;
});

// Clean up: drop the throwaway schemas completely.
console.log('\ncleaning up test schemas...');
await db.sql`drop schema if exists ${db.sql(A.schema)} cascade`;
await db.sql`drop schema if exists ${db.sql(B.schema)} cascade`;
await db.sql`delete from public.sites where schema_name in (${A.schema}, ${B.schema})`;
console.log('dropped');

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);