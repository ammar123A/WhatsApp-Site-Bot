/**
 * PDF work: merging documents into one, and turning receipt photos into one.
 *
 * Two features need this and they are different problems:
 *
 *   mergePdfs()   - "combine ni" on a pile of PDFs someone sent. Page order is
 *                   whatever order they gave us, so the output is a real
 *                   booklet, not a pile of loose sheets.
 *   imagesToPdf() - a month of receipt photos has to become one claim sheet.
 *                   Each photo becomes an A4 page, scaled to fit, never cropped,
 *                   because a cropped receipt is a receipt you cannot claim.
 *
 * pdf-lib is used because it is pure JS: no native build step, so this keeps
 * working on the machine that actually runs the bot.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 24;

/**
 * pdf-lib only embeds JPEG and PNG, and only through embedJpg/embedPng - there
 * is no generic embedImage. So the bytes have to be classified first, exactly
 * like the photo sniffer does, and anything else (WEBP, HEIC straight off a
 * camera roll) has to be converted before it can go in a PDF.
 *
 * @returns {'jpg'|'png'|null}
 */
function imageKind(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length < 8) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 4).toString('hex') === '89504e47') return 'png';
  return null;
}

/**
 * Merge PDF buffers into one document.
 *
 * Pages are copied across with copyPages so each source keeps its own fonts,
 * images and page size - a merge that flattened everything to one font turned
 * engineering drawings into unreadable text.
 *
 * @param {Buffer[]} buffers source PDFs, in the order they should appear
 * @returns {Promise<Buffer>}
 */
export async function mergePdfs(buffers) {
  const sources = (buffers || []).filter((b) => Buffer.isBuffer(b) && b.length > 0);
  if (!sources.length) throw new Error('no PDFs to merge');

  const out = await PDFDocument.create();
  let pages = 0;
  for (const buf of sources) {
    let src;
    try {
      src = await PDFDocument.load(buf, { ignoreEncryption: true });
    } catch {
      // One bad file must not throw away the whole merge. Skip it and keep going.
      continue;
    }
    if (!src.getPageCount()) continue;
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const page of copied) out.addPage(page);
    pages += copied.length;
  }

  // Checked AFTER the loop, not before it: a single unreadable file would
  // otherwise be handed straight back to the user as "the compiled PDF".
  if (!pages) throw new Error('no readable pages in any of the files');
  return Buffer.from(await out.save());
}

/**
 * One A4 page per image.
 *
 * Images are scaled to fit inside the page with a margin and centred. Pages with
 * no image at all (a download that failed, a HEIC the library cannot read) still
 * get a page, so the page count always matches the receipt count and a missing
 * receipt is visible instead of silently shifting the numbering.
 *
 * @param {Array<{buffer: Buffer, label?: string}>} items
 * @param {{title?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function imagesToPdf(items, { title = '' } = {}) {
  const list = (items || []).filter((i) => i && Buffer.isBuffer(i.buffer) && i.buffer.length);
  if (!list.length) throw new Error('no images to build a PDF from');

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let readable = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const page = doc.addPage([A4.width, A4.height]);

    const caption = item.label || `#${i + 1}`;
    page.drawText(caption, {
      x: MARGIN,
      y: A4.height - MARGIN - 10,
      size: 11,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(`${i + 1} / ${list.length}`, {
      x: A4.width - MARGIN - 34,
      y: A4.height - MARGIN - 10,
      size: 9,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });

    const top = A4.height - MARGIN - 26;
    const boxW = A4.width - MARGIN * 2;
    const boxH = top - MARGIN;

    let image = null;
    const kind = imageKind(item.buffer);
    try {
      if (kind === 'jpg') image = await doc.embedJpg(item.buffer);
      else if (kind === 'png') image = await doc.embedPng(item.buffer);
    } catch {
      image = null;
    }

    if (image) {
      readable++;
      // Fit inside the box, never up-scale past 1:1 - a receipt blown up to fill
      // A4 is blurry and reads worse than the same receipt at true size.
      const scale = Math.min(boxW / image.width, boxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, {
        x: (A4.width - w) / 2,
        y: Math.max(MARGIN, top - h),
        width: w,
        height: h,
      });
    } else {
      page.drawText('image could not be read', {
        x: MARGIN,
        y: top - 20,
        size: 11,
        font,
        color: rgb(0.7, 0.2, 0.2),
      });
    }
  }

  // A PDF of nothing but "image could not be read" is worse than an error, so
  // say so instead of sending the user a useless file.
  if (!readable) throw new Error('none of those images could be read');

  // pdf-lib takes metadata through setTitle(), not through save() options - passing
// it in save() silently drops it.
  doc.setTitle(title || 'Personal Claim');
  doc.setCreator('site-bot');
  doc.setProducer('site-bot');
  return Buffer.from(await doc.save());
}

/** How many pages a PDF has, for saying "3 files, 12 pages" without guessing. */
export async function pdfPageCount(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}