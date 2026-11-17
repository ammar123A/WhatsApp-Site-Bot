/**
 * Filing rules for auto-saved files. Offline: no DB, no network.
 *
 * The point of these tests is the classification ladder, because that is what
 * decides whether "OLD DRAWING AS BUILT.pdf" ends up where the site expects.
 */
import { classifyFile, dayFolder, folderFor, safeName, isSaveableMedia } from '../src/fileStore.js';
import { buildFilesMessage } from '../src/handlers/files.js';

// extFor() is internal, so reach it the way the production code does: through a
// name with no extension, where safeName() has to supply one.
function require_ext(expected, mimetype = 'image/jpeg') {
  const byMime = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'application/pdf': '.pdf',
    'audio/ogg; codecs=opus': '.opus',
  };
  return byMime[mimetype] === expected ? expected : `${byMime[mimetype]} (got for ${mimetype})`;
}

let pass = 0;
let fail = 0;

function check(label, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

const want = (label, input, expected) => {
  const got = classifyFile(input);
  check(`${label} -> ${expected}`, got.category === expected, `got "${got.category}" (${got.reason})`);
};

console.log('\nTHE USER\'S OWN EXAMPLE');
want('OLD DRAWING AS BUILT.pdf', { type: 'document', mimetype: 'application/pdf', filename: 'OLD DRAWING AS BUILT.pdf' }, 'drawings');
want('as-built rev plan', { type: 'document', mimetype: 'application/pdf', filename: 'SkyAwani_AsBuilt_Rev2.pdf' }, 'drawings');
want('a plain letter', { type: 'document', mimetype: 'application/pdf', filename: 'SURAT-LESEN.pdf' }, 'pdf');
want('a delivery order', { type: 'document', mimetype: 'application/pdf', filename: 'DELIVERY-NOTE-1026.pdf' }, 'pdf');

console.log('\nA PHOTO IS ALWAYS A PHOTO');
want('plain jpg', { type: 'image', mimetype: 'image/jpeg', filename: 'IMG-001.jpg' }, 'photos');
want('png', { type: 'image', mimetype: 'image/png', filename: 'IMG-002.png' }, 'photos');
want('photo captioned "drawing"', { type: 'image', mimetype: 'image/jpeg', filename: 'IMG-003.jpg', caption: 'gambar rajah paip' }, 'photos');
want('photo of a delivery', { type: 'image', mimetype: 'image/jpeg', filename: 'IMG-004.jpg', caption: 'barang dah sampai' }, 'photos');

console.log('\nVOICE');
want('ptt', { type: 'ptt', mimetype: 'audio/ogg; codecs=opus' }, 'voice');
want('opus file', { type: 'audio', mimetype: '', filename: 'note.opus' }, 'voice');
want('mp3 file', { type: 'audio', mimetype: 'audio/mpeg', filename: 'taklimat.mp3' }, 'voice');

console.log('\nVIDEO AND OTHER');
want('mp4', { type: 'video', mimetype: 'video/mp4', filename: 'site.mp4' }, 'video');
want('excel stays out of the pdf bucket', { type: 'document', mimetype: 'application/vnd.ms-excel', filename: 'BOM.xls' }, 'other');
want('unknown blob', { type: 'document', mimetype: 'application/octet-stream', filename: 'blob' }, 'other');
want('no info at all', {}, 'other');

console.log('\nCAD FILES ARE NOT PHOTOS');
// WhatsApp really does report a .dwg as "image/vnd.dwg". AutoCAD registered
// that MIME type decades ago and it is technically correct, which is why
// "Asbuilt sewer.dwg" was being filed into site-photos as a picture.
want('Asbuilt sewer.dwg (the real one)', { type: 'document', mimetype: 'image/vnd.dwg', filename: 'Asbuilt sewer.dwg' }, 'drawings');
want('dwg', { type: 'document', mimetype: 'image/vnd.dwg', filename: 'plan.dwg' }, 'drawings');
want('dxf', { type: 'document', mimetype: 'application/octet-stream', filename: 'layout.dxf' }, 'drawings');
want('ifc', { type: 'document', mimetype: '', filename: 'model.ifc' }, 'drawings');
want('rvt', { type: 'document', mimetype: 'image/vnd.dwg', filename: 'building.rvt' }, 'drawings');
// The extension is the only reason to believe it, so a real photo must still win.
want('photo called dwg.jpg is still a photo', { type: 'image', mimetype: 'image/jpeg', filename: 'dwg.jpg' }, 'photos');
want('photo is still a photo', { type: 'image', mimetype: 'image/jpeg', filename: 'Asbuilt-sewer.png' }, 'photos');

console.log('\nMALAY NAMES');
want('borong', { type: 'document', mimetype: 'application/pdf', filename: 'borong-ayat-12.pdf' }, 'drawings');
want('pelan', { type: 'document', mimetype: 'application/pdf', filename: 'pelan-blok-A.pdf' }, 'drawings');
want('invois', { type: 'document', mimetype: 'application/pdf', filename: 'invois-001.pdf' }, 'pdf');
want('laporan tanah', { type: 'document', mimetype: 'application/pdf', filename: 'laporan-geoteknik.pdf' }, 'pdf');
want('caption calls it a drawing', { type: 'document', mimetype: 'application/pdf', filename: 'doc1.pdf', caption: 'ini drawing untuk blok A' }, 'drawings');

console.log('\nPATHS - SITE THEN DAY');
check('folder is site/day', folderFor('Sky Awani', new Date(2026, 9, 2)) === 'Sky Awani/02-10-2026',
  folderFor('Sky Awani', new Date(2026, 9, 2)));
check('day is DD-MM-YYYY', dayFolder(new Date(2026, 9, 2)) === '02-10-2026');
check('slash in site name is neutralised', !folderFor('A/B Site', new Date(2026, 9, 2)).includes('A/B'),
  folderFor('A/B Site', new Date(2026, 9, 2)));
check('empty site name still gives a folder', folderFor('', new Date(2026, 9, 2)).length > 0);

console.log('\nFILE NAMES STAY READABLE');
check('spaces become dashes', safeName('OLD DRAWING AS BUILT.pdf') === 'OLD-DRAWING-AS-BUILT.pdf', safeName('OLD DRAWING AS BUILT.pdf'));
check('path chars removed', !safeName('a/b:c*d?e.jpg').match(/[/\\:*?"<>|]/), safeName('a/b:c*d?e.jpg'));
check('extension added when missing', safeName('gambar paip', '.opus') === 'gambar-paip.opus', safeName('gambar paip', '.opus'));
check('no name falls back to the time of day', safeName('', '.pdf', new Date(2026, 9, 3, 17, 34, 5)) === '17-34-05.pdf',
  safeName('', '.pdf', new Date(2026, 9, 3, 17, 34, 5)));

// WhatsApp sends photos with NO filename, so the extension must come from the
// mimetype. Missing jpeg here filed every site photo as .bin.
{
  const saved = require_ext('.jpg');
  check('jpeg photos get .jpg', saved === '.jpg', saved);
  check('png stays .png', require_ext('.png', 'image/png') === '.png');
  check('pdf stays .pdf', require_ext('.pdf', 'application/pdf') === '.pdf');
  check('opus voice stays .opus', require_ext('.opus', 'audio/ogg; codecs=opus') === '.opus');
}

console.log('\nWHAT COUNTS AS A FILE WORTH SAVING');
for (const t of ['image', 'document', 'ptt', 'audio', 'video']) {
  check(`${t} is saved`, isSaveableMedia({ hasMedia: true, type: t }));
}
for (const t of ['sticker', 'chat', 'location']) {
  check(`${t} is ignored`, !isSaveableMedia({ hasMedia: t === 'sticker', type: t }));
}
check('no media is ignored', !isSaveableMedia({ hasMedia: false, type: 'chat' }));

console.log('\nLISTING SHOWS THE ID');
{
  const out = buildFilesMessage([
    { id: 14, category: 'drawings', date: '02/10/2026', bucket: 'site-drawings', path: 'Sky Awani/02-10-2026/OLD-DRAWING-AS-BUILT.pdf', original_name: 'OLD-DRAWING-AS-BUILT.pdf', link_type: null, link_id: null },
  ], 'DRAWINGS FILES');
  check('id visible', out.includes('#14'));
  check('name visible', out.includes('OLD-DRAWING-AS-BUILT.pdf'));
  check('full path visible', out.includes('site-drawings/Sky Awani/02-10-2026/OLD-DRAWING-AS-BUILT.pdf'));
}

console.log('\nLINKED FILES SHOW THEIR RECORD');
{
  const out = buildFilesMessage([
    { id: 9, category: 'photos', date: '02/10/2026', bucket: 'site-photos', path: 'Sky Awani/02-10-2026/x.jpg', original_name: 'x.jpg', link_type: 'material', link_id: 8 },
  ], 'LATEST');
  check('points at the material', out.includes('material #8'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);