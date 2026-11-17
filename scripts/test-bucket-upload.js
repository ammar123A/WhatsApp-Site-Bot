/**
 * End-to-end storage check with no WhatsApp involved: create the bucket, upload
 * a small object into <site>/<DD-MM-YYYY>/, read it back, then delete both the
 * object and its folder so nothing is left behind.
 */
import config from '../config.js';
import { ensureBucket, uploadPhoto, downloadPhoto } from '../src/photoStore.js';
import { folderFor } from '../src/fileStore.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const body = Buffer.from('%PDF-1.4 test upload check');
const folder = folderFor('Sky Awani', new Date());

for (const [key, meta] of Object.entries(config.fileCategories)) {
  console.log(`\n${key} -> ${meta.bucket}`);
  const ready = await ensureBucket(meta.bucket);
  check('bucket ready', ready);
  if (!ready) continue;

  const ext = key === 'drawings' || key === 'pdf' ? '.pdf' : key === 'voice' ? '.opus' : '.jpg';
  const path = `${folder}/ZZ-CHECK-${key}${ext}`;

  try {
    await uploadPhoto(path, body, 'application/pdf', true, meta.bucket);
    check('upload accepted', true);
  } catch (e) {
    check('upload accepted', false, e.message);
    continue;
  }

  const back = await downloadPhoto(path, meta.bucket);
  check('read back from the right bucket', back && back.data === body.toString('base64'),
    back ? 'content mismatch' : 'null');

  // Clean up the probe object.
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${meta.bucket}/${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
  });
  check('probe removed', res.ok || res.status === 404, `status ${res.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);