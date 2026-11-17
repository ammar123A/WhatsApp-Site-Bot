import config from '../config.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import { downloadPhoto } from './photoStore.js';
import { filesDB } from './database.js';

// Return the array of photo paths attached to a record.
// Handles both the legacy single-path `photo` column and the newer
// `photos` JSON array column (which takes precedence).
export function getRecordPhotos(entry) {
  if (!entry) return [];
  if (entry.photos) {
    try {
      const parsed = JSON.parse(entry.photos);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (e) { /* not JSON - treat as legacy trash */ }
  }
  return entry.photo ? [entry.photo] : [];
}

// The record photo column is the fast path, but older records and records that
// received several files can have additional photo rows in site_files. Include
// those linked rows when a record is recalled so a progress query never loses
// an image merely because only one of the references made it into `photos`.
async function getAllRecordPhotos(entry, kind) {
  const direct = getRecordPhotos(entry);
  let linked = [];
  try {
    const rows = await filesDB.getByLink(String(kind || '').toLowerCase(), entry.id);
    linked = rows
      .filter((row) => row.category === 'photos' && row.path)
      .map((row) => row.bucket ? `${row.bucket}::${row.path}` : row.path);
  } catch (e) {
    console.log(`  ⚠️ linked photo lookup failed for ${kind} #${entry?.id}: ${e.message || e}`);
  }
  return [...new Set([...direct, ...linked])];
}

// Reply with text + the record's attached photo(s).
// `photos` may be a single path or an array of paths.
// - Single photo: photo carries the record text as its caption (as before).
// - Multiple photos: pictures are sent first (bare), then the record text
//   is sent as a separate, tidy message.
// Photos are fetched from Supabase Storage; missing ones are skipped and it
// falls back to text-only if none can be downloaded.
// Library media sends are fixed via scripts/wa-patch.js (strips the media
// model's __x_id sentinel and tolerates the MsgKey._serialized -> $1 rename).
// If a send still fails we fall back to text only - never force it through,
// a failing send may mean WhatsApp is flagging the session.
export async function replyWithPhoto(msg, text, photos, { textFirst = false } = {}) {
  const list = Array.isArray(photos)
    ? photos
    : (photos ? [photos] : []);
  // NOTE: never `.map(downloadPhoto)` here. Array#map passes (value, index), so
  // the index lands in downloadPhoto's `bucket` parameter and every fetch goes to
  // a bucket called "0" - which Supabase answers with NoSuchBucket, so the list
  // claimed "1 photo" and silently sent nothing.
  const existing = (await Promise.all(list.filter(Boolean).map((p) => downloadPhoto(p))))
    .filter(Boolean)
    .map(p => new MessageMedia(p.mimetype, p.data, p.filename));

  if (existing.length === 0) {
    return msg.reply(text);
  }

  const chatId = msg.from || msg.to;
  const sendText = () => msg.reply(text);

  // Multi-photo: pictures first (bare), then the record text in its own message.
  // List views pass textFirst so the summary lands before the pictures.
  if (existing.length > 1) {
    if (textFirst) await sendText();
    for (const media of existing) {
      try {
        await msg.client.sendMessage(chatId, media, { linkPreview: false });
      } catch (e) {
        console.log(`  ⚠️ Photo send failed (${e.message || e}).`);
      }
    }
    if (!textFirst) return sendText();
    return undefined;
  }

  // Single photo - caption mode (matches old behaviour).
  if (textFirst) {
    await sendText();
    try {
      await msg.client.sendMessage(chatId, existing[0], { linkPreview: false });
    } catch (e) {
      console.log(`  ⚠️ Photo send failed (${e.message || e}).`);
    }
    return undefined;
  }
  try {
    await msg.client.sendMessage(chatId, existing[0], { caption: text, linkPreview: false });
  } catch (e) {
    console.log(`  ⚠️ Photo send failed (${e.message || e}) - sending text only.`);
    return sendText();
  }
}

// Caption for ONE record's photo, so every picture arrives with the words that
// belong to it instead of a text block followed by a burst of bare photos.
export function recordCaption(entry, kind = 'Record') {
  if (kind.toLowerCase() === 'progress') {
    return [
      `*Progress #${entry.id}*`,
      entry.date ? `📅 ${entry.date}` : null,
      entry.description ? `> ${entry.description}` : null,
    ].filter(Boolean).join('\n');
  }
  if (kind.toLowerCase() === 'material') {
    return [
      `*Material #${entry.id}*`,
      entry.date ? `📅 ${entry.date}` : null,
      `> ${entry.material_name || entry.material || 'Material'}${entry.quantity != null ? ` - ${entry.quantity}${entry.unit ? ` ${entry.unit}` : ''}` : ''}`,
    ].filter(Boolean).join('\n');
  }
  if (kind.toLowerCase() === 'issue') {
    return [
      `*Issue #${entry.id}*`,
      entry.date ? `📅 ${entry.date}` : null,
      entry.title ? `> ${entry.title}` : null,
      entry.status ? `📌 ${String(entry.status).replace('_', ' ')}` : null,
    ].filter(Boolean).join('\n');
  }
  const lines = [`*${kind} #${entry.id}*`];
  if (entry.title) lines.push(`*${entry.title}*`);
  if (entry.description) lines.push(`> ${entry.description}`);
  if (entry.location) lines.push(`📍 ${entry.location}`);
  if (entry.status) lines.push(`📌 ${String(entry.status).replace('_', ' ')}`);
  if (entry.priority) lines.push(`🔥 ${entry.priority}`);
  if (entry.quantity != null) {
    lines.push(`📦 ${entry.quantity}${entry.unit ? ' ' + entry.unit : ''}`);
  }
  if (entry.reported_by) lines.push(`👤 ${entry.reported_by}`);
  if (entry.received_by) lines.push(`👤 ${entry.received_by}`);
  const n = getRecordPhotos(entry).length;
  if (n > 1) lines.push(`📷 (${n} photos for this record)`);
  return lines.join('\n');
}

// How many pictures a list view may push before it gets annoying.
const MAX_LIST_PHOTOS = 10;

// Reply with a list summary, then EACH photo sent one-by-one with its own
// record's description as the caption. Never "one big text + bare photo dump".
//
// If a record says it has photos but none of them can be loaded, that is reported
// in the summary. Previously the failure was swallowed and the site was told
// "📷 1 photo" while the message contained no picture at all.
export async function replyListWithPhotos(msg, text, entries, kind = 'Record') {
  const rows = (entries || []).filter(Boolean);

  let sent = 0;
  const broken = [];

  for (const entry of rows) {
    if (sent >= MAX_LIST_PHOTOS) break;
    const caption = recordCaption(entry, kind);
    const wanted = await getAllRecordPhotos(entry, kind);
    const pics = (await Promise.all(wanted.map((p) => downloadPhoto(p)))).filter(Boolean);

    if (wanted.length && !pics.length) broken.push(`#${entry.id}`);

    for (const p of pics) {
      if (sent >= MAX_LIST_PHOTOS) break;
      try {
        await msg.client.sendMessage(
          msg.from || msg.to,
          new MessageMedia(p.mimetype, p.data, p.filename),
          { caption, linkPreview: false }
        );
      } catch (e) {
        console.log(`  ⚠️ Photo send failed (${e.message || e}).`);
        broken.push(`#${entry.id}`);
      }
      sent++;
      await new Promise(r => setTimeout(r, 600)); // don't burst the group
    }
  }

  let footer = '';
  if (broken.length) {
    footer = `\n\n⚠️ Gambar tak dapat dimuatkan untuk ${[...new Set(broken)].join(', ')} -_fail dalam storage_`;
  }
  if (sent >= MAX_LIST_PHOTOS) {
    return msg.reply(`${text}\n\n_(showing first ${MAX_LIST_PHOTOS} photos)${footer}`);
  }
  return msg.reply(text + footer);
}

// Get today's date in DD/MM/YYYY format. Accepts a Date so a record can be
// filed under the day it happened rather than the day it was typed.
export function getToday(when = new Date()) {
  const now = when instanceof Date ? when : new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

// Get current time
export function getCurrentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// Get day name
export function getDayName() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date().getDay()];
}

