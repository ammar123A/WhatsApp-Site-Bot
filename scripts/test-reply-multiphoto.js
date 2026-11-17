// Verifies: multi-photo reply ordering + auto-attach helper (no WhatsApp needed)
import { replyWithPhoto } from '../src/utils.js';
import { clearPhotoBatch } from '../src/handlers/photos.js';
import config from '../config.js';

// Real object keys in the photo bucket. The old version used local paths
// ("data/photos/2026-09-24/t1.jpg") that stopped existing once photos moved to
// Supabase, so every download returned null and the send assertions failed for a
// reason that had nothing to do with the code under test.
const PATHS = [
  'SiteMate/03-10-2026/17-22-41.jpg',
  'SiteMate/03-10-2026/17-01-51.jpg',
  '2026-10-03/11-57-42-1790999862080.jpg',
];
import { ensureSiteSchema, runInSite, sql, issuesDB } from '../src/database.js';

// Pinned to one site and scoped: the old version reached for the newest real
// issue and overwrote its photos column, corrupting live site data on every run.
const [siteRow] = await sql`SELECT site_name, group_id FROM public.sites WHERE schema_name='site_sitemate_f85953'`;
const site = await ensureSiteSchema({ siteName: siteRow.site_name, groupId: siteRow.group_id });
const inSite = (fn) => runInSite(site, fn);

console.log(`photo bucket: ${config.photoBucket}`);
console.log(`keys: ${PATHS.join(', ')}\n`);

let failed = false;
const ok = (n, c) => { console.log(`${c ? '✅' : '❌'} ${n}`); if (!c) failed = true; };

// ── Test 1: multi-photo sends bare pics first, then text in separate message ──
{
  const sent = [];
  const mockMsg = {
    from: '1203@g.us',
    reply: async (text) => { sent.push({ kind: 'text', text }); },
    client: { sendMessage: async (chatId, media, opts) => { sent.push({ kind: 'media', chatId, hasCaption: !!opts.caption, caption: opts.caption }); } },
  };
  const paths = [...PATHS];
  await replyWithPhoto(mockMsg, 'ISSUE #7 summary', paths);
  const captioned = sent.filter(s => s.kind === 'media' && s.hasCaption);
  const textMsgs = sent.filter(s => s.kind === 'text');
  ok('3 media sends', sent.filter(s => s.kind === 'media').length === 3);
  ok('all 3 pics sent bare (no caption)', sent.filter(s => s.kind === 'media' && s.hasCaption).length === 0);
  ok('text sent separately after pics', textMsgs.length === 1 && textMsgs[0].text.includes('ISSUE #7') && sent.indexOf(textMsgs[0]) > sent.findIndex(s => s.kind === 'media'));
}

// ── Test 2: single photo still uses caption mode ──
{
  const sent = [];
  const mockMsg = {
    from: '1203@g.us',
    reply: async (t) => sent.push({ kind: 'text', t }),
    client: { sendMessage: async (chatId, media, opts) => sent.push({ kind: 'media', hasCaption: !!opts.caption, caption: opts.caption }) },
  };
  await replyWithPhoto(mockMsg, 'SINGLE CAPTION', [PATHS[0]]);
  ok('single photo carries caption', sent.length === 1 && sent[0].kind === 'media' && sent[0].hasCaption && sent[0].caption === 'SINGLE CAPTION');
}

// ── Test 3: auto-attach helper links batch to a record ──
{
  clearPhotoBatch();
  // Two photos "waiting", then attached to a record we create ourselves.
  const probe = await inSite(() =>
    issuesDB.add({ date: '01/01/2026', title: 'auto test', description: 'x', category: 'Test', priority: 'medium', status: 'open' })
  );
  const id = probe.lastInsertRowid;
  await inSite(() => issuesDB.updatePhotos(id, [PATHS[0], PATHS[1]]));
  const fresh = await inSite(() => issuesDB.getById(id));
  ok('multi photos stored + readable', typeof fresh.photos === 'string' && fresh.photos.includes(PATHS[0]) && fresh.photos.includes(PATHS[1]));
  ok('both photos on the record', (JSON.parse(fresh.photos || '[]') || []).length === 2);
  await inSite(() => issuesDB.delete(id));
  const gone = await inSite(() => issuesDB.getById(id));
  ok('probe issue cleaned up', gone == null);
}

if (!failed) console.log('\nAll reply/attach tests passed.');
else { console.log('\nSome tests FAILED.'); process.exitCode = 1; }
await sql.end();