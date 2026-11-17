import { diaryDB, attendanceDB } from '../database.js';
import {
  buildSSReportForDate,
  formatSSDate,
  getToday,
  ssList,
} from '../utils.js';

// ── Project SS report ──────────────────────────────────────────────────────
// Replaces the old .diary view. `.projectss` (aliases .ss / .project) prints
// the day's report; when a section is still empty the bot asks a short
// follow-up question and waits for the answer, carrying yesterday's value
// forward when the reply is just "same as yesterday".
//
// Any attendance/worker added with .addattendance shows up here automatically
// because the worker sections are read live from the attendance table.

// One pending question per chat, so the bot knows what the next plain message
// is answering.
const pending = new Map(); // chatId -> { date, field, label }

const SECTIONS = [
  {
    field: 'machinery_equipment',
    key: 'machineryEquipment',
    label: 'Machinery & Equipment',
    ask: 'Machinery & Equipment hari ini?',
    hint: 'Contoh:\n1) Dumpy level - 1 nos\n2) Grinder (small) - 1 nos\n3) Grinder (Big) - 1 nos',
  },
  {
    field: 'machinery',
    key: 'machinery',
    label: 'Machinery',
    ask: 'Machinery hari ini?',
    hint: 'Contoh:\n- Excavator 13\n- Compactor 25 ton\n- Backpusher (Repair)',
  },
  {
    field: 'weather',
    key: 'weather',
    label: 'Weather',
    ask: 'Cuaca hari ini?',
    hint: 'Contoh: 🌤️☀️🌤️ atau Cerah',
  },
];

// "sama", "same", "takde perubahan", "no change" -> reuse the previous day.
function isSameAsBefore(text) {
  return /^(sama|same|takde\s*(perubahan|tukar)|no\s*change|same\s*as\s*(yesterday|before)|macam\s*(semalam|before)|copy)$/i.test(
    String(text).trim()
  );
}

function isSkip(text) {
  return /^(takde|tak\s*ada|none|takde\s*apa|n\/a|skip|tiada)$/i.test(String(text).trim());
}

