import config from '../config.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;
import { existsSync } from 'fs';
import { resolve } from 'path';

// Return the array of photo paths attached to a record.
// Handles both the legacy single-path `photo` column and the newer
// `photos` JSON array column (which takes precedence).
export function getRecordPhotos(entry) {
  if (!entry) return [];
  if (entry.photos) {
    try {
      const parsed = JSON.parse(entry.photos);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (e) { /* not JSON - treat as legacy trash */ }
  }
  return entry.photo ? [entry.photo] : [];
}

// Reply with text + the record's attached photo(s).
// `photos` may be a single path or an array of paths.
// - Single photo: photo carries the record text as its caption (as before).
// - Multiple photos: pictures are sent first (bare), then the record text
//   is sent as a separate, tidy message.
// Falls back to text-only if none of the photos exist/readable.
// Library media sends are fixed via scripts/wa-patch.js (strips the media
// model's __x_id sentinel and tolerates the MsgKey._serialized -> $1 rename);
// the page-upload fallback below is kept as a safety net only.
export async function replyWithPhoto(msg, text, photos) {
  const list = Array.isArray(photos)
    ? photos
    : (photos ? [photos] : []);
  const existing = list
    .filter(Boolean)
    .filter(p => existsSync(resolve(process.cwd(), p)));

  if (existing.length === 0) {
    return msg.reply(text);
  }

  const chatId = msg.from || msg.to;

  // Multi-photo: pictures first, text after, in its own message.
  if (existing.length > 1) {
    for (const abs of existing) {
      try {
        const media = MessageMedia.fromFilePath(abs);
        await msg.client.sendMessage(chatId, media, { linkPreview: false });
      } catch (e) {
        console.log(`  ⚠️ Photo send failed (${e.message || e}).`);
      }
    }
    return msg.reply(text);
  }

  // Single photo - caption mode (matches old behaviour).
  const first = existing[0];
  try {
    const media = MessageMedia.fromFilePath(first);
    await msg.client.sendMessage(chatId, media, { caption: text, linkPreview: false });
  } catch (e) {
    console.log(`  ⚠️ Library send failed (${e.message || e}) - trying UI upload...`);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    try {
      const uiResult = await sendPhotoViaUI(msg.client, first, text);
      if (uiResult && uiResult.withCaption) {
        console.log('  ✅ Sent via UI upload fallback (with caption).');
      } else if (uiResult && uiResult.sent) {
        console.log('  ✅ Sent photo via UI upload fallback - sending text separately.');
        await msg.reply(text);
      }
    } catch (uiErr) {
      console.log(`  ⚠️ UI upload failed (${uiErr.message || uiErr}) - sending text only.`);
      await msg.reply(text);
    }
  }
}

// Simulate a real user: attach file in WhatsApp Web UI, caption it, send.
async function sendPhotoViaUI(client, absPath, caption) {
  const page = client.pupPage;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const sendVisible = async () => page.evaluate(() => {
    const sel = 'span[data-icon="send"], [data-icon="send"], button[aria-label="Send"], div[aria-label="Send"], [data-testid="send"]';
    return !!document.querySelector(sel);
  }).catch(() => false);

  const previewVisible = async () => page.evaluate(() => {
    const sel = '[data-testid="preview-drawer"], [data-testid="preview-drawer-"], [role="dialog"] div[contenteditable="true"]';
    return !!document.querySelector(sel);
  }).catch(() => false);

  const attachmentsReady = async () => (await sendVisible()) || (await previewVisible());

  // Try EVERY file input until the attachment UI actually appears -
  // the wrong first input silently attaches nothing.
  const inputs = await page.$$('input[type=file]');
  if (!inputs.length) throw new Error('no file inputs on page');
  console.log(`  (found ${inputs.length} file input(s), trying each...)`);

  let attached = false;
  for (const input of inputs) {
    try {
      await input.uploadFile(absPath);
    } catch (e) {
      console.log(`  (upload via an input failed: ${e.message || e})`);
      continue;
    }
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      if (await attachmentsReady()) { attached = true; break; }
    }
    if (attached) break;
  }
  if (!attached) {
    // Diagnostic dump so we can see the real DOM state
    const state = await page.evaluate(() => ({
      inputs: Array.from(document.querySelectorAll('input[type=file]')).map(i => ({
        accept: i.accept, testid: i.getAttribute('data-testid'), aria: i.getAttribute('aria-label')
      })),
      icons: Array.from(document.querySelectorAll('[data-icon]')).map(e => e.getAttribute('data-icon')).slice(0, 15),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      contenteditable: document.querySelectorAll('div[contenteditable="true"]').length,
    })).catch((e) => ({ evalError: String(e && e.message || e) }));
    console.log('  ⚠️ UI attach failed - DOM state:', JSON.stringify(state));
    throw new Error('media not attached (send UI never appeared)');
  }

  // Caption inside the preview panel's composer.
  const captionSel = [
    'footer div[contenteditable="true"]',
    '[data-testid="preview-drawer"] div[contenteditable="true"]',
    'div[data-animate-modal-body] div[contenteditable="true"]',
    'div[role="dialog"] div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label]'
  ];
  let captionOk = false;
  for (const sel of captionSel) {
    try {
      const box = await page.$(sel);
      if (box) {
        await box.click();
        await sleep(300);
        if (caption) {
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (el) el.focus();
          }, sel);
          await page.keyboard.type(caption, { delay: 3 });
          await sleep(400);
        }
        captionOk = true;
        break;
      }
    } catch (e) {
      console.log(`  (caption selector ${sel} failed: ${e.message || e})`);
    }
  }
  if (!captionOk) console.log('  (no caption box found - sending photo without caption)');

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('span[data-icon="send"], [data-icon="send"], button[aria-label="Send"], div[aria-label="Send"], [data-testid="send"]');
    if (btn) {
      (btn.closest('button') || btn.parentElement || btn).click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (!clicked) {
    await page.keyboard.press('Enter');
  }

  await sleep(3500);
  return { sent: true, withCaption: captionOk };
}

