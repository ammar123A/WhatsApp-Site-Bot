/**
 * Guards the ".bin" bug.
 *
 * whatsapp-web.js 1.34.7 never sets msg.mimetype, so anything that trusted it
 * filed every unnamed WhatsApp photo as ".bin". The fix is to identify the file
 * from its own bytes. These tests use real file signatures, not made-up ones.
 */
import { sniffType, classifyFile, safeName, dayFolder, folderFor } from '../src/fileStore.js';

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`       expected ${JSON.stringify(expected)}`);
    console.log(`       actual   ${JSON.stringify(actual)}`);
  }
}

/** Minimal real signatures. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from('GIF89a......', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3', 'latin1');
const OGG = Buffer.from('OggS.........', 'latin1');
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')]);
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]);

console.log('\n--- sniffType: identify by bytes ---');
check('jpeg', sniffType(JPEG)?.mime, 'image/jpeg');
check('jpeg ext', sniffType(JPEG)?.ext, '.jpg');
check('png', sniffType(PNG)?.mime, 'image/png');
check('gif', sniffType(GIF)?.mime, 'image/gif');
check('webp', sniffType(WEBP)?.mime, 'image/webp');
check('pdf', sniffType(PDF)?.mime, 'application/pdf');
check('opus voice', sniffType(OGG)?.mime, 'audio/ogg');
check('mp4', sniffType(MP4)?.mime, 'video/mp4');
check('heic', sniffType(HEIC)?.mime, 'image/heic');
check('unknown bytes', sniffType(Buffer.from('hello world, not a known file')), null);
check('too short', sniffType(Buffer.from([0xff])), null);

// The exact regression: an unnamed photo with NO mimetype anywhere.
console.log('\n--- the .bin regression ---');
const sniffed = sniffType(JPEG);
check('unnamed photo gets jpg', sniffed?.ext, '.jpg');
if (sniffed?.ext === '.bin') fail++; else pass++;

console.log('\n--- classifyFile still files by kind and words ---');
check('image is a photo', classifyFile({ type: 'image', mimetype: 'image/jpeg' }).category, 'photos');
check('ptt is voice', classifyFile({ type: 'ptt', mimetype: 'audio/ogg' }).category, 'voice');
check('video is video', classifyFile({ type: 'video', mimetype: 'video/mp4' }).category, 'video');
check('sniffed pdf', classifyFile({ type: 'document', mimetype: sniffType(PDF).mime }).category, 'pdf');
check(
  'as built pdf is a drawing',
  classifyFile({ type: 'document', mimetype: 'application/pdf', filename: 'OLD-DRAWING-AS-BUILT.pdf' }).category,
  'drawings',
);
check('caption drawing wins for doc', classifyFile({ type: 'document', mimetype: '', filename: 'doc1.pdf', caption: 'as built plan' }).category, 'drawings');
check('named pdf stays pdf', classifyFile({ type: 'document', mimetype: '', filename: 'surat lesen.pdf' }).category, 'pdf');
check('unknown doc is other', classifyFile({ type: 'document', mimetype: '' }).category, 'other');
// An image photographed sketch must still land in photos, not drawings.
check('sketch photo stays photo', classifyFile({ type: 'image', mimetype: 'image/jpeg', caption: 'drawing as built' }).category, 'photos');

console.log('\n--- paths ---');
check('day folder', dayFolder(new Date(2026, 9, 3)), '03-10-2026');
check('folder', folderFor('Sky Awani', new Date(2026, 9, 3)), 'Sky Awani/03-10-2026');
check('unnamed file is timestamped', safeName('', '.jpg', new Date(2026, 9, 3, 15, 57, 6)), '15-57-06.jpg');
check('named file kept', safeName('paip atas bumbung.jpg', '.jpg'), 'paip-atas-bumbung.jpg');
check('slashes stripped', safeName('a/b:c.pdf', '.pdf'), 'a-b-c.pdf');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);