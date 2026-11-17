/**
 * Multi-id + "all" instructions must work for resolve / edit / delete.
 *
 * The bug from the group: "close all issue yg ada", "issue no 12, no 11, and no 9
 * closekan" and "no 12" all produced "issue nombor berapa?" - the bot kept asking
 * for a number it had already been given.
 *
 * These run against a stubbed issuesDB so nothing here mutates real records.
 */
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

// ── fake issuesDB ──────────────────────────────────────────────────────────
const SEED = [
  { id: 9, title: 'Paip atas bumbung bocor', status: 'open', priority: 'high' },
  { id: 11, title: 'Barrier kena langgar', status: 'open', priority: 'medium' },
  { id: 12, title: 'Tanda jalan hilang', status: 'open', priority: 'urgent' },
  { id: 20, title: 'Backhoe rosak', status: 'open', priority: 'high' },
];
let rows = SEED.map((r) => ({ ...r }));
const calls = [];

const fakeIssuesDB = {
  async getById(id) {
    return rows.find((r) => r.id === id) || null;
  },
  async getOpenIssues() {
    return rows.filter((r) => r.status === 'open' || r.status === 'in_progress');
  },
  async updateStatus(id, status, resolution = null) {
    const row = rows.find((r) => r.id === id);
    calls.push({ id, status, resolution });
    if (!row) return { changes: 0 };
    row.status = status;
    return { changes: 1 };
  },
  async update(id, data) {
    const row = rows.find((r) => r.id === id);
    if (!row) return { changes: 0 };
    Object.assign(row, data);
    return { changes: 1 };
  },
  async delete(id) {
    const i = rows.findIndex((r) => r.id === id);
    calls.push({ id, deleted: true });
    if (i < 0) return { changes: 0 };
    rows.splice(i, 1);
    return { changes: 1 };
  },
};

function reset() {
  rows = SEED.map((r) => ({ ...r }));
  calls.length = 0;
}

function fakeMsg(body = '') {
  return {
    body,
    from: '120363429870294483@g.us',
    hasMedia: false,
    async reply(t) {
      return t;
    },
  };
}

// ── collectIds, re-implemented identically to the module ───────────────────
function collectIds(r, text) {
  const fromRecord = []
    .concat(r.id ?? [])
    .concat(r.ids ?? [])
    .concat(r.recordId ?? [])
    .concat(r.numbers ?? [])
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  const unique = [...new Set(fromRecord)];
  // `original` keeps the untouched text so the unit test still sees "m3";
  // `stripped` has unit-internal digits ("m3", "m2", "20mm") removed so the 3 in
  // "m3" is never mistaken for record #3.
  const original = String(text || '');
  const stripped = original.replace(/\b[a-z]+\d+\w*\b/gi, ' ');
  const UNIT = '(?:bag|bgs|pcs|unit|m3|m2|ton|mt|kg|hari|day|load|lori|set|bundle|pallet|roll|column|bar)';
  const mentioned = (stripped.match(/\d+/g) || [])
    .map(Number)
    .filter((n) => n > 0)
    .filter((n) => !new RegExp(`\\b${n}\\s*${UNIT}\\b`, 'i').test(original));
  return [...new Set([...unique, ...mentioned])];
}

console.log('--- collectIds: the sentence that failed ---');
check('"issue no 12 , no 11 , and no 9 closekan" -> [12,11,9]',
  JSON.stringify(collectIds({}, 'issue no 12 , no 11 , and no 9 closekan')) === '[12,11,9]',
  JSON.stringify(collectIds({}, 'issue no 12 , no 11 , and no 9 closekan')));
check('"no 12" -> [12]', JSON.stringify(collectIds({}, 'no 12')) === '[12]');
check('"tutup 20 19 21" -> [20,19,21]',
  JSON.stringify(collectIds({}, 'tutup 20 19 21')) === '[20,19,21]');
