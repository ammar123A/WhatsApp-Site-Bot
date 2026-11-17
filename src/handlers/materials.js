import { materialsDB } from '../database.js';
import { getToday, buildCompactMaterialsMessage, buildMaterialsMessage, buildStockSummary, replyWithPhoto, replyListWithPhotos, getRecordPhotos, getSenderName, parseRecordDate } from '../utils.js';
import { attachPendingPhotos, attachPhotoPaths, getPhotoBatchPaths, clearPhotoBatch } from './photos.js';

// Show the materials received on ONE date, with their ids.
async function showMaterialsForDate(msg, date) {
  const entries = await materialsDB.getByDate(date);
  if (!entries.length) {
    const label = date === getToday() ? 'hari ni' : date;
    return msg.reply(
      `*Takde material masuk pada ${label} boss.*\n\n` +
      `_.material semalam_ atau _.material 15/09/2026_ untuk hari lain._`
    );
  }
  const text = buildCompactMaterialsMessage(entries);
  return replyListWithPhotos(msg, text, entries, 'Material');
}

// Handle materials commands
export async function handleMaterials(msg, args) {
  const subCommand = args[0]?.toLowerCase();

  // Materials are recalled BY DATE and default to TODAY. When a DO photo
  // arrives today, "material?" must never answer with yesterday's list.
  if (!subCommand) {
    return showMaterialsForDate(msg, parseRecordDate(args.join(' ')) || getToday());
  }

  if (subCommand === 'today' || subCommand === 'hari') {
    return showMaterialsForDate(msg, getToday());
  }

  // Anything that reads as a date: .material 15/09/2026, .material semalam, ...
  const asked = parseRecordDate(args.join(' '));
  if (asked) {
    return showMaterialsForDate(msg, asked);
  }

  if (subCommand === 'recent') {
    const entries = await materialsDB.getRecent(parseInt(args[1]) || 10);
    const msg_text = entries.length > 0
      ? '*📦 RECENT MATERIALS*\n\n' + buildMaterialsMessage(entries)
      : '*No recent materials found.*';
    return replyListWithPhotos(msg, msg_text, entries, 'Material');
  }

  // View a single entry by numeric id (includes attached photo).
  // If the command itself came as a photo caption, auto-link that photo.
  const idNum = parseInt(subCommand);
  if (/^\d+$/.test(subCommand)) {
    const entry = await materialsDB.getById(idNum);
    if (entry) {
      if (msg.hasMedia) {
        const picked = await attachPendingPhotos(materialsDB, entry.id, msg.from);
        console.log(`  → auto-attached ${picked} photo(s) to material #${entry.id} (caption command)`);
      }
      const freshEntry = await materialsDB.getById(entry.id);
      let msg_text = `*📦 MATERIAL #${freshEntry.id}*\n\n`;
      msg_text += `*${freshEntry.material_name}*\n`;
      msg_text += `📂 Category: ${freshEntry.category}\n`;
      msg_text += `📊 Quantity: ${freshEntry.quantity} ${freshEntry.unit}\n`;
      if (freshEntry.supplier) msg_text += `🏭 Supplier: ${freshEntry.supplier}\n`;
      if (freshEntry.po_number) msg_text += `📄 PO: ${freshEntry.po_number}\n`;
      if (freshEntry.delivery_note) msg_text += `📑 DN: ${freshEntry.delivery_note}\n`;
      if (freshEntry.location) msg_text += `📍 Which site: ${freshEntry.location}\n`;
      if (freshEntry.received_by) msg_text += `👤 Received by: ${freshEntry.received_by}\n`;
      if (freshEntry.notes) msg_text += `📝 Notes: ${freshEntry.notes}\n`;
      msg_text += `📅 Date: ${freshEntry.date}\n`;
      msg_text += getRecordPhotos(freshEntry).length
        ? ''
        : `\n⚠️ *Tiada gambar bukti.* Hantar gambar dengan caption \`.material ${freshEntry.id}\``;
      return replyWithPhoto(msg, msg_text, getRecordPhotos(freshEntry));
    }
    return msg.reply(`*Material #${idNum} not found.*`);
  }

  // Search by name
  const entries = await materialsDB.getByName(subCommand);
  if (entries.length > 0) {
    return replyListWithPhotos(msg, `*📦 Materials matching "${subCommand}"*\n\n` + buildMaterialsMessage(entries), entries, 'Material');
  }

  return msg.reply(`*No materials found matching "${subCommand}".*`);
}

// Handle stock command
export async function handleStock(msg) {
  const stocks = await materialsDB.getStockSummary();
  return msg.reply(buildStockSummary(stocks));
}

// Keys that name the material itself, in order of preference. The long form
// "Material arrived onsite:" is what the old usage text suggested.
const MATERIAL_KEYS = ['material arrived onsite', 'material', 'item', 'nama', 'barang', 'name'];
const QUANTITY_KEYS = ['quantity', 'qty', 'kuantiti', 'bilangan', 'amount', 'jumlah'];