// Normalise a free-text list into one item per line.
function toListText(text) {
  const lines = String(text)
    .split('\n')
    .map(l => l.replace(/\u2060/g, '').trim())
    .filter(Boolean);
  // A single line with commas / semicolons is a list too.
  if (lines.length === 1) {
    const parts = lines[0].split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.join('\n');
  }
  return lines
    .map(l => l.replace(/^[-*\u2022]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
}

async function loadReport(date) {
  const [diary, attendance] = await Promise.all([
    diaryDB.getByDate(date),
    attendanceDB.getByDate(date),
  ]);
  return { diary, attendance };
}

// Which sections are still empty for the date?
function missingSections(diary) {
  const out = [];
  if (!diary || !diary.weather || !String(diary.weather).trim()) out.push(SECTIONS[2]);
  if (!diary || !ssList(diary.machinery).length) out.push(SECTIONS[1]);
  if (!diary || !ssList(diary.machinery_equipment).length) out.push(SECTIONS[0]);
  return out;
}

// Render one "missing section?" question, pre-filling yesterday's value.
async function askSectionQuestion(msg, next, date) {
  const yesterday = await diaryDB.getPrevious(date);
  const carried = yesterday && yesterday[next.field];

  let text = `❓ *${next.ask}*\n\n`;
  if (carried) {
    const shown = next.field === 'weather'
      ? carried
      : ssList(carried).map((l, i) => (next.field === 'machinery_equipment' ? `${i + 1}) ${l}` : `- ${l}`)).join('\n');
    text += `Semalam (${formatSSDate(yesterday.date)}):\n${shown}\n\n`;
    text += `Balik reply *sama* untuk guna yang semalam, `;
    text += `tatau taip senarai baru.\n\n`;
  } else {
    text += `Taip senarai baru.\n\n`;
  }
  text += `${next.hint}`;
  return msg.reply(text);
}

// Handle a plain (non-command) reply to a pending SS question.
export async function handleSSAnswer(msg, text) {
  const chatId = msg.from || msg.to;
  const state = pending.get(chatId);
  if (!state) return false;

  const reply = String(text || '').trim();
  if (!reply) return true; // ignore empty message, still waiting

  // "copy everything from yesterday" mode (plain .addss)
  if (state.mode === 'copyAll') {
    const yesterday = await diaryDB.getPrevious(state.date);
    if (isSameAsBefore(reply)) {
      if (!yesterday) {
        pending.delete(chatId);
        return msg.reply('❌ Tak ada rekod semalam untuk copy.');
      }
      const entry = { date: state.date };
      if (yesterday.site_name) entry.siteName = yesterday.site_name;
      if (yesterday.weather) entry.weather = yesterday.weather;
      if (yesterday.machinery) entry.machinery = yesterday.machinery;
      if (yesterday.machinery_equipment) entry.machineryEquipment = yesterday.machinery_equipment;
      if (yesterday.operators) entry.operators = yesterday.operators;
      await diaryDB.upsert(entry);
      pending.delete(chatId);
      await msg.reply(
        `✅ *Project SS* - copy semua dari ${formatSSDate(yesterday.date)}.\n` +
        `_*Buang worker yang tak datang / machinery repair / pergi site lain:_ hantar `.addss` semula dengan senarai betul.`
      );
      return showReport(msg, state.date, { askMore: true });
    }

    // Anything else = they typed the corrected list straight away.
    pending.delete(chatId);
    const parsed = parseSSBody(`.addss\n${reply}`);
    const entry = { date: state.date };
    if (parsed.site) entry.siteName = parsed.site;
    if (parsed.operators) entry.operators = toListText(parsed.operators);
    if (parsed.weather) entry.weather = parsed.weather;
    if (parsed.machinery) entry.machinery = toListText(parsed.machinery);
    if (parsed.machineryEquipment) entry.machineryEquipment = toListText(parsed.machineryEquipment);
    if (!Object.keys(entry).filter(k => k !== 'date').length) {
      return msg.reply('❌ Tak dapat baca senarai tu. Cuba format `Label: nilai` atau reply *sama*.');
    }
    await diaryDB.upsert(entry);
    await showReport(msg, state.date, { askMore: true });
    return true;
  }

  const section = SECTIONS.find(s => s.field === state.field);

  if (isSameAsBefore(reply)) {
    const yesterday = await diaryDB.getPrevious(state.date);
    if (!yesterday || !yesterday[section.field]) {
      await msg.reply(`❌ Semalam ada rekod *${section.label}*, tapi tiada entry sebelum tu juga.\nHantar senarai penuh ya.`);
      return true;
    }
    await diaryDB.upsert({ date: state.date, [section.key]: yesterday[section.field] });
    await msg.reply(`✅ *${section.label}* - ulang sama seperti ${formatSSDate(yesterday.date)}.`);
    await showReport(msg, state.date, { askMore: true });
    return true;
  }

  if (isSkip(reply)) {
    await msg.reply(`⚠️ *${section.label}* dikosongkan - akan tanya semula bila-bila masa.`);
    pending.delete(chatId);
    return true;
  }

  const value = section.field === 'weather' ? reply : toListText(reply);
  await diaryDB.upsert({ date: state.date, [section.key]: value });
  await msg.reply(`✅ *${section.label}* dikemas kini.`);
  await showReport(msg, state.date, { askMore: true });
  return true;
}

// Print the report. `askMore` also asks for whatever is still missing.
export async function showReport(msg, date, { askMore = true } = {}) {
  const { diary, attendance } = await loadReport(date);
  const report = await buildSSReportForDate({
    diary: diary || { date, site_name: null, weather: null },
    attendance,
  });

  await msg.reply(report);

  if (askMore) {
    const chatId = msg.from || msg.to;
    const missing = missingSections(diary);
    if (missing.length) {
      const next = missing[0];
      pending.set(chatId, { date, field: next.field });
      await askSectionQuestion(msg, next, date);
    } else {
      pending.delete(chatId);
    }
  }
  return report;
}

// `.projectss` / `.ss` / `.project`
export async function handleProjectSS(msg, args) {
  const dateArg = (args || []).join('/').trim();
  const date = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateArg) ? dateArg : getToday();
  return showReport(msg, date);
}

// `.addss` - update any part of today's Project SS report.
export async function handleAddSS(msg, messageBody) {
  const today = getToday();
  const parsed = parseSSBody(messageBody);

  if (!Object.keys(parsed).length) {
    // No fields at all: this is "start a new report from yesterday", which is
    // the common case. Offer a one-word copy, then let them edit anything
    // (worker didn't show up, machinery went for repair, went to another site).
    const yesterday = await diaryDB.getPrevious(today);
    if (yesterday) {
      pending.set(msg.from || msg.to, { mode: 'copyAll', date: today });
      const carried = [];
      if (yesterday.machinery_equipment) carried.push(`*Machinery & Equipment*\n${ssList(yesterday.machinery_equipment).map((l, i) => `${i + 1}) ${l}`).join('\n')}`);
      if (yesterday.machinery) carried.push(`*Machinery*\n${ssList(yesterday.machinery).map(l => `- ${l}`).join('\n')}`);
      if (yesterday.operators) carried.push(`*Operator*\n${ssList(yesterday.operators).map(l => `- ${l}`).join('\n')}`);
      if (yesterday.weather) carried.push(`*Weather* - ${yesterday.weather}`);
      return msg.reply(
        `📋 *Project SS baru* untuk hari ini.\n\n` +
        `Semalam (${formatSSDate(yesterday.date)}) ada:\n\n${carried.join('\n\n')}\n\n` +
        `Reply *sama* untuk copy semua, atau hantar terus senarai yang betul ` +
        `(cth buang worker yang tak datang, machinery *Repair* / *site lain*).\n\n` +
        `Format:\n` +
        '```\n' +
        `.addss\n` +
        `Site: Flora Hijauan SBR\n` +
        `Operator: Reza (ex08)\n` +
        `Weather: 🌤️☀️🌤️\n` +
        `Machinery & Equipment:\n` +
        `chainsaw - 1 nos\n` +
        `Grinder (small) - 1 nos\n` +
        `Machinery:\n` +
        `Excavator 13\n` +
        `Compactor 25 ton\n` +
        '```'
      );
    }
    return msg.reply(
      '*Usage:* .addss\n\n' +
      'Format:\n' +
      '```\n' +
      '.addss\n' +
      'Site: Flora Hijauan SBR\n' +
      'Operator: Reza (ex08)\n' +
      'Weather: 🌤️☀️🌤️\n' +
      'Machinery & Equipment:\n' +
      'Dumpy level - 1 nos\n' +
      'Grinder (small) - 1 nos\n' +
      'Machinery:\n' +
      'Excavator 13\n' +
      'Compactor 25 ton\n' +
      '```\n\n' +
      `_*Tips:*_*ada bahagian tak berubah, tulis *sama* (guna semalam) atau *takde* (kosong).`
    );
  }

const entry = { date: today };
  const yesterday = await diaryDB.getPrevious(today);

  if (parsed.site) entry.siteName = parsed.site;
  if (parsed.operators !== undefined && parsed.operators !== '') {
    entry.operators = toListText(parsed.operators);
  }

  for (const key of ['weather', 'machineryEquipment', 'machinery']) {
    const raw = parsed[`${key}Raw`];
    if (raw === undefined || raw === '') continue;
    if (isSameAsBefore(raw)) {
      const col = { weather: 'weather', machineryEquipment: 'machinery_equipment', machinery: 'machinery' }[key];
      if (yesterday && yesterday[col]) {
        entry[key] = yesterday[col];
      } else {
        return msg.reply(`❌ Tak ada rekod *${key}* untuk hari sebelum tu juga - taip senarai penuh ya.`);
      }
    } else {
      entry[key] = key === 'weather' ? raw : toListText(raw);
    }
  }

  if (parsed.generalNotes) entry.generalNotes = parsed.generalNotes;
  if (parsed.safetyNotes) entry.safetyNotes = parsed.safetyNotes;

  try {
    await diaryDB.upsert(entry);
    await showReport(msg, today);
  } catch (error) {
    console.error('Error updating Project SS:', error);
    return msg.reply('*❌ Error updating Project SS. Please try again.*');
  }
}

