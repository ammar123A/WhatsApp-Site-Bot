/**
 * Everything a site group sends is auto-saved and filed, and it can be found
 * again by number.
 *
 *   .files                 - latest files
 *   .files drawings        - one category
 *   .files 02-10-2026      - one day
 *   .files paip            - search names and captions
 *   .files 14              - one file by its id
 */
import config from '../../config.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import { filesDB } from '../database.js';
import { saveSiteFile, linkFiles, isSaveableMedia, classifyFile } from '../fileStore.js';
import { parseRecordDate, getToday } from '../utils.js';
import { downloadPhoto } from '../photoStore.js';
import { addToBatch } from './photos.js';

// Files saved in the last minute, waiting for the caption that says what they
// are about. Keyed by group, exactly like the photo batch.
const pending = new Map();
const activeIntakes = new Map();

export async function waitForActiveIntake(scope) {
  const work = activeIntakes.get(scope);
  if (work) await work;
}

export function stashFile(scope, id, now = Date.now()) {
  if (!id) return 0;
  const list = pending.get(scope) || [];
  list.push({ id, at: now });
  pending.set(scope, list);
  return list.length;
}

/**
 * The files still waiting, dropping any that arrived before the window.
 *
 * config.fileBatchWindowMs existed but was never read, so this map never expired
 * at all: one file sent with no caption stayed pending for the whole session and
 * was then linked to whatever record happened to be created next - an old
 * progress, an unrelated issue. Same defect the photo batch had.
 */
function livePending(scope, now = Date.now()) {
  const list = pending.get(scope) || [];
  if (!list.length) return [];
  const newest = list[list.length - 1];
  if (now - (newest?.at || 0) > config.fileBatchWindowMs) {
    pending.delete(scope);
    return [];
  }
  return list;
}

export function pendingCount(scope, now = Date.now()) {
  return livePending(scope, now).length;
}

// True only when the pending file batch has crossed the one-minute caption
// window. This lets a description sent immediately after a forwarded photo
// complete the record, while keeping the explicit # rule for late captions.
export function pendingIsDelayed(scope, now = Date.now()) {
  const list = pending.get(scope) || [];
  const newest = list[list.length - 1];
  return Boolean(newest && now - (newest.at || 0) > config.fileBatchWindowMs);
}

/** Called right after a record is created so its files point at it. */
export async function linkPendingFiles(scope, linkType, linkId) {
  const list = livePending(scope);
  if (!list.length) return 0;
  pending.delete(scope);
  const linked = await linkFiles(list.map((f) => f.id), linkType, linkId);
  console.log(`  🔗 ${linked} file(s) linked to ${linkType} #${linkId}`);
  return linked;
}

/**
 * Save one file that arrived in a group, whatever kind it is.
 * @returns {{saved?: object, error?: string}}
 */
