import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import './src/logger.js';
import './scripts/wa-patch.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import path, { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { isAdmin, buildHelpMessage } from './src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import handlers
import { handleProgress, handleAddProgress, handleDeleteProgress } from './src/handlers/progress.js';
import { handleMaterials, handleStock, handleAddMaterial, handleDeleteMaterial } from './src/handlers/materials.js';
import { handleIssues, handleAddIssue, handleResolve, handleAssign, handleUpdatePriority } from './src/handlers/issues.js';
import {
  handleAttendance, handleAddAttendance,
  handleWorkOrders, handleAddWorkOrder,
  handleMilestones, handleAddMilestone
} from './src/handlers/diary.js';
import { handleProjectSS, handleAddSS, handleSSAnswer } from './src/handlers/projectss.js';
import { handleEdit } from './src/handlers/edit.js';
import { handleDailyReport, handleWeeklyReport, handleStockReport } from './src/handlers/reports.js';
import { handlePhoto, handleAttach, handlePhotoInfo, setBotClient, getPhotoBatchSize } from './src/handlers/photos.js';
import { intakeFile, handleFiles, pendingCount, waitForActiveIntake } from './src/handlers/files.js';
import { isSaveableMedia } from './src/fileStore.js';
import { react, reactError, REACTIONS } from './src/reactions.js';
import { handleTaggedMessage, isSeparateRecordDescription } from './src/handlers/ai.js';
import { isMentioningBot, setBotId, getBotId, llmStatus } from './src/llm.js';
import { registerGroup, siteFor, listSites, allowGroup, blockGroup, isAllowedGroup, isBlockedGroup, allowGroupsFromEnv, listGroups, forgetGroup, forgetMissingGroups } from './src/sites.js';
import { ensureSiteSchema, runInSite, currentSite, chatLogDB, claimMonth, filesDB, savedSiteNameForGroup } from './src/database.js';
import { getToday, parseRecordDate } from './src/utils.js';
import { buildFilesMessage, replyFilesWithMedia } from './src/handlers/files.js';
import { startClaimScheduler, stopClaimScheduler } from './src/claimScheduler.js';
import { startReminderScheduler, stopReminderScheduler, hasPendingReminder, reminderConversationKey } from './src/reminders.js';

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

// Rolling buffer of recent messages, kept SEPARATE PER GROUP so a tagged
// question in one site group never gets answered using another site's chatter.
const contextBuffers = new Map();
const CONTEXT_LIMIT = 30;

function pushContext(groupId, author, text) {
  let buf = contextBuffers.get(groupId);
  if (!buf) {
    buf = [];
    contextBuffers.set(groupId, buf);
  }
  buf.push({ author, text });
  while (buf.length > CONTEXT_LIMIT) buf.shift();
  return buf;
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

// ── Site group allow-list persistence ────────────────────────────────────────
// `.site` claims a group at runtime, but the allow-list lives in memory, so a
// restart would silently un-claim it. Persist it to a small JSON file next to
// .env (never in git) and merge with SITE_GROUPS on boot.
const ALLOWED_FILE = 'site-groups.json';

function loadAllowedGroups() {
  if (!existsSync(ALLOWED_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ALLOWED_FILE, 'utf8'));
    return Array.isArray(parsed?.allowed) ? parsed.allowed.filter(Boolean) : [];
  } catch (e) {
    console.log(`⚠️  Could not read ${ALLOWED_FILE}: ${e.message}`);
    return [];
  }
}

function saveAllowedGroups(allowed) {
  try {
    writeFileSync(ALLOWED_FILE, JSON.stringify({ allowed }, null, 2));
  } catch (e) {
    console.log(`⚠️  Could not write ${ALLOWED_FILE}: ${e.message}`);
  }
}

/** Allow a group and remember it across restarts. */
function allowGroupPersistently(groupId) {
  allowGroup(groupId);
  const allowed = new Set([...loadAllowedGroups(), ...allowGroupsFromEnv(config.siteGroups), groupId]);
  saveAllowedGroups([...allowed]);
}

/**
 * The bot is no longer in a group (kicked / left it). Forget it completely:
 * drop it from the site registry, the allow-list, and the persisted file, so it
 * stops being served and stops showing up in any listing.
 */