// Parse date from DD/MM/YYYY format
export function parseDate(dateStr) {
  if (!dateStr) return getToday();
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return dateStr; // Already in correct format
  }
  return getToday();
}

// Get start of week (Monday)
export function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  const dayStr = String(monday.getDate()).padStart(2, '0');
  const monthStr = String(monday.getMonth() + 1).padStart(2, '0');
  return `${dayStr}/${monthStr}/${monday.getFullYear()}`;
}

// Get start of month
export function getMonthStart() {
  const now = new Date();
  const dayStr = String(now.getDate()).padStart(2, '0');
  const monthStr = String(now.getMonth() + 1).padStart(2, '0');
  return `01/${monthStr}/${now.getFullYear()}`;
}

// Format date for display
export function formatDate(dateStr) {
  if (!dateStr) return '-';
  return dateStr;
}

// Check if number is admin
export function isAdmin(phoneNumber) {
  const cleanNumber = (phoneNumber || '').replace(/[^0-9]/g, '');
  if (!cleanNumber) return false; // ''.endsWith check below would match every admin
  return config.adminNumbers.some(admin => {
    const cleanAdmin = admin.replace(/[^0-9]/g, '');
    return cleanNumber.endsWith(cleanAdmin) || cleanAdmin.endsWith(cleanNumber);
  });
}

