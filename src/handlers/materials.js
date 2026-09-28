import { materialsDB } from '../database.js';
import { getToday, parseArgs, buildMaterialsMessage, buildStockSummary, replyWithPhoto, getRecordPhotos } from '../utils.js';
import { attachPendingPhotos } from './photos.js';
import config from '../../config.js';

// Handle materials commands
export async function handleMaterials(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'today') {
    const today = getToday();
    const entries = materialsDB.getByDate(today);
    const msg_text = entries.length > 0 
      ? buildMaterialsMessage(entries)
      : '*No materials recorded today.*\n\nUse .addmaterial to add entry.';
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'recent') {
    const entries = materialsDB.getRecent(parseInt(args[1]) || 10);
    const msg_text = entries.length > 0
      ? '*📦 RECENT MATERIALS*\n\n' + buildMaterialsMessage(entries)
      : '*No recent materials found.*';
    return msg.reply(msg_text);
  }

  // View a single entry by numeric id (includes attached photo).
  // If the command itself came as a photo caption, auto-link that photo.
  const idNum = parseInt(subCommand);
  if (/^\d+$/.test(subCommand)) {
    const entry = materialsDB.getById(idNum);
    if (entry) {
      if (msg.hasMedia) {
        const picked = attachPendingPhotos(materialsDB, entry.id);
        console.log(`  → auto-attached ${picked} photo(s) to material #${entry.id} (caption command)`);
      }
      const freshEntry = materialsDB.getById(entry.id);
      let msg_text = `*📦 MATERIAL #${freshEntry.id}*\n\n`;
      msg_text += `*${freshEntry.material_name}*\n`;
      msg_text += `📂 Category: ${freshEntry.category}\n`;
      msg_text += `📊 Quantity: ${freshEntry.quantity} ${freshEntry.unit}\n`;
      if (freshEntry.supplier) msg_text += `🏭 Supplier: ${freshEntry.supplier}\n`;
      if (freshEntry.po_number) msg_text += `📄 PO: ${freshEntry.po_number}\n`;
      if (freshEntry.delivery_note) msg_text += `📑 DN: ${freshEntry.delivery_note}\n`;
      if (freshEntry.location) msg_text += `📍 Location: ${freshEntry.location}\n`;
      if (freshEntry.received_by) msg_text += `👤 Received by: ${freshEntry.received_by}\n`;
      if (freshEntry.notes) msg_text += `📝 Notes: ${freshEntry.notes}\n`;
      msg_text += `📅 Date: ${freshEntry.date}\n`;
      return replyWithPhoto(msg, msg_text, getRecordPhotos(freshEntry));
    }
    return msg.reply(`*Material #${idNum} not found.*`);
  }
  
  // Search by name
  const entries = materialsDB.getByName(subCommand);
  if (entries.length > 0) {
    return msg.reply(`*📦 Materials matching "${subCommand}"*\n\n` + buildMaterialsMessage(entries));
  }
  
  return msg.reply(`*No materials found matching "${subCommand}".*`);
}

// Handle stock command
export async function handleStock(msg) {
  const stocks = materialsDB.getStockSummary();
  return msg.reply(buildStockSummary(stocks));
}

// Handle addmaterial command
export async function handleAddMaterial(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.name || !args.quantity) {
    return msg.reply(
      '*Usage:* .addmaterial\n\n' +
      'Format:\n' +
      '```\n' +
      '.addmaterial\n' +
      'Name: Cement\n' +
      'Category: Cement\n' +
      'Quantity: 100\n' +
      'Unit: bags\n' +
      'Supplier: ABC Corp\n' +
      'PO: PO-001\n' +
      'DN: DN-001\n' +
      'Location: Store\n' +
      'By: John\n' +
      '```\n\n' +
      `*Categories:* ${config.materialCategories.join(', ')}\n` +
      '*Units:* bags, tons, kg, m3, pcs, rolls, lengths, etc.'
    );
  }
  
  const entry = {
    date: getToday(),
    materialName: args.name,
    category: args.category || 'Others',
    quantity: parseFloat(args.quantity) || 0,
    unit: args.unit || 'pcs',
    supplier: args.supplier,
    poNumber: args.po,
    deliveryNote: args.dn,
    receivedBy: args.by || args.received,
    location: args.location,
    photo: null
  };
  
  try {
    const result = materialsDB.add(entry);
    let photoNote = '';
    if (msg.hasMedia) {
      const picked = attachPendingPhotos(materialsDB, result.lastInsertRowid);
      if (picked > 0) {
        photoNote = `📸 *${picked} photo(s) auto-attached.*\n`;
      }
    }
    return msg.reply(
      '*✅ Material Added!*\n\n' +
      photoNote +
      `📦 *Material:* ${entry.materialName}\n` +
      `📂 *Category:* ${entry.category}\n` +
      `📊 *Quantity:* ${entry.quantity} ${entry.unit}\n` +
      (entry.supplier ? `🏭 *Supplier:* ${entry.supplier}\n` : '') +
      (entry.poNumber ? `📄 *PO Number:* ${entry.poNumber}\n` : '') +
      (entry.location ? `📍 *Location:* ${entry.location}\n` : '') +
      (entry.receivedBy ? `👤 *Received by:* ${entry.receivedBy}\n` : '')
    );
  } catch (error) {
    console.error('Error adding material:', error);
    return msg.reply('*❌ Error adding material. Please try again.*');
  }
}

// Handle deletematerial command
export async function handleDeleteMaterial(msg, args) {
  const id = parseInt(args[0]);
  if (!id) {
    return msg.reply('*Usage:* .deletematerial [id]');
  }
  
  try {
    const result = materialsDB.delete(id);
    if (result.changes > 0) {
      return msg.reply(`*✅ Material #${id} deleted.*`);
    }
    return msg.reply(`*Material #${id} not found.*`);
  } catch (error) {
    console.error('Error deleting material:', error);
    return msg.reply('*❌ Error deleting material.*');
  }
}
