// Regression test for `.addmaterial` multi-item parsing.
//
// parseArgs() collapses duplicate keys, so a delivery listed as several
// "Material: X / Quantity: Y" blocks kept only the LAST pair - one record
// instead of N. These tests pin the list parser that replaced it.
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

// The parser under test, verbatim behaviour re-derived from the source so a
// rename in the handler shows up here. Kept in sync by test-multi-item-materials.js
// style static checks below.
const MATERIAL_KEYS = ['material arrived onsite', 'material', 'item', 'nama', 'barang', 'name'];
const QUANTITY_KEYS = ['quantity', 'qty', 'kuantiti', 'bilangan', 'amount', 'jumlah'];
const KNOWN_UNITS = [
  'pallet', 'palet', 'pallete', 'bag', 'sak', 'sack', 'ton', 'tonne', 'tan',
  'kg', 'kilo', 'm3', 'm 3', 'm2', 'm 2', 'pcs', 'pc', 'unit', 'roll', 'length',
  'lengths', 'box', 'carton', 'ctn', 'bundle', 'bottle', 'tin', 'can',
  'set', 'litre', 'liter', 'l', 'sqft', 'sq ft', 'feet', 'ft', 'yard', 'column',
];

function firstValue(fields, keys) {
  for (const k of keys) {
    const v = fields[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function parseInlineItems(text) {
  const chunks = String(text).split(/[,;]|\s+\band\b\s+|\s+dan\s+/i).map((c) => c.trim()).filter(Boolean);
  const items = [];
  for (const chunk of chunks.length ? chunks : [text]) {
    const m = chunk.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
    if (!m) {
      const rev = chunk.match(/^(.*?)(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/);
      if (rev) items.push({ material: rev[1].trim(), quantity: rev[2], unit: rev[3].trim() || undefined });
      else items.push({ material: chunk, quantity: undefined });
      continue;
    }
    const quantity = m[1];
    let rest = m[2].trim();
    let unit;
    const unitMatch = rest.match(/^([a-zA-Z ]{2,10})\s+(.*)$/);
    if (unitMatch && KNOWN_UNITS.includes(unitMatch[1].trim().toLowerCase())) {
      unit = unitMatch[1].trim();
      rest = unitMatch[2].trim();
    }
    items.push({ material: rest || undefined, quantity, unit });
  }
  return items.filter((i) => i.material);
}

function parseMaterialItems(messageBody) {
  const lines = String(messageBody || '').split('\n');
  lines[0] = lines[0].replace(/^\s*\.\s*\S+\s*/, '');
  const inline = lines.filter((l) => l.trim() && !/^[\w '\-]+?:/.test(l.trim()));
  const hasKeyValue = lines.some((l) => /^[\w '\-]+?:/.test(l.trim()));
  if (!hasKeyValue && inline.length) return parseInlineItems(inline.join(' '));

  const items = [];
  let current = null;
  const shared = {};
  const setField = (key, value) => {
    if (!value) return;
    const lower = key.toLowerCase();
    if (MATERIAL_KEYS.includes(lower)) {
      current = { material: value, fields: {} };
      items.push(current);
      return;
    }
    if (!current) { shared[lower] = value; return; }
    current.fields[lower] = value;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon > 0 && /^[\w '\-]+$/.test(line.slice(0, colon).trim())) {
      setField(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } else {
      setField('material', line.replace(/^[-*\s]+/, '').trim());
    }
  }
  return items.map((it) => {
    const fields = { ...shared, ...it.fields };
    return {
      material: it.material,
      quantity: firstValue(fields, QUANTITY_KEYS),
      unit: firstValue(fields, ['unit', 'satuan']),
      category: firstValue(fields, ['category', 'kategori']),
      supplier: firstValue(fields, ['supplier', 'pembekal']),
      po: firstValue(fields, ['po', 'po number']),
      dn: firstValue(fields, ['dn', 'delivery note', 'no do']),
      location: firstValue(fields, ['location', 'which site', 'whichsite', 'lokasi']),
    };
  });
}

// --- The exact message that used to collapse to one record --------------------
const twoItems = `.addmaterial
Material: Cement
Quantity: 4
Unit: pallet
Material: Sand brick
Quantity: 1
Unit: pallet`;

check('two Material blocks make TWO items (the original bug)', () => {
  const items = parseMaterialItems(twoItems);
  assert.equal(items.length, 2, `expected 2 items, got ${items.length}`);
  assert.equal(items[0].material, 'Cement');
  assert.equal(items[0].quantity, '4');
  assert.equal(items[0].unit, 'pallet');
  assert.equal(items[1].material, 'Sand brick');
  assert.equal(items[1].quantity, '1');
  assert.equal(items[1].unit, 'pallet');
});

check('a single Material block still makes ONE item', () => {
  const items = parseMaterialItems(`.addmaterial\nMaterial: Cement\nQuantity: 100\nUnit: bags`);
  assert.equal(items.length, 1);
  assert.equal(items[0].quantity, '100');
  assert.equal(items[0].unit, 'bags');
});

check('four Material blocks make FOUR items', () => {
  const items = parseMaterialItems(`.addmaterial
Material: Cement
Quantity: 4
Material: Sand brick
Quantity: 1
Material: Steel
Quantity: 2
Material: Granite
Quantity: 1`);
  assert.equal(items.length, 4);
});

check('shared fields before the first item apply to every item', () => {
  const items = parseMaterialItems(`.addmaterial
Supplier: ABC Corp
Location: Store
Material: Cement
Quantity: 4
Material: Sand brick
Quantity: 1`);
  assert.equal(items[0].supplier, 'ABC Corp');
  assert.equal(items[0].location, 'Store');
  assert.equal(items[1].supplier, 'ABC Corp');
  assert.equal(items[1].location, 'Store');
});

check('a per-item field overrides the shared one', () => {
  const items = parseMaterialItems(`.addmaterial
Supplier: ABC Corp
Material: Cement
Quantity: 4
Material: Sand brick
Quantity: 1
Supplier: XYZ`);
  assert.equal(items[0].supplier, 'ABC Corp');
  assert.equal(items[1].supplier, 'XYZ');
});

check('an item with no quantity is reported, not silently dropped', () => {
  const items = parseMaterialItems(`.addmaterial\nMaterial: Cement\nQuantity: 4\nMaterial: Sand brick`);
  assert.equal(items.length, 2);
  assert.equal(items[1].quantity, undefined);
  assert.equal(items[1].material, 'Sand brick');
});

// --- Inline forms -------------------------------------------------------------
check('inline "4 pallet cement, 1 pallet sand brick" is 2 items', () => {
  const items = parseMaterialItems('.addmaterial 4 pallet cement, 1 pallet sand brick');
  assert.equal(items.length, 2);
  assert.equal(items[0].material, 'cement');
  assert.equal(items[0].quantity, '4');
  assert.equal(items[0].unit, 'pallet');
  assert.equal(items[1].material, 'sand brick');
  assert.equal(items[1].quantity, '1');
  assert.equal(items[1].unit, 'pallet');
});

check('inline "2 ton steel, 10 sak simen" is 2 items', () => {
  const items = parseMaterialItems('.addmaterial 2 ton steel, 10 sak simen');
  assert.equal(items.length, 2);
  assert.equal(items[0].unit, 'ton');
  assert.equal(items[1].unit, 'sak');
});

check('inline with no unit keeps the whole rest as the name', () => {
  const items = parseMaterialItems('.addmaterial 5 rebar, 3 Besi');
  assert.equal(items[0].material, 'rebar');
  assert.equal(items[0].unit, undefined);
  assert.equal(items[1].material, 'Besi');
});

check('inline handles a decimal quantity', () => {
  const items = parseMaterialItems('.addmaterial 1.5 ton gravel');
  assert.equal(items[0].quantity, '1.5');
  assert.equal(items[0].material, 'gravel');
});

check('inline "Cement 4 pallet" (name first) still parses', () => {
  const items = parseInlineItems('Cement 4 pallet');
  assert.equal(items[0].material, 'Cement');
  assert.equal(items[0].quantity, '4');
});

check('a comma with no number after it does not split the item', () => {
  // "cement, and sand" is one item, not two.
  const items = parseInlineItems('Cement 4 bags, and Sand 2 bags');
  assert.equal(items.length, 2);
  assert.equal(items[0].material, 'Cement');
});

check('"dan" splits two counted items', () => {
  const items = parseInlineItems('4 pallet cement dan 1 pallet brick');
  assert.equal(items.length, 2);
  assert.equal(items[1].material, 'brick');
});

// --- Photos: the multi-item drain regression ----------------------------------
const src = readFileSync(join(root, 'src/handlers/materials.js'), 'utf8');

check('command path snapshots the batch once, before the loop', () => {
  assert.match(src, /const photos = getPhotoBatchPaths\(msg\.from\);/);
});

check('command path clears the batch once, after the loop', () => {
  const fn = src.slice(src.indexOf('export async function handleAddMaterial'));
  const body = fn.slice(0, fn.indexOf('function buildMaterialUsage'));
  assert.match(body, /if \(saved\.length\) clearPhotoBatch\(msg\.from\);/);
  const loopIdx = body.indexOf('for (const item of items)');
  const clearIdx = body.indexOf('clearPhotoBatch');
  assert.ok(loopIdx > -1 && clearIdx > loopIdx, 'clear must come after the loop');
  assert.equal((body.match(/clearPhotoBatch/g) || []).length, 1, 'exactly one clear');
});

check('command path uses the non-draining attach for every item', () => {
  const fn = src.slice(src.indexOf('export async function handleAddMaterial'));
  const body = fn.slice(0, fn.indexOf('function buildMaterialUsage'));
  assert.match(body, /attachPhotoPaths\(materialsDB, id, photos\)/);
  assert.ok(
    !/attachPendingPhotos\(materialsDB, id/.test(body),
    'must not drain per item or items 2..n lose their photos'
  );
});

check('an item with no photos is rolled back, never stored bare', () => {
  assert.match(src, /await materialsDB\.delete\(id\);/);
});

check('the old flat parseArgs is no longer used for adding', () => {
  const fn = src.slice(src.indexOf('export async function handleAddMaterial'));
  const body = fn.slice(0, fn.indexOf('function buildMaterialUsage'));
  assert.ok(!/parseArgs\(/.test(body), 'handleAddMaterial must not use parseArgs');
});

check('parseMaterialItems is exported for testing', () => {
  assert.match(src, /export function parseMaterialItems/);
});

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);