// Extract phone number from WhatsApp message
export function extractPhone(contact) {
  if (contact.id && contact.id._serialized) {
    return contact.id._serialized.replace('@c.us', '').replace('@g.us', '');
  }
  return '';
}

// Parse key-value arguments from message
export function parseArgs(text, startFrom = 1) {
  const args = text.split('\n').slice(startFrom).map(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      return {
        key: line.substring(0, colonIndex).trim().toLowerCase(),
        value: line.substring(colonIndex + 1).trim()
      };
    }
    return null;
  }).filter(Boolean);
  
  return args.reduce((acc, { key, value }) => {
    acc[key] = value;
    return acc;
  }, {});
}

// Who sent this message. Reported-by / received-by is never typed by the user -
// it is taken from the WhatsApp profile name of whoever ran the command.
export function getSenderName(msg) {
  const d = msg?._data || {};
  return String(d.notifyName || d.pushname || '').trim() || null;
}

// Build progress report message
export function buildProgressMessage(entries) {
  if (entries.length === 0) return '*No progress entries found.*';

  let msg = '';
  
  entries.forEach((entry) => {
    msg += `*Progress #${entry.id}*\n`;
    if (entry.date) msg += `📅 ${entry.date}\n`;
    msg += `> ${entry.description}\n`;
    msg += '\n';
  });

return msg;
}

// Full progress report is opt-in. The normal daily query intentionally stays
// compact: the description, date and the actual photo are enough.
export function buildProgressSummaryMessage(entries) {
  if (entries.length === 0) return '*No progress entries found.*';

  let msg = '*📸 SITE PROGRESS SUMMARY*\n';
  msg += `_${getDayName()}, ${getToday()}_\n\n`;
  entries.forEach((entry) => {
    msg += `*#${entry.id}*\n`;
    msg += `> ${entry.description}\n`;
    if (entry.location) msg += `📍 ${entry.location}\n`;
    if (entry.reported_by) msg += `👤 ${entry.reported_by}\n`;
    const photos = getRecordPhotos(entry);
    if (photos.length) msg += `📷 ${photos.length} photo${photos.length > 1 ? 's' : ''}\n`;
    msg += '\n';
  });
  return msg;
}

// Build materials report message.
// The header shows the date of the RECORDS, not today's date - materials are
// recalled by date, so saying "today" over yesterday's list was wrong.
export function buildMaterialsMessage(entries) {
  if (entries.length === 0) return '*No material entries found.*';

  const dates = [...new Set(entries.map((e) => e.date).filter(Boolean))];
  const shown = dates.length === 1 ? dates[0] : dates.length > 1 ? `${dates[0]} - ${dates[dates.length - 1]}` : getToday();

  let msg = '*📦 MATERIALS RECEIVED*\n';
  msg += `_${shown}_\n\n`;

  entries.forEach((entry, i) => {
    msg += `*#${entry.id}* ${entry.material_name}\n`;
    msg += `> ${entry.quantity} ${entry.unit}\n`;
    if (entry.date && dates.length > 1) msg += `📅 ${entry.date}\n`;
    if (entry.supplier) msg += `🏭 Supplier: ${entry.supplier}\n`;
    if (entry.po_number) msg += `📄 PO: ${entry.po_number}\n`;
    if (entry.location) msg += `📍 Location: ${entry.location}\n`;
    if (entry.received_by) msg += `👤 Received by: ${entry.received_by}\n`;
    msg += '\n';
  });

  return msg;
}