// Get today's date in DD/MM/YYYY format
export function getToday() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

// Get current time
export function getCurrentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// Get day name
export function getDayName() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date().getDay()];
}

// Parse date from DD/MM/YYYY format
export function parseDate(dateStr) {
  if (!dateStr) return getToday();
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return dateStr; // Already in correct format
  }
  return getToday();
}

// Get start of week (Monday)
export function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  const dayStr = String(monday.getDate()).padStart(2, '0');
  const monthStr = String(monday.getMonth() + 1).padStart(2, '0');
  return `${dayStr}/${monthStr}/${monday.getFullYear()}`;
}

// Get start of month
export function getMonthStart() {
  const now = new Date();
  const dayStr = String(now.getDate()).padStart(2, '0');
  const monthStr = String(now.getMonth() + 1).padStart(2, '0');
  return `01/${monthStr}/${now.getFullYear()}`;
}

// Format date for display
export function formatDate(dateStr) {
  if (!dateStr) return '-';
  return dateStr;
}

// Check if number is admin
export function isAdmin(phoneNumber) {
  const cleanNumber = (phoneNumber || '').replace(/[^0-9]/g, '');
  if (!cleanNumber) return false; // ''.endsWith check below would match every admin
  return config.adminNumbers.some(admin => {
    const cleanAdmin = admin.replace(/[^0-9]/g, '');
    return cleanNumber.endsWith(cleanAdmin) || cleanAdmin.endsWith(cleanNumber);
  });
}

// Extract phone number from WhatsApp message
export function extractPhone(contact) {
  if (contact.id && contact.id._serialized) {
    return contact.id._serialized.replace('@c.us', '').replace('@g.us', '');
  }
  return '';
}

// Parse key-value arguments from message
export function parseArgs(text, startFrom = 1) {
  const args = text.split('\n').slice(startFrom).map(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      return {
        key: line.substring(0, colonIndex).trim().toLowerCase(),
        value: line.substring(colonIndex + 1).trim()
      };
    }
    return null;
  }).filter(Boolean);
  
  return args.reduce((acc, { key, value }) => {
    acc[key] = value;
    return acc;
  }, {});
}

