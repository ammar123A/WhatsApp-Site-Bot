/**
 * Regression test for the bug that made every photo list come back empty.
 *
 * `paths.map(downloadPhoto)` calls downloadPhoto(path, INDEX). The index landed
 * in the `bucket` parameter, so the fetch went to a bucket literally named "0"
 * and Supabase replied NoSuchBucket. The list then printed "1 photo" and sent
 * nothing at all.
 *
 * This asserts the real behaviour: any path handed in must resolve against the
 * default bucket, whatever position it sits at in a list.
 */
import config from '../config.js';
import { downloadPhoto } from '../src/photoStore.js';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` - ${extra}` : ''}`);
  }
};

// A path that must NOT be treated as a bucket. If the index leaks in, the
// request goes to bucket "0"/"1" and Supabase answers NoSuchBucket.
const PATHS = [
  'SiteMate/03-10-2026/17-22-41.jpg',
  'SiteMate/03-10-2026/17-01-51.jpg',
  '2026-10-03/11-57-42-1790999862080.jpg',
];

console.log(`default bucket: ${config.photoBucket}\n`);

console.log('--- single call (always worked) ---');
for (const p of PATHS) {
  const got = await downloadPhoto(p);
  check(`direct ${p}`, !!got, got ? '' : 'returned null');
}

console.log('--- via .map(downloadPhoto) - the bug ---');
const viaMap = await Promise.all(PATHS.map((p) => downloadPhoto(p)));
viaMap.forEach((got, i) => check(`mapped[${i}] ${PATHS[i]}`, !!got));

console.log('--- via .map(fn) with explicit wrap ---');
const viaWrap = await Promise.all(PATHS.map((p) => downloadPhoto(p)));
viaWrap.forEach((got, i) => check(`wrapped[${i}] ${PATHS[i]}`, !!got));

console.log('--- index passed explicitly as bucket ---');
for (let i = 0; i < PATHS.length; i++) {
  const got = await downloadPhoto(PATHS[i], i);
  check(`index-as-bucket ${i}`, !!got);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);