// Parse `.addss` body: "Key: value" lines, plus multi-line list blocks where a
// line is just "Key:" and the following lines belong to it.
function parseSSBody(messageBody) {
  const lines = String(messageBody).split('\n').slice(1); // drop ".addss"
  const out = {};
  const aliases = {
    site: 'site', 'site name': 'site', proj: 'site', project: 'site',
    weather: 'weather', 'cuaca': 'weather',
    operator: 'operators', operators: 'operators', 'operator & crew': 'operators',
    'machinery & equipment': 'machineryEquipment',
    'machinery and equipment': 'machineryEquipment',
    'machinery &eq': 'machineryEquipment',
    mequipment: 'machineryEquipment', equipment: 'machineryEquipment',
    machinery: 'machinery', mesin: 'machinery',
    notes: 'generalNotes', 'general notes': 'generalNotes', umum: 'generalNotes',
    safety: 'safetyNotes', 'safety notes': 'safetyNotes',
  };

  let currentListKey = null;
  const listBuf = {};

  for (const raw of lines) {
    const line = raw.replace(/\u2060/g, '');
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : null;
    const canonical = key ? aliases[key] : null;

    if (canonical) {
      currentListKey = null;
      const value = colon >= 0 ? line.slice(colon + 1).trim() : '';
      out[`${canonical}Raw`] = value;
      if (['machineryEquipment', 'machinery', 'operators'].includes(canonical)) {
        // Always become the current list - even when the value is empty, the
        // lines below belong to it ("Machinery:\n- Excavator 13").
        listBuf[canonical] = value ? [value] : [];
        currentListKey = canonical;
        out[canonical] = listBuf[canonical].join('\n');
      } else {
        out[canonical] = value;
      }
      continue;
    }

    // Continuation line for a list section
    if (currentListKey && line.trim()) {
      listBuf[currentListKey].push(line.trim());
      out[currentListKey] = listBuf[currentListKey].join('\n');
      out[`${currentListKey}Raw`] = out[currentListKey];
    }
  }

  return out;
}