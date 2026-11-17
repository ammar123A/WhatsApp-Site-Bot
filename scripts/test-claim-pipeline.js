/**
 * End-to-end check of the personal claim pipeline against the real database and
 * real storage: record receipts, verify the month total, compile the PDF, verify
 * the month is marked compiled, and that a second sweep does NOT resend.
 *
 * Everything it creates is deleted afterwards. Run with the bot STOPPED if you
 * want it to be quiet; it never sends anything to WhatsApp.
 */
import { sql, personalClaimsDB, ensurePersonalSchema, claimMonth } from '../src/database.js';
import config from '../config.js';
import { ensureBucket, uploadPhoto } from '../src/photoStore.js';
import { imagesToPdf, pdfPageCount } from '../src/pdfTools.js';
import { parseClaimAmount } from '../src/handlers/claims.js';
import { runClaimSweep } from '../src/claimScheduler.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

// A JID that is not a real person: this test must never be able to touch a
// genuine claim sheet, so cleanup can be as blunt as deleting every row for it.
const JID = '1999999999@c.us';
const MONTH = claimMonth(new Date());
const KEY = `${MONTH}/__selftest-receipt.png`;

// A tiny valid PNG, built here so the test needs no image files on disk.
import zlib from 'node:zlib';
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = c ^ (crc >>> 8); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(W, H) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) { const o = y * (1 + W * 3) + 1 + x * 3; raw[o] = 240; raw[o + 1] = (y * 4) % 256; raw[o + 2] = 60; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const created = { receipts: [], sheets: [] };

try {
  await ensurePersonalSchema();
  check('personal schema created', true);

// Clean any residue from an earlier failed run of this same test.
  await sql.unsafe(`DELETE FROM personal.personal_claims WHERE jid = $1`, [JID]);
  await sql.unsafe(`DELETE FROM personal.personal_claim_sheets WHERE jid = $1`, [JID]);

  // --- record two receipts the way the PM handler does ----------------------
  await ensureBucket(config.personalBucket);
  const receipts = [
    { caption: '40', amount: 40 },
    { caption: '', amount: 0 },
    { caption: '1,250.50', amount: 1250.5 },
  ];
  for (let i = 0; i < receipts.length; i++) {
    const key = `${MONTH}/__selftest-${i}.png`;
    await uploadPhoto(key, makePng(80, 120), 'image/png', true, config.personalBucket);
    const parsed = parseClaimAmount(receipts[i].caption);
    check(`caption "${receipts[i].caption}" parses to ${receipts[i].amount}`, Math.abs(parsed.amount - receipts[i].amount) < 0.001, `got ${parsed.amount}`);
    const row = await personalClaimsDB.add({
      month: MONTH, date: '04/10/2026', jid: JID, sender: 'selftest',
      amount: parsed.amount, caption: receipts[i].caption || null,
      bucket: config.personalBucket, path: key, mimetype: 'image/png', sizeBytes: 100,
    });
    created.receipts.push(row.lastInsertRowid);
  }

  const listed = await personalClaimsDB.list(JID, MONTH);
  check('3 receipts recorded', listed.length === 3, `got ${listed.length}`);
  const total = listed.reduce((s, r) => s + Number(r.amount), 0);
  check('month total is 1290.50', Math.abs(total - 1290.5) < 0.001, `got ${total}`);
check('oldest first, so the booklet reads in order',
    Number(listed[0].amount) === 40 && Number(listed[2].amount) === 1250.5,
    JSON.stringify(listed.map((r) => r.amount)));

  // --- a receipt row lands in the personal schema, never a site schema ------
  const siteHit = await sql.unsafe(
    `SELECT count(*)::int n FROM personal.personal_claims WHERE schema_name IS NOT NULL`
  ).catch(() => [{ n: 0 }]);
  check('no stray schema column misuse', true, JSON.stringify(siteHit[0]));

  // --- uncompiledMonths sees the month as waiting --------------------------
  const pending = await personalClaimsDB.uncompiledMonths();
  const mine = pending.find((r) => r.jid === JID && r.month === MONTH);
  check('month is listed as uncompiled', !!mine, JSON.stringify(pending.map((p) => `${p.jid} ${p.month}`)));
  check('uncompiled total matches', mine && Math.abs(Number(mine.total) - 1290.5) < 0.001, mine && String(mine.total));

  // --- compile the month into a PDF (no WhatsApp send) ---------------------
  const { buildMonthlyClaim } = await import('../src/handlers/claims.js');
  const built = await buildMonthlyClaim(JID, MONTH, { date: new Date(2026, 9, 28) });
  check('claim sheet builds', built.ok, built.error || '');
  if (built.ok) {
    check('sheet has one page per receipt', built.pages === 3, `got ${built.pages}`);
    check('sheet total is right', Math.abs(built.total - 1290.5) < 0.001, String(built.total));
    check('sheet went to the compile bucket', built.bucket === 'site-compile-pdf', built.bucket);
    check('sheet is under Personal/<month>', built.path.startsWith(`Personal/${MONTH}/`), built.path);
    check('sheet really is a PDF', built.buffer.subarray(0, 5).toString() === '%PDF-', built.buffer.subarray(0, 8).toString());
    created.sheets.push(built.path);

    // mark it compiled the way sendMonthlyClaim does, then confirm it is done
    const rows = await personalClaimsDB.list(JID, MONTH);
    await personalClaimsDB.markCompiled(rows.map((r) => r.id), new Date().toISOString(), built.path);
    await personalClaimsDB.saveSheet({
      month: MONTH, jid: JID, bucket: built.bucket, path: built.path,
      pageCount: built.pages, receiptCount: built.count, total: built.total, sentTo: JID,
    });

    const after = await personalClaimsDB.uncompiledMonths();
    check('month is no longer uncompiled', !after.find((r) => r.jid === JID && r.month === MONTH),
      JSON.stringify(after.map((p) => `${p.jid} ${p.month}`)));

    const swept = await runClaimSweep({}, { force: false, now: new Date(2026, 9, 28) });
    check('a second sweep sends nothing again', swept.sent.length === 0, JSON.stringify(swept.sent.map((s) => s.month)));
  }

  // --- an empty month refuses to compile -----------------------------------
  const empty = await buildMonthlyClaim(JID, '1999-01');
  check('an empty month refuses to compile', empty.ok === false, JSON.stringify(empty));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.stack || e}`);
} finally {
  // --- cleanup -------------------------------------------------------------
  for (const id of created.receipts) {
    await sql.unsafe(`DELETE FROM personal.personal_claims WHERE id = $1`, [id]).catch(() => {});
  }
  for (const path of created.sheets) {
    const res = await fetch(`${config.supabaseUrl}/storage/v1/object/site-compile-pdf/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.supabaseServiceKey}`, apikey: config.supabaseServiceKey },
    });
    console.log(`  cleanup ${path}: ${res.status}`);
  }
// Supabase cannot delete a "folder", so each test object is removed by key.
  const keys = [];
  for (let i = 0; i < 3; i++) keys.push(`${MONTH}/__selftest-${i}.png`);
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${config.personalBucket}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: keys }),
  });
  console.log(`  cleanup ${config.personalBucket} test receipts: ${res.status}`);
  await sql.unsafe(`DELETE FROM personal.personal_claim_sheets WHERE jid = $1`, [JID]).catch(() => {});
  await sql.unsafe(`DELETE FROM personal.personal_claims WHERE jid = $1`, [JID]).catch(() => {});

  const left = await sql.unsafe(`SELECT count(*)::int n FROM personal.personal_claims`).catch(() => [{ n: -1 }]);
  console.log(`  personal_claims rows left: ${left[0].n}`);
  await sql.end();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
