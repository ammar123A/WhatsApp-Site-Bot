// Guards the per-site database wiring in index.js.
//
// The failure this protects against: a new site group silently sharing the old
// site's tables, so opening issues there showed the previous site's issues.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const idx = readFileSync(join(root, 'index.js'), 'utf8');
const dbSrc = readFileSync(join(root, 'src/database.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
    fail++;
  }
};

check('index.js imports the site-scope helpers', () => {
  assert.match(idx, /import \{[^}]*ensureSiteSchema[^}]*\} from '\.\/src\/database\.js'/);
  assert.match(idx, /runInSite/);
});

// Checked by slicing out the scope block instead of matching one literal call
// shape: rememberMessage() has to sit INSIDE this block too. It used to be
// called just before it, which ran with the default search_path and sent every
// write to public.chat_log - a schema that has never had that table - so every
// single message logged "relation chat_log does not exist".
check('every site-group message runs inside runInSite', () => {
  const start = idx.indexOf('runInSite(site,');
  const end = idx.indexOf('return scoped;', start);
  assert.ok(start > 0 && end > start, 'scope block must exist');
  const scoped = idx.slice(start, end);
  assert.match(scoped, /handleSiteMessage\(/, 'the site handler must be inside the scope');
  assert.match(scoped, /rememberMessage\(/, 'the chat log write must be inside the scope');
});

check('the database is prepared before any DB work happens', () => {
  const prep = idx.indexOf('await ensureSiteSchema(');
  const scope = idx.indexOf('runInSite(site,');
  const photo = idx.indexOf('await handlePhoto(msg)');
  assert.ok(prep > 0 && scope > 0, 'both must exist');
  assert.ok(prep < scope, 'schema must be created before entering the scope');
  assert.ok(scope < photo, 'no photo/DB work may run before the scope');
});

check('handleSiteMessage is a separate function, not inline code', () => {
  assert.match(idx, /async function handleSiteMessage\(msg, ctx\)/);
});

check('the handler refuses to run with no site scope', () => {
  assert.match(idx, /handleSiteMessage called without a site scope/);
});

check('a site DB failure is reported, not silently ignored', () => {
  assert.match(idx, /Could not prepare site database/);
  assert.match(idx, /database site ni tak boleh dibuka/);
});

check('each group resolves its own schema name', () => {
  assert.match(idx, /ensureSiteSchema\(\{ siteName, groupId: msg\.from \}\)/);
});

check('q() is the single place that switches schema', () => {
  assert.match(dbSrc, /SET LOCAL search_path TO \$\{sql\(site\.schema\)\}, public/);
  assert.match(dbSrc, /AsyncLocalStorage/);
});

check('schema names are validated before going into SQL', () => {
  assert.match(dbSrc, /refusing to use an unsafe schema name/);
  assert.match(dbSrc, /const SCHEMA_NAME = \/\^\[a-z_\]\[a-z0-9_\]\{0,50\}\$\//);
});

check('identity sequences are moved past copied ids', () => {
  // Copying rows with explicit ids leaves the sequence at 1, and the next insert
  // dies with: duplicate key value violates unique constraint "issues_pkey".
  assert.match(dbSrc, /setval\(/);
  assert.match(dbSrc, /pg_get_serial_sequence/);
  assert.match(dbSrc, /coalesce\(\(select max\(id\)/);
  assert.match(dbSrc, /export async function syncIdentitySequences/);

  const migrate = dbSrc.slice(dbSrc.indexOf('export async function migratePublicTablesToSite'));
  assert.match(migrate, /syncIdentitySequences\(schema\)/, 'the copy path must sync too');

  const ensure = dbSrc.slice(dbSrc.indexOf('export async function ensureSiteSchema'));
  assert.match(ensure, /syncIdentitySequences\(schema\)/, 'and the create path, to self-heal');
});

// Real behaviour of the naming + caching, no DB writes needed.
const db = await import(pathToFileURL(join(root, 'src/database.js')).href);

check('schema name is readable and stable per group', () => {
  const a = db.schemaNameFor('Flora Hijauan', '120363412164633402@g.us');
  assert.equal(a, db.schemaNameFor('Flora Hijauan', '120363412164633402@g.us'), 'must be stable');
  assert.match(a, /^site_flora_hijauan_[0-9a-f]{6}$/);
});

check('same site name in two groups never shares a schema', () => {
  const a = db.schemaNameFor('Alzac', 'group1@g.us');
  const b = db.schemaNameFor('Alzac', 'group2@g.us');
  assert.notEqual(a, b);
});

check('hostile names cannot escape the identifier', () => {
  const nasty = 'x"; drop table issues; --';
  const name = db.schemaNameFor(nasty, 'g@g.us');
  assert.match(name, /^[a-z_][a-z0-9_]*$/, `unsafe schema name produced: ${name}`);
});

check('currentSite() is null outside a scope', () => {
  assert.equal(db.currentSite(), null);
});

check('runInSite exposes the site inside and hides it outside', async () => {
  const site = { schema: 'site_test_x', siteName: 'X' };
  const inside = await db.runInSite(site, async () => db.currentSite());
  assert.deepEqual(inside, site);
  assert.equal(db.currentSite(), null);
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);