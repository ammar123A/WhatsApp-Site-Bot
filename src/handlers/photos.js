import { saveMessagePhoto } from '../photoStore.js';
import { progressDB, materialsDB, issuesDB } from '../database.js';
import config from '../../config.js';

// Latest saved photo (kept for .photo info)
let lastPhoto = null;

// Photos sent close together form ONE batch that can be attached to a single
// record later ("tag me then say attach these 5 photos to one progress").
// The window is 90 seconds: once 90 seconds passes, the next photo starts a NEW
// batch, so photos taken minutes apart never get glued onto one record.
// Batches are per-group so a photo taken in one site group can never attach to
// a record in another.
const batches = new Map(); // groupId -> [{ path, filename, dir, msgTime }]
const PHOTO_BURST_GAP_MS = 90 * 1000; // 1.5 minutes
const MAX_BATCH_PHOTOS = 20;
let botClient = null;

export function setBotClient(client) {
  botClient = client;
}

/** The live client, for callers that only hold a bare message object. */
export function getBotClient() {
  return botClient;
}

export function getLastPhoto() {
  return lastPhoto;
}

const key = (scope) => scope || 'default';

/**
 * The batch for this scope, but only while it is still LIVE - and a stale batch
 * is dropped rather than merely hidden.
 *
 * This is the fix for photos being glued onto the wrong progress. The burst
 * window was only ever checked when a NEW photo arrived (in addToBatch), so a
 * photo sent with no caption sat in the map forever: the user sent one photo,
 * then said "add progress ..." minutes later, and saveProgress saw a non-empty
 * batch and attached it. Nothing had expired it because no second photo came.
 *
 * A burst is over once the window has passed with no new photo, so the whole
 * batch is discarded here and can never be resurrected by a later command.
 */
function liveBatch(scope, now = Date.now()) {
  const k = key(scope);
  const current = batches.get(k);
  if (!current || !current.length) return [];
  const newest = current[current.length - 1];
  if (now - (newest?.msgTime || 0) > PHOTO_BURST_GAP_MS) {
    batches.delete(k);
    return [];
  }
  return current;
}

/** Paths currently in the live photo batch. Used so a photo whose caption is a
 * command can auto-attach to the record that command refers to/create. */
export function getPhotoBatchPaths(scope, now = Date.now()) {
  return liveBatch(scope, now).map((p) => p.bucket ? `${p.bucket}::${p.path}` : p.path);
}

// In-memory snapshot of the batch - lets callers attach it and verify.
export function getPhotoBatchSize(scope, now = Date.now()) {
  return liveBatch(scope, now).length;
}

// Drain the batch so it can't be re-used by a later .attach.
export function clearPhotoBatch(scope) {
  batches.delete(key(scope));
}

// Attach the current photo batch to a record (maps photos column) and drain
// the batch. Used when a photo arrives with a caption command so the photo(s)
// auto-link to the record the command refers to / creates.
// Returns the number of photos attached (0 if none/batch empty).
export async function attachPendingPhotos(table, id, scope, now = Date.now()) {
  const paths = getPhotoBatchPaths(scope, now);
  if (!paths.length) return 0;
  const result = await table.updatePhotos(id, paths);
  const ok = result && result.changes > 0;
  if (ok) batches.delete(key(scope));
  return ok ? paths.length : 0;
}

/**
 * Write a specific list of photo paths to a record WITHOUT draining the batch.
 *
 * Needed when ONE message creates several records ("4 pallet cement, 1 pallet
 * sand brick"): every line was delivered in the same photo batch, so each
 * record must point at the same photos. Draining per record (attachPendingPhotos)
 * meant the first record consumed the batch and every later record found zero
 * photos - so it was rejected and deleted as "no photo evidence".
 *
 * The caller drains once, after all records are written.
 * Returns the number of photos written.
 */
export async function attachPhotoPaths(table, id, paths) {
  if (!Array.isArray(paths) || !paths.length) return 0;
  const result = await table.updatePhotos(id, paths);
  return result && result.changes > 0 ? paths.length : 0;
}

/**
 * Add a stored photo to its group's batch, starting a NEW batch once the
 * 1-minute window has passed since that group's previous photo.
 * @returns {number} photos now waiting in this group's batch
 */
export function addToBatch(scope, saved, now = Date.now()) {
  const k = key(scope);
  const current = batches.get(k) || [];
  const last = current[current.length - 1];
  const expired = last && now - (last.msgTime || 0) > PHOTO_BURST_GAP_MS;
  if (expired) console.log('  → 1 min gap passed, starting a new batch');

  const next = (expired ? [] : current).concat([{ ...saved, msgTime: now }]);
  if (next.length > MAX_BATCH_PHOTOS) {
    console.log(`  → photo batch capped at ${MAX_BATCH_PHOTOS}`);
    next.splice(0, next.length - MAX_BATCH_PHOTOS);
  }
  batches.set(k, next);
  return next.length;
}