// Build progress report message
export function buildProgressMessage(entries) {
  if (entries.length === 0) return '*No progress entries found.*';
  
  let msg = '*📋 SITE PROGRESS REPORT*\n';
  msg += `_${getDayName()}, ${getToday()}_\n\n`;
  
  let totalPercentage = 0;
  entries.forEach((entry, i) => {
    totalPercentage += entry.percentage || 0;
    msg += `*[${entry.category}]* ${entry.percentage}%\n`;
    msg += `> ${entry.description}\n`;
    if (entry.location) msg += `📍 ${entry.location}\n`;
    if (entry.reported_by) msg += `👤 ${entry.reported_by}\n`;
    msg += '\n';
  });
  
  if (entries.length > 0) {
    const avgPercentage = (totalPercentage / entries.length).toFixed(1);
    msg += `_Average Progress: ${avgPercentage}%_\n`;
  }
  
  return msg;
}

// Build materials report message
export function buildMaterialsMessage(entries) {
  if (entries.length === 0) return '*No material entries found.*';
  
  let msg = '*📦 MATERIALS RECEIVED*\n';
  msg += `_${getDayName()}, ${getToday()}_\n\n`;
  
  entries.forEach((entry, i) => {
    msg += `*[${entry.category}]* ${entry.material_name}\n`;
    msg += `> ${entry.quantity} ${entry.unit}\n`;
    if (entry.supplier) msg += `🏭 Supplier: ${entry.supplier}\n`;
    if (entry.po_number) msg += `📄 PO: ${entry.po_number}\n`;
    if (entry.location) msg += `📍 Location: ${entry.location}\n`;
    if (entry.received_by) msg += `👤 Received by: ${entry.received_by}\n`;
    msg += '\n';
  });
  
  return msg;
}

// Build issues report message
export function buildIssuesMessage(issues) {
  if (issues.length === 0) return '*No issues found.*';
  
  const priorityEmoji = {
    urgent: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢'
  };
  
  const statusEmoji = {
    open: '⬜',
    in_progress: '🔄',
    resolved: '✅',
    closed: '🔒'
  };
  
  let msg = '*⚠️ SITE ISSUES*\n';
  msg += `_${getDayName()}, ${getToday()}_\n\n`;
  
  issues.forEach(issue => {
    msg += `${priorityEmoji[issue.priority] || '⚪'} *#${issue.id} ${issue.title}*\n`;
    msg += `${statusEmoji[issue.status] || '❓'} Status: ${issue.status.replace('_', ' ').toUpperCase()}\n`;
    msg += `📂 Category: ${issue.category}\n`;
    if (issue.location) msg += `📍 Location: ${issue.location}\n`;
    if (issue.assigned_to) msg += `👤 Assigned: ${issue.assigned_to}\n`;
    msg += '\n';
  });
  
  return msg;
}

// Build stock summary
export function buildStockSummary(stocks) {
  if (stocks.length === 0) return '*No stock data found.*';
  
  let msg = '*📊 STOCK SUMMARY*\n\n';
  
  const grouped = {};
  stocks.forEach(s => {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  });
  
  for (const [category, items] of Object.entries(grouped)) {
    msg += `*${category}*\n`;
    items.forEach(item => {
      msg += `> ${item.material_name}: ${item.total_qty} ${item.unit}\n`;
    });
    msg += '\n';
  }
  
  return msg;
}

// Build issue stats
export function buildIssueStats(stats) {
  let msg = '*📈 ISSUE STATISTICS*\n\n';
  msg += `Total Issues: ${stats.total}\n`;
  msg += `⬜ Open: ${stats.open}\n`;
  msg += `🔄 In Progress: ${stats.in_progress}\n`;
  msg += `✅ Resolved: ${stats.resolved}\n`;
  msg += `🔒 Closed: ${stats.closed}\n\n`;
  
  if (stats.urgent_open > 0) {
    msg += `🔴 *URGENT OPEN: ${stats.urgent_open}*\n`;
  }
  if (stats.high_open > 0) {
    msg += `🟠 *HIGH PRIORITY OPEN: ${stats.high_open}*\n`;
  }
  
  return msg;
}