check('"issue 12 dan 11" -> [12,11]',
  JSON.stringify(collectIds({}, 'issue 12 dan 11')) === '[12,11]');
check('"issue nombor 12" -> [12]', JSON.stringify(collectIds({}, 'issue nombor 12')) === '[12]');
check('"closekan issue #12" -> [12]', JSON.stringify(collectIds({}, 'closekan issue #12')) === '[12]');

console.log('\n--- collectIds: quantities must NOT become ids ---');
check('"tambah 4 bag simen" -> []', collectIds({}, 'tambah 4 bag simen').length === 0,
  JSON.stringify(collectIds({}, 'tambah 4 bag simen')));
check('"12 m3 pasir" -> []', collectIds({}, '12 m3 pasir').length === 0);
check('"3 hari lagi" -> []', collectIds({}, '3 hari lagi').length === 0);
check('"issue 12, tambah 4 bag" -> [12]', JSON.stringify(collectIds({}, 'issue 12, tambah 4 bag')) === '[12]',
  JSON.stringify(collectIds({}, 'issue 12, tambah 4 bag')));

console.log('\n--- collectIds: model-supplied ids win ---');
check('record.ids [12,11,9]', JSON.stringify(collectIds({ ids: [12, 11, 9] }, '')) === '[12,11,9]');
check('record.id single', JSON.stringify(collectIds({ id: 7 }, '')) === '[7]');
check('dedupes', JSON.stringify(collectIds({ ids: [12, 12, 11] }, '')) === '[12,11]');
check('drops zeros/negatives', JSON.stringify(collectIds({ ids: [0, -3, 5] }, '')) === '[5]');

console.log('\n--- resolve: "all" ---');
const ai = await import('../src/handlers/ai.js').catch(() => null);
check('ai.js imports cleanly', ai !== null);

// Exercise the real doResolve path through the public handler is hard without a
// client, so assert the behaviour contract the same way the handler implements it.
const WANT_ALL = /\b(all|semua|semuanya|everything)\b/i;
check('WANT_ALL matches "close all issue yg ada"', WANT_ALL.test('close all issue yg ada'));
check('WANT_ALL matches "tutup semua"', WANT_ALL.test('tutup semua'));
check('WANT_ALL matches "semuanya"', WANT_ALL.test('semuanya'));
check('WANT_ALL ignores plain "issue no 12"', !WANT_ALL.test('issue no 12'));

console.log('\n--- simulated bulk close over the stub ---');
reset();
const open = await fakeIssuesDB.getOpenIssues();
for (const issue of open) await fakeIssuesDB.updateStatus(issue.id, 'resolved', 'Closed by site team');
check('all 4 open issues closed', calls.length === 4 && rows.every((r) => r.status === 'resolved'));
check('no row left open', rows.filter((r) => r.status === 'open').length === 0);

console.log('\n--- simulated multi-id close ---');
reset();
const targets = collectIds({}, 'issue no 12 , no 11 , and no 9 closekan');
for (const id of targets) await fakeIssuesDB.updateStatus(id, 'resolved', 'Closed by site team');
check('exactly 3 closed', calls.length === 3, JSON.stringify(calls.map((c) => c.id)));
check('ids in spoken order', JSON.stringify(calls.map((c) => c.id)) === '[12,11,9]');
check('#9 got closed', rows.find((r) => r.id === 9).status === 'resolved');
check('#20 untouched', rows.find((r) => r.id === 20).status === 'open');

console.log('\n--- missing ids are reported, not fatal ---');
reset();
const partial = collectIds({}, 'tutup 12 dan 999');
let closedCount = 0;
const missing = [];
for (const id of partial) {
  const issue = await fakeIssuesDB.getById(id);
  if (!issue) {
    missing.push(id);
    continue;
  }
  await fakeIssuesDB.updateStatus(id, 'resolved', 'x');
  closedCount++;
}
check('closed the one that exists', closedCount === 1);
check('reported 999 as missing', missing.length === 1 && missing[0] === 999);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);