/** Photos waiting in this group's live batch, newest last. */
export function getPhotoBatch(scope, now = Date.now()) {
  return [...liveBatch(scope, now)];
}

/** Milliseconds until this group's batch expires (0 if empty/already open-ended). */
export function batchWindowMs(scope) {
  return PHOTO_BURST_GAP_MS;
}

// Download and store a photo sent in the group.
// Returns { saved } on success, { error } on failure.
export async function handlePhoto(msg) {
  // whatsapp-web.js 1.34.7 does not put mimetype on the Message, so read it off
  // the raw payload. Printing msg.mimetype always said "undefined".
  const mime = msg._data?.mimetype || msg.mimetype || '';
  console.log(`🖼️  Media received: type=${msg.type} hasMedia=${msg.hasMedia} mimetype=${mime || '(none)'} size=${msg.size || '?'}`);

  // Only process actual photos
  const isImage = msg.type === 'image' || mime.startsWith('image/');
  if (!isImage) {
    console.log('  → not a photo, skipped');
    return { error: 'not_image' };
  }

  // Try downloading up to 5 times - media must stream to the headless browser first
  let lastErr = null;
  const delays = [0, 2000, 5000, 8000, 10000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const saved = await saveMessagePhoto(msg, botClient);
      lastPhoto = saved;

      const count = addToBatch(msg.from, saved, Date.now());
      console.log(`  → batch size now ${count} (waiting up to 1 min for more)`);
      return { saved };
    } catch (error) {
      lastErr = error;
      console.log(`  → download attempt ${i + 1}/${delays.length} failed: ${error.message || error}`);
    }
  }

  console.error('Photo save error:', lastErr);
  return { error: lastErr ? lastErr.message || String(lastErr) : 'unknown' };
}

// Attach the latest photo batch to a progress/material/issue record
export async function handleAttach(msg, args) {
  const type = (args[0] || '').toLowerCase().trim();
  const id = parseInt(args[1]);
  // Expired batches must not be attachable to an OLD record either: "attach these
  // to progress 12" five minutes after the photos would otherwise still find them.
  const batch = liveBatch(msg.from);

  if (!['progress', 'p', 'material', 'mat', 'issue', 'i'].includes(type) || !id) {
    return msg.reply(
      '*Usage:* send your photos, then:\n' +
      '`.attach progress <id>`\n' +
      '`.attach material <id>`\n' +
      '`.attach issue <id>`\n\n' +
      '_Photos sent within 1 minute of each other form one batch._'
    );
  }
  if (!batch.length) {
    return msg.reply('*No photo waiting.* Send your photos in this group first (within 1 min of each other), then attach.');
  }

  const table = type === 'progress' || type === 'p'
    ? progressDB
    : type === 'material' || type === 'mat'
      ? materialsDB
      : issuesDB;

  const field = type === 'progress' || type === 'p'
    ? 'progress'
    : type === 'material' || type === 'mat'
      ? 'material'
      : 'issue';

  const paths = batch.map(p => p.path);
  const result = await table.updatePhotos(id, paths);
  if (result.changes === 0) {
    return msg.reply(`*${field.charAt(0).toUpperCase() + field.slice(1)} #${id} not found.*`);
  }

  const count = paths.length;
  const fileList = batch.map(p => '`' + p.filename + '`').join('\n');
  const replyMsg =
    count > 1
      ? `*📸 ${count} photos attached to ${field} #${id}!*\n\n${fileList}\n\n` +
        `☁️ Folder: \`${config.photoBucket}/${batch[0].dir}\``
      : `*📸 Photo attached to ${field} #${id}!*\n\n` +
        `☁️ Saved to: \`${config.photoBucket}/${batch[0].path}\``;

  // Batch is consumed once attached
  batches.delete(key(msg.from));
  return msg.reply(replyMsg);
}

// Reply with info about the most recent photo
export async function handlePhotoInfo(msg) {
  if (!lastPhoto) {
    return msg.reply('*No photo recorded yet.* Send a photo in the group, then use .photo to see its saved path.');
  }
  const n = getPhotoBatchSize(msg.from);
  const batchNote = n > 1
    ? `\n\n_*${n} photos waiting in this group - tag me and say "attach these to one <progress/material/issue>" to link them all._\n`
    : '';
  return msg.reply(
    `*📸 Latest photo*\n\n` +
    `☁️ Saved to: \`${config.photoBucket}/${lastPhoto.path}\`` +
    batchNote
  );
}
