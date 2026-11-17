import { remindersDB, runInSite, siteOfGroup, ensureSiteSchema } from './database.js';
import { listSites } from './sites.js';
import pkg from 'whatsapp-web.js';
import config from '../config.js';
const { MessageMedia } = pkg;

const TZ = 'Asia/Kuala_Lumpur';
const pad = (n) => String(n).padStart(2, '0');

function localParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((out, p) => (out[p.type] = p.value, out), {});
}

function localDate(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00+08:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localIsoNow(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const pendingReminderRequests = new Map();
const PENDING_REMINDER_TTL_MS = 5 * 60 * 1000;

export function reminderConversationKey(msg) {
  return `${msg?.from || ''}:${msg?.author || msg?.from || ''}`;
}

export function rememberPendingReminder(key, text) {
  pendingReminderRequests.set(key, { text: String(text || ''), expiresAt: Date.now() + PENDING_REMINDER_TTL_MS });
}

export function hasPendingReminder(key) {
  const pending = pendingReminderRequests.get(key);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingReminderRequests.delete(key);
    return false;
  }
  return true;
}

export function takePendingReminder(key) {
  const pending = pendingReminderRequests.get(key);
  pendingReminderRequests.delete(key);
  return pending && pending.expiresAt >= Date.now() ? pending.text : null;
}

export function parseReminderRequest(text, now = new Date()) {
  const raw = String(text || '').replace(/@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const t = raw.toLowerCase();
  if (!/\b(remind(?:er|kan)?|ingatkan(?:\s+saya)?)\b/.test(t)) return null;

  // Relative reminders: "lagi setengah jam from now", "lagi 20 minit",
  // "in 30 minutes", and "dalam 1 jam". Resolve from the actual instant so
  // a reminder crossing midnight gets the correct local date.
  const halfHour = /\b(?:lagi\s+)?setengah\s+jam\s*(?:lagi|from\s+now|dari\s+sekarang)?\b/i.test(t);
  const singleUnit = t.match(/\b(?:lagi\s+)?(seminit|sejam|satu\s+(?:minit|minute|jam|hour)|one\s+(?:minute|hour))\s*(?:lagi|from\s+now|dari\s+sekarang|from\s+sekarang)?\b/i);
  const relative = t.match(/\b(?:lagi\s+)?(\d+(?:[.,]\d+)?)\s*(minit|minute|minutes|mins?|jam|hour|hours)\s*(?:lagi|from\s+now|dari\s+sekarang|from\s+sekarang)?\b/i)
    || t.match(/\b(?:in|dalam)\s+(\d+(?:[.,]\d+)?)\s*(minit|minute|minutes|mins?|jam|hour|hours)\b/i);
  if (halfHour || singleUnit || relative) {
    const amount = halfHour ? 30
      : singleUnit ? (/sejam|satu\s+(?:jam|hour)|one\s+hour/i.test(singleUnit[1]) ? 60 : 1)
      : Number(String(relative[1]).replace(',', '.')) * (/jam|hour/i.test(relative[2]) ? 60 : 1);
    const event = new Date(now.getTime() + amount * 60 * 1000);
    const title = raw
      .replace(/^\s*(?:oi|tlg|tolong)\s+/i, ' ')
      .replace(/\bsetkan\s+/ig, ' ')
      .replace(/\bset\s+/ig, ' ')
      .replace(/\b(?:tolong\s+)?(?:setkan\s+)?remind(?:er|kan)?\b/ig, ' ')
      .replace(/\b(?:ingatkan(?:\s+saya)?)\b/ig, ' ')
      .replace(/\b(?:lagi\s+)?setengah\s+jam\s*(?:lagi|from\s+now|dari\s+sekarang)?\b/ig, ' ')
      .replace(/\b(?:in|dalam)\s+(?=(?:seminit|sejam)\b)/ig, ' ')
      .replace(/\b(?:lagi\s+)?(?:seminit|sejam)\s*(?:lagi|from\s+now|dari\s+sekarang|from\s+sekarang)?\b/ig, ' ')
      .replace(/\b(?:lagi\s+)?(?:satu\s+(?:minit|minute|jam|hour)|one\s+(?:minute|hour))\s*(?:lagi|from\s+now|dari\s+sekarang|from\s+sekarang)?\b/ig, ' ')
      .replace(/\b(?:in|dalam)\s+(?=\d+(?:[.,]\d+)?\s*(?:minit|minute|minutes|mins?|jam|hour|hours)\b)/ig, ' ')
      .replace(/\b(?:lagi\s+)?\d+(?:[.,]\d+)?\s*(?:minit|minute|minutes|mins?|jam|hour|hours)\s*(?:lagi|from\s+now|dari\s+sekarang|from\s+sekarang)?\b/ig, ' ')
      .replace(/\b(?:esok|tomorrow|hari ini|today)\b/ig, ' ')
      .replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim() || 'meeting';
    return { eventAt: localIsoNow(event), title };
  }

  const time = t.match(/\b(?:pukul|jam|at|@)\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm|pagi|petang|ptg|malam)?\b/)
    || t.match(/\b(\d{1,2})\s*(am|pm|pagi|petang|ptg|malam)\b/);
  if (!time) return { needsTime: true };

  let hour = Number(time[1]);
  const hasClockMinutes = /[:.]/.test(time[0]);
  const minute = hasClockMinutes ? Number(time[2] || 0) : 0;
  const suffix = time[3] || (!hasClockMinutes ? time[2] : '') || '';
  if (minute > 59 || hour > 23) return { needsTime: true };
  if (['pm', 'petang', 'ptg', 'malam'].includes(suffix)) {
    if (hour < 12) hour += 12;
  } else if (suffix === 'am' && hour === 12) hour = 0;
  if (!suffix && hour >= 1 && hour <= 7) hour += 12;

  const date = /\b(esok|tomorrow)\b/.test(t) ? addDays(localDate(now), 1) : localDate(now);
  const title = raw
    .replace(/^\s*(?:oi|tlg|tolong)\s+/i, ' ')
    .replace(/\bsetkan\s+/ig, ' ')
    .replace(/\bset\s+/ig, ' ')
    .replace(/\b(?:tolong\s+)?(?:setkan\s+)?remind(?:er|kan)?\b/ig, ' ')
    .replace(/\b(?:ingatkan(?:\s+saya)?)\b/ig, ' ')
    .replace(/\b(?:pukul|jam|at|@)\s*\d{1,2}(?:\s*[:.]\s*\d{2})?\s*(?:am|pm|pagi|petang|ptg|malam)?\b/ig, ' ')
    .replace(/\b(?:esok|tomorrow|hari ini|today)\b/ig, ' ')
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim() || 'meeting';
  return { eventAt: `${date}T${pad(hour)}:${pad(minute)}:00`, title };
}

export function reminderText(row, leadMinutes) {
  return `⏰ Reminder — ${row.title}\n📅 ${row.event_at.replace('T', ' ').slice(0, 16)} (${leadMinutes} min lagi)`;
}

let timer = null;
let sweeping = false;
const voiceCache = new Map();
let resolvedVoiceId = config.elevenLabsVoiceId || '';
let voiceAuthFailed = false;
let voiceAuthWarningShown = false;

async function getVoiceId() {
  if (resolvedVoiceId) return resolvedVoiceId;
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': config.elevenLabsApiKey, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`ElevenLabs voices HTTP ${response.status}`);
  const voices = (await response.json()).voices || [];
  const wanted = String(config.elevenLabsVoiceName || '').trim().toLowerCase();
  const voice = voices.find((v) => String(v.name || '').trim().toLowerCase() === wanted)
    || voices.find((v) => String(v.name || '').toLowerCase().includes(wanted));
  if (!voice?.voice_id) throw new Error(`voice "${config.elevenLabsVoiceName}" not found`);
  resolvedVoiceId = voice.voice_id;
  console.log(`[reminder] ElevenLabs voice selected: ${voice.name}`);
  return resolvedVoiceId;
}

async function reminderVoice(row, leadMinutes) {
  if (!config.elevenLabsApiKey || voiceAuthFailed) return null;
  const cacheKey = `${row.id}:${leadMinutes}`;
  if (voiceCache.has(cacheKey)) return voiceCache.get(cacheKey);
  const title = String(row.title || 'meeting')
    .replace(/\b(?:aku|saya|kau|awak|you|me)\b/gi, 'boss')
    .replace(/\s+/g, ' ').trim();
  const spoken = `Boss, ${title} lagi ${leadMinutes} minit. Jangan lupa boss.`;
  let voiceId;
  try {
    voiceId = await getVoiceId();
  } catch (e) {
    if (/HTTP 401/i.test(String(e.message || e))) {
      voiceAuthFailed = true;
      if (!voiceAuthWarningShown) {
        voiceAuthWarningShown = true;
        console.error('[reminder] ElevenLabs API key rejected (401); using text reminders until key is replaced.');
      }
      return null;
    }
    throw e;
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`, {
    method: 'POST',
    headers: { 'xi-api-key': config.elevenLabsApiKey, 'Content-Type': 'application/json', Accept: 'audio/ogg' },
    body: JSON.stringify({ text: spoken, model_id: config.elevenLabsModel }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      voiceAuthFailed = true;
      if (!voiceAuthWarningShown) {
        voiceAuthWarningShown = true;
        console.error('[reminder] ElevenLabs API key rejected (401); using text reminders until key is replaced.');
      }
      return null;
    }
    throw new Error(`ElevenLabs HTTP ${response.status}`);
  }
  // WhatsApp voice notes expect an OGG/Opus stream; sending the MP3 response
  // as a voice note can produce "something went wrong with the audio".
  const media = new MessageMedia('audio/ogg', Buffer.from(await response.arrayBuffer()).toString('base64'), `reminder-${row.id}-${leadMinutes}.ogg`);
  voiceCache.set(cacheKey, media);
  return media;
}

async function sendReminder(client, site, row, lead) {
  const voice = await reminderVoice(row, lead);
  if (voice) {
    try {
      await client.sendMessage(site.groupId, voice, { sendAudioAsVoice: true });
      console.log(`[reminder] voice sent #${row.id} (${lead} min) to ${site.site}`);
      await sendAllMention(client, site);
      return;
    } catch (error) {
      // WhatsApp Web can time out while uploading an audio message even when
      // the browser session is still healthy. Keep the reminder reliable by
      // sending the text version and allowing the caller to mark it sent.
      console.error(`[reminder] voice send failed #${row.id}: ${error.message || error}; falling back to text`);
    }
  }
  await client.sendMessage(site.groupId, reminderText(row, lead));
  console.log(`[reminder] text sent #${row.id} (${lead} min) to ${site.site}`);
}

