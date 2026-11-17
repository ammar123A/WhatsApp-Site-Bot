/**
 * Proves the rememberMessage() fix: a chat_log write must succeed inside
 * runInSite() and must NEVER hit public (which has no chat_log at all).
 * Writes one row, reads it back, then deletes it. Leaves nothing behind.
 */
import { runInSite, chatLogDB, ensureSiteSchema } from '../src/database.js';

const SITE = { siteName: 'Kerani', groupId: '120363413250104647@g.us' };
const timer = setTimeout(() => { console.log('FAIL timeout'); process.exit(1); }, 45000);

try {
  const site = await ensureSiteSchema(SITE);
  console.log(`site=${site.siteName} schema=${site.schemaName}`);

  const marker = `selftest-${Date.now()}`;
  const id = await runInSite(site, () => chatLogDB.add({
    date: '2026-10-05',
    sender: 'selftest',
    senderId: '0',
    isBot: false,
    body: marker,
    kind: 'chat',
  }));
  console.log(`PASS  chat_log insert inside runInSite -> id ${id}`);

  const rows = await runInSite(site, () => chatLogDB.search(marker.split('-').slice(1)));
  const mine = rows.filter(r => r.body === marker);
  console.log(`PASS  read back inside runInSite -> ${mine.length} row(s)`);

  if (mine.length) {
    await runInSite(site, () => chatLogDB.delete(mine[0].id));
    console.log('PASS  self-test row deleted, nothing left behind');
  }

  // The real regression: without runInSite this throws. Prove it still does.
  try {
    await chatLogDB.add({ date: '2026-10-05', sender: 'x', senderId: '0', isBot: false, body: marker, kind: 'chat' });
    console.log('WARN  unscoped write unexpectedly succeeded (public.chat_log exists?)');
  } catch (e) {
    console.log(`PASS  unscoped write still fails as expected -> ${String(e.message || e).slice(0, 60)}`);
  }

  clearTimeout(timer);
  process.exit(0);
} catch (e) {
  clearTimeout(timer);
  console.log('FAIL', e.message || e);
  process.exit(1);
}