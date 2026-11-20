/**
 * Regression checks for the security review fixes. Offline: fetch is mocked and
 * no DB query is made.
 */
import config from '../config.js';
import { runInSite, schemaNameFor, sql } from '../src/database.js';
import { isAdmin } from '../src/utils.js';
import { handleTaggedMessage } from '../src/handlers/ai.js';
import { siteBucketFor, uploadNew } from '../src/fileStore.js';
import { redactSecrets } from '../src/training.js';

let pass = 0;
let fail = 0;
function check(label, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

console.log('\nSTORAGE IS ISOLATED BY GROUP, NOT NAME');
const a = { schema: schemaNameFor('Sky Awani Prima', '120363000000000001@g.us') };
const b = { schema: schemaNameFor('Sky Awani Prima', '120363000000000002@g.us') };
const bucketA = runInSite(a, () => siteBucketFor('Sky Awani Prima'));
const bucketB = runInSite(b, () => siteBucketFor('Sky Awani Prima'));
check('same-name groups get different buckets', bucketA !== bucketB, `${bucketA} vs ${bucketB}`);

console.log('\nUPLOADS NEVER OVERWRITE');
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), upsert: opts.headers?.['x-upsert'] });
  if (calls.length === 1) return { ok: false, status: 400, text: async () => '{"statusCode":"409","error":"Duplicate"}' };
  return { ok: true, status: 200, text: async () => '' };
};
const key = await uploadNew('drawings/19-11-2026/Pelan-Awning.pdf', Buffer.from('x'), 'application/pdf', bucketA);
check('no request asks for upsert', calls.every((c) => c.upsert === 'false'), JSON.stringify(calls));
check('a clash writes a new key', key !== 'drawings/19-11-2026/Pelan-Awning.pdf' && /^drawings\/19-11-2026\/Pelan-Awning-[a-z0-9]+\.pdf$/.test(key), key);

console.log('\nTRAINING LOG REDACTS PASTED KEYS');
const fake = 'csk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3';
check('cerebras-style key redacted', !redactSecrets(`Rep: ${fake}`).includes(fake));
check('db password redacted', !redactSecrets('postgresql://postgres.x:hunter2pass@host:5432/db').includes('hunter2pass'));
check('normal chat untouched', redactSecrets('4 pallet cement masuk stor A') === '4 pallet cement masuk stor A');

console.log('\nADMIN CHECK DOES NOT FAIL OPEN');
config.adminNumbers = ['60123456789', ' ', '+'];
check('blank/"+" admin entry does not make everyone admin', !isAdmin('60111111111@c.us'));
check('configured admin still matches', isAdmin('60123456789@c.us'));
check('local format still matches', isAdmin('0123456789'));
check('short fragment never matches', !isAdmin('789@c.us'));
config.adminNumbers = ['0123456789'];
check('local-format admin matches international sender', isAdmin('60123456789@c.us'));

console.log('\nMessageMedia RESOLVES FROM THE CJS PACKAGE');
check('default.MessageMedia is a constructor', typeof (await import('whatsapp-web.js')).default.MessageMedia === 'function');

console.log('\nLLM EDIT NEEDS A YES FROM THE SAME ADMIN');
config.adminNumbers = ['60199999999'];
const sqlCalls = [];
sql.unsafe = async (text) => { sqlCalls.push(text); const rows = [{ id: 3 }]; rows.count = 1; return rows; };
sql.begin = async (fn) => fn(Object.assign(async () => {}, { unsafe: sql.unsafe }));
const groupMsg = (author, body) => {
  const replies = [];
  return { replies, msg: { from: '120363000000000009@g.us', author, body, hasMedia: false, _data: {},
    getContact: async () => ({ number: author.split('@')[0], id: { user: author.split('@')[0], _serialized: author } }),
    reply: async (t) => { replies.push(String(t)); return true; }, react: async () => true } };
};
const updates = () => sqlCalls.filter((t) => /^\s*UPDATE/i.test(t)).length;
const edit = { action: 'edit', record: { type: 'issue', id: 3, field: 'resolution', value: 'settled' } };
const first = groupMsg('60199999999@c.us', '@kerani ok tq');
await handleTaggedMessage(first.msg, { interactive: true, decision: edit });
check('edit is held for confirmation', updates() === 0 && first.replies.some((r) => /Confirm edit/.test(r)), JSON.stringify(first.replies));
await handleTaggedMessage(groupMsg('60188888888@c.us', 'YES').msg, { interactive: true });
check("another member's YES does not apply it", updates() === 0);
await handleTaggedMessage(groupMsg('60199999999@c.us', 'YES').msg, { interactive: true });
check("the admin's YES applies it", updates() === 1, `${updates()} updates`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
