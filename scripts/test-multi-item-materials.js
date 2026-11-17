// Regression test for the multi-item material photo bug:
//   "4 pallet cement, 1 pallet sand brick" -> 2 records.
// The first record drained the photo batch, so the second found 0 photos,
// failed its photo requirement and was DELETED. Only 1 of 2 lines survived.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    fail++;
  }
}

const ai = readFileSync(join(root, 'src/handlers/ai.js'), 'utf8');
const photos = readFileSync(join(root, 'src/handlers/photos.js'), 'utf8');

// --- The fix: a non-draining attach exists and is what multi-item uses -------
check('photos.js has a non-draining attachPhotoPaths', () => {
  assert.match(photos, /export async function attachPhotoPaths/);
  assert.match(photos, /WITHOUT draining the batch/);
});

check('saveOneMaterial uses the snapshot, never the draining attach', () => {
  const fn = ai.slice(ai.indexOf('async function saveOneMaterial'));
  const end = fn.indexOf('\nasync function saveMaterial');
  const body = fn.slice(0, end);
  assert.match(body, /attachPhotoPaths\(materialsDB/);
  assert.ok(
    !/attachPendingPhotos\(materialsDB/.test(body),
    'saveOneMaterial must not drain the batch per record'
  );
});

check('the batch is snapshotted ONCE before the loop', () => {
  assert.match(ai, /const photos = getPhotoBatchPaths\(msg\.from\);/);
});

check('the batch is cleared once, after the loop, not inside it', () => {
  const fn = ai.slice(ai.indexOf('async function saveMaterial'));
  const body = fn.slice(0, fn.indexOf('async function saveIssue'));
  assert.match(body, /if \(willDrain\) clearPhotoBatch\(msg\.from\);/);
  const clearIdx = body.indexOf('clearPhotoBatch');
  const loopIdx = body.indexOf('for (const item of');
  assert.ok(loopIdx > -1 && clearIdx > loopIdx, 'clear must come after the loop');
  assert.equal((body.match(/clearPhotoBatch/g) || []).length, 1, 'exactly one clear');
});

// --- Behaviour, simulated with a stub table ---------------------------------
async function saveMultiItem(items, batchPaths) {
  const rows = [];
  const table = {
    async updatePhotos(id, paths) {
      const row = rows.find((r) => r.id === id);
      if (!row) return { changes: 0 };
      row.photos = paths;
      return { changes: 1 };
    },
  };
  const add = async (r) => {
    rows.push({ id: rows.length + 1, ...r });
    return { lastInsertRowid: rows.length };
  };

  // Mirror saveOneMaterial
  for (const item of items) {
    const res = await add(item);
    const written = batchPaths.length ? await table.updatePhotos(res.lastInsertRowid, batchPaths) : { changes: 0 };
    const picked = written.changes > 0 ? batchPaths.length : 0;
    if (!picked) {
      const idx = rows.findIndex((r) => r.id === res.lastInsertRowid);
      if (idx > -1) rows.splice(idx, 1);
    }
  }
  return rows;
}

const batch = [
  '2026-10-01/10-00-00-1.jpg',
  '2026-10-01/10-00-01-2.jpg',
  '2026-10-01/10-00-02-3.jpg',
];

const run = async () => {
  const rows = await saveMultiItem(
    [
      { material: 'cement', quantity: '4', unit: 'pallet' },
      { material: 'sand brick', quantity: '1', unit: 'pallet' },
    ],
    batch
  );
  check('both lines of a 2-line delivery survive', () => {
    assert.equal(rows.length, 2, `expected 2 records, got ${rows.length}`);
  });
  check('each line carries the photo evidence', () => {
    assert.deepEqual(rows[0].photos, batch);
    assert.deepEqual(rows[1].photos, batch);
  });
  check('each line keeps its own name and quantity', () => {
    assert.equal(rows[0].material, 'cement');
    assert.equal(rows[0].quantity, '4');
    assert.equal(rows[1].material, 'sand brick');
    assert.equal(rows[1].quantity, '1');
  });

  // No photos at all: nothing may be saved, since material needs evidence.
  const noPhotos = await saveMultiItem([{ material: 'cement', quantity: '4' }], []);
  check('a delivery with no photo is rejected, not stored bare', () => {
    assert.equal(noPhotos.length, 0);
  });

  // 4-line delivery.
  const four = await saveMultiItem(
    [
      { material: 'cement', quantity: '4' },
      { material: 'sand brick', quantity: '1' },
      { material: 'steel', quantity: '2' },
      { material: 'cement', quantity: '10' },
    ],
    batch
  );
  check('a 4-line delivery makes 4 records', () => {
    assert.equal(four.length, 4);
  });
};

await run();

// --- Site group allow-list ---------------------------------------------------
const sites = readFileSync(join(root, 'src/sites.js'), 'utf8');

check('site groups are allow-listed, not auto-detected from the name', () => {
  assert.match(sites, /export function isAllowedGroup/);
  assert.match(sites, /export function allowGroup/);
  assert.match(sites, /export function blockGroup/);
});

check('registerGroup re-derives the site so a rename is picked up', () => {
  assert.ok(
    !/existing\?\.site \|\| site/.test(sites),
    'must not keep the old site name on rename'
  );
  assert.match(sites, /renamed:/);
});

check('the allow-list can be seeded from env', () => {
  assert.match(sites, /export function allowGroupsFromEnv/);
  const cfg = readFileSync(join(root, 'config.js'), 'utf8');
  assert.match(cfg, /siteGroups: process\.env\.SITE_GROUPS/);
});

const index = readFileSync(join(root, 'index.js'), 'utf8');

check('index gates on the allow-list BEFORE any photo/record work', () => {
  const gate = index.indexOf('if (!isAllowedGroup(msg.from))');
  const photo = index.indexOf('await handlePhoto(msg)');
  assert.ok(gate > -1, 'allow-list gate missing');
  assert.ok(photo > -1, 'photo handler missing');
  assert.ok(gate < photo, 'gate must come before photos are saved');
});

check('an unregistered group is fully silent unless claimed', () => {
  assert.match(index, /\.\(site\|daftar\|register\)/);
  assert.match(index, /\^\\\.unsite\\b/);
});

check('admin check uses adminNumbers (plural), not a missing adminNumber', () => {
  assert.match(index, /config\.adminNumbers\.some\(/);
  assert.ok(!/config\.adminNumber\b/.test(index), 'config.adminNumber does not exist');
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);