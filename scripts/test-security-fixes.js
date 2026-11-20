/**
 * Regression checks for the security review fixes. Offline: fetch is mocked and
 * no DB query is made.
 */
import { runInSite, schemaNameFor } from '../src/database.js';
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
