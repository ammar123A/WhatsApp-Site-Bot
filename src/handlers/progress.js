import { progressDB } from '../database.js';
import { getToday, parseArgs, parseDate, buildProgressMessage, getWeekStart, getMonthStart, getDayName, formatDate, replyWithPhoto, getRecordPhotos } from '../utils.js';
import { attachPendingPhotos } from './photos.js';
import config from '../../config.js';

// Handle progress commands
export async function handleProgress(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'today') {
    const today = getToday();
    const entries = await progressDB.getByDate(today);
    const msg_text = entries.length > 0 
      ? buildProgressMessage(entries)
      : '*No progress recorded today.*\n\nUse .addprogress to add entry.';
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'week') {
    const weekStart = getWeekStart();
    const today = getToday();
    const entries = await progressDB.getByDateRange(weekStart, today);
    const msg_text = entries.length > 0
      ? `*📊 WEEKLY PROGRESS (${weekStart} - ${today})*\n\n` + buildProgressMessage(entries)
      : '*No progress recorded this week.*';
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'month') {
    const monthStart = getMonthStart();
    const today = getToday();
    const entries = await progressDB.getByDateRange(monthStart, today);
    const msg_text = entries.length > 0
      ? `*📊 MONTHLY PROGRESS (${monthStart} - ${today})*\n\n` + buildProgressMessage(entries)
      : '*No progress recorded this month.*';
    return msg.reply(msg_text);
  }
  
  // View a single entry by numeric id (includes attached photo).
  // If the command itself came as a photo caption, auto-link that photo.
  if (/^\d+$/.test(subCommand)) {
    const entry = await progressDB.getById(parseInt(subCommand));
    if (entry) {
      if (msg.hasMedia) {
        const picked = await attachPendingPhotos(progressDB, entry.id);
        console.log(`  → auto-attached ${picked} photo(s) to progress #${entry.id} (caption command)`);
      }
      const freshEntry = await progressDB.getById(entry.id);
      let msg_text = `*📋 PROGRESS #${freshEntry.id}*\n\n`;
      msg_text += `📂 Category: ${freshEntry.category}\n`;
      msg_text += `📝 Description: ${freshEntry.description}\n`;
      msg_text += `📊 Progress: ${freshEntry.percentage}%\n`;
      if (freshEntry.location) msg_text += `📍 Location: ${freshEntry.location}\n`;
      if (freshEntry.reported_by) msg_text += `👤 Reported by: ${freshEntry.reported_by}\n`;
      msg_text += `📅 Date: ${freshEntry.date}\n`;
      return replyWithPhoto(msg, msg_text, getRecordPhotos(freshEntry));
    }
    return msg.reply(`*Progress #${subCommand} not found.*`);
  }
  
  // Try to parse as date
  const dateStr = parseDate(subCommand);
  const entries = await progressDB.getByDate(dateStr);
  if (entries.length > 0) {
    return msg.reply(buildProgressMessage(entries));
  }
  
  return msg.reply(`*No progress found for ${dateStr}.*`);
}

// Handle addprogress command
export async function handleAddProgress(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.category || !args.description) {
    return msg.reply(
      '*Usage:* .addprogress\n\n' +
      'Format:\n' +
      '```\n' +
      '.addprogress\n' +
      'Category: Civil\n' +
      'Description: Foundation work\n' +
      'Percentage: 50\n' +
      'Location: Block A\n' +
      'By: Contractor A\n' +
      '```\n\n' +
      `*Categories:* ${config.categories.join(', ')}`
    );
  }
  
  const entry = {
    date: getToday(),
    category: args.category,
    description: args.description,
    percentage: parseFloat(args.percentage) || 0,
    location: args.location,
    reportedBy: args.by || args.reported,
    photo: null
  };
  
  try {
    const result = await progressDB.add(entry);
    let photoNote = '';
    if (msg.hasMedia) {
      const picked = await attachPendingPhotos(progressDB, result.lastInsertRowid);
      if (picked > 0) {
        photoNote = `📸 *${picked} photo(s) auto-attached.*\n`;
      }
    }
    return msg.reply(
      '*✅ Progress Added!*\n\n' +
      photoNote +
      `📋 *Category:* ${entry.category}\n` +
      `📝 *Description:* ${entry.description}\n` +
      `📊 *Progress:* ${entry.percentage}%\n` +
      (entry.location ? `📍 *Location:* ${entry.location}\n` : '') +
      (entry.reportedBy ? `👤 *Reported by:* ${entry.reportedBy}\n` : '')
    );
  } catch (error) {
    console.error('Error adding progress:', error);
    return msg.reply('*❌ Error adding progress. Please try again.*');
  }
}

// Handle deleteprogress command
export async function handleDeleteProgress(msg, args) {
  const id = parseInt(args[0]);
  if (!id) {
    return msg.reply('*Usage:* .deleteprogress [id]');
  }
  
  try {
    const result = await progressDB.delete(id);
    if (result.changes > 0) {
      return msg.reply(`*✅ Progress #${id} deleted.*`);
    }
    return msg.reply(`*Progress #${id} not found.*`);
  } catch (error) {
    console.error('Error deleting progress:', error);
    return msg.reply('*❌ Error deleting progress.*');
  }
}
