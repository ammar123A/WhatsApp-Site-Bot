// Self-check for date ranges, priority order and admin matching (no WhatsApp needed).
//
// Scoped to one site schema and self-cleaning. The previous version was unscoped
// and finished with `TRUNCATE progress, issues RESTART IDENTITY`, which wiped the
// legacy shared tables - including real site history - and its "sorted exactly
// urgent,high,medium,low" assertion only held while no other test had left rows
// behind in those same unscoped tables.
process.env.ADMIN_NUMBERS = '60123456789';   // dotenv won't override these

const { isAdmin, parseDate } = await import('../src/utils.js');
const { sql, ensureSiteSchema, runInSite, progressDB, issuesDB } = await import('../src/database.js');

let failed = false;
const ok = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed = true;
};

const [siteRow] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: siteRow.site_name, groupId: siteRow.group_id });
const inSite = (fn) => runInSite(site, fn);

// Dates unique to this script, so cleanup can find exactly what it inserted.
const DATES = ['15/08/2026', '05/09/2026', '28/09/2026', '02/10/2026', '10/09/2025'];
const ISSUE_DATE = '28/09/2026';
const seededProgress = [];
const seededIssues = [];

try {
  for (const date of DATES) {
    seededProgress.push((await inSite(() => progressDB.add({ date, category: 'Civil', description: `ZZfixes ${date}` }))).lastInsertRowid);
  }
  // Filtered to this script's own rows: the site has real progress inside these
  // ranges, so comparing the whole result array tested the data, not the filter.
  const dates = async (a, b) =>
    (await inSite(() => progressDB.getByDateRange(a, b)))
      .filter((r) => /^ZZfixes /.test(r.description || ''))
      .map((r) => r.date);

  ok('month range returns only Sept 2026, newest first',
    JSON.stringify(await dates('01/09/2026', '30/09/2026')) === JSON.stringify(['28/09/2026', '05/09/2026']),
    JSON.stringify(await dates('01/09/2026', '30/09/2026')));
  ok('week crossing month boundary returns both ends',
    JSON.stringify(await dates('28/09/2026', '04/10/2026')) === JSON.stringify(['02/10/2026', '28/09/2026']));

  // All four priorities from ONE date, so the comparison is about ordering and
  // not about whatever else the site happens to have open.
  for (const priority of ['low', 'high', 'medium', 'urgent']) {
    seededIssues.push(
      (await inSite(() => issuesDB.add({ date: ISSUE_DATE, title: `ZZfixes ${priority}`, description: '-', category: 'Others', priority })))
        .lastInsertRowid
    );
  }
  const order = (await inSite(() => issuesDB.getOpenIssues()))
    .filter((i) => /^ZZfixes /.test(i.title || ''))
    .map((i) => i.priority)
    .join();
  ok('open issues sorted urgent > high > medium > low', order === 'urgent,high,medium,low', order);

  ok('empty sender is not admin', isAdmin('') === false);
  ok('resolved phone (pn) matches admin', isAdmin('60123456789@c.us') === true);
  ok('unrelated LID is not admin', isAdmin('207816925118684@lid') === false);
  ok('parseDate is exported', parseDate('24/09/2026') === '24/09/2026');
} finally {
  // Delete only this script's rows. A blanket TRUNCATE would take the site's
  // real history with it.
  for (const id of seededProgress) await inSite(() => progressDB.delete(id));
  for (const id of seededIssues) await inSite(() => issuesDB.delete(id));
  const leftP = await inSite(() => progressDB.getByDateRange('01/01/2000', '31/12/2030'));
  const leftI = await inSite(() => issuesDB.getOpenIssues());
  ok('seeded progress removed', !leftP.some((r) => /^ZZfixes /.test(r.description || '')), `${leftP.length} rows left`);
  ok('seeded issues removed', !leftI.some((r) => /^ZZfixes /.test(r.title || '')), `${leftI.length} open left`);
  await sql.end();
}

process.exit(failed ? 1 : 0);