// Normal material lookup: one compact row per record. Full headers and
// supplier/PO metadata stay available to dedicated reports, not daily recall.
export function buildCompactMaterialsMessage(entries) {
  if (entries.length === 0) return '*No material entries found.*';
  return entries.map((entry) => [
    `*Material #${entry.id}*`,
    entry.date ? `📅 ${entry.date}` : null,
    `> ${entry.material_name || entry.material || 'Material'}`,
    entry.quantity != null ? `📦 ${entry.quantity}${entry.unit ? ` ${entry.unit}` : ''}` : null,
    '',
  ].filter((line) => line !== null).join('\n')).join('\n');
}

/**
 * Read a date out of what someone typed, in the forms site people actually use.
 * Returns 'DD/MM/YYYY' or null when it is not a date.
 *   "hari ini" "today" "hari nie" -> today
 *   "semalam" "yesterday"         -> yesterday
 *   "2 hari lepas"                -> two days ago
 *   "15/09/2026" "15-9-26" "15/9" -> that day
 */
export function parseRecordDate(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;

  const shift = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-GB');
  };

  if (/\b(hari\s*(?:ini|ni|nie)|harian|today|now|sekarang)\b/.test(t)) return getToday();
  if (/\b(semalam|smalam|yesterday|AR?ku|full\s*aqo?)\b|\b1\s*hari\s*(lalu|lepas)\b/.test(t)) return shift(-1);
  if (/\b(hari\s*lusa|day\s*before\s*yesterday)\b/.test(t)) return shift(-2);

  const lastWeekDay = t.match(/(?:minggu\s+lepas|last\s+week|last)\s+(?:hari\s+)?(ahad|isnin|selasa|rabu|khamis|jumaat|sabtu|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (lastWeekDay) {
    const day = {
      ahad: 0, sunday: 0, isnin: 1, monday: 1, selasa: 2, tuesday: 2,
      rabu: 3, wednesday: 3, khamis: 4, thursday: 4, jumaat: 5, friday: 5,
      sabtu: 6, saturday: 6,
    }[lastWeekDay[1]];
    const [todayDay, todayMonth, todayYear] = getToday().split('/').map(Number);
    const d = new Date(todayYear, todayMonth - 1, todayDay);
    const daysFromMonday = (d.getDay() + 6) % 7;
    const targetOffset = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - daysFromMonday - 7 + targetOffset);
    return d.toLocaleDateString('en-GB');
  }

  const ago = t.match(/(\d+)\s*hari\s*(lalu|lepas)/);
  if (ago) return shift(-parseInt(ago[1], 10));

  // "12 Oktober", "12hb Okt 2026", "12 october" - the way people actually type
  // it. Malay and English month names both, because the group mixes them.
  const MONTHS = {
    jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2,
    mar: 3, mac: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5,
    jun: 6, june: 6, jul: 7, july: 7, ogos: 8, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10,
    nov: 11, november: 11, dis: 12, desember: 12, dec: 12, december: 12,
  };
  const dayMonth = t.match(/\b(\d{1,2})\s*(?:hari\s*bulan|hb)\s*(\d{1,2})(?:\s*(\d{4}))?\b/);
  if (dayMonth) {
    const year = dayMonth[3] || String(new Date().getFullYear());
    return `${dayMonth[1].padStart(2, '0')}/${dayMonth[2].padStart(2, '0')}/${year}`;
  }
  const named = t.match(/\b(\d{1,2})\s*(?:hb|haribulan)?\s*([a-z]+)\s*(\d{4})?\b/);
  if (named && MONTHS[named[2]]) {
    const dd = named[1].padStart(2, '0');
    const mm = String(MONTHS[named[2]]).padStart(2, '0');
    const year = named[3] || String(new Date().getFullYear());
    return `${dd}/${mm}/${year}`;
  }

  const full = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (full) {
    const [, dd, mm, yy] = full;
    const year = yy.length === 2 ? `20${yy}` : yy;
    return `${dd.padStart(2, '0')}/${mm.padStart(2, '0')}/${year}`;
  }

  const short = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (short) {
    const year = new Date().getFullYear();
    return `${short[1].padStart(2, '0')}/${short[2].padStart(2, '0')}/${year}`;
  }

  return null;
}

/** The question to ask when a date is needed but was not given. */
export const ASK_WHICH_DATE =
  'Tarikh mana boss? (cth: hari ini / semalam / 15/09/2026)';

