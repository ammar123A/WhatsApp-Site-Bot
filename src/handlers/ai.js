import { askGemini, isConfigured } from '../llm.js';
import { progressDB, materialsDB, issuesDB, attendanceDB, diaryDB, pendingDB, remindersDB, currentSite } from '../database.js';
import { parseReminderRequest, reminderConversationKey, rememberPendingReminder, takePendingReminder } from '../reminders.js';
import { getToday, getSenderName, parseRecordDate, isAdmin } from '../utils.js';
import { attachPendingPhotos, attachPhotoPaths, getPhotoBatchPaths, clearPhotoBatch, getPhotoBatchSize, handleAttach } from './photos.js';
import { linkPendingFiles, pendingCount, pendingIsDelayed } from './files.js';
import { buildRecordSnapshot, recallRecords } from '../recordContext.js';
import { react, REACTIONS } from '../reactions.js';
import config_ from '../../config.js';
const config = config_;

// Destructive actions are deliberately two-step.  A busy site group can send
// "delete" while someone is still discussing a record, so never mutate on the
// first request.  The pending item is scoped to the sender and expires quickly.
const pendingMutations = new Map();
const MUTATION_TTL_MS = 2 * 60 * 1000;

function mutationKey(msg) {
  return `${msg.from}:${msg.author || msg.from}`;
}

async function isAdminMessage(msg) {
  // The sender only - never msg.from, which in a group is the group's own id.
  const ids = [msg.author];
  try {
    const contact = await msg.getContact?.();
    ids.push(contact?.number, contact?.id?.user, contact?.id?._serialized);
  } catch { /* LID resolution is best effort; command routing also checks admin */ }
  return ids.filter(Boolean).some(isAdmin);
}

function queueMutation(msg, item) {
  pendingMutations.set(mutationKey(msg), { ...item, expiresAt: Date.now() + MUTATION_TTL_MS });
}

/** Consume YES/NO for a pending destructive request before the LLM sees it. */
export async function handleMutationConfirmation(msg) {
  const key = mutationKey(msg);
  const pending = pendingMutations.get(key);
  if (!pending || Date.now() > pending.expiresAt) {
    if (pending) pendingMutations.delete(key);
    return false;
  }
  const answer = String(msg.body || '').trim().toLowerCase().replace(/[.!]/g, '');
  if (/^(no|tak|cancel|batal|stop)$/.test(answer)) {
    pendingMutations.delete(key);
    await msg.reply('Baik boss, tindakan tu dibatalkan.');
    return true;
  }
  if (!/^(yes|ya|y|confirm|sahkan|ok|okay)$/.test(answer)) return false;
  pendingMutations.delete(key);
  if (pending.kind === 'edit') {
    if (!await isAdminMessage(msg)) {
      await msg.reply('Edit rekod hanya untuk admin/supervisor boss.');
      return true;
    }
    const out = await doEdit(msg, pending.record, { skipConfirm: true });
    await msg.reply(out.ok ? out.text : `Tak dapat edit - ${out.why}`);
    return true;
  }
  const out = await doDelete(msg, pending.record, pending.rawText, { skipConfirm: true });
  if (!out.ok) await msg.reply(`Tak dapat delete - ${out.why}`);
  else await msg.reply(out.text);
  return true;
}

// AI handler for the construction-site group.
//
// Two ways in:
//   interactive  - they mentioned the bot -> always answer.
//   not          - a photo + caption arrived and the AI filed it -> stay
//                  silent unless something was saved or something failed.
//
// Safety: the LLM proposes, this file decides. Every field it produced is
// validated here before anything touches the database, and every reply is
// checked for Chinese characters before going out.

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function clean(text, max = 300) {
  return String(text == null ? '' : text)
    .replace(/\u2060/g, '')
    .replace(new RegExp(CJK.source, 'g'), '') // never pass Chinese on
    .trim()
    .slice(0, max);
}

// Must not be empty - if the model gave nothing usable we refuse to store junk.
function req(value, max = 300) {
  const v = clean(value, max);
  return v || null;
}

function hasRecordSymbol(text) {
  return /#(?:progress|kemajuan|material|bahan|issue|masalah|attendance|kehadiran)\b/i.test(String(text || ''));
}

function delayedEvidenceNeedsSymbol(msg) {
  return !msg.hasMedia && pendingIsDelayed(msg.from) && !hasRecordSymbol(msg.body);
}

