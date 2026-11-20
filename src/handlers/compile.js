/**
 * Compiling files into one PDF.
 *
 *   combine     - merge several PDFs (and/or receipt photos) into one booklet,
 *                 file it in its own bucket, and send it straight back.
 *
 * The output is deliberately NOT filed under "pdf": a source letter and a
 * finished compiled booklet look identical in a bucket, and three months later
 * nobody can tell which is which. Compiled output goes to site-compile-pdf.
 */
import config from '../../config.js';
import { filesDB } from '../database.js';
import { downloadPhoto, ensureBucket } from '../photoStore.js';
import { categoryFolderFor, siteBucketFor, safeName, uploadNew } from '../fileStore.js';
import { mergePdfs, imagesToPdf, pdfPageCount } from '../pdfTools.js';
import { getToday } from '../utils.js';

/** Filenames we are willing to treat as a source document. */
const isPdfRow = (r) =>
  String(r.mimetype || '').includes('pdf') || /\.pdf$/i.test(String(r.original_name || r.path || ''));

const isImageRow = (r) => String(r.mimetype || '').startsWith('image/') || r.category === 'photos';

/**
 * Which files to compile.
 *
 * With no ids given, take the most recent documents and photos that arrived in
 * this group, oldest first, so the booklet reads in the order they were sent.
 * "Most recent" is bounded by a window rather than "everything ever", because
 * compiling three months of site documents by accident is worse than asking.
 */
async function resolveSources(ids, limit = 12) {
  if (ids.length) {
    const rows = [];
    for (const id of ids) {
      const row = await filesDB.getById(id);
      if (row) rows.push(row);
    }
    return rows;
  }

  const recent = await filesDB.getRecent(40);
  const usable = recent.filter((r) => isPdfRow(r) || isImageRow(r));
  return usable.slice(0, limit).reverse();
}

/**
 * @param {object} msg      the WhatsApp message to reply on
 * @param {object} options
 * @param {number[]} [options.ids]      explicit site_files ids, in order
 * @param {string}   [options.name]     title for the output
 * @param {string}   [options.sender]
 * @param {string}   [options.siteName]
 * @param {boolean}  [options.send]     false = build and file only (claims)
 * @returns {Promise<{ok: boolean, text?: string, file?: object, pages?: number, used?: number}>}
 */
export async function compileToPdf(msg, { ids = [], name = '', sender = null, siteName = '', send = true } = {}) {
  const rows = await resolveSources(ids);
  if (rows.length < 1) {
    return { ok: false, text: 'Takde file untuk dikompil. Hantar PDF atau gambar dulu.' };
  }

  const pdfs = [];
  const images = [];
  let skipped = 0;
  for (const row of rows) {
    let media;
    try {
      media = await downloadPhoto(row.path, row.bucket);
    } catch {
      skipped++;
      continue;
    }
    if (!media) { skipped++; continue; }
    const buf = Buffer.from(media.data, 'base64');
    if (isPdfRow(row)) pdfs.push(buf);
    else if (isImageRow(row)) images.push({ buffer: buf, label: `${row.id} - ${row.original_name || row.date}` });
    else skipped++;
  }

  if (!pdfs.length && !images.length) {
    return { ok: false, text: `Takde file boleh dibaca (${skipped} gagal dimuat turun).` };
  }

  // Images first, then the PDFs, each part already in page order. Merging the
  // two groups separately and concatenating avoids having to interleave pages
  // from two documents, which pdf-lib cannot do inside a single copyPages pass.
  const parts = [];
  if (images.length) parts.push(await imagesToPdf(images, { title: name }));
  if (pdfs.length) parts.push(await mergePdfs(pdfs));
  const merged = parts.length === 1 ? parts[0] : await mergePdfs(parts);

  const pages = await pdfPageCount(merged);
  if (!pages) return { ok: false, text: 'Gagal compile - tiada page boleh dibaca.' };

  const bucket = siteBucketFor(siteName);
  const today = new Date();
  const date = getToday();
  const fileName = safeName(name || `COMPILED-${today.replace(/\//g, '-')}`, '.pdf', today);
  await ensureBucket(bucket);
  const key = await uploadNew(`${categoryFolderFor(siteName, 'compiled', today)}/${fileName}`, merged, 'application/pdf', bucket);

  const sourceIds = rows.map((r) => r.id);
  const provenance = `compiled from ${sourceIds.map((i) => `#${i}`).join(', ')}` +
    (skipped ? ` (${skipped} skipped)` : '');

  const row = await filesDB.add({
    date,
    category: 'compiled',
    bucket,
    path: key,
    originalName: fileName,
    mimetype: 'application/pdf',
    sizeBytes: merged.length,
    classifiedBy: 'compile',
    sender,
    caption: provenance,
  });

  let text =
    `*🧩 COMPILED - ${fileName}*\n\n` +
    `📄 ${pages} page dari ${rows.length} file\n` +
    (skipped ? `⚠️ ${skipped} file tak boleh dibaca, tinggalkan\n` : '') +
    `📅 ${date}\n📁 ${bucket}/${key}\n` +
    (row?.id ? `🗂️ file #${row.id}\n` : '') +
    `${provenance}`;

  if (send && msg?.reply) {
    const { MessageMedia } = await import('whatsapp-web.js');
    await msg.reply(text, { media: new MessageMedia('application/pdf', merged.toString('base64'), fileName) });
  }

  return { ok: true, text, file: row, pages, used: rows.length };
}

/** Entry point for the AI action. */
export async function doCombinePdf(msg, args = {}) {
  return compileToPdf(msg, {
    ids: (args.ids || []).map((n) => parseInt(n, 10)).filter(Number.isFinite),
    name: String(args.name || '').trim(),
    sender: args.sender || null,
    siteName: args.siteName || '',
  });
}

export { isPdfRow, isImageRow, resolveSources };
