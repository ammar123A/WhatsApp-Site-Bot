import { progressDB } from '../database.js';
import { getToday, parseArgs, parseDate, buildProgressMessage, buildProgressSummaryMessage, getWeekStart, getMonthStart, getDayName, formatDate, replyWithPhoto, replyListWithPhotos, getRecordPhotos, getSenderName } from '../utils.js';
import { attachPendingPhotos, getPhotoBatchSize } from './photos.js';
import { pendingCount } from './files.js';
import config from '../../config.js';

// Handle progress commands
export async function handleProgress(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  const wantsSummary = args.some((arg) => /^(summary|summar(y|ise)|full|report|detail|details)$/i.test(String(arg)));
  const buildMessage = wantsSummary ? buildProgressSummaryMessage : buildProgressMessage;

  if (!subCommand || subCommand === 'today') {
    const today = getToday();
    const entries = await progressDB.getByDate(today);
    const msg_text = entries.length > 0
      ? buildMessage(entries)
      : '*No progress recorded today.*\n\nUse .addprogress to add entry.';
    // Summary text + every photo attached to today's progress entries.
    return replyListWithPhotos(msg, msg_text, entries, 'Progress');
  }

  if (subCommand === 'week') {
    const weekStart = getWeekStart();
    const today = getToday();
    const entries = await progressDB.getByDateRange(weekStart, today);
    const msg_text = entries.length > 0
      ? `*📊 WEEKLY PROGRESS (${weekStart} - ${today})*\n\n` + buildMessage(entries)
      : '*No progress recorded this week.*';
    return replyListWithPhotos(msg, msg_text, entries, 'Progress');
  }

  if (subCommand === 'month') {
    const monthStart = getMonthStart();
    const today = getToday();
    const entries = await progressDB.getByDateRange(monthStart, today);
    const msg_text = entries.length > 0
      ? `*📊 MONTHLY PROGRESS (${monthStart} - ${today})*\n\n` + buildMessage(entries)
      : '*No progress recorded this month.*';
    return replyListWithPhotos(msg, msg_text, entries, 'Progress');
  }

  // View a single entry by numeric id (includes attached photo).
  // If the command itself came as a photo caption, auto-link that photo.
  if (/^\d+$/.test(subCommand)) {
    const entry = await progressDB.getById(parseInt(subCommand));
    if (entry) {
      if (msg.hasMedia) {
        const picked = await attachPendingPhotos(progressDB, entry.id, msg.from);
        console.log(`  → auto-attached ${picked} photo(s) to progress #${entry.id} (caption command)`);
      }
      const freshEntry = await progressDB.getById(entry.id);
      let msg_text = `*📋 PROGRESS #${freshEntry.id}*\n\n`;
      msg_text += `📝 Description: ${freshEntry.description}\n`;
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
    return replyListWithPhotos(msg, buildMessage(entries), entries, 'Progress');
  }

  return msg.reply(`*No progress found for ${dateStr}.*`);
}

// Handle addprogress command
//
// Kept deliberately tiny: a photo, a description, an optional location.
// No Work/Category, no Percentage, no Reported By - the reporter is taken
// from the WhatsApp profile of whoever sent it.
export async function handleAddProgress(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  const description = args.description || args.update || args.note || args['site update'];
  const location = args.location || args['which site'] || args.area;
  const photos = getPhotoBatchSize(msg.from);
  const hasEvidence = photos > 0 || pendingCount(msg.from) > 0;

  if (!hasEvidence) {
    return msg.reply('*Gambar atau file bukti diperlukan.* Hantar evidence dulu sebelum progress direkod.');
  }

  if (!description) {
    return msg.reply(
      '*Usage:* `.addprogress`\n\n' +
      'Just a description (photo optional but recommended):\n' +
      '```\n' +
      '.addprogress\n' +
      'Description: pasang paip atas bumbung dah siap\n' +
      'Location: Blok A\n' +
      '```\n\n' +
      '_Atau hantar gambar + caption `.addprogress Description: ...` - gambar auto attach._\n' +
      '_Reported by memang bot detect sendiri._'
    );
  }

  const entry = {
    date: getToday(),
    category: args.work || args.category || 'Site Update',
    description,
    percentage: 0,
    location,
    reportedBy: getSenderName(msg),
    photo: null
  };

  try {
    const result = await progressDB.add(entry);
    let picked = 0;
    if (msg.hasMedia || photos > 0) {
      picked = await attachPendingPhotos(progressDB, result.lastInsertRowid, msg.from);
    }
    console.log(
      `✅ progress #${result.lastInsertRowid} by ${entry.reportedBy || 'user'}` +
      (picked ? ` with ${picked} photo(s)` : ' (no photo)')
    );
    return null;
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
