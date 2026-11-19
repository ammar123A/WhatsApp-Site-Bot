/**
 * Personal claim calculator - PRIVATE CHAT ONLY.
 *
 * The owner forwards a receipt photo in a PM, with the amount as the caption.
 * Every receipt is kept; on the 28th of the month the whole month is compiled
 * into one PDF, sent back, and the total is stated.
 *
 *   [photo] 40          -> receipt recorded, 40.00 counted
 *   [photo]             -> receipt recorded, 0.00 (no amount yet, still evidence)
 *   [photo] 40.50       -> 40.50
 *   [photo] RM 1,250    -> 1250.00
 *   [photo] 2 x 20      -> 40.00
 *
 * Why PM-only: these are someone's personal expenses. If this ran in a group,
 * every member could forward receipts into one person's claim and read the
 * running total. Nothing in this file is reachable from a group message.
 */
import config from '../../config.js';
import { personalClaimsDB, claimMonth } from '../database.js';
import { downloadAnyMedia, uploadPhoto, ensureBucket } from '../photoStore.js';
import { imagesToPdf, pdfPageCount } from '../pdfTools.js';
import { safeName } from '../fileStore.js';
import { getToday } from '../utils.js';

const pad = (n) => String(n).padStart(2, '0');
/** Storage folder for one person's claims: the digits of their WhatsApp id. */
const jidFolder = (jid) => String(jid || '').replace(/\D/g, '') || 'unknown';

/** What day of the month the claim sheet goes out. */
export const CLAIM_DAY = 28;

/**
 * Turn one number as written into a value.
 *
 * Malaysia writes "1,250.00" for a thousand and "40,50" for forty-five ringgit,
 * and both have to come out right. The rule that separates them is how many
 * digits follow the comma: two (or one) means decimals, three or more means
 * thousands.
 */
