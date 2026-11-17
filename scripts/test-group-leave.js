// Tests for "once the bot is removed from a group, that group is dead to it".
//
// The risk being pinned here: a group the bot had been serving (and had recorded
// from) stayed in the site registry and on the allow-list after the bot was
// kicked. It would then resume recording the moment it was re-added, and would
// keep appearing in the serving list while the bot could not even reach it.
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

const sitesSrc = readFileSync(join(root, 'src/sites.js'), 'utf8');
const indexSrc = readFileSync(join(root, 'index.js'), 'utf8');

// --- Real behaviour, against the real module --------------------------------
const A = '120363412164633402@g.us';
const B = '999111@g.us';
const C = '888222@g.us';

const m = await import('../src/sites.js');

check('a group is served only while the bot is still in it', () => {
  m.allowGroup(A);
  m.allowGroup(B);
  m.allowGroup(C);
  assert.equal(m.isAllowedGroup(A), true);
  assert.equal(m.isAllowedGroup(B), true);
});

check('reconciliation forgets a group missing from the scan', () => {
  const gone = m.forgetMissingGroups([A, C]);
  assert.deepEqual(gone, [B]);
  assert.equal(m.isAllowedGroup(B), false, 'B must stop being served');
});

check('a forgotten group leaves the site registry', () => {
  m.registerGroup(B, 'Old Site');
  assert.equal(m.siteFor(B), 'Old Site');
  m.forgetMissingGroups([A, C]);
  assert.equal(m.siteFor(B), null, 'B must not still be known as a site');
});

check('a forgotten group stays dead even if the bot is re-added later', () => {
  assert.equal(m.isAllowedGroup(B), false);
  assert.equal(m.isBlockedGroup(B), true);
  m.forgetGroup(B);
  assert.equal(m.isAllowedGroup(B), false, 're-joining must NOT auto-resume recording');
});

check('explicit forgetGroup also stops service', () => {
  m.allowGroup(C);
  assert.equal(m.isAllowedGroup(C), true);
  m.forgetGroup(C);
  assert.equal(m.isAllowedGroup(C), false);
  assert.equal(m.siteFor(C), null);
});

check('groups still present are untouched', () => {
  m.allowGroup(A);
  m.registerGroup(A, 'SiteMate');
  m.forgetMissingGroups([A]);
  assert.equal(m.isAllowedGroup(A), true);
  assert.equal(m.siteFor(A), 'SiteMate');
});

check('reconciling twice does not report the same group twice', () => {
  m.allowGroup(A);
  const first = m.forgetMissingGroups([A]);
  assert.deepEqual(first, []);
  assert.equal(m.isAllowedGroup(A), true);
});

// --- The wiring in index.js --------------------------------------------------
check('index imports the forget helpers', () => {
  assert.match(indexSrc, /forgetGroup,\s*forgetMissingGroups/);
  assert.match(indexSrc, /forgetMissingGroups/);
});

check('there is a group-leave handler that forgets the group', () => {
  assert.match(indexSrc, /client\.on\('group-leave'/);
  assert.match(indexSrc, /forgetGroupPersistently\(String\(gid\), 'kicked or left'\)/);
});

check('group_join does NOT silently resume recording', () => {
  assert.match(indexSrc, /client\.on\('group_join'/);
  const join = indexSrc.slice(indexSrc.indexOf("client.on('group_join'"));
  const body = join.slice(0, join.indexOf('async function') === -1 ? 900 : join.indexOf('async function'));
  assert.ok(
    /staying silent/.test(body),
    'being added to a group must not auto-enable it'
  );
  assert.ok(
    !/allowGroup\(/.test(body),
    'group_join must not call allowGroup'
  );
});

check('scan reconciles by comparing against groups we are actually in', () => {
  assert.match(indexSrc, /forgetMissingGroups\(groups\.map\(\(g\) => g\.id\)\)/);
});

check('forgetting also removes the group from the persisted allow-list', () => {
  assert.match(indexSrc, /function forgetGroupPersistently/);
  const fn = indexSrc.slice(indexSrc.indexOf('function forgetGroupPersistently'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /saveAllowedGroups\(remaining\)/);
  assert.match(body, /forgetGroup\(groupId\)/);
});

check('the allow-list file is gitignored', () => {
  const gi = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(gi, /site-groups\.json/);
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);