function forgetGroupPersistently(groupId, how) {
  const known = forgetGroup(groupId);
  const remaining = [...loadAllowedGroups(), ...allowGroupsFromEnv(config.siteGroups)].filter(
    (id) => id !== groupId
  );
  saveAllowedGroups(remaining);
  console.log(
    `🚪 Left group ${groupId}${known?.name ? ` ("${known.name}")` : ''} (${how}) - no longer served or recorded.`
  );
}

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth'
  }),
  ...(config.pairPhoneNumber
    ? {
        // Login by phone number (pairing code) instead of QR scan.
        // WhatsApp phone: Linked devices > Link with phone number > tap your
        // companion device when it shows the 8-char code.
        pairWithPhoneNumber: {
          phoneNumber: config.pairPhoneNumber,
          showNotification: true,
          intervalMs: 20000,
        },
      }
    : {}),
  restartOnAuthFail: false,
  authTimeoutMs: 120000,
  puppeteer: {
    // Chrome headless is failing on the current Chrome build, while normal
    // visible Chrome launches and stays attached reliably on this machine.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    // Keep the browser window alive; the terminal remains visible as requested.
    headless: false,
    // Audio uploads through WhatsApp Web can take longer than normal text
    // sends. Keep enough time for the upload without changing our own retry
    // and recovery behaviour.
    protocolTimeout: 180000,
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

// Every send (msg.reply included) routes through client.sendMessage - queue them
// with a short gap so a BURST doesn't look robotic to WhatsApp.
//
// The gap only applies between messages. Before this, every send slept
// 1000-2500ms unconditionally, so even a single one-word reply waited 1-2.5s
// for nothing - "kerani took too long to reply". The first message in a burst
// now goes out immediately; only the messages after it are spaced.
const REPLY_GAP_MIN = 400;
const REPLY_GAP_MAX = 900;
// After this long with nothing sent, the next message opens a new burst and gets
// the full human pause. Inside a burst, replies stay snappy.
const TYPING_IDLE_MS = 12000;
const rawSend = client.sendMessage.bind(client);
let sendChain = Promise.resolve();
let lastSendAt = 0;
let pageRestartScheduled = false;

function isDetachedFrameError(error) {
  const details = [
    error?.message,
    error?.error?.message,
    error?.code,
    error?.target?.url,
    error?.target?._url,
    String(error || ''),
  ].filter(Boolean).join(' ');
  return /detached frame|target closed|session closed|execution context was destroyed|ECONNRESET|devtools\/browser|websocket.*(?:closed|error)|browser.*(?:disconnected|closed)/i.test(details);
}

function schedulePageRestart(error) {
  if (pageRestartScheduled) return;
  // Chrome can emit a DevTools ECONNRESET while it is still creating the page
  // during startup. Do not turn that normal launch race into a restart loop;
  // run.bat already owns startup retries. Only restart a page that had reached
  // an authenticated/ready state and then detached.
  if (!announcedReady) {
    console.error(`⚠️ WhatsApp startup WebSocket closed: ${error?.message || error}`);
    return;
  }
  pageRestartScheduled = true;
  console.error(`⚠️ WhatsApp page detached: ${error?.message || error}`);
  console.error('🔄 Scheduling a controlled restart; session will be kept.');
  setTimeout(() => {
    wedgedExit().catch(() => process.exit(3));
  }, 1200);
}

// A detached Puppeteer frame can surface as an unhandled rejection from the
// WhatsApp library, outside the normal message try/catch. Convert it into the
// same clean exit used by the heartbeat so run.bat can relaunch the page.
process.on('unhandledRejection', (error) => {
  if (isDetachedFrameError(error)) return schedulePageRestart(error);
  console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', (error) => {
  if (isDetachedFrameError(error)) return schedulePageRestart(error);
  console.error('Uncaught exception:', error);
  process.exitCode = 1;
});

/** Where a send is going, for the "typing..." presence update. */
function chatIdOf(arg) {
  if (typeof arg === 'string') return arg;
  return arg?.id?._serialized || arg?.from || arg?._serialized || null;
}

client.sendMessage = (...args) => {
  const p = sendChain.then(async () => {
    const chatId = chatIdOf(args[0]);
    const newBurst = !lastSendAt || Date.now() - lastSendAt > TYPING_IDLE_MS;

    if (config.humanTyping && chatId && newBurst) {
      // Show "typing..." for a few seconds before the first reply of a burst.
      // A machine that answers in 0.3s flat is exactly what Meta's spam heuristics
      // look for; a person takes a breath, types, then sends.
      try { await client.sendPresenceUpdate('composing', chatId); } catch {}
      const lo = config.typingDelayMinMs;
      const hi = Math.max(lo, config.typingDelayMaxMs);
      await new Promise(r => setTimeout(r, lo + Math.random() * (hi - lo)));
    } else {
      const readyAt = lastSendAt
        ? lastSendAt + REPLY_GAP_MIN + Math.random() * (REPLY_GAP_MAX - REPLY_GAP_MIN)
        : 0;
      const wait = readyAt - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }

    const res = await rawSend(...args);
    lastSendAt = Date.now();
    if (config.humanTyping && chatId) {
      try { await client.sendPresenceUpdate('paused', chatId); } catch {}
    }
    return res;
  }).catch((error) => {
    if (isDetachedFrameError(error)) schedulePageRestart(error);
    throw error;
  });
  sendChain = p.catch(() => {});
  return p;
};

// QR Code generation - terminal + scannable PNG (ASCII gets mangled on copy/paste)
const QR_PNG = 'qr-latest.png';
client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
  console.log('    WhatsApp > Linked Devices > Link a Device\n');
  qrcode.generate(qr, { small: true }, (qrAscii) => {
    console.log(qrAscii);
  });
  // Write a real PNG too so it can be scanned from an image viewer instead of
  // squinting at block characters (and so copy/paste can't corrupt it).
  QRCode.toFile(QR_PNG, qr, { width: 720, margin: 2 })
    .then(() => console.log(`\n🖼️  Scannable PNG: ${path.resolve(QR_PNG)}`))
    .catch((e) => console.log(`⚠️  QR PNG failed: ${e.message}`));
  console.log('\nQR refreshes every ~20s if it expires - just scan the newest one.\n');
});

// Pairing code login (phone number verification, no QR) when configured
client.on('code', (code) => {
  lastQrAt = Date.now(); // keep watchdog alive while the code is being entered
  console.log('\n🔑 LOGIN WITH PHONE NUMBER (no QR needed)\n');
  console.log('    On your phone: WhatsApp > Linked Devices > Link with phone number');
  console.log(`    Enter this 8-char code on the phone when asked:`);
  console.log(`\n    ${code}\n`);
  console.log('    Code refreshes every ~20s if it expires.\n');
});

// Auth success
client.on('authenticated', () => {
  console.log('✅ Authentication successful!');
});

// Keep nudging until the bot is actually serving.
//
// 'ready' is the ONLY event that matters, and it is easy to lose: whatsapp-web.js
// emits it only after its injected Utils.js has created window.WWebJS, and it
// silently gives up if that injection throws. On a restored session 'authenticated'
// may not even fire, so waiting for either event is not enough. Poll instead.
let readyRescueBusy = false;
const readyRescueTimer = setInterval(async () => {
  if (announcedReady || readyRescueBusy || !client.pupPage) return;
  readyRescueBusy = true;
  try {
    await diagnoseAndHeal();
  } catch (e) {
    console.log(`🔬 Diagnosis failed: ${e.message || e}`);
  } finally {
    readyRescueBusy = false;
  }
}, 20000);
const stopReadyRescue = () => clearInterval(readyRescueTimer);

/**
 * Report what the page actually has, and try to build WWebJS ourselves.
 *
 * Everything the bot does in the page - group lists, media download, REACTIONS -
 * goes through window.require and the WWebJS helpers, so "is this defined?" is
 * the single most useful thing to know when nothing is happening.
 */