function toAmount(raw) {
  let s = String(raw || '').replace(/\s+/g, '');
  if (s.includes(',')) {
    const digitsAfter = s.length - s.lastIndexOf(',') - 1;
    s = digitsAfter <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  s = s.replace(/[^\d.]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Every number in a string, keeping commas and dots the way people type them. */
function numbersIn(text) {
  return String(text || '').match(/-?\d+(?:[.,]\d+)*/g) || [];
}

/**
 * How much is this receipt worth?
 *
 * No caption, or a caption with no number in it, is 0 - not an error. The photo
 * is still the evidence and someone may type the amount later, so the receipt is
 * kept either way.
 *
 * @returns {{amount: number, how: string}}
 */
export function parseClaimAmount(caption) {
  const text = String(caption || '').trim();
  if (!text) return { amount: 0, how: 'no caption' };

  // Things in a caption that look like numbers but are not money, removed before
  // anything is read as an amount:
  //   "resit 04/10/2026"  a date, not a 4-ringgit claim
  //   "resit 10/10"       a day/month, still not money
  //   "14:30"             a time
  //   "IMG-001"           a filename WhatsApp attached to the forward
  const cleaned = text
    .replace(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g, ' ')
    .replace(/\d{1,2}[-/]\d{1,2}(?![-/0-9])/g, ' ')
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
    .replace(/\b[A-Za-z][\w]*[-_]\d+\b/g, ' ');

  // 1. "2 x 20" at a hardware counter means 40, not 2 and not 20. This is checked
  //    before the labelled forms on purpose: "2 x 20 ringgit" is a total of 40
  //    with the currency word after it, and the label rules would read 20.
  const times = cleaned.match(/(\d+(?:[.,]\d+)*)\s*(?:x|\*)\s*(\d+(?:[.,]\d+)*)/i);
  if (times) {
    return { amount: toAmount(times[1]) * toAmount(times[2]), how: 'multiplied' };
  }

  // 2. An amount the user actually labelled as money beats everything else.
  //    The "40 ringgit" shape is tried FIRST: in "40 ringgit 2 bottle" the
  //    currency-prefix shape would otherwise match "ringgit 2" and claim 2.
  const suffix = cleaned.match(/(\d+(?:[.,]\d+)*)\s*(?:ringgit|myr|\brm\b)/i);
  if (suffix) return { amount: toAmount(suffix[1]), how: 'labelled' };
  const prefix = cleaned.match(/(?:rm|myr)\s*(\d+(?:[.,]\d+)*)/i);
  if (prefix) return { amount: toAmount(prefix[1]), how: 'labelled' };

  // 3. Otherwise the first number in the caption is the amount.
  const all = numbersIn(cleaned);
  if (all.length) return { amount: toAmount(all[0]), how: all.length > 1 ? 'first of several' : 'only number' };

  return { amount: 0, how: 'caption has no number' };
}

const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10' -> 'Oct 2026', for messages the user reads. */
export function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return String(month || '');
  return `${MONTH_LABEL[parseInt(m[2], 10) - 1] || m[2]} ${m[1]}`;
}

/** Money, always two decimals: a claim total must never look approximate. */
export function money(n) {
  return (Number(n) || 0).toFixed(2);
}

/**
 * Record one forwarded receipt.
 *
 * @returns {{ok: true, amount: number, total: number, count: number, how: string}
 *          |{ok: false, error: string}}
 */
export async function recordClaimReceipt(msg, { sender = null, jid = '', date = new Date() } = {}) {
  if (!jid) return { ok: false, error: 'no jid' };

  let media;
  try {
    media = await downloadAnyMedia(msg, msg.client);
  } catch (e) {
    return { ok: false, error: `download failed: ${e.message || e}` };
  }
  const buffer = Buffer.from(media.data, 'base64');
  if (!buffer.length) return { ok: false, error: 'empty file' };
  if (buffer.length > config.maxFileBytes) {
    return { ok: false, error: `too big (${Math.round(buffer.length / 1048576)}MB)` };
  }

  const caption = String(msg.body || '').trim();
  const { amount, how } = parseClaimAmount(caption);
  const month = claimMonth(date);
  const bucket = config.personalBucket;

  const ext = (String(media.mimetype || '').includes('png')) ? '.png' : '.jpg';
  // Per-person folder plus the message id: a timestamp alone collided across
  // users (and within one batch forward), and upsert let one overwrite another.
  const msgId = String(msg.id?.id || Date.now()).replace(/[^A-Za-z0-9]/g, '');
  const key = `${month}/${jidFolder(jid)}/receipt-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${msgId}${ext}`;

  await ensureBucket(bucket);
  await uploadPhoto(key, buffer, media.mimetype || 'image/jpeg', false, bucket);

  const row = await personalClaimsDB.add({
    month,
    date: getToday(date),
    jid,
    sender,
    amount,
    caption: caption || null,
    bucket,
    path: key,
    mimetype: media.mimetype || 'image/jpeg',
    sizeBytes: buffer.length,
  });

  const rows = await personalClaimsDB.list(jid, month);
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);

  console.log(
    `[claim] receipt #${row.lastInsertRowid} from ${jid}: ${money(amount)} (${how}) -> ${key}; ` +
    `${month} running total ${money(total)} over ${rows.length} receipt(s)`
  );

  return { ok: true, id: row.lastInsertRowid, amount, total, count: rows.length, how, month };
}

/**
 * Build this month's compiled claim sheet from the receipts.
 *
 * Every receipt gets a page, in the order they were forwarded, labelled with the
 * amount - so the PDF and the total can be checked against each other by eye.
 *
 * @returns {{ok: true, buffer: Buffer, path: string, fileName: string, total: number,
 *            count: number, pages: number}|{ok: false, error: string}}
 */
export async function buildMonthlyClaim(jid, month, { date = new Date() } = {}) {
  const rows = await personalClaimsDB.list(jid, month);
  if (!rows.length) return { ok: false, error: `no receipts for ${month}` };

  const items = [];
  for (const row of rows) {
    // Receipts are read back through storage, not through WhatsApp: the original
    // message is long gone by the 28th.
    const file = await downloadStored(row.bucket, row.path);
    if (!file) continue;
    items.push({
      buffer: file,
      label: `${row.date}  ${money(row.amount)}${row.amount > 0 ? '' : '  (tiada jumlah)'}`,
    });
  }

  if (!items.length) return { ok: false, error: 'no receipt could be read back' };

  const buffer = await imagesToPdf(items, { title: `Personal Claim ${monthLabel(month)}` });
  const pages = await pdfPageCount(buffer);

  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const fileName = safeName(`CLAIM-${month}`, '.pdf', date);
  // Per person, or every user's sheet overwrote the same object.
  const key = `Personal/${month}/${jidFolder(jid)}/${fileName}`;
  // Personal claim output belongs with the private receipts, not in the
  // site's compiled-document bucket. The old reference recreated the deleted
  // `site-compile-pdf` bucket whenever a personal claim was compiled.
  const bucket = config.personalBucket;

  await ensureBucket(bucket);
  await uploadPhoto(key, buffer, 'application/pdf', true, bucket);

  return { ok: true, buffer, path: key, bucket, fileName, total, count: rows.length, pages };
}

/** Read a stored object back as a Buffer. */
async function downloadStored(bucket, path) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    headers: {
      Authorization: `Bearer ${config.supabaseServiceKey}`,
      apikey: config.supabaseServiceKey,
    },
  });
  if (!res.ok) {
    console.log(`  ⚠️ receipt not readable from "${bucket}": ${path} (${res.status})`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Compile and send the month's claim, then mark those receipts as compiled.
 *
 * The mark happens only after the send succeeds, so a failed send leaves the
 * month uncompiled and the next run tries again instead of losing the receipts.
 */
export async function sendMonthlyClaim(client, jid, month, { date = new Date() } = {}) {
  const built = await buildMonthlyClaim(jid, month, { date });
  if (!built.ok) return { ok: false, error: built.error };

  const { MessageMedia } = await import('whatsapp-web.js');
  await client.sendMessage(jid, new MessageMedia('application/pdf', built.buffer.toString('base64'), built.fileName));

  const rows = await personalClaimsDB.list(jid, month);
  await personalClaimsDB.markCompiled(rows.map((r) => r.id), new Date().toISOString(), built.path);
  await personalClaimsDB.saveSheet({
    month,
    jid,
    bucket: built.bucket,
    path: built.path,
    pageCount: built.pages,
    receiptCount: built.count,
    total: built.total,
    sentTo: jid,
  });

  console.log(`[claim] ${month} sent to ${jid}: ${built.count} receipts, ${built.pages} pages, RM ${money(built.total)}`);
  return { ok: true, ...built };
}

/** Short confirmation after one receipt, with the running total for the month. */
export function claimConfirmText(out) {
  if (out.amount > 0) {
    return `✅ Resit direkod — RM ${money(out.amount)}\nTotal ${monthLabel(out.month)}: *RM ${money(out.total)}* (${out.count} resit)`;
  }
  return `✅ Resit direkod — tiada jumlah dalam caption, dikira 0.00\nTotal ${monthLabel(out.month)}: *RM ${money(out.total)}* (${out.count} resit)\n_Caption jumlah bila ingat._`;
}

/** `.claim` in a PM: what has been recorded this month so far. */
export async function claimStatus(jid, month = claimMonth()) {
  const rows = await personalClaimsDB.list(jid, month);
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const counted = rows.filter((r) => Number(r.amount) > 0).length;

  let text = `*🧾 CLAIM ${monthLabel(month)}*\n\n`;
  text += `💰 Total: *RM ${money(total)}*\n`;
  text += `🧾 ${rows.length} resit (${counted} ada jumlah)\n`;
  if (rows.length) {
    text += `\n`;
    for (const r of rows.slice(-15)) {
      const mark = Number(r.amount) > 0 ? `RM ${money(r.amount)}` : '_0.00 (tiada jumlah)_';
      text += `#${r.id} ${r.date} — ${mark}${r.caption ? ` · ${r.caption}` : ''}\n`;
    }
  }
  if (!rows.length) text += '\nBelum ada resit bulan ni.';
  text += `\n\n_Sheet akan dihantar pada ${CLAIM_DAY}hb._`;
  return text;
}
