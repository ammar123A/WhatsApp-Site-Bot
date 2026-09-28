import { saveMessagePhoto } from '../photoStore.js';
import { progressDB, materialsDB, issuesDB } from '../database.js';
import config from '../../config.js';

// Latest saved photo (kept for .photo info)
let lastPhoto = null;
// A batch of recently-sent photos, linked to a record together with .attach.
// Photos sent close together form one batch; a gap starts a new one.
let photoBatch = [];
const PHOTO_BURST_GAP_MS = 5 * 60 * 1000; // photos within 5 min = same burst
const MAX_BATCH_PHOTOS = 20;
let botClient = null;

export function setBotClient(client) {
  botClient = client;
}

export function getLastPhoto() {
  return lastPhoto;
}

// Paths currently in the photo batch. Used so a photo whose caption is a
// command can auto-attach to the record that command refers to/create.
export function getPhotoBatchPaths() {
  return photoBatch.map(p => p.path);
}

// In-memory snapshot of the batch - lets callers attach it and verify.
export function getPhotoBatchSize() {
  return photoBatch.length;
}

// Drain the batch so it can't be re-used by a later .attach.
export function clearPhotoBatch() {
  photoBatch = [];
}

// Attach the current photo batch to a record (maps photos column) and drain
// the batch. Used when a photo arrives with a caption command so the photo(s)
// auto-link to the record the command refers to / creates.
// Returns the number of photos attached (0 if none/batch empty).
export async function attachPendingPhotos(table, id) {
  const paths = getPhotoBatchPaths();
  if (!paths.length) return 0;
  const result = await table.updatePhotos(id, paths);
  const ok = result && result.changes > 0;
  if (ok) photoBatch = [];
  return ok ? paths.length : 0;
}

// Download and store a photo sent in the group.
// Returns { saved } on success, { error } on failure.
export async function handlePhoto(msg) {
  // Show what we received in the terminal for debugging
  console.log(`🖼️  Media received: type=${msg.type} hasMedia=${msg.hasMedia} mimetype=${msg.mimetype} size=${msg.size || '?'}`);

  // Only process actual photos
  const isImage = msg.type === 'image' || (msg.mimetype && msg.mimetype.startsWith('image/'));
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

      // Add to the current batch, or start a new burst if enough time passed
      const now = Date.now();
      const lastInBatch = photoBatch[photoBatch.length - 1];
      if (!lastInBatch || (saved.msgTime || now) - (lastInBatch.msgTime || 0) > PHOTO_BURST_GAP_MS) {
        if (lastInBatch) console.log(`  → photo batch reset (${PHOTO_BURST_GAP_MS / 60000} min gap)`);
        photoBatch = [];
      }
      photoBatch.push({ ...saved, msgTime: now });
      if (photoBatch.length > MAX_BATCH_PHOTOS) {
        photoBatch = photoBatch.slice(-MAX_BATCH_PHOTOS);
        console.log(`  → photo batch capped at ${MAX_BATCH_PHOTOS}`);
      }
      console.log(`  → batch size now ${photoBatch.length}`);
      return { saved };
    } catch (error) {
      lastErr = error;
      console.log(`  → download attempt ${i + 1}/${delays.length} failed: ${error.message || error}`);
    }
  }

  console.error('Photo save error:', lastErr);
  return { error: lastErr ? lastErr.message || String(lastErr) : 'unknown' };
}

// Attach the latest photo to a progress/material/issue record
export async function handleAttach(msg, args) {
  const type = (args[0] || '').toLowerCase().trim();
  const id = parseInt(args[1]);

  if (!['progress', 'p', 'material', 'mat', 'issue', 'i'].includes(type) || !id) {
    return msg.reply(
      '*Usage:* send a photo first, then:\n' +
      '`.attach progress <id>`\n' +
      '`.attach material <id>`\n' +
      '`.attach issue <id>`\n\n' +
      '_If you just sent a photo, use .photo to see where it was saved._'
    );
  }
  if (!photoBatch.length) {
    return msg.reply('*No photo recorded yet.* Send a photo in the group first, then use .attach.');
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

  const paths = photoBatch.map(p => p.path);
  const result = await table.updatePhotos(id, paths);
  if (result.changes === 0) {
    return msg.reply(`*${field.charAt(0).toUpperCase() + field.slice(1)} #${id} not found.*`);
  }

  const count = paths.length;
  const fileList = photoBatch.map(p => '`' + p.filename + '`').join('\n');
  const replyMsg =
    count > 1
      ? `*📸 ${count} photos attached to ${field} #${id}!*\n\n${fileList}\n\n` +
        `☁️ Folder: \`${config.photoBucket}/${photoBatch[0].dir}\``
      : `*📸 Photo attached to ${field} #${id}!*\n\n` +
        `☁️ Saved to: \`${config.photoBucket}/${lastPhoto.path}\``;

  // Batch is consumed once attached
  photoBatch = [];
  return msg.reply(replyMsg);
}

// Reply with info about the most recent photo
export async function handlePhotoInfo(msg) {
  if (!lastPhoto) {
    return msg.reply('*No photo recorded yet.* Send a photo in the group, then use .photo to see its saved path.');
  }
  const batchNote = photoBatch.length > 1
    ? `\n\n_${photoBatch.length} photos in the current batch - use .attach to link them all._\n`
    : '';
  return msg.reply(
    `*📸 Latest photo*\n\n` +
    `☁️ Saved to: \`${config.photoBucket}/${lastPhoto.path}\`` +
    batchNote
  );
}