async function diagnoseAndHeal() {
  if (!client.pupPage) return;

  const state = await client.pupPage.evaluate(() => ({
    href: location.href,
    hasRequire: typeof window.require === 'function',
    hasWWebJS: typeof window.WWebJS !== 'undefined',
    hasCollections: (() => {
      try {
        return typeof window.require('WAWebCollections') === 'object';
      } catch (e) {
        return false;
      }
    })(),
  })).catch((e) => ({ error: e.message }));

  console.log(`🔬 Page state: ${JSON.stringify(state)}`);

  if (state.hasWWebJS) {
    console.log('⚠️  WWebJS is present but "ready" never fired - completing startup by hand.');
    await completeClientStartup();
    startupVia = 'rescue';
    announcedReady = true;
    stopReadyRescue();
    try { stopSessionWatchdog(); } catch (e) { /* ignore */ }
    await onClientReady();
    return;
  }

  // WWebJS missing: run the library's own loader again and capture the error.
  console.log('🛠️  window.WWebJS is missing - re-running the library loader...');
  try {
    const { LoadUtils } = await import('whatsapp-web.js/src/util/Injected/Utils.js');
    await client.pupPage.evaluate(LoadUtils);
    const healed = await client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined');
    console.log(`🛠️  Loader re-run: WWebJS ${healed ? 'now present' : 'STILL missing'}`);
    if (healed) {
      await completeClientStartup();
      startupVia = 'rescue';
      announcedReady = true;
      stopReadyRescue();
      try { stopSessionWatchdog(); } catch (e) { /* ignore */ }
      await onClientReady();
    }
  } catch (e) {
    console.log(`🛠️  Loader re-run failed: ${e.message || e}`);
  }
}

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
// Every group we are in, mapped to the site it represents. No single locked
// group: the bot serves any group it has been invited to.
const readyWaitTimer = setInterval(() => {
  console.log('⏰ Still waiting for ready... (scan the QR if shown)');
}, 60000);

// ── Session health watchdog ──────────────────────────────────────────────
// If we never authenticate within a sane window, the stored session is stale
// (WhatsApp silently revoked it). We can't delete locked files from inside the
// running process on Windows (EPERM), so we exit with code 2 and the run.bat
// wrapper wipes the session and shows a fresh QR on next start.
//
// IMPORTANT: a successful scan is proof the session is GOOD. An earlier version
// only looked at "no recent QR", so a bot that authenticated fine but was slow
// to emit 'ready' wiped its own working session and forced a re-scan. Now an
// authenticated bot restarts the PAGE (code 3, session kept) instead of throwing
// the login away.
let lastQrAt = 0;
let authenticatedAt = 0;
const SESSION_STATUSCHECK_MS = 4 * 60 * 1000; // 4 min (generous while scanning)
let sessionStaleTimer = null;
let sessionFresh = false;

client.on('qr', (qr) => {
  lastQrAt = Date.now();
});

