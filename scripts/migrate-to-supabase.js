// One-off: copy data/sitebot.db + data/photos/** into Supabase.
// Run after supabase/schema.sql and the site-photos bucket exist:
//   node scripts/migrate-to-supabase.js
// Safe to re-run: existing rows are skipped, photos are overwritten.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { sql } from '../src/database.js';
import { uploadPhoto } from '../src/photoStore.js';

const TABLES = ['progress', 'materials', 'issues', 'work_orders', 'attendance', 'diary', 'milestones'];
const PHOTO_TABLES = ['progress', 'materials', 'issues'];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

// 'data/photos/2026-09-24/x.jpg' -> '2026-09-24/x.jpg'
const toKey = (p) => p && p.replace(/\\/g, '/').replace(/^.*data\/photos\//, '');

const local = new Database('data/sitebot.db', { readonly: true });

// 1. Photos
const root = join('data', 'photos');
let uploaded = 0;
for (const day of readdirSync(root)) {
  for (const file of readdirSync(join(root, day))) {
    await uploadPhoto(`${day}/${file}`, readFileSync(join(root, day, file)), MIME[extname(file).toLowerCase()] || 'image/jpeg', true);
    uploaded++;
  }
}
console.log(`photos: ${uploaded} uploaded`);

// 2. Rows (original ids kept, photo paths rewritten to storage keys)
for (const table of TABLES) {
  const rows = local.prepare(`SELECT * FROM ${table}`).all();
  for (const row of rows) {
    if (PHOTO_TABLES.includes(table)) {
      row.photo = toKey(row.photo);
      if (row.photos) {
        try { row.photos = JSON.stringify(JSON.parse(row.photos).map(toKey)); } catch { row.photos = null; }
      }
    }
    await sql`INSERT INTO ${sql(table)} ${sql(row)} ON CONFLICT (id) DO NOTHING`;
  }
  // Next new id continues after the migrated ones
  await sql.unsafe(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`);
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM ${sql(table)}`;
  console.log(`${table}: ${rows.length} local -> ${count} in Supabase`);
}

await sql.end();
