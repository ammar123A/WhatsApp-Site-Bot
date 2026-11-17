/**
 * Reproduce downloadPhoto()'s exact request and print the server's error body.
 *
 * The bot logs "not downloadable: 400" and moves on, which hides the only useful
 * part - what Supabase actually said. This prints it.
 *
 *   node scripts/check-record-photos.js
 */
import config from '../config.js';
import { downloadPhoto } from '../src/photoStore.js';

const keys = process.argv.slice(2);
if (!keys.length) {
  console.log('usage: node scripts/check-record-photos.js <key> [<key> ...]');
  process.exit(1);
}

console.log(`bucket: ${config.photoBucket}`);
console.log(`base:   ${config.supabaseUrl}/storage/v1/object/${config.photoBucket}/\n`);

for (const key of keys) {
  const url = `${config.supabaseUrl}/storage/v1/object/${config.photoBucket}/${key}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  http ${res.status}  ${buf.length}b  ${key}`);
  if (!res.ok) {
    console.log(`     body: ${buf.toString('utf8').slice(0, 300)}`);
  } else {
    console.log(`     magic: ${buf.subarray(0, 4).toString('hex')}`);
  }
}

console.log('\nvia downloadPhoto():');
for (const key of keys) {
  const got = await downloadPhoto(key);
  console.log(`  ${got ? `OK ${got.mimetype} ${Math.round(got.data.length * 0.75 / 1024)}kb` : 'null'}  ${key}`);
}
console.log();