// Build issues report message
// Kept deliberately short: id, the issue, and its status. That is what the site
// needs to recall a record later - the id is the handle, the status is the state.
// Category/priority/location used to be listed too and only buried the numbers.
export function buildIssuesMessage(issues) {
  if (issues.length === 0) return '*No issues found.*';

  const statusEmoji = {
    open: '⬜',
    in_progress: '🔄',
    resolved: '✅',
    closed: '🔒'
  };

  let msg = '*⚠️ SITE ISSUES*\n';
  msg += `_${getDayName()}, ${getToday()}_\n\n`;

  issues.forEach(issue => {
    msg += `*#${issue.id}* ${issue.title}\n`;
    msg += `${statusEmoji[issue.status] || '❓'} ${issue.status.replace('_', ' ').toUpperCase()}\n`;
    const photos = getRecordPhotos(issue);
    if (photos.length) msg += `📸 ${photos.length} photo${photos.length > 1 ? 's' : ''}\n`;
    msg += '\n';
  });
  
  return msg;
}

// Normal issue lookup: compact record rows only. Detailed issue reports remain
// available when the user explicitly asks for a report/summary.
export function buildCompactIssuesMessage(issues) {
  if (issues.length === 0) return '*No issues found.*';
  const statusEmoji = { open: '⬜', in_progress: '🔄', resolved: '✅', closed: '🔒' };
  return issues.map((issue) => [
    `*Issue #${issue.id}*`,
    issue.date ? `📅 ${issue.date}` : null,
    issue.title ? `> ${issue.title}` : null,
    issue.status ? `${statusEmoji[issue.status] || '❓'} ${issue.status.replace('_', ' ')}` : null,
    '',
  ].filter((line) => line !== null).join('\n')).join('\n');
}

// Build stock summary
export function buildStockSummary(stocks) {
  if (stocks.length === 0) return '*No stock data found.*';
  
  let msg = '*📊 STOCK SUMMARY*\n\n';
  
  const grouped = {};
  stocks.forEach(s => {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });
  
  for (const [category, items] of Object.entries(grouped)) {
    msg += `*${category}*\n`;
    items.forEach(item => {
      msg += `> ${item.material_name}: ${item.total_qty} ${item.unit}\n`;
    });
    msg += '\n';
  }
  
  return msg;
}

// Build issue stats
export function buildIssueStats(stats) {
  let msg = '*📈 ISSUE STATISTICS*\n\n';
  msg += `Total Issues: ${stats.total}\n`;
  msg += `⬜ Open: ${stats.open}\n`;
  msg += `🔄 In Progress: ${stats.in_progress}\n`;
  msg += `✅ Resolved: ${stats.resolved}\n`;
  msg += `🔒 Closed: ${stats.closed}\n\n`;
  
  if (stats.urgent_open > 0) {
    msg += `🔴 *URGENT OPEN: ${stats.urgent_open}*\n`;
  }
  if (stats.high_open > 0) {
    msg += `🟠 *HIGH PRIORITY OPEN: ${stats.high_open}*\n`;
  }
  
  return msg;
}

// Build diary report
export function buildDiaryMessage(diary) {
  if (!diary) return '*No diary entry found.*';
  
  let msg = '*📒 SITE DIARY*\n';
  msg += `_${diary.date}_\n\n`;
  
  if (diary.weather) msg += `☁️ Weather: ${diary.weather}\n`;
  if (diary.temperature) msg += `🌡️ Temperature: ${diary.temperature}\n`;
  if (diary.visitors) msg += `👥 Visitors: ${diary.visitors}\n`;
  if (diary.general_notes) msg += `\n📝 *General Notes:*\n${diary.general_notes}\n`;
  if (diary.safety_notes) msg += `\n🦺 *Safety Notes:*\n${diary.safety_notes}\n`;
  
  return msg;
}

// ── Project SS report ──────────────────────────────────────────────────────
// Site header + workers pulled from attendance, then machinery/equipment and
// weather for the day. Missing sections show a placeholder so the bot can ask
// the site team to fill them in.
export const SS_DEFAULT_SITE = 'Flora Hijauan SBR';

// DD/MM/YYYY -> D/M/YYYY (matches the format the site team writes by hand)
export function formatSSDate(dateStr) {
  if (!dateStr) return '';
  const [d, m, y] = String(dateStr).split('/');
  if (!d || !m || !y) return dateStr;
  return `${parseInt(d, 10)}/${parseInt(m, 10)}/${y}`;
}

