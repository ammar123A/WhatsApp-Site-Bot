/**
 * What does the list endpoint actually return - full keys or names relative to
 * the prefix? That difference is why a naive fetch 404s on every photo.
 */
import config from '../config.js';

const bucket = process.argv[2] || config.photoBucket;

async function listAt(prefix) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix, limit: 20, offset: 0, sortBy: { column: 'name', order: 'desc' } }),
  });
  if (!res.ok) return { err: `${res.status} ${await res.text()}` };
  return res.json();
}

console.log(`\nbucket: ${bucket}\n`);

const top = await listAt('');
console.log('--- prefix "" ---');
if (top.err) console.log('  error', top.err);
else for (const e of top.slice(0, 8)) {
  console.log(`  id=${e.id === null ? 'null' : 'set'} name="${e.name}" size=${e.size}`);
}

const firstFolder = Array.isArray(top) ? top.find((e) => e.id === null)?.name : null;
if (firstFolder) {
  const sub = await listAt(firstFolder);
  console.log(`\n--- prefix "${firstFolder}" ---`);
  if (sub.err) console.log('  error', sub.err);
  else for (const e of sub.slice(0, 5)) {
    console.log(`  id=${e.id === null ? 'null' : 'set'} name="${e.name}" size=${e.size}`);
  }
}

// Now try fetching both ways to see which key actually works.
console.log('\n--- fetch attempts ---');
const attempts = [];
if (firstFolder) {
  const sub = await listAt(firstFolder);
  if (Array.isArray(sub)) for (const e of sub.filter((x) => x.id).slice(0, 3)) attempts.push(e.name);
}
for (const e of (Array.isArray(top) ? top.filter((x) => x.id).slice(0, 3) : [])) attempts.push(e.name);

for (const key of attempts) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
    headers: { Authorization: `Bearer ${config.supabaseServiceKey}`, apikey: config.supabaseServiceKey },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`  ${res.status} ${String(buf.length).padStart(8)}b  key="${key}"`);
}
console.log();