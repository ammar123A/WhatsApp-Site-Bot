/**
 * Auto-save for EVERY file a site group receives, filed where it belongs.
 *
 * Layout, per category bucket:
 *
 *   site-photos/Sky Awani/02-10-2026/1730-1745-paip-atas-bumbung.jpg
 *   site-drawings/Sky Awani/02-10-2026/02-10-2026_OLD-DRAWING-AS-BUILT.pdf
 *   site-pdf/Sky Awani/02-10-2026/02-10-2026_SURAT-LESEN.pdf
 *   site-voice/Sky Awani/02-10-2026/02-10-2026_1735-siap.opus
 *
 * So: bucket = what kind of file it is, path = which site and which day.
 * "OLD-DRAWING-AS-BUILT.pdf" is a PDF by extension but it is filed as a DRAWING
 * - the name wins over the extension, because that is what the site means by it.
 */
import config from '../config.js';
import { downloadAnyMedia, uploadPhoto, ensureBucket } from './photoStore.js';
import { filesDB, currentSite } from './database.js';

const pad = (n) => String(n).padStart(2, '0');

/**
 * Keyword tables, split by how much they are allowed to decide.
 *
 * STRONG keywords name the thing itself. "OLD DRAWING AS BUILT.pdf" is a PDF by
 * extension but the site means a drawing, so a strong keyword beats the
 * extension.
 *
 * WEAK keywords only describe a format. They must never outrank an actual
 * mimetype, otherwise "doc1.pdf" + a caption mentioning a drawing would end up
 * filed as a plain PDF.
 */
const STRONG = {
  drawings: [
    'drawing', 'as built', 'as-built', 'asbuilt', 'shop drawing', 'blueprint',
    'sketch', 'layout plan', 'floor plan', 'site plan', 'elevation', 'section',
    'riser', 'cross section', 'detail plan', 'cad', 'dwg', 'ifc',
    'pelan', 'lukisan', 'gambar rajah', 'kaedah kerja', 'borong',
    'layout', 'rencana', 'blue print',
  ],
};

const WEAK = {
  pdf: [
    'pdf', 'surat', 'letter', 'invois', 'invoice', 'quotation', 'sebut harga',
    'sijil', 'certificate', 'permit', 'lesen', 'kontrak', 'contract',
    'laporan', 'report', 'delivery note', 'minit', 'minute', 'memo',
    'notis', 'notice', 'borang',
  ],
  video: ['video', 'rakaman'],
};

/**
 * Engineering/CAD extensions that decide the category on their own.
 *
 * WhatsApp reports a .dwg as "image/vnd.dwg" - AutoCAD registered that MIME type
 * in the 90s and it has been technically correct ever since. It is useless here:
 * the image/ check below filed "Asbuilt sewer.dwg" into site-photos as a .jpg
 * wearing a drawing's name. No real photograph is ever a .dwg, so for these
 * extensions the filename outranks the mimetype. This table is checked BEFORE
 * the image test, not after.
 */
const CAD_EXT = /\.(dwg|dxf|dwt|ifc|rvt|rfa|skp|3dm|3ds|max|pln|step|stp|iges|igs|sldprt|sldasm|dgn|epf|nwd|nwc|fbx|obj|fbx)$/i;

/** Any keyword for `table` inside this text? */
function matches(text, table) {
  const words = table || [];
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return words.some((w) => t.includes(w));
}

/**
 * Read an explicit routing symbol out of a caption, e.g. "#claim DO Mac.pdf".
 *
 * This is the deterministic tool layer: when the sender says where a file
 * belongs, that beats every guess the classifier could make. Returns the spec
 * from config.fileSymbols plus the caption with the symbol stripped, so the
 * remaining words still describe the file.
 *
 * @returns {{symbol: string|null, spec: object|null, text: string}}
 */
