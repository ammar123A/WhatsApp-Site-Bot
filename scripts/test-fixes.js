// Self-check for date ranges, priority order and admin matching (no WhatsApp needed).
// Uses a throwaway DB so the real data/sitebot.db is never touched.
//   node scripts/test-fixes.js
import { rmSync } from 'fs';

process.env.DB_PATH = './data/test-fixes.db';   // dotenv won't override these
process.env.ADMIN_NUMBERS = '60123456789';

// utils.js (→ whatsapp-web.js) must load before sqlite is used, same order as
// index.js; the reverse aborts Node 24 natively (better-sqlite3 11.10 cleanup hook).
const { isAdmin, parseDate } = await import('../src/utils.js');
const { default: db, progressDB, issuesDB } = await import('../src/database.js');

let failed = false;
const ok = (name, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) failed = true;
};

try {
  for (const date of ['15/08/2026', '05/09/2026', '28/09/2026', '02/10/2026', '10/09/2025']) {
    progressDB.add({ date, category: 'Civil', description: date });
  }
  const dates = (a, b) => progressDB.getByDateRange(a, b).map(r => r.date);

  ok('month range returns only Sept 2026, newest first',
    JSON.stringify(dates('01/09/2026', '30/09/2026')) === JSON.stringify(['28/09/2026', '05/09/2026']));
  ok('week crossing month boundary returns both ends',
    JSON.stringify(dates('28/09/2026', '04/10/2026')) === JSON.stringify(['02/10/2026', '28/09/2026']));

  for (const priority of ['low', 'high', 'medium', 'urgent']) {
    issuesDB.add({ date: '28/09/2026', title: priority, description: '-', category: 'Others', priority });
  }
  ok('open issues sorted urgent > high > medium > low',
    issuesDB.getOpenIssues().map(i => i.priority).join() === 'urgent,high,medium,low');

  ok('empty sender is not admin', isAdmin('') === false);
  ok('resolved phone (pn) matches admin', isAdmin('60123456789@c.us') === true);
  ok('unrelated LID is not admin', isAdmin('207816925118684@lid') === false);
  ok('parseDate is exported', parseDate('24/09/2026') === '24/09/2026');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`./data/test-fixes.db${suffix}`, { force: true });
}

process.exit(failed ? 1 : 0);