function oneOf(value, allowed, fallback) {
  const v = clean(value, 60).toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

async function saveProgress(msg, r) {
  if (delayedEvidenceNeedsSymbol(msg)) return { ok: false, why: 'gambar yang dihantar tadi perlu symbol #, contoh #progress, sebelum direkod', ask: true };
  const hasEvidence = getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0;
  if (!hasEvidence) return { ok: false, why: 'gambar atau file bukti diperlukan sebelum progress direkod', ask: true };
  const description = req(r.description || r.update || r.note, 500);
  if (!description) return { ok: false, why: 'apa yang berlaku boss?', ask: true };

  const res = await progressDB.add({
    date: getToday(),
    category: req(r.work, 60) || 'Site Update',
    description,
    percentage: 0,
    location: req(r.location),
    reportedBy: getSenderName(msg),
    photo: null,
  });
  const id = res.lastInsertRowid;
  if (msg.hasMedia || getPhotoBatchSize(msg.from) > 0) {
    await attachPendingPhotos(progressDB, id, msg.from);
  }
  return { ok: true, id, text: `*Progress #${id}* dah masuk boss 📸\n${description.slice(0, 80)}` };
}

/**
 * One material line. `data` is a single item from the model.
 * Returns { id, label } or { error, ask } when a field is missing.
 */
async function saveOneMaterial(msg, data, photos = null) {
  const material = req(data.material || data.name, 150);
  if (!material) return { error: 'material apa boss?', ask: true };

  const quantity = req(data.quantity, 40);
  if (!quantity) return { error: `berapa banyak ${material} boss?`, ask: true, material };

  const res = await materialsDB.add({
    date: getToday(),
    materialName: material,
    category: oneOf(data.category, config_.materialCategories, 'Others'),
    quantity,
    unit: req(data.unit, 30) || 'unit',
    supplier: req(data.supplier),
    poNumber: req(data.po),
    location: req(data.location),
    receivedBy: getSenderName(msg),
    photo: null,
  });

  // Materials must carry photo evidence - same rule as .addmaterial.
  // `photos` is the batch snapshot taken once by the caller, so every line of a
  // multi-line delivery gets the same evidence and the batch is drained once at
  // the end (rather than the first record eating it).
  const picked = await attachPhotoPaths(materialsDB, res.lastInsertRowid, photos);
  if (!picked && pendingCount(msg.from) === 0) {
    await materialsDB.delete(res.lastInsertRowid);
    return { error: 'gambar atau file bukti diwajibkan boss. Hantar evidence dulu ya.' };
  }
  return { id: res.lastInsertRowid, label: `${material} (${quantity}${data.unit ? ' ' + req(data.unit, 30) : ''})`, photos: picked };
}

/**
 * Materials can arrive as a LIST in one message - "4 pallet cement, 1 pallet
 * sand brick, 20 bag cement" is three separate records, not one. Photos get
 * attached to the first line so the whole batch is evidenced once.
 */
async function saveMaterial(msg, r) {
  if (delayedEvidenceNeedsSymbol(msg)) return { ok: false, why: 'gambar yang dihantar tadi perlu symbol #, contoh #material, sebelum direkod', ask: true };
  const items = Array.isArray(r.items) && r.items.length ? r.items : [r];

  // Snapshot the waiting photos ONCE. Every line in this delivery points at the
  // same batch - they arrived together - and the batch is only cleared after the
  // last record is written.
  const photos = getPhotoBatchPaths(msg.from);
  const willDrain = photos.length > 0;

  const results = [];
  for (const item of items.slice(0, 30)) {
    const out = await saveOneMaterial(msg, item, photos);
    if (out.error) {
      // Partial failure: keep whatever already saved, but tell the user what
      // was missed so they can resend just that line.
      if (!results.length) return { ok: false, why: out.error, ask: !!out.ask };
      results.push({ error: out.error, material: out.material });
      continue;
    }
    results.push(out);
  }

  const saved = results.filter((x) => x.id);
  const failed = results.filter((x) => x.error);
  if (!saved.length) return { ok: false, why: failed[0].error };

  // Only now is the batch safe to clear.
  if (willDrain) clearPhotoBatch(msg.from);

  const photoNote = saved.some((s) => s.photos) ? ' 📸' : '';
  let text;
  if (saved.length === 1) {
    text = `*Material #${saved[0].id}* dah masuk boss - ${saved[0].label}${photoNote}`;
  } else {
    const lines = saved.map((s) => `• ${s.label}`).join('\n');
    text = `*${saved.length} materials* dah masuk boss${photoNote}\n${lines}`;
  }
  if (failed.length) {
    text += `\n\n⚠️ Belum masuk: ${failed.map((f) => `${f.material || ''} - ${f.error}`).join('; ')}`;
  }

  return { ok: true, ids: saved.map((s) => s.id), id: saved[0].id, text };
}

async function saveIssue(msg, r) {
  if (delayedEvidenceNeedsSymbol(msg)) return { ok: false, why: 'gambar yang dihantar tadi perlu symbol #, contoh #issue, sebelum direkod', ask: true };
  const hasEvidence = getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0;
  if (!hasEvidence) return { ok: false, why: 'gambar atau file bukti diperlukan sebelum issue direkod', ask: true };
  const title = req(r.title || r.problem, 150);
  const description = req(r.description || r.detail, 500);
  if (!title && !description) return { ok: false, why: 'apa masalahnya boss?', ask: true };

  const res = await issuesDB.add({
    date: getToday(),
    title: title || description.slice(0, 80),
    description: description || title,
    category: oneOf(r.category, config_.categories, 'Others'),
    priority: oneOf(r.priority, ['low', 'medium', 'high', 'urgent'], 'medium'),
    status: 'open',
    location: req(r.location),
    reportedBy: getSenderName(msg),
    photo: null,
  });
  const id = res.lastInsertRowid;
  if (msg.hasMedia || getPhotoBatchSize(msg.from) > 0) {
    await attachPendingPhotos(issuesDB, id, msg.from);
  }
  return { ok: true, id, text: `*Issue #${id}* dah catat boss - ${title || description.slice(0, 60)}` };
}

async function saveAttendance(msg, r) {
  if (delayedEvidenceNeedsSymbol(msg)) return { ok: false, why: 'gambar attendance yang dihantar tadi perlu symbol #, contoh #attendance, sebelum direkod', ask: true };
  const list = Array.isArray(r.workers) ? r.workers : [];
  if (!list.length) return { ok: false, why: 'nama siapa boss?' };
  const hasEvidence = getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0;
  if (!hasEvidence) return { ok: false, why: 'gambar atau file attendance diperlukan sebelum worker direkod', ask: true };

  let saved = 0;
  const savedIds = [];
  for (const w of list.slice(0, 60)) {
    const name = req(w.name || w.worker, 80);
    if (!name) continue;
    try {
      const result = await attendanceDB.add({
        date: getToday(),
        workerName: name,
        contractor: req(w.contractor),
        role: req(w.role),
        status: 'present',
        shift: req(w.shift, 40) || req(r.shift, 40),
        notes: null,
      });
      saved++;
      savedIds.push(result.lastInsertRowid);
    } catch (e) {
      console.error('attendance save failed:', e.message);
    }
  }
  if (!saved) return { ok: false, why: 'tiada worker berjaya disimpan' };
  return { ok: true, count: saved, ids: savedIds.filter(Boolean), text: `*${saved} orang* dah masuk untuk hari ini boss.` };
}

// Someone talking about attaching/pasting photos while photos are waiting.
// Covers "attach okey", "sikat gambar tu", "tampal gambar ni", "nak attach".
function looksLikeAttach(text) {
  return /\b(attach|sikat|tampal|letak|masukkan|paste)\b|\b(gambar|foto|photo|image|picture)\b/i.test(
    String(text || '')
  );
}

// The model sometimes writes a promise ("Ok jap tgh edit", "sudah tambah")
// even when it returned action "chat" - i.e. it says it did something it never
// did. Sending that is worse than silence, because the user walks away
// believing the record changed. Detect it and refuse to send it.
//
// `set` needs a closing \b: with set\w* the word "setengah" matched, so a plain
// progress answer ("...tanah atas kasaran tu hilang setengah") was thrown away
// and replaced with "saya tak pasti nak buat apa". Malay words that merely
// START with set (setengah, setiap, setakat, seterusnya) are not claims.
export function promisesAnAction(text) {
  return /\b(sudah|dah|tqk|tkq)\b[^.!]*\b(tambah|edit|update|ubah|masuk|simpan|set\b|record|rekod|close|tutup|delete|buang)\w*|\b(jap|sekejap|satu|sesaat|sedang)\b[^.!]*\b(edit|update|ubah|tambah|masuk)\w*|\b(letak|simpan|masukkan|edit)\s+(itu|ni|eh)\b|\bi\s*(?:'?ll|will)\b/i.test(
    String(text || '')
  );
}

function conversationalFallback(text) {
  const t = String(text || '').toLowerCase().replace(/@[\w.-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(siapa|who)\b/.test(t) && !/\b(kau siapa|awak siapa|bot siapa)\b/.test(t)) {
    return 'Kalau pasal orang dalam group, saya tak boleh confirm jawatan atau siapa dia tanpa info yang betul boss. Nak saya cari rekod site, atau tanya dia terus?';
  }
  if (/\b(nak aku|aku nak|saya nak).{0,30}\b(mari|datang)\b/.test(t)) {
    return 'Yang itu kena confirm dengan orangnya sendiri boss — saya tak boleh teka dia jadi datang atau tidak 😅';
  }
  if (/\b(butoh|bodoh|sial|babi)\b/.test(t)) {
    return 'Hahaha relax boss 😅 Saya ada sini. Nak saya bantu apa?';
  }
  if (/\?\s*$/.test(t)) {
    return 'Boleh boss, tapi bagi sikit konteks — nak saya semak rekod site atau jawab soalan biasa?';
  }
  return 'Hahaha ok boss 😅 Ada apa-apa nak saya settle?';
}

/** Safe chat reply: never let a fake confirmation through. */
async function safeChatReply(msg, text) {
  const cleanText = clean(text, 900);
  const menuReply = /(?:nak|mahu)\s+tengok\s+(?:progress|material|issue|attendance)|progress,\s*material,\s*issue\s+atau\s+attendance/i.test(cleanText);
  if (!cleanText || (menuReply && !/\b(progress|material|issue|attendance|drawing|pdf|file)\b/i.test(String(msg.body || '')))) {
    return msg.reply(conversationalFallback(msg.body));
  }
  if (promisesAnAction(cleanText)) {
    console.log(`[ai] blocked false confirmation: ${cleanText.slice(0, 90)}`);
    return msg.reply(
      'Maaf boss, saya tak pasti nak buat apa tu - jadi saya tak ubah apa-apa lagi.\n' +
      'Cuba cakap macam: "editkan operator projectss tambah nama Arif", atau guna `.edit`.'
    );
  }
  return msg.reply(cleanText);
}

// ── Mutating an EXISTING record (never creates a new one) ───────────────
const TABLES = {
  progress: () => progressDB,
  material: () => materialsDB,
  issue: () => issuesDB,
  attendance: () => attendanceDB,
};

// Project SS is one row per DAY, not one row per id - so it edits today's diary
// entry by date instead of by number.
//
// The values are the REAL snake_case SQL column names. setSection() interpolates
// the column into SQL text, so a camelCase value here became `sitename` and
// Postgres raised 'column "sitename" does not exist'. The diary rows also come
// back keyed by these names, so reading uses the same key.
const SS_FIELDS = {
  operator: 'operators',
  operators: 'operators',
  weather: 'weather',
  machinery: 'machinery',
  equipment: 'machinery_equipment',
  'machinery & equipment': 'machinery_equipment',
  machineryequipment: 'machinery_equipment',
  site: 'site_name',
  'site name': 'site_name',
  sitename: 'site_name',
  notes: 'general_notes',
  'general notes': 'general_notes',
  safety: 'safety_notes',
  'safety notes': 'safety_notes',
  visitors: 'visitors',
};

const SS_LABELS = {
  operators: 'Operator',
  weather: 'Weather',
  machinery: 'Machinery',
  machinery_equipment: 'Machinery & Equipment',
  site_name: 'Site',
  general_notes: 'General Notes',
  safety_notes: 'Safety Notes',
  visitors: 'Visitors',
};

const SS_KEY_LABEL = {
  operator: 'Operator',
  operators: 'Operator',
  weather: 'Weather',
  machinery: 'Machinery',
  equipment: 'Machinery & Equipment',
  'machinery & equipment': 'Machinery & Equipment',
  machineryequipment: 'Machinery & Equipment',
  site: 'Site',
  'site name': 'Site',
  notes: 'General Notes',
  'general notes': 'General Notes',
  safety: 'Safety Notes',
  'safety notes': 'Safety Notes',
  visitors: 'Visitors',
};

/** Sections that hold a LIST of names, so we can add to / remove from them. */
const SS_LIST_SECTIONS = new Set(['operators', 'machinery', 'machinery_equipment', 'visitors']);

// Words that mean "add to this list" vs "remove from it" vs "just set it".
const SS_ADD_WORDS = /\b(tambah|tambahkan|masukkan|masuk|add|append|tampal|letak|ada| baru)\b/i;
const SS_REMOVE_WORDS = /\b(buang|keluarkan|hapus|remove|delete|takde lagi|tidak ada lagi|buangkan|separate|pecah|dah tak dalam)\b/i;

// Split a stored section into individual entries. Sections are plain text
// written by people, so entries can be separated by newlines, commas, or
// semicolons - and people sometimes just wrote everything in one run.
// "arif dan zarif" / "arif and zarif" is also two names.
function splitEntries(text) {
  return String(text || '')
    .split(/\n|;|•|\s+\/\s+|\s+(?:dan|and)\s+|,/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const sameName = (a, b) =>
  String(a).trim().toLowerCase().replace(/\s+/g, ' ') === String(b).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Edit ONE Project SS section for today. The SS is "today" (one row per day),
 * so there is no id.
 *
 * The user means exactly one section - if they said "edit bahagian operator je",
 * only `operators` is written and every other section is left untouched. That is
 * why this writes with a targeted UPDATE instead of a full-row upsert.
 *
 * For list sections (operators, machinery, visitors) it understands three verbs:
 *   tambah/ada  -> append (never duplicate, never drop what's there)
 *   buang/hapus -> remove just that one entry
 *   plain value -> replace the whole section
 */
async function doEditSS(msg, r, { skipConfirm = false } = {}) {
  const fieldKey = oneOf(r.field, Object.keys(SS_FIELDS), '');
  if (!fieldKey) {
    return { ok: false, ask: true, why: `bahagian mana nak edit? (${Object.values(SS_KEY_LABEL).filter((v, i, a) => a.indexOf(v) === i).join(', ')})` };
  }

  const column = SS_FIELDS[fieldKey];
  const label = SS_KEY_LABEL[fieldKey];
  const date = r.date && /^\d{2}\/\d{2}\/\d{4}$/.test(r.date) ? r.date : getToday();
  const isList = SS_LIST_SECTIONS.has(column);

  // Read current value first so add/remove can preserve everything else.
  const current = await diaryDB.getByDate(date);
  const before = current?.[column] ?? '';

  const raw = String(r.value ?? '').trim();
  const intent = `${r.hint || ''} ${r.instruction || ''}`;
  const removing = SS_REMOVE_WORDS.test(raw) || SS_REMOVE_WORDS.test(intent);
  const adding = !removing && (SS_ADD_WORDS.test(raw) || SS_ADD_WORDS.test(intent));

  // Strip the instruction words from the value so they don't get stored.
  const cleanValue = raw
    .replace(/^\s*(tambah|tambahkan|masukkan|masuk|add|append|tampal|letak)\b\s*/i, '')
    .replace(/^\s*(buang|keluarkan|hapus|remove|delete|buangkan|separate)\b\s*/i, '')
    .replace(/\b(baru|je|only)\b\s*$/i, '')
    .trim();

  if (!cleanValue && !removing) {
    return { ok: false, ask: true, why: `nama/tec apa nak masuk dalam ${label} boss?` };
  }

  let next;
  let what;

  if (isList && removing) {
    const target = cleanValue || '';
    const entries = splitEntries(before);
    const kept = entries.filter((e) => !sameName(e, target));
    if (kept.length === entries.length) {
      return { ok: false, why: `${target || label} takde dalam ${label} boss - takde apa nak buang` };
    }
    next = kept.join('\n');
    what = `buang ${target}`;
  } else if (isList && adding) {
    const entries = splitEntries(before);
    // Add every name they listed, skipping any already present.
    const wanted = splitEntries(cleanValue);
    const added = [];
    for (const w of wanted) {
      if (entries.some((e) => sameName(e, w)) || added.some((e) => sameName(e, w))) continue;
      entries.push(w);
      added.push(w);
    }
    if (!added.length) {
      return { ok: false, why: `${wanted.join(', ')} dah ada dalam ${label} boss` };
    }
    next = entries.join('\n');
    what = `tambah ${added.join(', ')}`;
  } else if (isList) {
    // Plain value on a list section = replace the whole list.
    next = splitEntries(cleanValue).join('\n');
    what = 'tukar senarai';
  } else {
    next = cleanValue;
    what = adding ? 'tambah' : 'tukar';
  }

  if (!skipConfirm) {
    queueMutation(msg, { kind: 'edit', record: r });
    return { ok: false, confirm: true, why: `Confirm edit *Project SS ${date}* — ${label} (${what})? Reply *YES* untuk teruskan atau *NO* untuk batal.` };
  }

  // Targeted write: only this one column moves, all other sections untouched.
  await diaryDB.setSection(date, column, next);

  console.log(`[ai] projectss ${date} ${column} ${what} -> ${JSON.stringify(next)}`);

  const shown = isList
    ? next.split('\n').map((e) => `• ${e}`).join('\n')
    : next;
  return {
    ok: true,
    text: `*Project SS* — ${label} sahaja ✅ (${what})\n${shown}`,
  };
}

// Which fields each record type is allowed to change, and the DB column each
// one writes to. Anything not listed here cannot be edited by the bot.
const EDITABLE = {
  progress: { description: 'description', location: 'location' },
  material: { material: 'material_name', name: 'material_name', quantity: 'quantity', unit: 'unit', supplier: 'supplier', location: 'location', po: 'po_number' },
  issue: { title: 'title', description: 'description', location: 'location', priority: 'priority', category: 'category', resolution: 'resolution' },
  attendance: { shift: 'shift', status: 'status', role: 'role', contractor: 'contractor' },
};

function editableTypes() {
  return [...Object.keys(EDITABLE), 'ss'].join(', ');
}

const WANT_ALL = /\b(all|semua|semuanya|everything)\b/i;

/**
 * Close / settle one or MANY existing issues.
 *
 * "closekan issue 12, 11 and no 9" and "close all issue yg ada" are both normal
 * at a site - people close off a batch in one breath. This used to take a single
 * id and answered "issue nombor berapa?" for anything else, which made the bot
 * look like it could not follow a simple instruction. Multi-id and "all" are now
 * handled here, in order, reporting exactly which ones closed and which did not.
 */
async function doResolve(msg, r) {
const status = oneOf(r.status, ['resolved', 'closed', 'in_progress', 'open'], 'resolved');
const resolution = req(r.resolution, 300) || 'Closed by site team';

// "close all" - resolve everything still open, and say how many.
if (WANT_ALL.test(String(r.all ?? r.instruction ?? '')) || WANT_ALL.test(String(msg.body || ''))) {
const open = await issuesDB.getOpenIssues();
if (!open.length) return { ok: false, why: 'takde open issue dah boss - semua dah tutup' };

const closed = [];
for (const issue of open) {
const res = await issuesDB.updateStatus(issue.id, status, resolution);
if (res && res.changes > 0) {
closed.push(issue);
console.log(`[ai] issue #${issue.id} -> ${status} (bulk "all")`);
}

}
if (!closed.length) return { ok: false, why: 'takde issue boleh ditutup boss' };

const lines = closed.map((i) => `• #${i.id} ${String(i.title || '').slice(0, 60)}`).join('\n');
return { ok: true, text: `*${closed.length} issue dah tutup* boss ✅\n${lines}\n\n> ${resolution}` };
}

const ids = collectIds(r, msg.body);
if (!ids.length) return { ok: false, ask: true, why: 'issue nombor berapa?' };

const closed = [];
const missing = [];
for (const id of ids) {
const issue = await issuesDB.getById(id);
if (!issue) {
missing.push(id);
continue;
}
await issuesDB.updateStatus(id, status, resolution);
closed.push({ id, title: issue.title });
console.log(`[ai] issue #${id} -> ${status} (${resolution})`);
}

if (!closed.length) {
return { ok: false, why: `issue #${ids.join(', ')} tak jumpa dalam DB boss` };
}

if (closed.length === 1) {
const [one] = closed;
return { ok: true, text: `*Issue #${one.id} dah tutup* boss ✅\n${one.title}\n> ${resolution}` };
}

const lines = closed.map((c) => `• #${c.id} ${String(c.title || '').slice(0, 60)}`).join('\n');
let text = `*${closed.length} issue dah tutup* boss ✅\n${lines}\n\n> ${resolution}`;
if (missing.length) text += `\n\n_Tak jumpa: ${missing.map((m) => `#${m}`).join(', ')}_`;
return { ok: true, text };
}

// Clear, human wording should not need an LLM to close an issue. WhatsApp
// commonly receives these as "tlg close issue #13 @KERANI" or "settle issue 13".
function directCloseRequest(text) {
  const raw = String(text || '')
    .replace(/@[\w.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\b(close|closekan|tutup|tutupkan|settle|resolved?|resolve|selesaikan)\b/i.test(raw)) return null;
  if (!/\b(issue|issues|masalah|problem)\b/i.test(raw)) return null;
  if (/\b(all|semua|semuanya)\b/i.test(raw)) return { all: true, status: 'closed', resolution: 'Closed by site team' };
  const ids = [...raw.matchAll(/#(\d+)|\b(?:issue|issues|masalah|problem)\s*(?:no\.?|nombor)?\s*(\d+)\b/gi)]
    .map((m) => Number(m[1] || m[2]))
    .filter(Boolean);
  return ids.length ? { ids: [...new Set(ids)], status: 'closed', resolution: 'Closed by site team' } : null;
}

/**
 * "buang no 20, 19, 21 dari attendance" / "delete issues 4, 7 and 9" - people
 * list several numbers in one breath. The model can only hand us one id, so pull
 * every id out of the raw text as a fallback.
 */
/**
 * Every record number the user named, in order, de-duplicated.
 *
 * People speak in runs of numbers: "issue 12, no 11, and no 9", "tutup 20 19 21",
 * "buang no 4, 7 and 9". The old version only accepted a hand-picked pattern
 * (a literal 20|19|21 or "digits,digits"), so "issue no 12, no 11, and no 9" came
 * back empty and the bot asked "issue nombor berapa?" three times in a row.
 *
 * A number is treated as a record id when it follows an id word ("no", "nombor",
 * "#", "issue") or when the sentence is a list of numbers. Quantities are the
 * risk ("close issue 12 dan tambah 4 bag simen"), so we drop a number that is
 * glued to a unit.
 */
function collectIds(r, text) {
  const fromRecord = []
    .concat(r.id ?? [])
    .concat(r.ids ?? [])
    .concat(r.recordId ?? [])
    .concat(r.numbers ?? [])
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

// `original` keeps the untouched text so the unit test below still sees "m3";
  // `stripped` has unit-internal digits ("m3", "m2", "20mm") removed so the 3 in
  // "m3" is never mistaken for record #3.
  const original = String(text || '');
  const stripped = original.replace(/\b[a-z]+\d+\w*\b/gi, ' ');
  const unique = [...new Set(fromRecord)];

  // Bare numbers in the message, minus any that are clearly quantities
  // ("4 bag", "12 m3", "3 hari").
  const UNIT = '(?:bag|bgs|pcs|unit|m3|m2|ton|mt|kg|hari|day|load|lori|set|bundle|pallet|roll|column|bar)';
  const mentioned = (stripped.match(/\d+/g) || [])
    .map(Number)
    .filter((n) => n > 0)
    .filter((n) => !new RegExp(`\\b${n}\\s*${UNIT}\\b`, 'i').test(original));

  return [...new Set([...unique, ...mentioned])];
}

/** Change one field of an existing record. */
async function doEdit(msg, r, { skipConfirm = false } = {}) {
  // Project SS is handled by date, not by id.
  const wantsSS = /\b(ss|projectss|project ss|laporan|report)\b/i.test(String(r.type || '')) ||
    /\b(ss|projectss)\b/i.test(String(r.record || r.recordType || r.what || ''));
  if (wantsSS) return doEditSS(msg, r, { skipConfirm });

  const id = parseInt(r.id, 10);
  const type = oneOf(r.type, [...Object.keys(EDITABLE), 'ss'], '');
  if (!type) return { ok: false, ask: true, why: `edit record yang mana? (${editableTypes()}, projectss)` };
  if (type === 'ss') return doEditSS(msg, r, { skipConfirm });
  if (!id) return { ok: false, ask: true, why: `nombor ${type} mana?` };

  const field = oneOf(r.field, Object.keys(EDITABLE[type]), '');
  if (!field) {
    return { ok: false, ask: true, why: `field mana nak diubah? (${Object.keys(EDITABLE[type]).join(', ')})` };
  }
  const value = r.value;
  if (value === null || value === undefined || value === '') {
    return { ok: false, ask: true, why: `nilai baru untuk ${field}?` };
  }

  const column = EDITABLE[type][field];
  let data;
  if (field === 'quantity') {
    data = { [column]: parseFloat(value) || 0 };
  } else {
    data = { [column]: req(value, 300) };
  }

  // Two-step like delete: the model reads the whole group chat, so a member's
  // message can steer it into proposing an edit the admin never asked for.
  if (!skipConfirm) {
    queueMutation(msg, { kind: 'edit', record: r });
    return { ok: false, confirm: true, why: `Confirm edit *${type} #${id}*: ${field} → ${data[column]}? Reply *YES* untuk teruskan atau *NO* untuk batal.` };
  }

  const res = await TABLES[type]().update(id, data);
  if (!res || res.changes === 0) return { ok: false, why: `${type} #${id} tak jumpa dalam DB boss` };

  const fresh = await TABLES[type]().getById(id);
  console.log(`[ai] ${type} #${id}: ${field} -> ${data[column]}`);
  return { ok: true, text: `*${type} #${id} dah kemas* ✅\n${field}: ${data[column]}` };
}

/**
 * Remove records. Refuses without a type so nothing is deleted blind.
 *
 * Handles several ids at once ("buang no 20, 19, 21 dari attendance") and,
 * for attendance, names as well ("buang nama workers abu, ali, anat"). A name
 * that is not in today's list is reported, never guessed at.
 */
async function doDelete(msg, r, rawText, { skipConfirm = false } = {}) {
  if (!await isAdminMessage(msg)) return { ok: false, why: 'delete hanya untuk admin/supervisor boss' };
  const type = oneOf(r.type, Object.keys(TABLES), '');
  if (!type) return { ok: false, ask: true, why: `delete yang mana? (${Object.keys(TABLES).join(', ')})` };

  // People also delete by NAME ("buang nama workers abu, ali, anat"), which is
  // far more natural at a site than reciting row ids.
  const named = [r.name, r.worker, r.workers, r.names]
    .flat()
    .map((n) => String(n || '').trim())
    .filter(Boolean);

  if (named.length && type === 'attendance') {
    const rows = await attendanceDB.getByNames(getToday(), named);
    if (!skipConfirm) {
      queueMutation(msg, { record: r, rawText });
      return { ok: false, confirm: true, why: `Confirm delete attendance untuk *${named.join(', ')}* hari ini? Reply *YES* untuk teruskan atau *NO* untuk batal.` };
    }
    const notThere = named.filter((n) => !rows.some((row) => sameName(row.worker_name, n)));
    const deletedNames = [];
    for (const row of rows) {
      const res = await attendanceDB.delete(row.id);
      if (res && res.changes > 0) deletedNames.push(row.worker_name);
      console.log(`[ai] attendance ${row.worker_name} (#${row.id}) deleted by name`);
    }
    if (!deletedNames.length) {
      return { ok: false, why: `${notThere.join(', ') || named.join(', ')} takde dalam attendance hari ni boss` };
    }
    let text = deletedNames.length === 1
      ? `*${deletedNames[0]}* dah buang dari attendance hari ni 🗑️`
      : `*${deletedNames.length} worker* dah buang dari attendance hari ni 🗑️\n${deletedNames.map((n) => `• ${n}`).join('\n')}`;
    if (notThere.length) text += `\n\n_Tak jumpa: ${notThere.join(', ')}_`;
    return { ok: true, text };
  }

  const ids = collectIds(r, rawText);
  if (!ids.length) return { ok: false, ask: true, why: `nombor ${type} mana?` };

  if (!skipConfirm) {
    queueMutation(msg, { record: r, rawText });
    return { ok: false, confirm: true, why: `Confirm delete *${type} #${ids.join(', #')}*? Reply *YES* untuk teruskan atau *NO* untuk batal.` };
  }

  const deleted = [];
  const missing = [];
  for (const id of ids) {
    const res = await TABLES[type]().delete(id);
    if (res && res.changes > 0) {
      deleted.push(id);
      console.log(`[ai] ${type} #${id} deleted`);
    } else {
      missing.push(id);
    }
  }

  if (!deleted.length) return { ok: false, why: `${type} #${ids.join(', ')} tak jumpa dalam DB boss` };

  let text = deleted.length === 1
    ? `*${type} #${deleted[0]} dah buang* 🗑️`
    : `*${deleted.length} ${type} records* dah buang 🗑️\n${deleted.map((i) => `• #${i}`).join('\n')}`;
  if (missing.length) text += `\n\n_Tak jumpa: ${missing.map((i) => `#${i}`).join(', ')}_`;
  return { ok: true, text };
}

/**
 * Attach the photos waiting in this group's batch to one record.
 * - They gave a record id  -> link to that record.
 * - They gave none         -> create a fresh record from the LLM fields first.
 */
async function doAttach(msg, r) {
  const target = oneOf(r.target, ['progress', 'material', 'issue'], '');
  if (!target) return { ok: false, why: 'kata progress, material atau issue' };

  const waiting = getPhotoBatchSize(msg.from);
  if (!waiting && !msg.hasMedia) {
    return { ok: false, why: 'takde gambar menunggu boss. Hantar gambar dulu - dalam 1 minit antara satu sama lain ya.' };
  }

  const id = parseInt(r.id, 10);
  const label = target.charAt(0).toUpperCase() + target.slice(1);

  // Attach to an existing record.
  if (id > 0) {
    const result = await handleAttach(msg, [target, String(id)]);
    return { ok: true, text: `*${waiting || 1} photo(s)* -> ${label} #${id}` , passthrough: result };
  }

  // No id: build the record they described, then attach the batch to it.
  const created = await ({ progress: saveProgress, material: saveMaterial, issue: saveIssue })[target](msg, r);
  if (!created.ok) return { ok: false, why: created.why };
  return { ok: true, text: `${created.text} with ${waiting || 1} photo(s) attached`, passthrough: created.passthrough };
}

/**
 * Pending items: the follow-up list of things agreed but not finished.
 *
 * Separate from issues (a fault someone reported) and progress (work completed),
 * because "Azman tolong tapis paip" is neither - it is a promise. Keeping it in
 * chat text meant it was forgotten the moment the conversation moved on.
 */
async function doPending(msg, r) {
  const mode = oneOf(r.mode, ['list', 'add', 'close', 'update', 'search'], 'list');

  if (mode === 'list') {
    const open = await pendingDB.getOpen(30);
    if (!open.length) return { ok: true, text: '*Takde pending item* boss — semua dah settle ✅' };
    const lines = open.map((p) => {
      const bits = [`• #${p.id} ${String(p.task || '').slice(0, 60)}`];
      if (p.pic) bits.push(`PIC ${p.pic}`);
      if (p.due_date) bits.push(`due ${p.due_date}`);
      if (p.status !== 'open') bits.push(p.status);
      if (p.priority) bits.push(p.priority);
      return bits.join(' · ');
    });
    return { ok: true, text: `*${open.length} pending item* 📌\n${lines.join('\n')}` };
  }

  if (mode === 'add') {
    const task = req(r.task, 300);
    if (!task) return { ok: false, ask: true, why: 'pending apa boss?' };
    const id = await pendingDB.add({
      date: getToday(),
      task,
      pic: req(r.pic, 80) || null,
      location: req(r.location, 120) || null,
      dueDate: req(r.dueDate, 30) || null,
      status: 'open',
      priority: oneOf(r.priority, ['low', 'medium', 'high', 'urgent'], 'medium'),
      notes: req(r.notes, 500) || null,
      raisedBy: msg._data?.notifyName || msg.author || 'unknown',
    });
    console.log(`[ai] pending #${id} added`);
    return { ok: true, text: `*Pending #${id}* dicatat 📌 ${task}` };
  }

  if (mode === 'search') {
    const term = req(r.term, 120) || req(r.task, 120);
    if (!term) return { ok: false, ask: true, why: 'cari pending apa boss?' };
    const hits = await pendingDB.search(term, 15);
    if (!hits.length) return { ok: true, text: `Takde pending item pasal "${term}" boss` };
    const lines = hits.map((p) => `• #${p.id} [${p.status}] ${String(p.task || '').slice(0, 60)}`);
    return { ok: true, text: `*Pending pasal "${term}"*\n${lines.join('\n')}` };
  }

  // close / update both work off record numbers, and both accept a list.
  const ids = collectIds(r, msg.body);
  const wantsAll = WANT_ALL.test(String(r.all ?? r.instruction ?? '')) || WANT_ALL.test(String(msg.body || ''));

  if (mode === 'close') {
    const targets = ids.length
      ? ids.map((id) => ({ id }))
      : wantsAll
        ? await pendingDB.getOpen(100)
        : [];
    if (!targets.length) return { ok: false, ask: true, why: 'pending nombor berapa boss?' };

    const closed = [];
    const missing = [];
    for (const t of targets) {
      const item = await pendingDB.getById(t.id);
      if (!item) {
        missing.push(t.id);
        continue;
      }
      await pendingDB.close(t.id, req(r.note ?? r.notes, 200) || null);
      closed.push({ id: t.id, task: item.task });
      console.log(`[ai] pending #${t.id} closed`);
    }
    if (!closed.length) return { ok: false, why: `pending #${ids.join(', ') || '(all)'} tak jumpa boss` };

    let text =
      closed.length === 1
        ? `*Pending #${closed[0].id} dah tutup* boss ✅ ${closed[0].task}`
        : `*${closed.length} pending item dah tutup* boss ✅\n${closed.map((c) => `• #${c.id} ${String(c.task || '').slice(0, 60)}`).join('\n')}`;
    if (missing.length) text += `\n\n_Tak jumpa: ${missing.map((m) => `#${m}`).join(', ')}_`;
    return { ok: true, text };
  }

  // update
  if (!ids.length) return { ok: false, ask: true, why: 'pending nombor berapa boss?' };
  const patch = {};
  if (r.pic) patch.pic = req(r.pic, 80);
  if (r.dueDate) patch.dueDate = req(r.dueDate, 30);
  if (r.location) patch.location = req(r.location, 120);
  if (r.priority) patch.priority = oneOf(r.priority, ['low', 'medium', 'high', 'urgent'], 'medium');
  if (r.notes) patch.notes = req(r.notes, 500);
  if (!Object.keys(patch).length) return { ok: false, ask: true, why: 'nak change apa boss?' };

  const changed = [];
  const missing = [];
  for (const id of ids) {
    const item = await pendingDB.getById(id);
    if (!item) {
      missing.push(id);
      continue;
    }
    await pendingDB.update(id, patch);
    changed.push(id);
    console.log(`[ai] pending #${id} updated -> ${Object.keys(patch).join(',')}`);
  }
  if (!changed.length) return { ok: false, why: `pending #${ids.join(', ')} tak jumpa boss` };

  const what = Object.entries(patch)
    .map(([k, v]) => `${k} -> ${v}`)
    .join(', ');
  let text = `*Pending #${changed.join(', #')}* dikemas kini ✅ ${what}`;
  if (missing.length) text += `\n\n_Tak jumpa: ${missing.map((m) => `#${m}`).join(', ')}_`;
  return { ok: true, text };
}

/**
 * Main entry.
 * @param {boolean} interactive true when the user addressed the bot directly.
 */
export async function handleTaggedMessage(msg, { context = [], hasMedia = false, interactive = true, decision: givenDecision = null } = {}) {
  if (!isConfigured()) {
    if (!interactive) return undefined;
    return msg.reply('LLM belum di-set - command biasa still berfungsi.');
  }

  // Resolve a pending YES/NO before greetings, date lookups or the LLM.  This
  // prevents "YES" from being mistaken for a new site question.
  if (interactive && !hasMedia && await handleMutationConfirmation(msg)) return;

  // Greetings are conversation, not a request for a site report. Keep this
  // deterministic so an LLM cannot turn "@Kerani hello bro" into a default
  // `view(progress)` action and reply with "No progress recorded today".
  if (interactive && !hasMedia && isGreetingOnly(msg.body)) {
    return msg.reply('Hello boss 👋 Apa nak saya bantu?');
  }
  if (interactive && !hasMedia && isIdentityQuestion(msg.body)) {
    return msg.reply(
      'Saya Kerani — supervisor site dalam group ni, bos. Saya bantu urus progress, material, issue, attendance, claim, drawing/PDF dan gambar site.'
    );
  }

  // Hard rule: never speak unless tagged. Auto-capture still files the record,
  // but stays completely silent in the group.
// Successful saves. With SILENT_ON_SUCCESS (the default) the site gets an
// emoji on their message and nothing else - no "dah masuk boss, material 14".
// The record still exists and still has its id; they just do not need to read
// about it. Set SILENT_ON_SUCCESS=false to get the text confirmations back.
const say = async (text) => {
  if (!text) return undefined;
  if (!interactive) {
    console.log(`[auto] ${text.replace(/\*/g, '')}`);
    return undefined;
  }
  if (config.silentOnSuccess) {
    await react(msg, REACTIONS.saved);
    return true;
  }
  return msg.reply(text);
};

  // When auto-capture fails to save (e.g. material without photo), DO NOT
  // reply in the group - just log it. This keeps silent auto-save truly silent.
  const fail = async (text) => {
    if (interactive) return msg.reply(text);
    console.log(`[auto-fail] ${text.replace(/\*/g, '')}`);
    return undefined;
  };

  // Explicit media labels are the sender's instruction, not an AI suggestion.
  // A caption such as "#progress install pipe 400mm" must create a progress
  // row immediately; otherwise the file gets stored but the later progress
  // query quite correctly finds nothing.
  const labelled = explicitMediaInstruction(msg.body);
  if (hasMedia && labelled?.action === 'progress') {
    const out = await saveProgress(msg, { description: labelled.description });
    if (!out.ok) return fail(`Tak dapat simpan progress - ${out.why}`);
    await linkPendingFiles(msg.from, 'progress', out.id);
    console.log(`[ai] explicit #progress #${out.id} saved from media caption`);
    return say(out.text);
  }
  if (hasMedia && labelled?.action === 'material') {
    const out = await saveMaterial(msg, { material: labelled.material, quantity: labelled.quantity, unit: labelled.unit });
    if (!out.ok) return fail(`Tak dapat simpan material - ${out.why}`);
    for (const id of out.ids || [out.id]) await linkPendingFiles(msg.from, 'material', id);
    console.log(`[ai] explicit material #${out.id} saved from media caption`);
    return say(out.text);
  }
  if (hasMedia && labelled?.action === 'attendance') {
    const out = await saveAttendance(msg, { workers: labelled.workers });
    if (!out.ok) return fail(`Tak dapat simpan attendance - ${out.why}`);
    if (out.ids?.[0]) await linkPendingFiles(msg.from, 'attendance', out.ids[0]);
    console.log(`[ai] explicit attendance saved: ${out.count} worker(s)`);
    return say(out.text);
  }
  if (hasMedia && labelled?.action === 'issue') {
    const out = await saveIssue(msg, { title: labelled.title, description: labelled.description, priority: labelled.priority });
    if (!out.ok) return fail(`Tak dapat simpan issue - ${out.why}`);
    await linkPendingFiles(msg.from, 'issue', out.id);
    console.log(`[ai] explicit issue #${out.id} saved from media caption`);
    return say(out.text);
  }

  // A forwarded photo often arrives first with no caption, followed by a
  // separate message such as "3 workers masaji badsha sarino". Complete the
  // attendance record from that description while the photo/file batch is
  // still live, instead of treating the words as a view query.
  if (interactive && !hasMedia && (getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0)) {
    const pendingLabel = explicitMediaInstruction(msg.body);
    const pendingText = String(msg.body || '').trim();
    const isAttendanceQuery = /^(?:\.?\s*)(?:attendance|kehadiran|workers?|pekerja)(?:\s+(?:today|hari\s*ini|harini|semalam|yesterday))?\s*[?؟.!]*$/i.test(pendingText);
    if (pendingLabel?.action === 'attendance' && !/^\./.test(pendingText) && !isAttendanceQuery && !/[?؟]\s*$/.test(pendingText)) {
      const out = await saveAttendance(msg, { workers: pendingLabel.workers });
      if (!out.ok) return fail(`Tak dapat simpan attendance - ${out.why}`);
      if (out.ids?.[0]) await linkPendingFiles(msg.from, 'attendance', out.ids[0]);
      console.log(`[ai] attendance completed from separate photo description: ${out.count} worker(s)`);
      return say(out.text);
    }
  }

  // Simple read requests should not depend on the LLM choosing the right
  // action. The user's record keyword and date are authoritative.
  if (interactive && !hasMedia) {
    const pendingReminder = takePendingReminder(reminderConversationKey(msg));
    const reminder = parseReminderRequest(pendingReminder ? `${pendingReminder} ${msg.body}` : msg.body);
    if (reminder) {
      if (reminder.needsTime) {
        rememberPendingReminder(reminderConversationKey(msg), pendingReminder || msg.body);
        return msg.reply('Boleh bos — pukul berapa nak saya setkan reminder tu?');
      }
      const saved = await remindersDB.add({
        eventAt: reminder.eventAt,
        title: reminder.title,
        createdBy: msg.author || msg.from,
      });
      const display = reminder.eventAt.replace('T', ' ').slice(0, 16);
      return msg.reply('Okay noted bos, nanti saya remind balik.');
    }

    // If the user sent the worker names as a plain message immediately before
    // asking "attendance?", recover that description from the per-group
    // context buffer and consume the waiting forwarded photo with it.
    if (getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0) {
      const recent = [...(context || [])].reverse()
        .filter((entry) => String(entry?.text || '').trim() !== String(msg.body || '').trim())
        .map((entry) => explicitMediaInstruction(entry?.text))
        .find((candidate) => candidate?.action === 'attendance' && candidate.workers?.length);
      if (recent) {
        const out = await saveAttendance(msg, { workers: recent.workers });
        if (!out.ok) return fail(`Tak dapat simpan attendance - ${out.why}`);
        if (out.ids?.[0]) await linkPendingFiles(msg.from, 'attendance', out.ids[0]);
        console.log(`[ai] attendance completed from recent separate description: ${out.count} worker(s)`);
        const { handleAttendance } = await import('./diary.js');
        return handleAttendance(msg, [getToday()]);
      }
    }
    const close = directCloseRequest(msg.body);
    if (close) {
      const out = await doResolve(msg, close);
      if (!out.ok) return msg.reply(`Tak dapat close - ${out.why}`);
      return msg.reply(out.text);
    }
    const direct = directViewRequest(msg.body);
    if (direct) {
      if (direct.what === 'progress') {
        const { handleProgress } = await import('./progress.js');
        return handleProgress(msg, direct.date ? [direct.date] : []);
      }
      if (direct.what === 'material') {
        const { handleMaterials } = await import('./materials.js');
        return handleMaterials(msg, [direct.date || getToday()]);
      }
      if (direct.what === 'issue') {
        const { handleIssues, handleIssuesForDate } = await import('./issues.js');
        return direct.date
          ? handleIssuesForDate(msg, direct.date, { openOnly: true })
          : handleIssuesForDate(msg, getToday(), { openOnly: true });
      }
      if (direct.what === 'attendance') {
        const { handleAttendance } = await import('./diary.js');
        return handleAttendance(msg, [direct.date || getToday()]);
      }
      if (direct.what === 'ss') {
        const { showReport } = await import('./projectss.js');
        return showReport(msg, direct.date || getToday());
      }
    }
  }

  let decision = givenDecision;
  try {
    if (!decision) {
      // Show the model what is really in the DB (with photo counts) so questions
      // like "boleh bagi gambar progress?" are answered from records, not from
      // recent chat text. `site` is the group's own schema, passed explicitly.
      let snapshot = '';
      try {
        snapshot = await buildRecordSnapshot(currentSite());
      } catch (e) {
        console.log(`[ai] record snapshot unavailable: ${e.message || e}`);
      }

      // Keyword recall. The snapshot only covers the last few records, so
      // "pasti issue paip" or "cari progress blok A" found nothing even when the
      // record existed. This searches the whole history for the words they used.
      let recall = '';
      try {
        recall = await recallRecords(currentSite(), msg.body);
      } catch (e) {
        console.log(`[ai] recall unavailable: ${e.message || e}`);
      }

      decision = await askGemini({
        userText: msg.body,
        context,
        hasPendingPhoto: hasMedia,
        pendingPhotoCount: getPhotoBatchSize(msg.from),
        recordSnapshot: snapshot + recall,
      });
    }
  } catch (err) {
    console.error('LLM call failed:', err.message);
    return interactive ? msg.reply('AI tak dapat respond sekarang. Cuba lagi atau guna .help.') : undefined;
  }

  // Accept ids at the TOP level too, not just inside "record". The prompt tells
  // the model it may use a flat {"action":"resolve","ids":[12,11,9]}, and models
  // do exactly that - so merge it rather than dropping the numbers on the floor.
  const r = { ...(decision.record || {}) };
  if (decision.ids != null) {
    const extra = [].concat(decision.ids).filter((n) => n !== null && n !== undefined && n !== '');
    if (extra.length) r.ids = [].concat(r.ids ?? [], extra);
  }
  if (decision.id != null && r.id == null) r.id = decision.id;
  // A nested {record:{...}} from the model - flatten it, keeping what we already
  // extracted from the top level.
  if (r.record && typeof r.record === 'object') Object.assign(r, r.record);

  // When the model already spotted a missing field it wrote the question into
  // "reply". Prefer our own precise question, fall back to theirs - but never
  // send a promised-but-not-done confirmation as a question.
  const askBack = (why) => {
    const modelQ = clean(decision.reply, 300);
    const question = modelQ && !promisesAnAction(modelQ) ? modelQ : why;
    if (!interactive) {
      console.log(`[auto-ask] ${question}`);
      return undefined;
    }
    return msg.reply(`${question}\n\n_(Jap reply, bot terus masukkan_)`);
  };

  try {
    switch (decision.action) {
      case 'progress': {
        const out = await saveProgress(msg, r);
        if (!out.ok) return out.ask ? askBack(out.why) : fail(`Tak dapat simpan progress - ${out.why}`);
        console.log(`[ai] progress #${out.id} saved`);
        // The photos/files that came with this message belong to this progress,
        // not to whatever was said next.
        await linkPendingFiles(msg.from, 'progress', out.id);
        return say(out.text);
      }

      case 'material': {
        const out = await saveMaterial(msg, r);
        if (!out.ok) return out.ask ? askBack(out.why) : fail(`Tak dapat simpan material - ${out.why}`);
        console.log(`[ai] material #${out.id} saved`);
        // A delivery photo is evidence for the material it arrived with.
        for (const id of out.ids || [out.id]) await linkPendingFiles(msg.from, 'material', id);
        return say(out.text);
      }

      case 'issue': {
        const out = await saveIssue(msg, r);
        if (!out.ok) return out.ask ? askBack(out.why) : fail(`Tak dapat simpan issue - ${out.why}`);
        console.log(`[ai] issue #${out.id} saved`);
        await linkPendingFiles(msg.from, 'issue', out.id);
        return say(out.text);
      }

      case 'attendance': {
        const out = await saveAttendance(msg, r);
        if (!out.ok) return fail(`Tak dapat simpan attendance - ${out.why}`);
        if (out.ids?.[0]) await linkPendingFiles(msg.from, 'attendance', out.ids[0]);
        console.log(`[ai] ${out.count} worker saved`);
        return say(out.text);
      }

      case 'resolve': {
        if (!interactive) return undefined;
        const out = await doResolve(msg, r);
        if (out.ask) return askBack(out.why);
        if (!out.ok) return msg.reply(`Tak dapat close - ${out.why}`);
        return msg.reply(out.text);
      }

      case 'edit': {
        if (!interactive) return undefined;
        if (!await isAdminMessage(msg)) return msg.reply('Edit rekod hanya untuk admin/supervisor boss.');
        const out = await doEdit(msg, r);
        if (out.confirm) return msg.reply(out.why);
        if (out.ask) return askBack(out.why);
        if (!out.ok) return msg.reply(`Tak dapat edit - ${out.why}`);
        return msg.reply(out.text);
      }

case 'delete': {
              if (!interactive) return undefined;
              const out = await doDelete(msg, r, msg.body);
        if (out.confirm) return msg.reply(out.why);
        if (out.ask) return askBack(out.why);
        if (!out.ok) return msg.reply(`Tak dapat delete - ${out.why}`);
        return msg.reply(out.text);
      }

      case 'pending': {
        // Listing/searching is a read, so it answers even in auto-capture mode.
        const out = await doPending(msg, r);
        if (out.ask) return askBack(out.why);
        if (!out.ok) return msg.reply(`Tak dapat buat pending - ${out.why}`);
        return say(out.text);
      }

      case 'combine': {
        if (!interactive) return undefined;
        // Merging files makes a new artefact and sends it back, so it only ever
        // runs when the user is actually watching (never in auto-capture).
        const { doCombinePdf } = await import('./compile.js');
        const site = currentSite();
        const out = await doCombinePdf(msg, {
          ...r,
          sender: r.sender || null,
          siteName: site?.siteName || r.siteName || '',
        });
        if (!out.ok) return msg.reply(out.text);
        console.log(`[ai] compiled #${out.file?.id}: ${out.pages} pages from ${out.used} files`);
        // doCombinePdf already sent the pdf with its caption.
        return undefined;
      }

      case 'attach': {
        if (!interactive) return undefined;
        const out = await doAttach(msg, r);
        if (out.passthrough) return out.passthrough;
        if (!out.ok) {
          // The model picks "attach" whenever the photo queue is non-empty, so a
          // request like "tengok progress harini" landed here and got the lecture
          // about a photo the user never mentioned. If their own words are not
          // about photos, this is a misclassification - answer what they asked
          // for instead of the attach error.
          if (!looksLikeAttach(msg.body)) {
            return safeChatReply(msg, clean(decision.reply, 900));
          }
          return msg.reply(`Tak dapat attach - ${out.why}`);
        }
        console.log('[ai] photos attached');
        return msg.reply(out.text);
      }

      // "attach okey" is clear enough to act on even when the model files it as
      // chat. Photos waiting + someone talking about pictures = attach them.
      case 'chat':
      default: {
        if (interactive && looksLikeAttach(msg.body) && getPhotoBatchSize(msg.from)) {
          const out = await doAttach(msg, r);
          if (out.passthrough) return out.passthrough;
          if (out.ok) return msg.reply(out.text);
        }

        const text = clean(decision.reply, 900);
        if (!interactive) return undefined;
        return safeChatReply(msg, text);
      }

      case 'ss': {
        if (!interactive) return undefined;
        const { showReport } = await import('./projectss.js');
        return showReport(msg, getToday());
      }

      case 'view': {
        if (!interactive) return undefined;
        // The user's words are the source of truth for dates. Never trust a
        // model date that was not actually mentioned: that caused a generic
        // "material hari ni" question to pull an older snapshot/history date.
        // No date means TODAY for all daily record views.
        const askedDate = dateMentionedByUser(msg.body);
        const what = oneOf(r.what, ['progress', 'material', 'issue', 'ss', 'stock', 'all'], '');
        if (what === 'stock') {
          const { handleStock } = await import('./materials.js');
          return handleStock(msg);
        }
        if (what === 'material') {
          const { handleMaterials } = await import('./materials.js');
          // Default to today: a DO photo that just arrived must be the one shown,
          // never yesterday's list.
          const asked = askedDate || getToday();
          return handleMaterials(msg, [asked]);
        }
        if (what === 'issue') {
          const { handleIssues, handleIssuesForDate } = await import('./issues.js');
          const status = oneOf(r.status, ['open', 'all', 'resolved'], 'open');
          if (!askedDate && status === 'open') return handleIssuesForDate(msg, getToday(), { openOnly: true });
          const args = status === 'resolved' ? ['all', 'resolved'] : [status];
          return handleIssues(msg, args);
        }
        if (what === 'ss') {
          const { showReport } = await import('./projectss.js');
          return showReport(msg, askedDate || getToday());
        }
        if (what === 'progress' || what === '') {
          const { handleProgress } = await import('./progress.js');
          // handleProgress already routes through replyListWithPhotos, which sends
          // each picture as its own message with the record description as caption.
          const wantsSummary = /\b(summary|summar(y|ise)|full\s+report|site\s+progress\s+report|detail(?:s)?|ringkasan)\b/i.test(String(msg.body || ''));
          return handleProgress(msg, [
            ...(askedDate ? [askedDate] : []),
            ...(wantsSummary ? ['summary'] : []),
          ]);
        }
        return msg.reply(clean(decision.reply, 300) || 'Kata progress, material, issue atau ss.');
      }
    }
  } catch (err) {
    console.error('AI action failed:', err);
    return msg.reply('Something went wrong saving that. Sila cuba lagi.');
  }
}

function dateMentionedByUser(text) {
  const raw = String(text || '').toLowerCase().replace(/\bsmalam\b/g, 'semalam');
  if (/\b(hari\s*(?:ini|ni)|harini|today)\b/.test(raw)) return getToday();
  if (/\b(semalam|yesterday)\b/.test(raw)) return parseRecordDate('semalam');

  // Only accept a date explicitly present in the sender's own words. This
  // prevents the LLM's record snapshot or an unrelated quantity from selecting
  // old data, while still understanding the date formats used on site.
  const explicit = raw.match(/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/);
  if (explicit) return parseRecordDate(explicit[0]);

  const named = raw.match(/\b\d{1,2}\s*(?:hb|haribulan)?\s*(?:jan(?:uari|uary)?|feb(?:ruari|ruary)?|mac|mar(?:ch)?|apr(?:il)?|mei|may|jun(?:e)?|jul(?:y)?|ogos|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dis(?:ember)?|dec(?:ember)?)\s*\d{0,4}\b/);
  if (named) return parseRecordDate(named[0]);

  return null;
}

function directViewRequest(text) {
  // WhatsApp passes the bot mention through in the body, e.g. "@KERANI
  // workers ?". Strip mentions before matching short deterministic queries so
  // they do not fall through to the LLM's generic database reply.
  const raw = String(text || '')
    .replace(/@[\w.-]+/g, ' ')
    .toLowerCase()
    .replace(/\bsmalam\b/g, 'semalam')
    .replace(/\s+/g, ' ')
    .trim();
  const hasDate = /\b(hari\s*ini|harini|today|semalam|yesterday)\b|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(raw);
  const attendanceShort = /^\s*(?:workers?|attendance|kehadiran)\s*[?!.]*\s*$/.test(raw);
  // Site users commonly say "attendance bro" / "workers?" rather than a
  // formal question. Treat that as a read request, but do not steal an
  // attendance save instruction such as "worker datang" or "tambah worker".
  const attendanceView = /\b(attendance|kehadiran|workers?|pekerja)\b/.test(raw) &&
    !/\b(add|tambah|masuk|datang|hadir|rekod|simpan|save|record|update|hantar|send)\b/.test(raw);
  if (attendanceShort || attendanceView) return { what: 'attendance', date: dateMentionedByUser(raw) };
  if (!/\b(pa|apa|what|tengok|lihat|show|bagi|beri|check|senarai|list|macam mana|berapa)\b/.test(raw) && !hasDate && !attendanceShort && !attendanceView) return null;
  const what = /\b(progress|kemajuan)\b/.test(raw) ? 'progress'
    : /\b(material|materials|bahan|barang|delivery|stok|stock)\b/.test(raw) ? 'material'
      : /\b(issue|issues|masalah|problem|rosak|safety)\b/.test(raw) ? 'issue'
        : /\b(attendance|kehadiran|worker|pekerja)\b/.test(raw) ? 'attendance'
          : /\b(ss|site report|laporan harian)\b/.test(raw) ? 'ss' : null;
  return what ? { what, date: dateMentionedByUser(raw) } : null;
}

function explicitMediaInstruction(text) {
  const raw = String(text || '').replace(/@[^\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  // A hashtag is the strongest instruction. Without one, a clear keyword in
  // the caption still routes the media into the matching record table.
  if (/(?:^|\s)#(?:progress|kemajuan)\b/i.test(raw) || /\b(progress|kemajuan)\b/i.test(raw)) {
    const description = clean(raw
      .replace(/#(?:progress|kemajuan)\b/gi, ' ')
      .replace(/\b(progress|kemajuan)\b/gi, ' ')
      .replace(/^[\s:>-]+/, ''), 500);
    return description ? { action: 'progress', description } : null;
  }

  if (/(?:^|\s)#attendance\b/i.test(raw) || /\b(attendance|kehadiran|workers?|pekerja|hadir)\b/i.test(raw) || /\b(?:sub|subcon|subcontractor)\b[\s\S]*\bteam\b/i.test(raw)) {
    // A query such as "attendance today?" is a view request, never a worker
    // list. Do not turn the query words into fake attendance names when a
    // forwarded photo is still pending.
    if (/[?؟]/.test(raw) || /\b(today|hari\s*ini|harini|semalam|yesterday|apa|tengok|show|check|lihat)\b/i.test(raw)) return null;
    const teamMatch = raw.match(/\b(?:sub|subcon|subcontractor)\s+(.+?)\s+(?:with\s+)?team\b/i);
    if (teamMatch) {
      const teamName = clean(teamMatch[1], 80);
      return teamName
        ? { action: 'attendance', workers: [{ name: `Sub ${teamName} Team`, team: true }] }
        : null;
    }

    const namesText = raw
      .replace(/#attendance\b/gi, ' ')
      .replace(/^\s*\d+\s*(?:workers?|pekerja)\b/gi, ' ')
      .replace(/\b(attendance|kehadiran|workers?|pekerja|hadir)\b/gi, ' ')
      .replace(/^[\s:>-]+/, '')
      .trim();
    const workers = namesText.split(/,|\s+dan\s+|\s+and\s+/i)
      .flatMap((part) => part.trim().split(/\s+/))
      .map((name) => clean(name, 80))
      .filter((name) => name && !/^\d+$/.test(name));
    return workers.length ? { action: 'attendance', workers: workers.map((name) => ({ name })) } : null;
  }

  if (/(?:^|\s)#issue\b/i.test(raw) || /\b(issue|masalah|problem|rosak|bocor|leak|safety|helmet|tak\s+pakai)\b/i.test(raw)) {
    if (/\b(no|not|tiada|takde)\s+issue\b/i.test(raw)) return null;
    const description = clean(raw
      .replace(/#issue\b/gi, ' ')
      .replace(/^[\s:>-]+/, '')
      .trim(), 500);
    if (!description) return null;
    return { action: 'issue', title: description.slice(0, 150), description, priority: /\b(safety|helmet|bahaya|danger)\b/i.test(description) ? 'high' : 'medium' };
  }

  if (/(?:^|\s)#material\b/i.test(raw) || /\b(material|materials|barang|bahan|delivery|delivered|received|sampai|stok|stock)\b/i.test(raw)) {
    const quantityMatches = [...raw.matchAll(/\b(\d+(?:\.\d+)?)\s*(bag|bags|bgs|pallet|ton|mt|kg|m3|m2|pcs|piece|unit|roll|bundle|box|trip|lorry|btg)\b/gi)];
    if (quantityMatches.length !== 1) return null; // Let the model split multi-item deliveries.
    const quantityMatch = quantityMatches[0];
    const unit = quantityMatch[2];
    const material = clean(raw
      .replace(/#material\b/gi, ' ')
      .replace(/\b(material|materials|barang|bahan|delivery|delivered|received|sampai|stok|stock)\b/gi, ' ')
      .replace(quantityMatch[0], ' ')
      .replace(/^[\s:>-]+/, ''), 150);
    return material ? { action: 'material', material, quantity: quantityMatch[1], unit } : null;
  }

  return null;
}

// A photo and its description are sometimes sent as two WhatsApp messages,
// especially when the photo is forwarded. The second message does not carry
// the first message's caption, so the normal media path cannot see it. This
// helper is used by index.js to route only clear record descriptions here;
// ordinary group chatter remains untouched.
export function isSeparateRecordDescription(text) {
  const raw = String(text || '').replace(/@[^\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw || /[?؟]\s*$/.test(raw)) return false;
  if (/^(?:apa|what|show|tengok|lihat|check|bagi|beri|send|hantar|nak tengok)\b/i.test(raw)) return false;
  if (/^(?:progress|kemajuan|material|materials|bahan|barang|issue|issues|masalah|attendance|kehadiran|workers?|pekerja)\s+(?:today|hari\s*ini|harini|semalam|yesterday)\s*[.!]*$/i.test(raw)) return false;
  return Boolean(explicitMediaInstruction(raw));
}

function isGreetingOnly(text) {
  const cleaned = String(text || '')
    .replace(/@[^\s]+/g, ' ')
    .replace(/[.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return /^(?:hello|hi|hey|hai|helo|yo|morning|good morning|afternoon|good afternoon|evening|good evening|assalamualaikum|salam|bro|boss|bos|mate|brader|br|okay|ok|alright|noted)(?:\s+(?:bro|boss|bos|mate|brader|br))?$/.test(cleaned);
}

function isIdentityQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /\b(kau|awak|anda|you|u)\s+(siapa|apa)\b|\b(siapa|what)\s+(kau|awak|anda|you|u)\b|\b(asal|kenapa|why)\b.{0,30}\b(group|sini|here)\b/i.test(t);
}