export function parseSymbol(caption) {
  const text = String(caption || '');
  const m = text.match(/(^|\s)(#[a-z]+)\b/i);
  if (!m) return { symbol: null, spec: null, text: text.trim() };
  const symbol = m[2].toLowerCase();
  const spec = config.fileSymbols[symbol] || null;
  if (!spec) return { symbol: null, spec: null, text: text.trim() };
  const stripped = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { symbol, spec, text: stripped };
}

// Hashtags are the clearest preference, but ordinary site captions should work
// too: "latest claim", "as-built drawing", "DO cement". These inferred routes
// only choose the file folder; the sender's explicit hashtag always wins.
function inferFileRoute({ caption = '', filename = '' } = {}) {
  const text = `${caption} ${filename}`.toLowerCase();
  const pick = (symbol) => ({
    symbol: `auto-${symbol.slice(1)}`,
    spec: config.fileSymbols[symbol],
    text: String(caption || '').trim(),
  });
  if (/\b(claim|tuntutan)\b/.test(text)) return pick('#claim');
  if (/\b(drawing|drawings|pelan|lukisan|as[- ]?built|shop drawing|dwg|dxf)\b/.test(text)) return pick('#drawing');
  if (/\b(invoice|invois)\b/.test(text)) return pick('#invoice');
  if (/\b(delivery order|\bdo\b)\b/.test(text)) return pick('#do');
  if (/\b(report|laporan)\b/.test(text)) return pick('#report');
  if (/\b(attendance|kehadiran|workers?|pekerja|hadir)\b/.test(text)) return pick('#attendance');
  return { symbol: null, spec: null, text: String(caption || '').trim() };
}

/**
 * The canonical document name used for versioning.
 *
 * "02-10-2026_Pelan-Awning.pdf" and "Pelan Awning.pdf" are the same drawing, so
 * both collapse to "pelan awning". A file with no name of its own - every
 * WhatsApp photo - has no stable identity and returns null: it must not spawn a
 * new version of some unrelated document.
 */
export function docNameFor({ filename } = {}) {
  const raw = String(filename || '').trim();
  if (!raw) return null;
  const base = raw
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\d{2}[-_]\d{2}[-_]\d{4}[_-]?/, '')
    .replace(/^\d{4}[-_]\d{2}[-_]\d{2}[_-]?/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // Pure time/day stamps are not names ("14 05 11" from an unnamed file).
  if (!base || /^\d{1,2} \d{1,2} \d{1,2}$/.test(base) || /^\d+$/.test(base)) return null;
  return base.slice(0, 120);
}

/**
 * Decide which category a file belongs to. Deterministic - no AI call, so this
 * is fast, free, and gives the same answer for the same file every time.
 *
 * Priority ladder, most authoritative first:
 *   1. voice notes                 - ptt/audio
 *   2. an image is a photo         - a site photo stays in the photo bucket
 *   3. video
 *   4. strong "drawing" in name    - OLD-DRAWING-AS-BUILT.pdf -> drawing
 *   5. strong "drawing" in caption
 *   6. real PDF (mime or .pdf)     - and weak pdf words in name/caption
 *   7. anything else
 *
 * @returns {{category: string, reason: string}}
 */
export function classifyFile({ type, mimetype, filename, caption } = {}) {
  const name = String(filename || '');
  const mime = String(mimetype || '').toLowerCase();
  const kind = String(type || '').toLowerCase();

  if (kind === 'ptt' || mime.startsWith('audio/') || /\.(opus|ogg|m4a|mp3|aac)$/i.test(name)) {
    return { category: 'voice', reason: 'voice note' };
  }

  // A .dwg is not a picture, whatever mimetype WhatsApp claims for it.
  if (CAD_EXT.test(name)) return { category: 'drawings', reason: 'cad file' };

  // An image is a site photo. People do photograph sketches, and the site said
  // photos go to the photo folder, so the mimetype wins over the words.
  if (kind === 'image' || mime.startsWith('image/')) {
    return { category: 'photos', reason: mime.startsWith('image/') ? 'image' : 'photo' };
  }

  if (kind === 'video' || mime.startsWith('video/') || matches(name, WEAK.video)) {
    return { category: 'video', reason: 'video' };
  }

  if (matches(name, STRONG.drawings)) return { category: 'drawings', reason: 'filename says drawing' };
  if (matches(caption, STRONG.drawings)) return { category: 'drawings', reason: 'caption says drawing' };

  if (mime === 'application/pdf' || /\.pdf$/i.test(name) || matches(name, WEAK.pdf) || matches(caption, WEAK.pdf)) {
    return { category: 'pdf', reason: /\.pdf$/i.test(name) || mime === 'application/pdf' ? 'pdf document' : 'filename says pdf' };
  }

  return { category: 'other', reason: 'other file' };
}

/** 02-10-2026 - one folder per day, the way the site says it out loud. */
export function dayFolder(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** "Sky Awani/02-10-2026" - site folder, then day folder. */
export function folderFor(siteName, date) {
  const site = String(siteName || 'site')
    .replace(/[/\\]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'site';
  return `${site}/${dayFolder(date)}`;
}

/** Supabase bucket id for a site. Bucket ids cannot contain spaces or capitals. */
export function siteBucketName(siteName) {
  const normalized = String(siteName || 'site')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 55);
  return normalized || 'site';
}

/**
 * Bucket for the site being served. Keyed by the site's schema, which carries a
 * hash of the group id, so two groups that share a display name (or a renamed
 * group) can never write into each other's bucket.
 */
export function siteBucketFor(siteName) {
  return siteBucketName(currentSite()?.schema || siteName);
}

/**
 * Upload without ever replacing an existing object. On a name clash the key gets
 * a unique suffix instead. Returns the key actually written.
 */
export async function uploadNew(key, buffer, mimetype, bucket) {
  try {
    await uploadPhoto(key, buffer, mimetype, false, bucket);
    return key;
  } catch (e) {
    if (!/\b409\b|duplicate|already exists/i.test(String(e?.message || e))) throw e;
    const unique = key.replace(/(\.[a-z0-9]{2,5})?$/i, `-${Date.now().toString(36)}$1`);
    await uploadPhoto(unique, buffer, mimetype, false, bucket);
    return unique;
  }
}

/** "drawings/26-10-2026" inside the site's own bucket. */
export function categoryFolderFor(siteName, category, date) {
  const folder = config.fileCategoryFolders?.[category] || category || 'other';
  return `${folder}/${dayFolder(date)}`;
}

/** Keep the name people will look for, drop anything a path cannot hold. */
// Keep the name people will look for, drop anything a path cannot hold.
// When the sender gave no name at all (every WhatsApp photo, every voice note)
// fall back to the time of day, so files sort sensibly instead of all being
// called "file.jpg" and overwriting each other.
export function safeName(name, fallbackExt = '', date = new Date()) {
  const original = String(name || '').trim();
  let cleaned = (original ? original : timeStamp(date))
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 90);
  if (!cleaned) cleaned = `file${fallbackExt}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(cleaned)) cleaned += fallbackExt;
  return cleaned;
}

/**
 * Extensions per mimetype. Kept as a table so the sniffed type and the mimetype
 * WhatsApp reported both resolve to the same answer.
 */
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'audio/ogg': '.opus',
  'audio/ogg; codecs=opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/zip': '.zip',
};

/**
 * Identify the file by its first bytes.
 *
 * This is the authoritative answer. WhatsApp photos arrive with no filename and
 * no usable mimetype on the Message object, so anything that trusts those two
 * ends up calling every photo ".bin". The bytes never lie.
 *
 * @param {Buffer} buffer
 * @returns {{mime: string, ext: string}|null} null when the type is unknown
 */
export function sniffType(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length < 4) return null;
  const hex = b.subarray(0, 16).toString('hex');
  const ascii = b.subarray(0, 16).toString('latin1');

  const known = (mime, ext) => ({ mime, ext });

  if (hex.startsWith('ffd8ff')) return known('image/jpeg', '.jpg');
  if (hex.startsWith('89504e47')) return known('image/png', '.png');
  if (ascii.startsWith('GIF8')) return known('image/gif', '.gif');
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return known('image/webp', '.webp');
  if (hex.startsWith('1a45dfa3')) return known('video/webm', '.webm');
  if (hex.startsWith('25504446')) return known('application/pdf', '.pdf');
  if (hex.startsWith('494433')) return known('audio/mpeg', '.mp3');
  if (hex.startsWith('fffb') || hex.startsWith('fff3')) return known('audio/mpeg', '.mp3');
  if (ascii.startsWith('OggS')) return known('audio/ogg', '.opus');
  if (hex.startsWith('d0cf11e0')) return known('application/msword', '.doc');
  if (hex.startsWith('504b0304')) return known('application/zip', '.zip');

  // ISO base media (mp4, m4a, heic, 3gp): "....ftyp<brand>"
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12).toLowerCase();
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return known('image/heic', '.heic');
    if (brand.startsWith('m4a')) return known('audio/mp4', '.m4a');
    if (brand.startsWith('3gp')) return known('video/3gpp', '.3gp');
    return known('video/mp4', '.mp4');
  }
  return null;
}

/**
 * The extension to file this under.
 *
 * Order of trust: the sender's own filename, then the actual bytes, then the
 * mimetype WhatsApp reported, then the category's usual format. ".bin" is only
 * correct when we genuinely do not know what the file is.
 */
function extFor(mimetype, originalName, category, sniffedExt = '') {
  const fromName = String(originalName || '').match(/\.[a-z0-9]{2,5}$/i);
  if (fromName) return fromName[0].toLowerCase();
  if (sniffedExt) return sniffedExt;
  if (EXT_BY_MIME[String(mimetype || '').toLowerCase()]) return EXT_BY_MIME[String(mimetype || '').toLowerCase()];

  const m = String(mimetype || '');
  if (m.includes('pdf')) return '.pdf';
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('opus') || m.includes('ogg')) return '.opus';
  if (m.includes('mpeg')) return '.mp3';
  if (m.includes('mp4')) return '.mp4';
  if (category === 'voice') return '.opus';
  if (category === 'video') return '.mp4';
  return '.bin';
}

/** HH-MM-SS, so files with no name of their own still sort by time of day. */
function timeStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Everything the site can send. Stickers are decoration, not a site record. */
export function isSaveableMedia(msg) {
  if (!msg || !msg.hasMedia) return false;
  const kind = String(msg.type || '').toLowerCase();
  return ['image', 'document', 'ptt', 'audio', 'video'].includes(kind);
}

/**
 * Download, classify, upload and index one file.
 * @returns {{saved: object}|{error: string}}
 */
export async function saveSiteFile(msg, { siteName, caption = '', sender = null, date = new Date() } = {}) {
  const kind = String(msg.type || '').toLowerCase();
  const originalName = msg._data?.filename || msg.filename || '';

  // Download FIRST. The download is what tells us the real type: whatsapp-web.js
  // 1.34.7 never assigns msg.mimetype on a Message, so reading it there always
  // gave undefined and every unnamed file fell through to ".bin".
  let media;
  try {
    media = await downloadAnyMedia(msg, msg.client);
  } catch (e) {
    return { error: `download failed: ${e.message || e}` };
  }

  const buffer = Buffer.from(media.data, 'base64');
  if (buffer.length > config.maxFileBytes) {
    return { error: `too big (${Math.round(buffer.length / 1048576)}MB)` };
  }

  // Trust the bytes first, then the mimetype that came back with the download,
  // then the raw _data. Voice notes are .opus inside an audio wrapper.
  const sniffed = sniffType(buffer);
  const reported = media.mimetype || msg._data?.mimetype || msg.mimetype || '';
  const mime = sniffed?.mime || (kind === 'ptt' ? 'audio/ogg; codecs=opus' : reported);

  const { category, reason } = classifyFile({
    type: kind,
    mimetype: mime,
    filename: originalName,
    caption,
  });

  // An explicit #symbol wins over the classifier. This is the whole point of the
  // symbols: the person sending the file decides, the bot does not guess.
  const explicitRoute = parseSymbol(caption);
  const route = explicitRoute.symbol
    ? explicitRoute
    : inferFileRoute({ caption, filename: media.filename || originalName });
  const finalCategory = route.spec?.category || category;
  const finalReason = route.symbol ? `symbol ${route.symbol}` : reason;

  // Each site is its own Supabase bucket. Category and date are folders inside
  // that bucket: <site-bucket>/<category>/<date>/<file>.
  const bucket = siteBucketFor(siteName);

  // Versioning is keyed on (category, doc_name). Only named documents version -
  // photos and voice notes do not.
  const docName = docNameFor({ filename: media.filename || originalName });
  const version = await filesDB.nextVersion(finalCategory, docName);

  let fileName = safeName(
    media.filename || originalName,
    extFor(mime, originalName, finalCategory, sniffed?.ext || ''),
    date,
  );
  // Same day + same name would overwrite the object in storage, which would
  // quietly destroy the previous version's bytes. Only the row would remember
  // it existed. So v2+ gets its own object name.
  if (version > 1) fileName = fileName.replace(/(\.[a-z0-9]{2,5})$/i, `-v${version}$1`);

  // Storage hierarchy is always site -> category -> date -> file. The bucket
  // already separates the broad type (site-pdf, site-drawings, etc.); symbols
  // choose the category, while the physical layout stays predictable.
  const folder = categoryFolderFor(siteName, finalCategory, date);
  let key = `${folder}/${fileName}`;

  try {
    await ensureBucket(bucket);
    key = await uploadNew(key, buffer, mime || 'application/octet-stream', bucket);
  } catch (e) {
    return { error: `upload failed: ${e.message || e}` };
  }

  // The searchable row. This is what makes the database organised: the file is
  // a row with an id, a category, a day, and whatever record it belongs to.
  let row = null;
  try {
    const res = await filesDB.add({
      date: date instanceof Date ? date.toLocaleDateString('en-GB') : String(date),
      category: finalCategory,
      bucket,
      path: key,
      originalName: fileName,
      mimetype: mime,
      sizeBytes: buffer.length,
      classifiedBy: finalReason,
      sender,
      caption: route.text || null,
      docName,
      version,
      isLatest: true,
      folder,
    });
    // Only after the new row exists: if the insert fails, the old version must
    // stay "latest" rather than leaving the document with no latest at all.
    if (docName && version > 1) {
      try {
        await filesDB.markNotLatest(finalCategory, docName, res.lastInsertRowid);
      } catch (e) {
        console.error(`  ⚠️ version ${version} saved but old version still marked latest: ${e.message || e}`);
      }
    }
    row = {
      id: res.lastInsertRowid, category: finalCategory, bucket, path: key,
      dir: folder, filename: fileName, docName, version, symbol: route.symbol,
    };
  } catch (e) {
    // The file IS in storage; losing the index row is bad but not fatal.
    console.error(`  ⚠️ file saved but not indexed: ${e.message || e}`);
    row = {
      id: null, category: finalCategory, bucket, path: key, dir: folder,
      filename: fileName, docName, version, symbol: route.symbol,
    };
  }

  return { saved: { ...row, reason: finalReason } };
}

/**
 * Point files at the record they turned out to be about - a delivery photo at a
 * material, an "as built" drawing at the progress it documents.
 */
export async function linkFiles(ids, linkType, linkId) {
  const clean = (ids || []).filter(Boolean);
  if (!clean.length || !linkType || !linkId) return 0;
  try {
    await filesDB.linkMany(clean, linkType, linkId);
    return clean.length;
  } catch (e) {
    console.error(`  ⚠️ could not link files: ${e.message || e}`);
    return 0;
  }
}
