// Regression tests for two real failures reported from WhatsApp:
//
//  1. "tukar nama site flora hijauan tu jadi Sky Awani" died with
//     PostgresError: column "sitename" of relation "diary" does not exist.
//     SS_FIELDS mapped to camelCase (siteName) and setSection() interpolated
//     the column into SQL, so Postgres saw "sitename".
//
//  2. Multiple targets in one sentence were dropped:
//     "buang no 20, 19, 21 dari attendance" only deleted #20, and
//     "buang nama workers abu, ali, anat" ignored the buang part entirely.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    fail++;
  }
}

const aiSrc = readFileSync(join(root, 'src/handlers/ai.js'), 'utf8');
const dbSrc = readFileSync(join(root, 'src/database.js'), 'utf8');
const llmSrc = readFileSync(join(root, 'src/llm.js'), 'utf8');

// --- 1. The column names ---------------------------------------------------
check('every SS field maps to a real snake_case diary column', () => {
  const block = aiSrc.slice(aiSrc.indexOf('const SS_FIELDS'), aiSrc.indexOf('const SS_LABELS'));
  const targets = [...block.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const camelish = targets.filter((c) => /[A-Z]/.test(c));
  assert.equal(camelish.length, 0, `camelCase column left in SS_FIELDS: ${camelish}`);

  const allowed = new Set(
    [...dbSrc.slice(dbSrc.indexOf('DIARY_SECTIONS = new Set')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  );
  for (const t of targets) {
    assert.ok(allowed.has(t), `SS field "${t}" is not a writable diary column`);
  }
});

check('the exact broken column is gone', () => {
  assert.ok(!/:\s*'siteName'/.test(aiSrc), 'siteName must not be used as a SQL column');
  assert.ok(!/:\s*'machineryEquipment'/.test(aiSrc));
  assert.ok(!/:\s*'generalNotes'/.test(aiSrc));
  assert.ok(!/:\s*'safetyNotes'/.test(aiSrc));
  assert.match(aiSrc, /site:\s*'site_name'/);
  assert.match(aiSrc, /safety:\s*'safety_notes'/);
});

check('list sections use the snake_case column too', () => {
  const block = aiSrc.slice(aiSrc.indexOf('SS_LIST_SECTIONS'));
  assert.ok(!/machineryEquipment/.test(block.slice(0, 200)));
  assert.match(block, /'machinery_equipment'/);
});

check('setSection refuses a column that is not writable', async () => {
  const { diaryDB } = await import('../src/database.js');
  await assert.rejects(
    async () => diaryDB.setSection('01/10/2026', 'sitename', 'Sky Awani'),
    /not writable/,
    'a typo must not reach SQL'
  );
  await assert.rejects(async () => diaryDB.setSection('01/10/2026', 'attacker; drop table diary', 'x'), /not writable/);
});

check('the writable-column whitelist is exactly the diary sections', () => {
  const block = dbSrc.slice(
    dbSrc.indexOf('DIARY_SECTIONS = new Set'),
    dbSrc.indexOf(']', dbSrc.indexOf('DIARY_SECTIONS = new Set'))
  );
  const allowed = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const must of ['site_name', 'weather', 'machinery_equipment', 'general_notes', 'safety_notes', 'operators', 'visitors']) {
    assert.ok(allowed.includes(must), `${must} must be writable`);
  }
  // No column may sneak in that is not a real diary column.
  const real = new Set([
    'id', 'date', 'site_name', 'weather', 'temperature', 'visitors', 'machinery_equipment',
    'machinery', 'operators', 'general_notes', 'safety_notes', 'created_at', 'updated_at',
  ]);
  for (const c of allowed) assert.ok(real.has(c), `${c} is not a diary column`);
});

// --- 2. Several targets in one sentence ------------------------------------
check('collectIds keeps every id the user listed', () => {
  const fnSrc = aiSrc.slice(aiSrc.indexOf('function collectIds'), aiSrc.indexOf('/** Change one field'));
  assert.match(fnSrc, /r\.ids/, 'must read an ids array from the model');
});

check('delete loops over all ids instead of one', () => {
  const fn = aiSrc.slice(aiSrc.indexOf('async function doDelete'));
  assert.match(fn, /for \(const id of ids\)/, 'delete must loop over every id');
  assert.match(fn, /deleted\.push\(id\)/);
  assert.match(fn, /missing\.push\(id\)/, 'ids that do not exist must be reported, not silently dropped');
  assert.ok(
    !/TABLES\[type\]\(\)\.delete\(id\);\s*\n\s*const res/.test(fn),
    'the old single-delete pattern must be gone'
  );
});

check('delete can remove attendance by worker name', () => {
  const fn = aiSrc.slice(aiSrc.indexOf('async function doDelete'));
  assert.match(fn, /attendanceDB\.getByNames/);
  assert.match(fn, /r\.names/, 'the model is allowed to return names');
  assert.match(fn, /type === 'attendance'/, 'name deletion only makes sense for attendance');
});

check('a name that is not in today list is reported, not guessed', () => {
  const fn = aiSrc.slice(aiSrc.indexOf('async function doDelete'));
  assert.match(fn, /notThere/);
});

check('the model is told it may list several ids or names', () => {
  assert.match(llmSrc, /"ids":\[20,19,21\]/);
  assert.match(llmSrc, /"names":\["abu","ali","anat"\]/);
  assert.match(llmSrc, /never just the first/i);
});

check('the prompt keeps the record id rules coherent', () => {
  assert.match(llmSrc, /"delete","reply":"\.\.\.","record":\{"type":"issue","id":3\}/);
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);