// Send the short literal @all notification after the voice note. Do not make
// this depend on participant lookup: WhatsApp Web can occasionally return an
// empty participant list while the group is still perfectly sendable.
async function sendAllMention(client, site) {
  try {
    await client.sendMessage(site.groupId, '@all');
    console.log(`[reminder] @all mention sent to ${site.site}`);
  } catch (error) {
    // A failed mention must never turn a successful voice reminder into a
    // retry, otherwise a flaky participant lookup could cause duplicate audio.
    console.error(`[reminder] @all mention failed for ${site.site}: ${error.message || error}`);
  }
}

export async function runReminderSweep(client, now = new Date()) {
  if (sweeping) return;
  sweeping = true;
  try {
    const nowIso = localIsoNow(now);
    const nowMs = Date.parse(`${nowIso}+08:00`);
    for (const site of listSites()) {
      if (!site?.groupId || !site.site) continue;
      await ensureSiteSchema({ siteName: site.site, groupId: site.groupId });
      await runInSite(siteOfGroup(site.groupId, site.site), async () => {
        const due = await remindersDB.due(nowIso);
        for (const row of due) {
          const eventMs = Date.parse(`${row.event_at}+08:00`);
          const difference = eventMs - nowMs;
          // Each reminder has two independent slots. Once the 1-minute slot
          // was delivered, the row remains queryable because sent_15 may still
          // be false; explicitly skip that already-delivered slot.
          if (difference <= 60 * 1000 && row.sent_1) continue;
          if (difference > 60 * 1000 && row.sent_15) continue;
          // If the event is already within the final minute, send the 1-minute
          // notice even when the earlier 15-minute slot was missed.
          const lead = row.sent_15 || difference <= 60 * 1000 ? 1 : 15;
          if (difference > lead * 60 * 1000 || difference < -60 * 1000) continue;
          const sentColumn = lead === 15 ? 'sent_15' : 'sent_1';
          // Reserve the slot before sending. If WhatsApp reports a timeout
          // after accepting the message, the next sweep must not send it again.
          await remindersDB.markSent(row.id, sentColumn);
          try { await sendReminder(client, site, row, lead); }
          catch (e) { console.error(`[reminder] send failed #${row.id}:`, e.message || e); }
        }
      });
    }
  } finally { sweeping = false; }
}

export function startReminderScheduler(client) {
  if (timer) return timer;
  timer = setInterval(() => runReminderSweep(client).catch((e) => console.error('[reminder] sweep failed:', e.message || e)), 15000);
  timer.unref?.();
  console.log('[reminder] scheduler on: 15-minute and 1-minute notices');
  return timer;
}

export function stopReminderScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