// Split a command body into material ITEMS instead of one flat key/value map.
//
// parseArgs() collapses duplicate keys, so ".addmaterial / Material: Cement /
// Quantity: 4 / Material: Sand brick / Quantity: 1" silently kept only the last
// pair - one record instead of two. A delivery is a LIST, so this walks the
// lines and starts a new item every time a material name reappears.
//
// Supported shapes:
//   .addmaterial
//   Material: Cement
//   Quantity: 4
//   Unit: pallet
//   Supplier: ABC          <- shared fields apply to every item
//   Material: Sand brick   <- starts a new item
//   Quantity: 1
//   Unit: pallet
//
//   .addmaterial Cement 4 pallet, Sand brick 1 pallet   (one-liner)
//   .addmaterial 4 pallet cement, 1 pallet sand brick
export function parseMaterialItems(messageBody) {
  // Strip the command word from the FIRST line only, keeping the line structure
  // intact - this is what lets the inline form work:
  //   .addmaterial 4 pallet cement, 1 pallet sand brick
  // while the block form still reads as one "Key: value" line each.
  const lines = String(messageBody || '').split('\n');
  lines[0] = lines[0].replace(/^\s*\.\s*\S+\s*/, '');

  // ── Inline form: text with no "Key: value" lines at all ──
  const inline = lines.filter((l) => l.trim() && !/^[\w '\-]+?:/.test(l.trim()));
  const hasKeyValue = lines.some((l) => /^[\w '\-]+?:/.test(l.trim()));
  if (!hasKeyValue && inline.length) {
    return parseInlineItems(inline.join(' '));
  }

  // ── Block form ──
  const items = [];
  let current = null;
  // Fields seen before any Material line: they describe every item.
  const shared = {};

  const setField = (key, value) => {
    if (!value) return;
    const lower = key.toLowerCase();
    if (MATERIAL_KEYS.includes(lower)) {
      // A new material name always starts a new item.
      current = { material: value, fields: {} };
      items.push(current);
      return;
    }
    if (!current) {
      shared[lower] = value;
      return;
    }
    current.fields[lower] = value;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon > 0 && /^[\w '\-]+$/.test(line.slice(0, colon).trim())) {
      setField(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } else {
      // A bare line before any Material line is the material name.
      setField('material', line.replace(/^[-*\s]+/, '').trim());
    }
  }

  // Shared fields (supplier/location/etc) apply to every item.
  const out = items.map((it) => {
    const fields = { ...shared, ...it.fields };
    const material = it.material;
    const quantity = firstValue(fields, QUANTITY_KEYS);
    const unit = firstValue(fields, ['unit', 'satuan']);
    return {
      material,
      quantity,
      unit,
      category: firstValue(fields, ['category', 'kategori']),
      supplier: firstValue(fields, ['supplier', 'pembekal']),
      po: firstValue(fields, ['po', 'po number']),
      dn: firstValue(fields, ['dn', 'delivery note', 'no do']),
      location: firstValue(fields, ['location', 'which site', 'whichsite', 'lokasi']),
    };
  });

  return out;
}

function firstValue(fields, keys) {
  for (const k of keys) {
    const v = fields[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

// Units people actually type. Anything else after the count is treated as the
// material name, so "2 sak simen" -> qty 2, unit sak, name "simen".
const KNOWN_UNITS = [
  'pallet', 'palet', 'pallete', 'bag', 'sak', 'sack', 'ton', 'tonne', 'tan',
  'kg', 'kilo', 'm3', 'm 3', 'm2', 'm 2', 'pcs', 'pc', 'unit', 'roll', 'length',
  'lengths', 'box', 'carton', 'ctn', 'bundle', 'bottle', 'bottle', 'tin', 'can',
  'set', 'litre', 'liter', 'l', 'sqft', 'sq ft', 'feet', 'ft', 'yard', 'column',
];

// ".addmaterial 4 pallet cement, 1 pallet sand brick" -> two items
function parseInlineItems(text) {
  // Split on commas/semicolons, but only when the next chunk starts with a
  // number - "cement, and sand" must stay one item.
  const chunks = String(text)
    .split(/[,;]|\s+\band\b\s+|\s+dan\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const items = [];
  for (const chunk of chunks.length ? chunks : [text]) {
    const m = chunk.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
    if (!m) {
      // No leading count: ".addmaterial cement 4 pallet"
      const rev = chunk.match(/^(.*?)(\d+(?:[.,]\d+)?)\s*([a-zA-Z]*)$/);
      if (rev) {
        items.push({ material: rev[1].trim(), quantity: rev[2], unit: rev[3].trim() || undefined });
      } else {
        items.push({ material: chunk, quantity: undefined });
      }
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

// Handle addmaterial command. Accepts ONE or MANY items per message.
export async function handleAddMaterial(msg, messageBody) {
  const items = parseMaterialItems(messageBody).filter((i) => i.material);
  const usable = items.filter((i) => i.quantity);

  if (!items.length || !usable.length) {
    return msg.reply(buildMaterialUsage(items));
  }

  // Photo is mandatory for every material - a delivery without proof is not
  // recorded. Snapshot the batch ONCE so every item in a multi-item delivery
  // gets the same evidence (draining per item left items 2..n with zero photos,
  // which then failed and were deleted).
  const photos = getPhotoBatchPaths(msg.from);
  if (!photos.length) {
    return msg.reply(buildMaterialPhotoReminder(items));
  }

  const saved = [];
  const failed = [];

  for (const item of items) {
    if (!item.quantity) {
      failed.push({ material: item.material, why: 'tiada quantity' });
      continue;
    }
    try {
      const result = await materialsDB.add({
        date: getToday(),
        materialName: item.material,
        category: item.category || 'Others',
        quantity: parseFloat(String(item.quantity).replace(',', '.')) || 0,
        unit: item.unit || 'pcs',
        supplier: item.supplier,
        poNumber: item.po,
        deliveryNote: item.dn,
        receivedBy: getSenderName(msg),
        location: item.location,
        photo: null,
      });
      const id = result.lastInsertRowid;

      const picked = await attachPhotoPaths(materialsDB, id, photos);
      if (picked === 0) {
        // Never leave a material row without photo evidence behind.
        await materialsDB.delete(id);
        console.log(`⚠️ material #${id} rolled back - no photo evidence`);
        failed.push({ material: item.material, why: 'tiada gambar' });
        continue;
      }

      saved.push({ id, material: item.material, quantity: item.quantity, unit: item.unit });
      console.log(`✅ material #${id} recorded with ${picked} photo(s)`);
    } catch (error) {
      console.error('Error adding material:', error);
      failed.push({ material: item.material, why: 'DB error' });
    }
  }

  // Clear the batch only after every item has been written.
  if (saved.length) clearPhotoBatch(msg.from);

  if (!saved.length) {
    return msg.reply('⚠️ *Takde satu pun material dapat disimpan* - cuba semula dengan gambar.');
  }

  const lines = saved.map((s) => `• ${s.material} (${s.quantity}${s.unit ? ' ' + s.unit : ''}) → #${s.id}`).join('\n');
  const head = saved.length === 1
    ? `✅ *Material #${saved[0].id}* dah masuk boss 📸`
    : `✅ *${saved.length} materials* dah masuk boss 📸`;
  let text = `${head}\n${lines}`;

  if (failed.length) {
    text += `\n\n⚠️ Belum masuk: ${failed.map((f) => `${f.material} (${f.why})`).join(', ')}`;
  }
  return msg.reply(text);
}

function buildMaterialUsage(items) {
  const missing = items.filter((i) => !i.quantity);
  const ask = missing.length
    ? `\n\nBerapa banyak boss?\n\`\`\`\n${missing.map((m) => `Material: ${m.material}\nQuantity: ?`).join('\n')}\n\`\`\``
    : '';
  return (
    '*Usage:* `.addmaterial`\n\n' +
    '```\n' +
    '.addmaterial\n' +
    'Material: Cement\n' +
    'Quantity: 100\n' +
    'Unit: bags\n' +
    'Supplier: ABC Corp\n' +
    'Location: Store\n' +
    '```\n\n' +
    '*Banyak sekali sekali jalan* - ulang `Material:` untuk setiap baris:\n' +
    '```\n' +
    '.addmaterial\n' +
    'Supplier: ABC Corp\n' +
    'Material: Cement\n' +
    'Quantity: 4\n' +
    'Unit: pallet\n' +
    'Material: Sand brick\n' +
    'Quantity: 1\n' +
    'Unit: pallet\n' +
    '```\n\n' +
    '*Atau satu baris je:* `.addmaterial 4 pallet cement, 1 pallet sand brick`\n\n' +
    '_Supplier/Location yang di atas guna untuk semua baris._' +
    ask
  );
}

function buildMaterialPhotoReminder(items) {
  const body = items.map((i) => `Material: ${i.material}\nQuantity: ${i.quantity}${i.unit ? '\nUnit: ' + i.unit : ''}`).join('\n');
  return (
    '⚠️ *Gambar bukti diwajibkan* - material tak direkodkan.\n\n' +
    'Hantar gambar DO/material dulu, kemudian hantar semula:\n' +
    '```\n' +
    '.addmaterial\n' +
    `${body}\n` +
    '```\n\n' +
    '_Atau hantar gambar dengan `.addmaterial` sebagai caption - ia auto attach._'
  );
}

// Handle deletematerial command
export async function handleDeleteMaterial(msg, args) {
  const id = parseInt(args[0]);
  if (!id) {
    return msg.reply('*Usage:* .deletematerial [id]');
  }
  
  try {
    const result = await materialsDB.delete(id);
    if (result.changes > 0) {
      return msg.reply(`*✅ Material #${id} deleted.*`);
    }
    return msg.reply(`*Material #${id} not found.*`);
  } catch (error) {
    console.error('Error deleting material:', error);
    return msg.reply('*❌ Error deleting material.*');
  }
}