// Turn a stored multi-line list into clean lines (strips bullets/numbering,
// drops the U+2060 word-joiner that WhatsApp sometimes injects).
export function ssList(raw) {
  if (!raw) return [];
  return String(raw)
    .split('\n')
    .map(l => l.replace(/\u2060/g, '').trim())
    .filter(Boolean)
    .map(l => l.replace(/^[-*\u2022]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

// Workers show their shift only ("Ali : 0800-1900"). Hours/OT were dropped
// from attendance - the shift is what the site team actually reports.
function workerWhen(a) {
  return (a.shift && String(a.shift).trim()) || '-';
}

export function buildSSReport(d) {
  const L = [];
  const MISSING = '_belum diisi - hantar .addss untuk update_';

  L.push(`*${d.siteName || SS_DEFAULT_SITE}*`);
  L.push(`Date : ${formatSSDate(d.date)}`);
  L.push('');
  L.push('');

  L.push('*HY Workers*');
  if (d.hyWorkers && d.hyWorkers.length) {
    for (const w of d.hyWorkers) L.push(`- ${w.worker_name} : ${workerWhen(w)}`);
  } else {
    L.push(MISSING);
  }
  L.push('');
  L.push('');

  L.push('*Operator*');
  // Operators are typed into .addss, so an empty section just stays empty
  // instead of showing a "belum diisi" nag.
  if (d.operators && d.operators.length) {
    for (const o of d.operators) L.push(`- ${o}`);
  }
  L.push('');
  L.push('');
  L.push('');

  L.push('*Machinery & Equipment*');
  const me = ssList(d.machineryEquipment);
  if (me.length) {
    me.forEach((item, i) => L.push(`${i + 1}) ${item}`));
  } else {
    L.push(MISSING);
  }
  L.push('');
  L.push('');
  L.push('');
  L.push('');

  L.push('*Machinery*');
  const mac = ssList(d.machinery);
  if (mac.length) {
    for (const item of mac) L.push(`- ${item}`);
  } else {
    L.push(MISSING);
  }
  L.push('');
  L.push('');
  L.push('');

  L.push(`*Weather* - ${d.weather || MISSING}`);

  return L.join('\n');
}

// Build the report straight from DB rows for a date.
export async function buildSSReportForDate({ diary, attendance }) {
  const workers = attendance || [];
  return buildSSReport({
    siteName: (diary && diary.site_name) || SS_DEFAULT_SITE,
    date: diary && diary.date,
    hyWorkers: workers,
    operators: ssList(diary && diary.operators),
    machineryEquipment: diary && diary.machinery_equipment,
    machinery: diary && diary.machinery,
    weather: diary && diary.weather,
  });
}

// Build help message
export function buildHelpMessage() {
  let msg = '*🤖 SITE BOT COMMANDS*\n\n';

  msg += '*📋 Project SS Report*\n';
  msg += '> .projectss - Today\'s Project SS report\n';
  msg += '> .projectss [DD/MM/YYYY] - Report for a specific date\n';
  msg += '> .addss - Update the report\n';
  msg += '```\n.addss\nSite: Flora Hijauan SBR\nOperator: Reza (ex08)\nWeather: 🌤️☀️🌤️\nMachinery & Equipment:\nchainsaw - 1 nos\nGrinder (small) - 1 nos\nMachinery:\nExcavator 13\nCompactor 25 ton\n```\n\n';
  msg += '_Hantar `.addss` tanpa apa-apa untuk mula report baru - bot tunjuk data semalam, reply *sama* untuk copy semua, atau taip senarai betul (buang worker tak datang, machinery repair / site lain)._\n\n';

  msg += '*📝 Progress Tracking*\n';
  msg += '> .progress - Today\'s progress + photos\n';
  msg += '> .progress [DD/MM/YYYY] - Progress on specific date\n';
  msg += '> .progress week - This week\'s progress\n';
  msg += '> .progress month - This month\'s progress\n';
  msg += '> .progress [id] - One entry with its photos\n';
  msg += '> .addprogress - Add progress entry\n';
  msg += '```\n.addprogress\nDescription: pasang paip atas bumbung dah siap\nLocation: Blok A\n```\n\n';
  msg += '_Description + gambar dah cukup. Reported by bot detect sendiri._\n\n';

  msg += '*📦 Materials*\n';
  msg += '> .materials - Today\'s materials + photos (default)\n';
  msg += '> .materials [tarikh] - Materials for that day\n';
  msg += '> .materials semalam / 02/10/2026 - Other days\n';
  msg += '> .material [id] - One entry with its photos\n';
  msg += '> .stock - Current stock summary\n';
  msg += '> .addmaterial - Add material entry (photo wajib)\n';
  msg += '```\n.addmaterial\nMaterial: Cement\nQuantity: 100\nUnit: bags\nSupplier: ABC Corp\nLocation: Store\n```\n\n';
  msg += '_Received by bot detect sendiri._\n\n';
  msg += '⚠️ _Material tanpa gambar tidak direkodkan - hantar gambar DO dulu._\n\n';

  msg += '*⚠️ Issues*\n';
  msg += '> .issues - Open issues + photos\n';
  msg += '> .issues all - All issues\n';
  msg += '> .issuestats - Issue statistics\n';
  msg += '> .addissue - Report issue\n';
  msg += '```\n.addissue\nTitle: Water leak\nDescription: Leak at 2nd floor\nLocation: Block A L2\n```\n';
  msg += '> .issue [id] - View one issue (with photos)\n';
  msg += '> .resolve [id] [resolution] - Mark resolved\n';
  msg += '> .assign [id] [name] - Assign issue\n';
  msg += '> .updatepriority [id] [low|medium|high|urgent]\n\n';

  msg += '*✏️ Edit / Delete*\n';
  msg += '> .edit [progress|material|issue|workorder|attendance|ss|milestone] [id]\n';
  msg += '```\n.edit issue 3\nPriority: urgent\nAssigned to: Azman\n```\n\n';
  msg += '> .deleteprogress [id] / .deletematerial [id]\n\n';

  msg += '*📸 Photos*\n';
  msg += '> Send photo(s) in the group - saved automatically\n';
  msg += '> .attach [progress|material|issue] [id] - Link recent photos\n';
  msg += '> .photo - Where the latest photo was saved\n';
  msg += '_Tip: send a photo with .addissue / .addprogress / .addmaterial as the caption to attach it directly._\n\n';

  msg += '*🗂️ Files & Versions*\n';
  msg += '> #claim / #do / #invoice / #drawing / #progress + file - terus ke folder betul\n';
  msg += '> .latest - Versi terbaru setiap fail\n';
  msg += '> .latest pelan awning - Cari versi terbaru ikut nama\n';
  msg += '> .files 02-10-2026 - Semua fail pada tarikh itu\n';
  msg += '> .files <id> - Hantar balik fail itu\n';
  msg += '_Upload nama yang sama = versi baru (v2, v3...). Bot sentiasa bagi yang terbaru._\n\n';

  msg += '*👷 Attendance*\n';
  msg += '> .attendance - Today\'s attendance (shows #id)\n';
  msg += '> .addattendance - Add attendance (banyak worker sekali)\n';
  msg += '```\n.addattendance\nName: Ali\nContractor: ABC\nRole: Foreman\nShift: 0800-1900\nName: Abu\nContractor: hys\nRole: Foreman\nShift: 0800-1900\n```\n\n';
  msg += '_Setiap `Name:` baru = satu worker. Hours/OT tak perlu lagi - shift je yang dipaparkan._\n\n';

  msg += '*👷 Work Orders*\n';
  msg += '> .workorders - Pending work orders\n';
  msg += '> .addworkorder - Add work order\n\n';

  msg += '*📊 Reports*\n';
  msg += '> .dailyreport - Full daily report\n';
  msg += '> .weeklyreport - Weekly summary\n\n';

  msg += '*ℹ️ Other*\n';
  msg += '> .milestones - Project milestones\n';
  msg += '> .addmilestone - Add milestone\n';
  msg += '> .help - Show this message\n\n';
  msg += '_Bot senyap bila rekod berjaya disimpan - dia hanya balas bila ada failure atau bila kamu tanya view (`.projectss`, `.progress`, dll)._\n\n';

  msg += '*🤖 AI Assistant*\n';
  msg += '> Tag bot (`@kerani`) bila nak tanya atau simpan tanpa command\n';
  msg += '> `@kerani` cement 100 bags sampai site, supplier ABC\n';
  msg += '> `@kerani` ada progress apa hari ni?\n';
  msg += '_Bot klasifikasi sendiri ke progress / material / issue / attendance. Kalau tak pasti, dia tanya balik._\n\n';

  return msg;
}
