/**
 * Ground truth on what is really stored, with FULL object keys.
 *
 * The list endpoint returns entries whose `name` is relative to the prefix that
 * was requested. Two earlier versions of this script walked folders, kept only
 * the relative name, and then fetched that bare name - which 404s on every real
 * photo and made it look like the bucket was full of broken 88-byte blobs.
 * They were not. This version joins the prefix back on before fetching.
 *
 *   node scripts/check-storage-sizes.js [bucket]
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
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'desc' } }),
  });
  if (!res.ok) {
    console.error(`  ! list "${prefix || '/'}" failed: ${res.status}`);
    return [];
  }
  return res.json();
}

function magic(buf) {
  const h = buf.subarray(0, 4).toString('hex');
  if (h.startsWith('ffd8ff')) return 'JPEG';
  if (h.startsWith('89504e47')) return 'PNG';
  if (h.startsWith('25504446')) return 'PDF';
  if (h.startsWith('494433')) return 'MP3';
  if (h.startsWith('1a45dfa3')) return 'WEBM/OPUS';
  if (h.startsWith('000001')) return 'MP4';
  if (h.startsWith('7b2273')) return 'JSON(!)';
  return `unknown(${h})`;
}

const bucket = process.argv[2] || config.photoBucket;
const objects = [];

/** prefix is joined onto relative names so we always fetch the full key. */
async function walk(prefix, depth) {
  for (const e of await listAt(bucket, prefix)) {
    if (e.id) {
      objects.push({
        key: prefix ? `${prefix}/${e.name}` : e.name,
        size: e.size,
        updated_at: e.updated_at,
        mimetype: e.metadata?.mimetype,
      });
    } else if (depth < 4) {
      await walk(prefix ? `${prefix}/${e.name}` : e.name, depth + 1);
    }
  }
}
await walk('', 0);

console.log(`\n=== ${bucket}: ${objects.length} real object(s) ===`);

const extCount = {};
let sized = 0;
let bytes = 0;
for (const o of objects) {
  const ext = (o.key.match(/\.[a-z0-9]+$/i)?.[0] || '(none)').toLowerCase();
  extCount[ext] = (extCount[ext] || 0) + 1;
  if (typeof o.size === 'number') {
    sized++;
    bytes += o.size;
  }
}
console.log(`extensions: ${Object.entries(extCount).map(([k, v]) => `${k} x${v}`).join(', ') || '(none)'}`);
// The list endpoint often omits size, so only claim a total when it reported one.
console.log(`total size: ${sized ? `${Math.round(bytes / 1024)}kb across ${sized} listed` : '(not reported by the list endpoint)'}\n`);

const newest = objects
  .slice()
  .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  .slice(0, 6);

console.log('byte-level check of the newest objects:');
for (const o of newest) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${o.key}`, {
    headers: { Authorization: `Bearer ${config.supabaseServiceKey}`, apikey: config.supabaseServiceKey },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = magic(buf);
  const looksImage = ['JPEG', 'PNG'].includes(type);
  const claimsImage = /\.(jpg|jpeg|png|webp)$/i.test(o.key);
  const ok = res.ok && (!claimsImage || looksImage);
  console.log(`  ${o.key}`);
  console.log(`     http ${res.status}  ${buf.length} bytes  -> ${type}  ${ok ? 'OK' : '*** PROBLEM ***'}`);
}
console.log();