client.on('authenticated', () => {
  authenticatedAt = Date.now();
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

    // We got past the QR. The login is valid, so do NOT wipe it - restart the
    // page instead and keep the session.
    if (authenticatedAt) {
      const since = Math.round((Date.now() - authenticatedAt) / 1000);
      console.log(`\n⚠️  Authenticated ${since}s ago but 'ready' still has not fired.`);
      console.log('🔄 Restarting the WhatsApp page - session KEPT, no new QR needed.');
      try { await client.destroy(); } catch (e) { /* ignore */ }
      process.exit(3); // code 3 = restart page, session kept
    }

    console.log('\n⚠️  Never authenticated and no recent QR - session is stale/revoked.');
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

// Register every group we sit in, and work out which site each one is.
// There is no single locked group any more: the bot serves ANY group it has
// been invited to, so invite it to a new site group and it just works there.
// List the groups we are in, WITHOUT client.getChats().
//
// getChats() is unreliable here: internally it calls groupMetadata.update(),
// a network round-trip PER group, and if any single one rejects the whole
// promise fails with an opaque minified error ("r"). We only need each group's
// id and name, both of which are already in memory - so read them straight out
// of the Store instead of triggering network updates.
async function scanGroups() {
  let groups = [];
  try {
    groups = await client.pupPage.evaluate(() => {
      try {
        const Chat = window.require('WAWebCollections').Chat;
        return (Chat?.getModelsArray?.() || [])
          .filter((c) => c?.id?._serialized?.endsWith('@g.us'))
          .map((c) => ({
            id: c.id._serialized,
            name: c.formattedTitle || c.subject || c.name || c.groupMetadata?.subject || '',
          }));
      } catch (e) {
        return [{ __error: String(e?.message || e) }];
      }
    });
  } catch (e) {
    console.log(`⚠️  group scan failed: ${e.message || e}`);
    return;
  }

  const scanError = groups.find((g) => g.__error);
  if (scanError) {
    console.log(`⚠️  group scan error: ${scanError.__error}`);
    return;
  }

  // Only groups the bot actually serves are worth showing. Listing every group it
// sits in (family chats included) reads like it is serving them, and hides the
// ones that matter.
  const served = groups.filter((g) => isAllowedGroup(g.id));
  for (const g of served) {
    const info = registerGroup(g.id, g.name);
    if (info.renamed) {
      console.log(`🔄 Group "${info.name}" renamed - site is now "${info.site}"`);
    }
  }
  if (served.length) {
    console.log(
      `📋 Serving ${served.length} group(s): ` +
        served.map((g) => `"${g.name || '?'}" => ${siteFor(g.id) || '?'}`).join(', ')
    );
  }
  const muted = groups.filter((g) => !isAllowedGroup(g.id)).length;
  if (muted) console.log(`🔇 ${muted} other group(s) muted (not site groups)`);

  // Reconcile: any group we were serving but no longer see has had the bot
  // removed. Forget it so it is never recorded from again.
  const gone = forgetMissingGroups(groups.map((g) => g.id));
  for (const id of gone) {
    forgetGroupPersistently(id, 'no longer in group list');
  }
}

// The bot was removed from a group (kicked) or left it. Stop serving it at once
// instead of waiting for the next scan.
client.on('group-leave', async (chat) => {
  const gid = chat?.id?._serialized ?? chat?.id?.remote ?? chat?.id;
  if (!gid || !String(gid).includes('@g.us')) return;
  forgetGroupPersistently(String(gid), 'kicked or left');
});

// Being added to a group is not enough to start recording there - the group
// still has to be a known site group, otherwise the bot would begin filing site
// records into whatever chat invites it.
client.on('group_join', async (chat) => {
  const gid = chat?.id?._serialized ?? chat?.id?.remote ?? chat?.id;
  if (!gid || !String(gid).includes('@g.us')) return;
  const gidStr = String(gid);
  const name = chat?.name || chat?.formattedTitle || '(no name yet)';
  if (isAllowedGroup(gidStr)) {
    registerGroup(gidStr, name);
    console.log(`➕ Re-joined known site group "${name}" -> site "${siteFor(gidStr)}"`);
  } else {
    console.log(`➕ Added to "${name}" but staying silent - not a registered site group. Run .site there to enable.`);
  }
});

// Legacy alias - used by the ready handler.
async function lockSiteGroup() {
  // ── Strategy 1: resolve via invite code ──────────────────────────────
  const inviteCode = config.siteGroupInvite
    ? config.siteGroupInvite.split('/').pop().split('?')[0].trim()
    : '';
  if (inviteCode) {
    try {
      const info = await client.getInviteInfo(inviteCode);
      const gid = info && (info.gid || (info.id && info.id._serialized));
      if (gid) {
        registerGroup(String(gid), info.title || config.siteGroupName);
        console.log(`✅ Registered group via invite: "${info.title || config.siteGroupName}" -> site "${siteFor(String(gid))}"`);
      }
    } catch (e) {
      console.log(`⚠️  Invite resolution failed: ${e.message || e}`);
    }
  }
  await scanGroups();
}

// Keep the group list fresh so a newly created / renamed group is picked up
// without a restart (slow retry - page calls compete with photo downloads).
const findGroupTimer = setInterval(scanGroups, 60000);

/**
 * Everything that must happen once the client is usable.
 *
 * Split out of the 'ready' listener because 'ready' can fail to fire while the
 * page is actually fine - diagnoseAndHeal() then calls this directly so the bot
 * still starts serving instead of sitting there mute.
 */
/**
 * How did we get up? Worth saying out loud: the two paths behave very
 * differently, and "ready" from the rescue path is easy to mistake for a healthy
 * bot when it is not.
 *   'library' - whatsapp-web.js emitted 'ready' itself, so its own
 *               attachEventListeners() ran and the bot receives messages.
 *   'rescue'  - we rebuilt WWebJS and finished startup by hand.
 */
/**
 * Remember every message so the bot can recall it later.
 *
 * Fire-and-forget on purpose: a chat_log write must never delay or break a
 * reply, and the bot's own replies are excluded because they are not evidence of
 * what the site said.
 */
function rememberMessage(msg, siteName) {
  const body = String(msg.body || '').trim();
  if (!body) return;
  chatLogDB
    .add({
      date: getToday(),
      sender: msg._data?.notifyName || msg.author || 'unknown',
      senderId: String(msg.author || msg.from || ''),
      isBot: false,
      body: body.slice(0, 1000),
      kind: msg.hasMedia ? `${msg.type}+media` : msg.type || 'chat',
    })
    .catch((e) => console.log(`[memory] chat_log write failed: ${e.message || e}`));
}

let startupVia = null;

async function onClientReady() {
  clearInterval(readyWaitTimer);
  console.log(`✅ Site Bot is ready! (startup: ${startupVia || 'library'})`);
  console.log(`🧠 Brain: ${llmStatus()}`);
  // Load qwen into VRAM now so the first tagged message is not an 90s cold start.
  // Only warm Ollama when it is actually the brain. Loading qwen into VRAM while
// Gemini or Groq answers just steals memory from everything else on the PC.
if (config.llmProvider === 'local') {
  import('./src/llmLocal.js').then(({ warmLocal }) => warmLocal()).catch(() => {});
}

  // Do not pre-create one bucket per file category. Site files are stored in
  // the site's own bucket; category names are folders inside it, for example
  // `myself-group/photos/27-10-2026/...` and `myself-group/pdf/...`.
  // saveSiteFile() and the compile handler create the active site bucket on
  // demand once the group/site is known.
  stopSessionWatchdog();
  // Remember our own JID so "@167315484241950 ..." is recognised as a mention.
  await rememberOwnBotId();
  await lockSiteGroup();
  console.log(`👤 Admin numbers: ${config.adminNumbers.join(', ') || 'None configured'}`);

  // Which groups the bot serves. Anything not listed stays silent, because the
  // bot also sits in family/personal chats.
  const seeded = allowGroupsFromEnv(config.siteGroups);
  if (seeded.length) {
    console.log(`🏗️  Site groups allowed from SITE_GROUPS: ${seeded.join(', ')}`);
  } else {
    console.log('⚠️  SITE_GROUPS is empty - bot will stay silent until `.site` is run in a group.');
  }
  // Restore groups claimed with `.site` on a previous run.
  for (const id of loadAllowedGroups()) {
    allowGroup(id);
    console.log(`🏗️  Site group allowed (remembered): ${id}`);
  }
  console.log('\nCommands available:');
  console.log('  .help      - Show all commands');
  console.log('  .projectss - Project SS report');
  console.log('  .progress  - Track site progress');
  console.log('  .materials - Today\'s materials + photos (or .materials [tarikh])');
  console.log('  .issues    - Track issues');
  console.log('  .files     - Auto-saved files: drawings, PDFs, photos, voice');
  console.log('  .dailyreport - Generate daily report');
  console.log('\nPress Ctrl+C to stop.\n');
}

/**
 * Learn the bot's own WhatsApp id.
 *
 * Normally whatsapp-web.js fills client.info.wid on 'ready'. When we start up via
 * the rescue path there is no client.info, and an unknown bot id means the bot
 * cannot recognise a mention - so "@bot" would be treated as plain text and the
 * AI would never be asked anything. Read the id straight out of the page.
 */
async function rememberOwnBotId() {
  try {
    if (client.info?.wid) {
      setBotId(client.info.wid);
    }
    // WhatsApp can address the same account by phone number (PN) or linked
    // device id (LID). Learn both so mentions continue working after a
    // library/rescue startup path switch.
    if (client.pupPage) {
      const fromPage = await client.pupPage.evaluate(() => {
        const prefs = window.require('WAWebUserPrefsMeUser');
        const lid = prefs.getMaybeMeLidUser?.();
        const pn = prefs.getMaybeMePnUser?.();
        const str = (u) => (u ? String(u._serialized ?? u.$1 ?? u) : null);
        return { lid: str(lid), pn: str(pn) };
      });
      setBotId(fromPage?.lid || null);
      setBotId(fromPage?.pn || null);
    }
    const id = getBotId();
    if (id) console.log(`Bot ID: ${id} - tag this to talk to me`);
    else console.log('⚠️  Could not determine bot id - @mentions may not be recognised.');
  } catch (e) {
    console.log('could not read bot id:', e.message);
  }
}

/**
 * Finish the startup that whatsapp-web.js only performs on its 'ready' path.
 *
 * This is NOT optional. Inside the library, 'ready' is emitted at the end of a
 * block that does three things in order: wait for window.WWebJS, build
 * client.info + client.interface, then await attachEventListeners() - and THAT
 * last call is what pipes WhatsApp's incoming messages into client.on('message').
 *
 * A rescue that only rebuilt WWebJS produced a bot that could call the API fine
 * (getChats worked, storage worked) but was completely deaf - no message events
 * at all, so it never replied to anything. Always run the listeners.
 */
async function completeClientStartup() {
  // 1. client.info - used for the bot's own wid.
  try {
    if (!client.info) {
      const { ClientInfo } = await import('whatsapp-web.js/src/structures/ClientInfo.js');
      const raw = await client.pupPage.evaluate(() => ({
        ...window.require('WAWebConnModel').Conn.serialize(),
        wid:
          window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
          window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser(),
      }));
      client.info = new ClientInfo(client, raw);
    }
  } catch (e) {
    console.log(`⚠️  Could not build client.info: ${e.message || e}`);
  }

  // 2. client.interface - the send/typing helpers handlers call into.
  try {
    if (!client.interface) {
      const { InterfaceController } = await import('whatsapp-web.js/src/util/InterfaceController.js');
      client.interface = new InterfaceController(client);
    }
  } catch (e) {
    console.log(`⚠️  Could not build client.interface: ${e.message || e}`);
  }

  // 3. THE IMPORTANT ONE - incoming message events.
  try {
    await client.attachEventListeners();
    console.log('👂 Incoming message listeners attached (bot can hear the groups).');
  } catch (e) {
    console.log(`❌ attachEventListeners failed - the bot would be deaf: ${e.message || e}`);
    throw e;
  }
}

client.on('ready', async () => {
  startupVia = 'library';
  if (announcedReady) return; // internal reloads should not repeat the menu
  announcedReady = true;
  stopReadyRescue();
  await onClientReady();
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

/**
 * Everything the bot does in a PRIVATE chat.
 *
 * Today that is exactly one feature - the personal claim calculator - plus the
 * small commands that go with it. Everything else in a DM is ignored, as it has
 * always been, because site records belong in site groups.
 *
 * A forwarded receipt is told apart from anything else by having media attached;
 * the amount comes from the caption. No media and no known command means the
 * message is not ours to answer.
 *
 * @returns {Promise<boolean>} true when the message was handled
 */
async function handlePrivateMessage(msg, { senderName = '', senderNumber = '' } = {}) {
  const jid = msg.from;
  const body = String(msg.body || '').trim();
  const command = body.toLowerCase();

  // --- small claim commands -------------------------------------------------
  if (command === '.claim' || command === '.claims') {
    const { claimStatus } = await import('./src/handlers/claims.js');
    return msg.reply(await claimStatus(jid)), true;
  }

  if (command === '.claim test' || command === '.claim testpdf') {
    // Compile and send this month right now instead of waiting for the 28th.
    // Admin only, and only the sender's own claims: an unscoped forced sweep
    // sent (and marked compiled) every user's month and replied with the first
    // one's total.
    if (!(await senderIsAdmin(msg))) return false;
    const { runClaimSweep } = await import('./src/claimScheduler.js');
    const out = await runClaimSweep(client, { force: true, jid });
    if (!out.sent.length) return msg.reply('Tiada claim untuk dihantar.'), true;
    const sent = out.sent[0];
    return msg.reply(
      `🧾 *CLAIM ${sent.month}*\n\n💰 Total: *RM ${Number(sent.total).toFixed(2)}*\n` +
      `🧾 ${sent.count} resit, ${sent.pages} page\n📁 ${sent.bucket}/${sent.path}`,
      true
    );
  }

  // --- a forwarded receipt --------------------------------------------------
  // Only images count. A PDF in a PM is not a claim receipt, and silently filing
  // it as one would put a document into a money total.
  const isImage = msg.type === 'image' || String(msg.mimetype || '').startsWith('image/');
  if (!isImage || !msg.hasMedia) return false;

  const { recordClaimReceipt, claimConfirmText } = await import('./src/handlers/claims.js');
  const out = await recordClaimReceipt(msg, { sender: senderName || senderNumber, jid });

  if (!out.ok) {
    console.log(`⚠️  claim receipt failed from ${jid}: ${out.error}`);
    return msg.reply(`❌ Resit tak dapat direkod - ${out.error}`), true;
  }
  return msg.reply(claimConfirmText(out)), true;
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

    // RULE: only ever react inside a GROUP. Personal chats stay private.
    //
    // The one thing that DOES happen in a private chat is the personal claim
    // calculator: the owner forwards their own receipts to the bot directly and
    // gets one compiled claim sheet a month. It lives here, before the group
    // gate, and it is deliberately unreachable from any group message.
    if (!isGroup) {
      const handled = await handlePrivateMessage(msg, { senderName, senderNumber });
      if (handled) return;
      return;
    }

    // Commands get pasted inside ``` fences constantly. Strip them, otherwise
    // ".addmaterial" inside a code block looks like plain chat and is ignored.
    // Done before the site-group gate because `.site` is itself the gate command.
    let messageBody = (msg.body || '').trim();
    if (messageBody.startsWith('```')) {
      messageBody = messageBody.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    }
    const isCommand = messageBody.startsWith('.');
    const reminderFollowup = !isCommand && hasPendingReminder(reminderConversationKey(msg)) &&
      /\b(?:pukul|jam|at|\d{1,2}\s*(?:am|pm)|seminit|sejam|satu\s+(?:minit|minute|jam|hour)|one\s+(?:minute|hour))\b/i.test(messageBody);
    const mentioned = !isCommand && messageBody && (isMentioningBot(msg) || reminderFollowup);

    // RULE: only serve groups we have been told are site groups. The bot sits in
    // family chats and personal groups too, and filing site records there (or
    // replying as a site assistant) is pure noise. A group becomes a site group
    // via SITE_GROUPS in .env, `.site`, or the admin tagging us once.
    if (!isAllowedGroup(msg.from)) {
      if (isBlockedGroup(msg.from)) {
        return;
      }
      // Claim this group as a site group: admin tagging it, or admin `.site`.
      // senderIsAdmin resolves the group sender's @lid to a phone number; the
      // old exact compare against senderNumber never matched a LID, and `.site`
      // had no check at all, so any member could switch the bot on anywhere.
      const wantsClaim = (mentioned || /^\.(site|daftar|register)\b/i.test(messageBody)) &&
        await senderIsAdmin(msg);
      if (wantsClaim) {
        allowGroupPersistently(msg.from);
        let claimName = '';
        try {
          claimName = (await msg.getChat())?.name || '';
        } catch (e) { /* name lookup is best effort */ }
        registerGroup(msg.from, claimName);
        console.log(`✅ Registered site group: "${claimName}" -> site "${siteFor(msg.from)}"`);
        await react(msg, REACTIONS.saved);
        return msg.reply(
          `Ok boss, group ni didaftar sebagai site *${siteFor(msg.from)}*. Bot siap nak record apa-apa pa 📸`
        );
      }

      // An admin may also turn a group OFF with `.unsite`.
      if (/^\.unsite\b/i.test(messageBody)) {
        blockGroup(msg.from, 'admin');
        const remaining = [...loadAllowedGroups(), ...allowGroupsFromEnv(config.siteGroups)].filter(
          (id) => id !== msg.from
        );
        saveAllowedGroups(remaining);
        console.log(`⛔ Site group disabled by admin: ${msg.from}`);
        await react(msg, REACTIONS.deleted);
        return msg.reply('Ok boss, bot diam dalam group ni dari sekarang. Takde apa direkod kat sini.');
      }

      // Otherwise: silent. Do not react, do not log, do not touch photos here.
      return;
    }

    // Learn which site this group is (from its name) the first time we see it.
    // Name lookup can fail while WhatsApp's page is busy, so retry once and
    // only give up if the group is genuinely nameless.
    if (!siteFor(msg.from)) {
      let groupName = '';
      for (let attempt = 0; attempt < 2 && !groupName; attempt++) {
        try {
          groupName = (await msg.getChat())?.name || '';
        } catch (e) {
          console.log(`⚠️  Group name lookup failed for ${msg.from} (try ${attempt + 1}): ${e.message || e}`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      const savedSiteName = !groupName ? await savedSiteNameForGroup(msg.from).catch(() => null) : null;
      registerGroup(msg.from, groupName || savedSiteName || '');
      console.log(`🏗️  New site group: "${groupName || savedSiteName || '(no name yet)'}" -> site "${siteFor(msg.from)}"`);
    }
    const siteName = siteFor(msg.from);

    // Each site group gets its OWN database (its own Postgres schema). Created
    // on first message in that group, empty, so a new site never inherits the
    // previous site's issues/progress/attendance. Everything below - photos,
    // AI, commands, reports - runs inside this site's scope.
    let site;
    try {
      site = await ensureSiteSchema({ siteName, groupId: msg.from });
    } catch (err) {
      console.error(`⚠️  Could not prepare site database for "${siteName}":`, err.message);
      return msg.reply(
        `⚠️ Boss, database site ni tak boleh dibuka sekarang.\n` +
        `Sebab: ${err.message}\nCuba lagi nanti ya.`
      );
    }
    // Remember it before handling, so the memory is stored even if a handler
    // throws - but INSIDE runInSite(). Called on its own it ran with the default
    // search_path, so every write went looking for chat_log in public (which has
    // never had one) and failed on every single message.
    const scoped = await runInSite(site, async () => {
      if (!msg.hasMedia) await waitForActiveIntake(msg.from);
      rememberMessage(msg, siteName);
      return handleSiteMessage(msg, { siteName, site, senderName, isGroup, isCommand, mentioned, messageBody, autoCaptureScope: true });
    });
    return scoped;
  } catch (error) {
    console.error('Error handling message:', error);
    if (isDetachedFrameError(error)) schedulePageRestart(error);
    // Don't send error messages to avoid spam
  }
});

// Everything from here on touches the database, so it runs inside runInSite():
// every progress/material/issue/attendance/SS read and write goes to THIS group's
// own schema and nothing else.
// A file lookup, not a file upload. Requires BOTH a document noun and a "give me"
// verb, and is skipped when the message is clearly about doing work ("nak hantar
// gambar progress") so normal site chatter never gets hijacked.
const FILE_NOUN = /\b(fail|file|dokumen|document|pelan|drawing|lukisan|claim|tuntutan|invois|invoice|resit|report|laporan|pdf|progress|kemajuan|material|bahan|gambar|photo|attendance|kehadiran)\b/i;
const FILE_ASK = /\b(bagi|beri|show|tunjuk|cari|carikan|find|mana|where|download|tengok|hantar|send|kirim|balik)\b/i;
const NOT_A_QUERY = /\b(nak hantar|nak upload|nak simpan|nak rekod|baru sampai|masuk stor|dah siap|update|tambah)\b/i;

function looksLikeFileQuery(text) {
  const t = String(text || '');
  // A normal attendance question is a database view, not a file lookup.
  // Only route attendance here when the user explicitly asks for its photo/file.
  if (/\b(attendance|kehadiran|workers?|pekerja)\b/i.test(t) &&
      !/\b(photo|gambar|image|file|fail|dokumen|document|send|hantar|balik|download)\b/i.test(t)) {
    return false;
  }
  return FILE_NOUN.test(t) && FILE_ASK.test(t) && !NOT_A_QUERY.test(t);
}

function fileCategoryHint(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(progress|kemajuan)\b/.test(t)) return { linkType: 'progress' };
  if (/\b(material|bahan|barang|delivery)\b/.test(t)) return { linkType: 'material' };
  if (/\b(attendance|kehadiran|worker|pekerja)\b/.test(t)) return { category: 'attendance' };
  if (/\b(drawing|pelan|lukisan|as[- ]?built|dwg)\b/.test(t)) return { category: 'drawings' };
  if (/\b(pdf|document|dokumen)\b/.test(t)) return { category: 'pdf', fileType: 'pdf' };
  if (/\b(claim|tuntutan|invoice|invois)\b/.test(t)) return { category: 'pdf', term: t.match(/\b(claim|tuntutan|invoice|invois)\b/)?.[1] };
  return null;
}

function filterFileRows(rows, text) {
  const hint = fileCategoryHint(text);
  if (!hint) return rows;
  return rows.filter((row) => {
    if (hint.linkType && row.link_type === hint.linkType) return true;
    // "pdf" means the PDF folder. Drawing PDFs are deliberately filed under
    // drawings and must only appear when the user asks for drawings.
    if (hint.category === 'pdf') {
      if (row.category !== 'pdf') return false;
      if (!hint.term) return true;
      return `${row.original_name || ''} ${row.caption || ''}`.toLowerCase().includes(hint.term);
    }
    if (hint.fileType === 'pdf' && (String(row.mimetype || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(String(row.original_name || row.path || '')))) return true;
    if (hint.category && row.category === hint.category) {
      if (!hint.term) return true;
      return `${row.original_name || ''} ${row.caption || ''}`.toLowerCase().includes(hint.term);
    }
    return false;
  });
}

async function handleSiteMessage(msg, ctx) {
  const { siteName, site, senderName, isGroup, isCommand, mentioned, messageBody } = ctx;
  if (!ctx.autoCaptureScope) {
    // Safety net: if this ever gets called outside a site scope, say so loudly
    // rather than quietly writing into the shared tables again.
    console.error('🚨 handleSiteMessage called without a site scope');
    return msg.reply('⚠️ Internal site scope missing - nothing was saved.');
  }
  {
    // Log site-group messages so we always see activity in the terminal
    console.log(`[${new Date().toLocaleTimeString()}] 📩 [${siteName}] ${senderName} type=${msg.type} body="${(msg.body || '').slice(0, 60)}"`);

// Keep a short rolling buffer of group chatter so the LLM has context when
    // someone tags the bot (e.g. "macam mana dengan yang kat gambar tadi?").
    if (!isCommand && messageBody) {
      pushContext(msg.from, senderName, messageBody);
    }

    // Every file the site sends is auto-saved and filed: photo -> photos bucket,
    // drawing-named PDF -> drawings bucket, letter -> pdf bucket, voice note ->
    // voice bucket. Path is <site>/<DD-MM-YYYY>/<file>. No command, no tag.
    if (msg.hasMedia) {
      const isSaveable = isSaveableMedia(msg);
      if (isSaveable) {
        const result = await intakeFile(msg, {
          siteName,
          caption: messageBody || '',
          sender: senderName,
        });
        if (result && result.saved) {
          // React ALWAYS - tagged or not. The site asked for an emoji on their
          // message and "no emoji" is indistinguishable from "bot not running".
          // One text message per photo is a burst of noise, so emoji only.
          await react(msg, REACTIONS.file);
        } else if (result && result.error) {
          await reactError(msg, `Couldn't save that file (${result.error})`);
        }
      } else {
        // Stickers and the like are decoration, not a site record.
        await handlePhoto(msg);
      }
    }

    // "Kerani, bagi saya pelan awning" / "gambar site pada 12 Oktober".
    // Deterministic tool call, not an LLM guess: the model is good at deciding
    // WHAT to do, but this must never invent a filename or hand out an old
    // version. So the lookup runs here, against the real index.
    if (mentioned && !isCommand && !msg.hasMedia && looksLikeFileQuery(messageBody)) {
      const asked = parseRecordDate(messageBody);
      let rows;
      let title;
      if (asked) {
        rows = filterFileRows(await filesDB.getByDate(asked), messageBody);
        title = `FILES - ${asked}`;
      } else {
        const hint = fileCategoryHint(messageBody);
        if (hint) {
          // No date means newest matching files. Date was already handled
          // above, so this never mixes an old file into a dated request.
          rows = filterFileRows(await filesDB.getRecent(100), messageBody).slice(0, 8);
          title = `LATEST ${hint.linkType || hint.category || 'FILES'}`;
        } else {
        const term = messageBody
          .replace(/\b(kerani|bot|tolong|please|bagi|beri|show|tunjuk|cari|carikan|find|mana|where|download|tengok|hantar|send|kirim|balik|nak|saya|i|me|the|file|fail|dokumen)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        rows = term ? await filesDB.getLatestByName(term, 8) : await filesDB.getLatestPerDoc(10);
        title = term ? `FILES MATCHING "${term}"` : 'LATEST VERSION OF EACH FILE';
        }
      }

      // Exactly one hit -> send the file itself, because that is what they asked
      // for. Several -> list them with ids AND send the files themselves.
      if (rows.length === 1) return handleFiles(msg, [String(rows[0].id)]);
      if (rows.length > 1) return replyFilesWithMedia(msg, buildFilesMessage(rows, title), rows);
      const hint = fileCategoryHint(messageBody);
      const label = hint?.linkType || hint?.category || 'fail';
      return msg.reply(
        `*Tak jumpa ${label} untuk tarikh/permintaan tu boss.*\n\n` +
        `Nak saya cari versi terbaru, atau bagi tarikh/nama file yang tepat?`
      );
    }

    // Photo + any caption, with no dot-command: let the AI file it. This is the
    // "just send the photo and say what it is" flow - no command, no tag needed.
    const autoCapture = !isCommand && messageBody && msg.hasMedia;

    if (mentioned || autoCapture) {
      // mentioned = they expect a reply. autoCapture = stay silent unless it
      // saved something or failed.
      await handleTaggedMessage(msg, {
        context: contextBuffers.get(msg.from) || [],
        hasMedia: msg.hasMedia,
        interactive: Boolean(mentioned),
      });
      return;
    }

    // Forwarded-photo flow: WhatsApp may deliver the photo first and the
    // worker/material/progress description as a separate text message. If it
    // arrives within the live 90-second evidence window, process it against
    // the waiting photo batch even without a bot tag or dot-command.
    if (!isCommand && !mentioned && !msg.hasMedia &&
        (getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0) &&
        isSeparateRecordDescription(messageBody)) {
      await handleTaggedMessage(msg, {
        context: contextBuffers.get(msg.from) || [],
        hasMedia: false,
        interactive: false,
      });
      return;
    }

    if (!isCommand) {
      // A pending Project SS question is waiting for a plain-text answer
      // (e.g. the machinery list the bot asked for).
      if (messageBody) {
        const answered = await handleSSAnswer(msg, messageBody);
        if (answered) return;
      }
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
        
      // Project SS report (replaces the old .diary)
      case 'projectss':
      case 'project':
      case 'ss':
        await handleProjectSS(msg, args);
        break;

      case 'addss':
      case 'updates':
        await handleAddSS(msg, messageBody);
        break;

      // Attendance commands
      case 'attendance':
      case 'att':
        // Route the plain attendance command through the same context-recovery
        // path as a tagged question. This matters for the normal flow:
        // photo -> "3 workers ..." -> .attendance. Without this, the command
        // only displayed the database and never consumed the pending photo or
        // the worker description.
        if (!args.length || /^(today|hari|harini|semalam|yesterday)$/i.test(args[0])) {
          await handleTaggedMessage(msg, {
            context: contextBuffers.get(msg.from) || [],
            hasMedia: false,
            interactive: true,
          });
        } else {
          await handleAttendance(msg, args);
        }
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

      // Diagnostic: does this message get an emoji or not?
      // Answers with the truth (landed / failed + why) so a missing emoji is
      // never confused with "the bot is not running".
case 'reacttest': {
  const landed = await react(msg, '✅');
  console.log(`✅ reacttest on ${msg.id?._serialized || 'no-id'} -> ${landed ? 'OK' : 'FAILED'}`);
  return msg.reply(landed
  ? '✅ Reaction landed. Bot is running and replying.'
  : '⚠️ Reaction did NOT land. Check the terminal for the reason.');
  }

  // What does the bot actually know about this company? Reads
  // knowledge/*.md and reloads from disk, so notes can be added without a
  // restart. Admin only - it prints paths on the shared machine.
  case 'knowledge': {
  if (!(await senderIsAdmin(msg))) return msg.reply('Admin only boss.');
  const { reloadKnowledge, knowledgeStatus } = await import('./src/knowledge.js');
  const info = knowledgeStatus();
  reloadKnowledge();
  if (!info.present) {
    return msg.reply(
      `📁 Tiada knowledge lagi boss.\n` +
      `Create \`knowledge/company.md\` and write anything the bot should know - ` +
      `company profile, contract, client, teams, standing arrangements.\n` +
      `Folder: ${info.dir}`
    );
  }
  return msg.reply(
    `🧠 Knowledge loaded: ${info.files.join(', ')}\n` +
    `${info.chars} chars dalam prompt.\n\n` +
    `📁 ${info.dir}\n_Edit a file then run .knowledge again._`
  );
  }

      case 'attach':
        await handleAttach(msg, args);
        break;

      // Every auto-saved file: search back by id, category, date or name
      case 'files':
      case 'file':
        await handleFiles(msg, args);
        break;

      // Newest version of a document, never an old copy
      case 'latest':
        await handleFiles(msg, ['latest', ...args]);
        break;

      // Edit any record: .edit <type> <id>
      case 'edit':
        if (!(await senderIsAdmin(msg))) {
          await msg.reply('Edit rekod hanya untuk admin/supervisor boss.');
          break;
        }
        await handleEdit(msg, args, messageBody);
        break;

      // Safe two-step delete: the AI handler asks for YES before mutating.
      case 'delete':
      case 'del': {
        if (!(await senderIsAdmin(msg))) {
          await msg.reply('Delete rekod hanya untuk admin/supervisor boss.');
          break;
        }
        const type = String(args[0] || '').toLowerCase();
        const ids = args.slice(1).flatMap((arg) => [...String(arg).matchAll(/\d+/g)].map((m) => Number(m[0]))).filter(Boolean);
        if (!type || !ids.length) {
          await msg.reply('*Usage:* `.delete <progress|material|issue|attendance|workorder|milestone> <id>`\nContoh: `.delete progress 12`\nBot akan minta confirmation YES dahulu.');
          break;
        }
        await handleTaggedMessage(msg, {
          interactive: true,
          hasMedia: false,
          decision: { action: 'delete', record: { type, ids } },
        });
        break;
      }

      // Unknown command
      default:
        // Don't respond to unknown commands to avoid spam
        break;
    }
  }
}

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
// Personal claims: compiled and sent from the private-chat side only. Started
// here so the tables exist before the first receipt arrives, not lazily on the
// 28th when a failure would mean a missed claim.
startClaimScheduler(client);
  startReminderScheduler(client);
client.initialize().catch((error) => {
  console.error('❌ WhatsApp client initialization failed:', error?.stack || error?.message || String(error));
  // Puppeteer may have spawned Edge before initialization rejected. Close that
  // child first; otherwise the next run sees the session as "already running".
  client.destroy().catch(() => {}).finally(() => {
    process.exitCode = 1;
  });
});

// Graceful shutdown
async function gracefulShutdown() {
  console.log('\n🛑 Shutting down Site Bot...');
  stopClaimScheduler();
  stopReminderScheduler();
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
