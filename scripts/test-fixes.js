// Self-check for date ranges, priority order and admin matching (no WhatsApp needed).
// Needs an EMPTY Postgres with supabase/schema.sql applied - never the real one,
// it inserts test rows:
//   DATABASE_URL=postgres://user:pass@localhost:5432/test node scripts/test-fixes.js
process.env.ADMIN_NUMBERS = '60123456789';   // dotenv won't override these

const { isAdmin, parseDate } = await import('../src/utils.js');
const { sql, progressDB, issuesDB } = await import('../src/database.js');

let failed = false;
const ok = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed = true;
};

try {
  for (const date of ['15/08/2026', '05/09/2026', '28/09/2026', '02/10/2026', '10/09/2025']) {
    await progressDB.add({ date, category: 'Civil', description: date });
  }
  const dates = async (a, b) => (await progressDB.getByDateRange(a, b)).map(r => r.date);

  ok('month range returns only Sept 2026, newest first',
    JSON.stringify(await dates('01/09/2026', '30/09/2026')) === JSON.stringify(['28/09/2026', '05/09/2026']));
  ok('week crossing month boundary returns both ends',
    JSON.stringify(await dates('28/09/2026', '04/10/2026')) === JSON.stringify(['02/10/2026', '28/09/2026']));

  for (const priority of ['low', 'high', 'medium', 'urgent']) {
    await issuesDB.add({ date: '28/09/2026', title: priority, description: '-', category: 'Others', priority });
  }
  ok('open issues sorted urgent > high > medium > low',
    (await issuesDB.getOpenIssues()).map(i => i.priority).join() === 'urgent,high,medium,low');

  ok('empty sender is not admin', isAdmin('') === false);
  ok('resolved phone (pn) matches admin', isAdmin('60123456789@c.us') === true);
  ok('unrelated LID is not admin', isAdmin('207816925118684@lid') === false);
  ok('parseDate is exported', parseDate('24/09/2026') === '24/09/2026');
} finally {
  await sql`TRUNCATE progress, issues RESTART IDENTITY`;
  await sql.end();
}

process.exit(failed ? 1 : 0);