async function intakeFileUnsafe(msg, { siteName, caption = '', sender = null } = {}) {
  if (!isSaveableMedia(msg)) return { skipped: true };

  const result = await saveSiteFile(msg, { siteName, caption, sender });
  if (result.error) return result;

  const { saved } = result;
  if (saved.id) stashFile(msg.from, saved.id);

  // Images must ALSO join the existing photo batch. .addmaterial and the AI
  // material path attach "the photos that just arrived" to the record, and they
  // read that batch - so filing a photo only in site_files would silently strip
  // the evidence off every delivery.
  if (saved.category === 'photos') {
    addToBatch(msg.from, { bucket: saved.bucket, path: saved.path, dir: saved.dir, filename: saved.filename });
  }

  const meta = config.fileCategories[saved.category] || config.fileCategories.other;
  console.log(
    `🗂️  ${meta.emoji} ${saved.category.toUpperCase()} saved by ${sender || msg.from}: ` +
    `${saved.bucket}/${saved.path}${saved.id ? ` (file #${saved.id})` : ''} - ${saved.reason}`
  );
  return result;
}

export async function intakeFile(msg, options = {}) {
  const scope = msg?.from;
  const previous = activeIntakes.get(scope) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  activeIntakes.set(scope, current);
  await previous;
  try {
    return await intakeFileUnsafe(msg, options);
  } finally {
    release();
    if (activeIntakes.get(scope) === current) activeIntakes.delete(scope);
  }
}

const CAT_LABEL = () =>
  Object.entries(config.fileCategories)
    .map(([k, v]) => `${k} (${v.bucket})`)
    .join(', ');

/** One line per file: the id is what you quote back later. */
export function buildFilesMessage(rows, title = 'FILES') {
  if (!rows.length) return `*No files found.*`;
  let msg = `*🗂️ ${title}*\n\n`;
  for (const f of rows) {
    const name = f.original_name || f.path.split('/').pop();
    const link = f.link_type ? ` → ${f.link_type} #${f.link_id}` : '';
    const ver = f.version && f.version > 1 ? ` · v${f.version}` : '';
    msg += `*#${f.id}* ${f.category}${ver}${link}\n`;
    msg += `> ${name}\n`;
    msg += `> ${f.date} · ${f.bucket}/${f.path}\n\n`;
  }
  return msg.trim();
}

// How many files a listing may push back into the chat. A "list" that dumps
// twenty PDFs is worse than no list at all.
const MAX_FILES_PER_LIST = 5;

function sendableMime(mimetype, filename) {
  const mime = String(mimetype || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  if (mime === 'image/vnd.dwg' || /\.(dwg|dxf|rvt|rfa|ifc|skp)$/i.test(name)) return 'application/octet-stream';
  return mime || 'application/octet-stream';
}

/**
 * Reply with the list, then send the actual files (DO photo, material picture,
 * drawing, PDF). The site asked to see what they sent, not just its filename.
 */
export async function replyFilesWithMedia(msg, text, rows, limit = MAX_FILES_PER_LIST) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return msg.reply(text);

  const shown = list.slice(0, limit);
  const chatId = msg.from || msg.to;

  await msg.reply(text);

  let sent = 0;
  for (const row of shown) {
    try {
      const media = await downloadPhoto(row.path, row.bucket);
      if (!media) continue;
      const name = row.original_name || String(row.path || '').split('/').pop();
      const ver = row.version && row.version > 1 ? ` · v${row.version}` : '';
      await msg.client.sendMessage(
        chatId,
        new MessageMedia(sendableMime(media.mimetype, media.filename), media.data, media.filename),
        { caption: `*#${row.id}* ${name}${ver}`, linkPreview: false }
      );
      sent++;
    } catch (e) {
      console.log(`  ⚠️ file send failed (#${row.id}): ${e.message || e}`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (list.length > shown.length) {
    await msg.reply(
      `_(hantar ${sent} daripada ${list.length} fail - \`.files <id>\` untuk yang lain)_`
    );
  }
  return sent;
}

export async function handleFiles(msg, args) {
  const first = (args[0] || '').trim();

  // .latest / .files latest        -> newest version of every document
  // .latest pelan awning           -> newest version matching that name
  if (first.toLowerCase() === 'latest') {
    const term = args.slice(1).join(' ').trim();
    const rows = term
      ? await filesDB.getLatestByName(term, 10)
      : await filesDB.getLatestPerDoc(15);
    const title = term ? `LATEST MATCHING "${term}"` : 'LATEST VERSION OF EACH FILE';
    return replyFilesWithMedia(
      msg,
      buildFilesMessage(rows, title) +
      `\n\n_Only the newest version is listed. .files <id> sends the file itself._`,
      rows
    );
  }

  // .files 14  -> the file with that id, sent back so they can see it.
  if (/^\d+$/.test(first)) {
    const row = await filesDB.getById(parseInt(first, 10));
    if (!row) return msg.reply(`*File #${first} not found.*`);

    const meta = config.fileCategories[row.category] || config.fileCategories.other;
    // Every indexed object is resendable, including DWG/CAD and other files.
    const media = await downloadPhoto(row.path, row.bucket);

    let text = `*🗂️ FILE #${row.id}*\n\n`;
    text += `${meta.emoji} ${meta.label}\n`;
    text += `${row.original_name || row.path}\n`;
    if (row.version && row.version > 1) text += `🔢 Version ${row.version}\n`;
    text += `📅 ${row.date}\n`;
    text += `📁 ${row.bucket}/${row.path}\n`;
    if (row.link_type) text += `🔗 ${row.link_type} #${row.link_id}\n`;
    if (row.sender) text += `👤 ${row.sender}\n`;
    if (row.caption) text += `> ${row.caption}\n`;

    if (media) {
      await msg.reply(text, { media: new MessageMedia(sendableMime(media.mimetype, media.filename), media.data, media.filename) });
      return;
    }
    return msg.reply(text);
  }

  // .files drawings / .files pdf / .files voice ...
  const known = [...new Set([...Object.keys(config.fileCategories), 'attendance'])];
  if (first && known.includes(first.toLowerCase())) {
    const rows = await filesDB.getByCategory(first.toLowerCase(), parseInt(args[1]) || 10);
    return replyFilesWithMedia(msg, buildFilesMessage(rows, `${first.toUpperCase()} FILES`), rows);
  }

  // .files hari ini / .files 02-10-2026
  const asked = parseRecordDate(args.join(' '));
  if (asked) {
    const rows = await filesDB.getByDate(asked);
    return replyFilesWithMedia(msg, buildFilesMessage(rows, `FILES - ${asked}`), rows);
  }

  // .files paip  -> search
  const term = args.join(' ').trim();
  if (term) {
    const rows = await filesDB.search(term, 10);
    return replyFilesWithMedia(msg, buildFilesMessage(rows, `FILES MATCHING "${term}"`), rows);
  }

  const rows = await filesDB.getRecent(10);
  return replyFilesWithMedia(
    msg,
    buildFilesMessage(rows, 'LATEST FILES') +
    `\n\n_Categories: ${CAT_LABEL()}_\n` +
    `_.files drawings | .files 02-10-2026 | .files paip | .files 14_`,
    rows
  );
}

export { classifyFile, getToday };