// Build diary report
export function buildDiaryMessage(diary) {
  if (!diary) return '*No diary entry found.*';
  
  let msg = '*📒 SITE DIARY*\n';
  msg += `_${diary.date}_\n\n`;
  
  if (diary.weather) msg += `☁️ Weather: ${diary.weather}\n`;
  if (diary.temperature) msg += `🌡️ Temperature: ${diary.temperature}\n`;
  if (diary.visitors) msg += `👥 Visitors: ${diary.visitors}\n`;
  if (diary.general_notes) msg += `\n📝 *General Notes:*\n${diary.general_notes}\n`;
  if (diary.safety_notes) msg += `\n🦺 *Safety Notes:*\n${diary.safety_notes}\n`;
  
  return msg;
}

// Build help message
export function buildHelpMessage() {
  let msg = '*🤖 SITE BOT COMMANDS*\n\n';
  
  msg += '*📝 Progress Tracking*\n';
  msg += '> .progress - Today\'s progress\n';
  msg += '> .progress [DD/MM/YYYY] - Progress on specific date\n';
  msg += '> .progress week - This week\'s progress\n';
  msg += '> .progress month - This month\'s progress\n';
  msg += '> .addprogress - Add progress entry\n';
  msg += '```\n.addprogress\nCategory: Civil\nDescription: Foundation work done 50%\nPercentage: 50\nLocation: Block A\nBy: Contractor A\n```\n\n';
  
  msg += '*📦 Materials*\n';
  msg += '> .materials - Today\'s materials\n';
  msg += '> .stock - Current stock summary\n';
  msg += '> .addmaterial - Add material entry\n';
  msg += '```\n.addmaterial\nName: Cement\nCategory: Cement\nQuantity: 100\nUnit: bags\nSupplier: ABC Corp\nPO: PO-001\nLocation: Store\nBy: John\n```\n\n';
  
  msg += '*⚠️ Issues*\n';
  msg += '> .issues - Open issues\n';
  msg += '> .issues all - All issues\n';
  msg += '> .issuestats - Issue statistics\n';
  msg += '> .addissue - Report issue\n';
  msg += '```\n.addissue\nTitle: Water leak\nDescription: Leak at 2nd floor\nCategory: MEP\nPriority: high\nLocation: Block A L2\nBy: Site Engineer\n```\n';
  msg += '> .issue [id] - View one issue (with photos)\n';
  msg += '> .resolve [id] [resolution] - Mark resolved\n';
  msg += '> .assign [id] [name] - Assign issue\n';
  msg += '> .updatepriority [id] [low|medium|high|urgent]\n\n';

  msg += '*📸 Photos*\n';
  msg += '> Send photo(s) in the group - saved automatically\n';
  msg += '> .attach [progress|material|issue] [id] - Link recent photos\n';
  msg += '> .photo - Where the latest photo was saved\n';
  msg += '_Tip: send a photo with .addissue / .addprogress / .addmaterial as the caption to attach it directly._\n\n';
  
  msg += '*📒 Diary*\n';
  msg += '> .diary - Today\'s diary\n';
  msg += '> .adddiary - Update diary\n';
  msg += '```\n.adddiary\nWeather: Sunny\nTemp: 32C\nVisitors: Client PM\nNotes: Work progressing well\nSafety: All PPE in use\n```\n\n';
  
  msg += '*👷 Attendance*\n';
  msg += '> .attendance - Today\'s attendance count\n';
  msg += '> .addattendance - Add attendance\n';
  msg += '```\n.addattendance\nName: Ali\nContractor: ABC\nRole: Foreman\nHours: 9\nOT: 2\n```\n\n';
  
  msg += '*👷 Work Orders*\n';
  msg += '> .workorders - Pending work orders\n';
  msg += '> .addworkorder - Add work order\n\n';
  
  msg += '*📊 Reports*\n';
  msg += '> .dailyreport - Full daily report\n';
  msg += '> .weeklyreport - Weekly summary\n\n';
  
  msg += '*ℹ️ Other*\n';
  msg += '> .milestones - Project milestones\n';
  msg += '> .addmilestone - Add milestone\n';
  msg += '> .help - Show this message\n';
  
  return msg;
}
