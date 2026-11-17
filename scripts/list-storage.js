/**
 * Walk a storage bucket and print every object with its real mimetype and size.
 * The REST list endpoint only returns one level at a time and needs an explicit
 * `prefix`, so this recurses.
 *
 *   node scripts/list-storage.js                -> every configured bucket
 *   node scripts/list-storage.js site-photos    -> one bucket
 */
import config from '../config.js';

async function listAt(bucket, prefix) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
      sortBy: { column: 'name', order: 'desc' },
    }),
  });
  if (!res.ok) {
    console.error(`  ! list ${prefix || '/'} failed: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

/** id is null for folder placeholders, present for real objects. */
function isRealObject(entry) {
  return entry.id !== null && entry.id !== undefined;
}

async function walk(bucket, prefix, depth, out) {
  const entries = await listAt(bucket, prefix);
  for (const e of entries) {
    if (isRealObject(e)) {
      out.push({ key: e.name, ...e });
      continue;
    }
    // Folder placeholder: recurse unless we are already deep enough.
    if (depth < 4) await walk(bucket, e.name, depth + 1, out);
  }
}

const buckets = process.argv[2] ? [process.argv[2]] : [...new Set(Object.values(config.fileCategories).map((c) => c.bucket))];

for (const bucket of buckets) {
  const found = [];
  await walk(bucket, '', 0, found);

  console.log(`\n=== ${bucket} — ${found.length} object(s) ===`);
  if (!found.length) {
    console.log('  (empty)');
    continue;
  }
  for (const f of found.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))) {
    const mime = f.metadata?.mimetype || '?';
    const kb = Math.round((f.size || 0) / 1024);
    console.log(`  ${f.key}`);
    console.log(`     ${mime}  ${kb}kb  ${f.updated_at || ''}`);
  }
}
console.log();