import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import './scripts/wa-patch.js';
import qrcode from 'qrcode-terminal';
import { existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { isAdmin, buildHelpMessage } from './src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import handlers
import { handleProgress, handleAddProgress, handleDeleteProgress } from './src/handlers/progress.js';
import { handleMaterials, handleStock, handleAddMaterial, handleDeleteMaterial } from './src/handlers/materials.js';
import { handleIssues, handleAddIssue, handleResolve, handleAssign, handleUpdatePriority } from './src/handlers/issues.js';
import { 
  handleDiary, handleAddDiary, 
  handleAttendance, handleAddAttendance,
  handleWorkOrders, handleAddWorkOrder,
  handleMilestones, handleAddMilestone 
} from './src/handlers/diary.js';
import { handleDailyReport, handleWeeklyReport, handleStockReport } from './src/handlers/reports.js';
import { handlePhoto, handleAttach, handlePhotoInfo, setBotClient } from './src/handlers/photos.js';

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    🏗️  SITE BOT v1.0  🏗️                     ║
║              WhatsApp Construction Site Manager              ║
╚══════════════════════════════════════════════════════════════╝
`);

// Helper: return first line for compact logging
function firstLineOf(text) {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.substring(0, idx);
}

// Clean any stale auth locks left by force-killed processes (prevents EBUSY crash)
const authDir = './.wwebjs_auth';
try {
  if (existsSync(authDir)) {
    const lockFile = `${authDir}/session/lockfile`;
    if (existsSync(lockFile)) {
      rmSync(lockFile, { force: true });
      console.log('🧹 Removed stale session lockfile');
    }
  }
} catch (e) {
  // ignore - auth may not exist yet
}

// Cached group name, refreshed whenever the chat is successfully found
let lastKnownGroupName = config.siteGroupName;

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth'
  }),
  restartOnAuthFail: false,
  authTimeoutMs: 120000,
  puppeteer: {
    headless: true,
    protocolTimeout: 90000,
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run'
    ]
  }
});

// Every send (msg.reply included) routes through client.sendMessage - queue
// them with a short random gap so bursts don't look robotic to WhatsApp.
// ponytail: one global queue; per-chat queues if we ever serve >1 chat
const rawSend = client.sendMessage.bind(client);
let sendChain = Promise.resolve();
client.sendMessage = (...args) => {
  const p = sendChain.then(async () => {
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1500));
    return rawSend(...args);
  });
  sendChain = p.catch(() => {});
  return p;
};

// QR Code generation - terminal only, no browser window
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
  console.log('    WhatsApp > Linked Devices > Link a Device\n');
  qrcode.generate(qr, { small: true }, (qrAscii) => {
    console.log(qrAscii);
  });
  console.log('\nQR refreshes every ~20s if it expires - just scan the newest one.\n');
});

// Auth success
client.on('authenticated', () => {
  console.log('✅ Authentication successful!');
});

// Loading screen progress
client.on('loading_screen', (percent, msg) => {
  console.log(`⏳ Loading WhatsApp Web: ${percent}% ${msg || ''}`);
});

// Auth failure
client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
  process.exit(1);
});

// Client ready
let announcedReady = false;
let siteGroupId = null; // cached SiteMate chat id (serialized)
const readyWaitTimer = setInterval(() => {
  console.log('⏰ Still waiting for ready... (scan the QR if shown)');
}, 60000);

// ── Session health watchdog ──────────────────────────────────────────────
// If 'ready' never fires within a sane window, the stored session is stale
// (WhatsApp silently revoked it). We can't delete locked files from inside
// the running process on Windows (EPERM), so we exit with code 2 and the
// run.bat wrapper wipes the session and shows a fresh QR on next start.
// NOTE: only expires if NO QR was shown recently - so a user mid-scan is
// never interrupted.
let lastQrAt = 0;
const SESSION_STATUSCHECK_MS = 4 * 60 * 1000; // 4 min (generous while scanning)
let sessionStaleTimer = null;
let sessionFresh = false;

client.on('qr', (qr) => {
  lastQrAt = Date.now();
});

function startSessionWatchdog() {
  console.log(`🔍 Session health check: QR shown within last 60s is always kept alive. Timeout: ${SESSION_STATUSCHECK_MS / 1000}s.`);
  const check = async () => {
    if (sessionFresh) return;
    if (Date.now() - lastQrAt < 60000) {
      console.log('ℹ️  QR was shown recently - keeping bot alive for you to scan. Checking again later...');
      sessionStaleTimer = setTimeout(check, 60000);
      return;
    }
    console.log('\n⚠️  Session restore timed out (stale/revoked session) and no recent QR.');
    console.log('🔄 Exiting - run.bat will wipe the session and show a FRESH QR.');
    try { await client.destroy(); } catch (e) { /* ignore */ }
    process.exit(2); // exit code 2 = stale session, run.bat wipes + restarts
  };
  sessionStaleTimer = setTimeout(check, SESSION_STATUSCHECK_MS);
}

function stopSessionWatchdog() {
  if (sessionStaleTimer) clearTimeout(sessionStaleTimer);
  sessionFresh = true;
}

// ── Page health monitor ──────────────────────────────────────────────────
// whatsapp-web.js needs the WhatsApp Web page to answer calls (getChats,
// downloadMedia, etc.). Headless Chrome can wedge, making every internal
// call time out ("r", "Runtime.callFunctionOn timed out"). Probe the page
// periodically; if it stops responding, exit cleanly so the wrapper
// restarts the bot with a working page.
let pageHealthy = false;
let pageFailCount = 0;

async function probePage() {
  try {
    if (!client.pupPage) return;
    const probe = await Promise.race([
      client.pupPage.evaluate(() => 1 + 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 15000))
    ]);
    if (probe === 2) {
      if (!pageHealthy) console.log('💓 Page heartbeat OK - WhatsApp Web page is responsive.');
      pageHealthy = true;
      pageFailCount = 0;
    } else {
      throw new Error(`unexpected probe result: ${probe}`);
    }
  } catch (e) {
    pageFailCount++;
    if (pageHealthy || pageFailCount >= 3) {
      console.log(`⚠️  Page heartbeat FAILED (x${pageFailCount}): ${e.message} - WhatsApp Web page is wedged.`);
      pageHealthy = false;
      if (pageFailCount >= 3) {
        pageFailCount = 0;
        await wedgedExit();
      }
    }
  }
}

// Exit cleanly when the WhatsApp page is unresponsive - the run.bat
// wrapper restarts Chrome and keeps the session (no new QR / device link).
async function wedgedExit() {
  console.log('\n🧹 WhatsApp Web page is unresponsive - exiting so run.bat can restart it.');
  try { await client.destroy(); } catch (e) { /* ignore */ }
  process.exit(3); // exit code 3 = wedged page, run.bat restarts (session kept)
}

// Probe every 60s once we're connected (less page contention)
setInterval(probePage, 60000);

// Find & cache the target group's id. Strategy:
// 1. Resolve the group's real WhatsApp ID from the invite code (authoritative).
// 2. Fallback: case-insensitive name match.
// Returns true once the group is locked onto.
async function lockSiteGroup() {
  if (siteGroupId) return true;

  // ── Strategy 1: resolve via invite code ──────────────────────────────
  const inviteCode = config.siteGroupInvite
    ? config.siteGroupInvite.split('/').pop().split('?')[0].trim()
    : '';
  if (inviteCode) {
    try {
      const info = await client.getInviteInfo(inviteCode);
      const gid = info && (info.gid || (info.id && info.id._serialized));
      if (gid) {
        siteGroupId = String(gid);
        console.log(`✅ Locked onto SiteMate group via invite: "${info.title || config.siteGroupName}" (${siteGroupId})`);
        return true;
      }
      console.log(`⚠️  Invite resolved but no group id: ${JSON.stringify(info).slice(0, 200)}`);
    } catch (e) {
      console.log(`⚠️  Invite resolution failed: ${e.message || e} - falling back to name match`);
    }
  }

  // ── Strategy 2: name match (case-insensitive) ────────────────────────
  try {
    const chats = await client.getChats();
    const wanted = config.siteGroupName.toLowerCase().trim();

    // Log every group we can see so the match is easy to verify
    const groups = chats.filter(c => c.id && c.id._serialized && c.id._serialized.endsWith('@g.us'));
    console.log(`📋 Groups visible (${groups.length}): ${groups.map(g => JSON.stringify(g.name)).join(', ')}`);

    const target = groups.find(g => g.name && g.name.toLowerCase().trim() === wanted);
    if (target) {
      siteGroupId = target.id._serialized;
      console.log(`✅ Locked onto SiteMate group by name: "${target.name}" (${siteGroupId})`);
      return true;
    }
    console.log(`⏳ "${config.siteGroupName}" not found in visible groups yet - retrying...`);
  } catch (e) {
    console.log(`⚠️  getChats failed: ${e.message || e} - retrying...`);
  }
  return false;
}

// Keep trying to find the group until it is locked (slow retry - the
// expensive page calls compete with photo downloads).
const findGroupTimer = setInterval(async () => {
  if (siteGroupId) {
    clearInterval(findGroupTimer);
    return;
  }
  await lockSiteGroup();
}, 60000);

client.on('ready', async () => {
  clearInterval(readyWaitTimer);
  if (announcedReady) return; // internal reloads should not repeat the menu
  announcedReady = true;
  console.log('✅ Site Bot is ready!');
  stopSessionWatchdog();
  await lockSiteGroup();
  console.log(`👤 Admin numbers: ${config.adminNumbers.join(', ') || 'None configured'}`);
  console.log('\nCommands available:');
  console.log('  .help     - Show all commands');
  console.log('  .progress - Track site progress');
  console.log('  .materials - Track materials');
  console.log('  .issues   - Track issues');
  console.log('  .diary    - Site diary');
  console.log('  .dailyreport - Generate daily report');
  console.log('\nPress Ctrl+C to stop.\n');
});

// WhatsApp now identifies group senders by a hidden "@lid" id, not their
// phone number. Accept an id listed directly in ADMIN_NUMBERS, otherwise
// resolve it to the phone number. Only called for admin-only commands.
async function senderIsAdmin(msg) {
  const id = msg.author || msg.from;
  if (isAdmin(id)) return true;
  try {
    const [res] = await client.getContactLidAndPhone([id]);
    return !!(res && res.pn) && isAdmin(res.pn);
  } catch (e) {
    console.log(`⚠️  Could not resolve sender phone for admin check: ${e.message || e}`);
    return false;
  }
}

// Message handler - ONLY reacts in the configured SiteMate group
client.on('message', async (msg) => {
  try {
    // Determine chat type from serialized ID - no DOM evaluation needed
    const isGroup = msg.from.includes('@g.us');
    const senderNumber = isGroup
      ? (msg.author || '').replace('@c.us', '').replace('@g.us', '')
      : msg.from.replace('@c.us', '').replace('@g.us', '');
    const senderName = (msg._data && (msg._data.notifyName || msg._data.pushname)) || senderNumber;

    // STRICT RULE: only react inside the SiteMate group (matched by ID at ready).
    // Ignore personal chats AND any other group, regardless of admin status.
    // Nothing from other chats is logged - the linked phone's personal messages stay private.
    if (!siteGroupId || msg.from !== siteGroupId) {
      return;
    }

    // Log site-group messages so we always see activity in the terminal
    console.log(`[${new Date().toLocaleTimeString()}] 📩 MSG from=${senderName} type=${msg.type} body="${(msg.body || '').slice(0, 60)}"`);

    // Check for command prefix AFTER group check (no work for ignored chats)
    const messageBody = (msg.body || '').trim();
    const isCommand = messageBody.startsWith('.');

    // Auto-record any photo sent in the group
    if (msg.hasMedia) {
      const result = await handlePhoto(msg);
      if (result && result.saved) {
        const saved = result.saved;
        console.log(`📸 Photo saved by ${senderName}: ${config.photoBucket}/${saved.path}`);
        // React instead of replying - one text message per photo is a burst
        // of automated sends. .photo still shows the saved path.
        if (!isCommand) {
          await msg.react('📸');
        }
      } else if (result && result.error) {
        await msg.reply(
          `⚠️ *Couldn't save that photo.* (${result.error})\n` +
          `Try sending it again, or make sure it's a regular image.`
        );
      }
    }

    if (!isCommand) {
      return; // Not a command
    }

    // Log what we receive so it's easy to see activity in the terminal
    const cmdLine = firstLineOf(messageBody);
    console.log(`[${new Date().toLocaleTimeString()}] ${isGroup ? `[$GROUP ${msg.from}]` : '[DM]'} ${senderName}: ${cmdLine}`);
    
    // Parse command and arguments
    const lines = messageBody.split('\n');
    const firstLine = lines[0].split(' ');
    const command = firstLine[0].toLowerCase().replace('.', '');
    const args = firstLine.slice(1);
    
    console.log(`[${new Date().toLocaleTimeString()}] Command: ${command} from ${senderName}`);
    
    // Command routing
    switch (command) {
      // Help
      case 'help':
      case 'menu':
        await msg.reply(buildHelpMessage());
        break;
        
      // Progress commands
      case 'progress':
      case 'prog':
        await handleProgress(msg, args);
        break;
        
      case 'addprogress':
      case 'addprog':
        await handleAddProgress(msg, messageBody);
        break;
        
      case 'deleteprogress':
      case 'delprog':
        if (!(await senderIsAdmin(msg))) {
          await msg.reply('*Admin only command.*');
          break;
        }
        await handleDeleteProgress(msg, args);
        break;
        
      // Materials commands
      case 'materials':
      case 'material':
      case 'mat':
        await handleMaterials(msg, args);
        break;
        
      case 'stock':
        await handleStock(msg);
        break;
        
      case 'addmaterial':
      case 'addmat':
        await handleAddMaterial(msg, messageBody);
        break;
        
      case 'deletematerial':
      case 'delmat':
        if (!(await senderIsAdmin(msg))) {
          await msg.reply('*Admin only command.*');
          break;
        }
        await handleDeleteMaterial(msg, args);
        break;
        
      // Issues commands
      case 'issues':
      case 'issue':
        await handleIssues(msg, args);
        break;
        
      case 'addissue':
        await handleAddIssue(msg, messageBody);
        break;
        
      case 'resolve':
        await handleResolve(msg, args);
        break;
        
      case 'assign':
        await handleAssign(msg, args);
        break;
        
      case 'updatepriority':
        await handleUpdatePriority(msg, args);
        break;
        
      case 'issuestats':
        await handleIssues(msg, ['stats']);
        break;
        
      // Diary commands
      case 'diary':
        await handleDiary(msg, args);
        break;
        
      case 'adddiary':
        await handleAddDiary(msg, messageBody);
        break;
        
      // Attendance commands
      case 'attendance':
      case 'att':
        await handleAttendance(msg, args);
        break;
        
      case 'addattendance':
      case 'addatt':
        await handleAddAttendance(msg, messageBody);
        break;
        
      // Work orders
      case 'workorders':
      case 'wo':
        await handleWorkOrders(msg, args);
        break;
        
      case 'addworkorder':
      case 'addwo':
        await handleAddWorkOrder(msg, messageBody);
        break;
        
      // Milestones
      case 'milestones':
      case 'milestone':
        await handleMilestones(msg, args);
        break;
        
      case 'addmilestone':
        await handleAddMilestone(msg, messageBody);
        break;
        
      // Reports
      case 'dailyreport':
      case 'dr':
        await handleDailyReport(msg);
        break;
        
      case 'weeklyreport':
      case 'wr':
        await handleWeeklyReport(msg);
        break;
        
      case 'stockreport':
        await handleStockReport(msg);
        break;

      // Photo commands
      case 'photo':
      case 'photos':
        await handlePhotoInfo(msg);
        break;

      case 'attach':
        await handleAttach(msg, args);
        break;

      // Unknown command
      default:
        // Don't respond to unknown commands to avoid spam
        break;
    }
    
  } catch (error) {
    console.error('Error handling message:', error);
    // Don't send error messages to avoid spam
  }
});

// Disconnected
let reconnecting = false;
client.on('disconnected', (reason) => {
  if (reconnecting) return;
  reconnecting = true;
  console.log('⚡ Disconnected:', reason);
  if (reason === 'LOGOUT') {
    console.log('🔓 Session ended, waiting for new QR scan...');
  } else {
    console.log('🔄 Reconnecting in 5 seconds...');
  }
  setTimeout(() => {
    client.initialize().catch(() => {
      console.log('⚠️ Reconnect attempt failed - restart the bot.');
    });
    reconnecting = false;
  }, 5000);
});

// Initialize
console.log('🔄 Initializing WhatsApp client...');
setBotClient(client);
startSessionWatchdog();
client.initialize();

// Graceful shutdown
async function gracefulShutdown() {
  console.log('\n🛑 Shutting down Site Bot...');
  try {
    await client.destroy();
  } catch (e) {
    console.log('Session cleanup skipped:', e.message);
  }
  console.log('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
