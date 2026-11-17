/**
 * Which Supabase project are we talking to, and which buckets does it have?
 *
 * The bot logged `NoSuchBucket` for site-photos seconds after successfully
 * uploading into site-photos, which should be impossible. Print the resolved URL,
 * the project id, and the real bucket list so the contradiction is visible.
 */
import config from '../config.js';

console.log(`SUPABASE_URL (env)  : ${process.env.SUPABASE_URL || '(unset)'}`);
console.log(`config.supabaseUrl  : ${config.supabaseUrl || '(EMPTY!)'}`);
console.log(`config.photoBucket  : ${config.photoBucket}`);
console.log(`buckets configured   : ${[...new Set(Object.values(config.fileCategories).map((c) => c.bucket))].join(', ')}`);
console.log(`key present          : ${config.supabaseServiceKey ? `yes (${config.supabaseServiceKey.slice(0, 12)}...)` : 'NO'}`);

const headers = {
  Authorization: `Bearer ${config.supabaseServiceKey}`,
  apikey: config.supabaseServiceKey,
};

const res = await fetch(`${config.supabaseUrl}/storage/v1/bucket`, { headers });
console.log(`\nlist buckets -> http ${res.status}`);
const body = await res.text();

if (!res.ok) {
  console.log(`  ${body.slice(0, 300)}`);
} else {
  const buckets = JSON.parse(body);
  console.log(`  ${buckets.length} bucket(s):`);
  for (const b of buckets.sort((a, z) => a.name.localeCompare(z.name))) {
    console.log(`    ${b.name.padEnd(18)} public=${b.public}  files=${b.file_size_limit ? `${Math.round(b.file_size_limit / 1048576)}MB cap` : '?'}`);
  }
  const names = buckets.map((b) => b.name);
  const wanted = [...new Set(Object.values(config.fileCategories).map((c) => c.bucket))];
  const missing = wanted.filter((w) => !names.includes(w));
  console.log(`\n  missing buckets: ${missing.length ? missing.join(', ') : 'none'}`);
}
console.log();