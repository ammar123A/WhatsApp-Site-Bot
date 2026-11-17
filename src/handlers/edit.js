import {
  progressDB, materialsDB, issuesDB,
  workOrdersDB, attendanceDB, diaryDB, milestonesDB,
} from '../database.js';
import { getToday, parseArgs, getRecordPhotos, replyWithPhoto } from '../utils.js';
import config from '../../config.js';

// Canonical kind name per label, used to pick the right field map.
const FIELD_LABEL = {
  progress: 'Progress', material: 'Material', issue: 'Issue',
  workorder: 'Work Order', attendance: 'Attendance', ss: 'Project SS',
  milestone: 'Milestone',
};

// `.edit <type> <id>` - update any field on any record.
// Types: progress, material, issue, workorder, attendance, ss (Project SS),
//        milestone
// Body is the normal key:value block, e.g.
//   .edit issue 3
//   Priority: urgent
//   Assigned to: Azman
// Fields left out stay as they are.

const TYPES = {
  progress: { table: progressDB, label: 'Progress' },
  prog: { table: progressDB, label: 'Progress' },
  p: { table: progressDB, label: 'Progress' },
  material: { table: materialsDB, label: 'Material' },
  mat: { table: materialsDB, label: 'Material' },
  m: { table: materialsDB, label: 'Material' },
  issue: { table: issuesDB, label: 'Issue' },
  i: { table: issuesDB, label: 'Issue' },
  workorder: { table: workOrdersDB, label: 'Work Order' },
  work: { table: workOrdersDB, label: 'Work Order' },
  wo: { table: workOrdersDB, label: 'Work Order' },
  attendance: { table: attendanceDB, label: 'Attendance' },
  att: { table: attendanceDB, label: 'Attendance' },
  worker: { table: attendanceDB, label: 'Attendance' },
  ss: { table: diaryDB, label: 'Project SS' },
  project: { table: diaryDB, label: 'Project SS' },
  projectss: { table: diaryDB, label: 'Project SS' },
  milestone: { table: milestonesDB, label: 'Milestone' },
  ms: { table: milestonesDB, label: 'Milestone' },
};

// Per-type mapping from a normalised key to the DB update field, plus a
// validator. Returns null when the key isn't editable on that table.
const FIELD_MAPS = {
  progress: {
    work: ['category', null],
    category: ['category', null],
    description: ['description', null],
    desc: ['description', null],
    percentage: ['percentage', num],
    percent: ['percentage', num],
    location: ['location', null],
    'reported by': ['reportedBy', null],
    reported: ['reportedBy', null],
    by: ['reportedBy', null],
    date: ['date', null],
  },
  material: {
    'material arrived onsite': ['materialName', null],
    material: ['materialName', null],
    name: ['materialName', null],
    quantity: ['quantity', num],
    qty: ['quantity', num],
    unit: ['unit', null],
    supplier: ['supplier', null],
    category: ['category', null],
    po: ['poNumber', null],
    'po number': ['poNumber', null],
    dn: ['deliveryNote', null],
    'delivery note': ['deliveryNote', null],
    'which site': ['location', null],
    location: ['location', null],
    site: ['location', null],
    'received by': ['receivedBy', null],
    received: ['receivedBy', null],
    by: ['receivedBy', null],
    notes: ['notes', null],
    date: ['date', null],
  },
  issue: {
    title: ['title', null],
    description: ['description', null],
    desc: ['description', null],
    category: ['category', null],
    priority: ['priority', oneOf(['low', 'medium', 'high', 'urgent'])],
    status: ['status', oneOf(Object.values(config.issueStatus))],
    location: ['location', null],
    'reported by': ['reportedBy', null],
    reported: ['reportedBy', null],
    by: ['reportedBy', null],
    'assigned to': ['assignedTo', null],
    assigned: ['assignedTo', null],
    assign: ['assignedTo', null],
    resolution: ['resolution', null],
    date: ['date', null],
  },
  workorder: {
    title: ['title', null],
    description: ['description', null],
    desc: ['description', null],
    category: ['category', null],
    priority: ['priority', oneOf(['low', 'medium', 'high', 'urgent'])],
    'assigned to': ['assignedTo', null],
    assigned: ['assignedTo', null],
    assign: ['assignedTo', null],
    due: ['dueDate', null],
    'due date': ['dueDate', null],
    notes: ['notes', null],
    date: ['date', null],
  },
  attendance: {
    name: ['workerName', null],
    worker: ['workerName', null],
    contractor: ['contractor', null],
    role: ['role', null],
    status: ['status', null],
    shift: ['shift', null],
  },
  ss: {
    site: ['siteName', null],
    'site name': ['siteName', null],
    weather: ['weather', null],
    operator: ['operators', text],
    operators: ['operators', text],
    'machinery & equipment': ['machineryEquipment', text],
    'machinery and equipment': ['machineryEquipment', text],
    machinery: ['machinery', text],
    'general notes': ['generalNotes', text],
    notes: ['generalNotes', text],
    safety: ['safetyNotes', text],
    'safety notes': ['safetyNotes', text],
  },
  milestone: {
    title: ['title', null],
    description: ['description', null],
    desc: ['description', null],
    due: ['targetDate', null],
    'target date': ['targetDate', null],
    percentage: ['percentage', num],
    percent: ['percentage', num],
    status: ['status', null],
  },
};

function num(v) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? undefined : n;
}
function oneOf(list) {
  return (v) => {
    const lower = String(v).trim().toLowerCase();
    return list.includes(lower) ? lower : undefined;
  };
}
function text(v) {
  const t = String(v).trim();
  return t || undefined;
}

// Project SS keeps the "sama" / list behaviour of .addss.
function normaliseSSValue(field, raw) {
  if (/^(sama|same|takde\s*(perubahan|tukar)|no\s*change)$/i.test(raw.trim())) return '=SAME';
  const lines = raw.split('\n').map(l => l.replace(/\u2060/g, '').trim()).filter(Boolean);
  const clean = lines
    .map(l => l.replace(/^[-*\u2022]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  if (field === 'weather') return clean.join(' ');
  if (clean.length === 1) {
    const parts = clean[0].split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.join('\n');
  }
  return clean.join('\n');
}

export async function handleEdit(msg, args, messageBody) {
  const typeKey = (args[0] || '').toLowerCase().trim();
  const id = parseInt(args[1]);
  const type = TYPES[typeKey];

  if (!type) {
    return msg.reply(
      '*Usage:* `.edit <type> <id>`\n\n' +
      '*Types:* progress, material, issue, workorder, attendance, ss, milestone\n\n' +
      'Contoh:\n' +
      '```\n' +
      '.edit issue 3\n' +
      'Priority: urgent\n' +
      'Assigned to: Azman\n' +
      '```\n\n' +
      '```\n' +
      '.edit progress 2\n' +
      'Percentage: 75\n' +
      'Description: Pipe laying 75%\n' +
      '```'
    );
  }
  if (!id) {
    return msg.reply(`*Usage:* \`.edit ${typeKey} <id>\`\n_Contoh: .edit ${typeKey} 1_`);
  }

  const { table, label } = type;
  const fieldMap = FIELD_MAPS[kindFor(typeKey)];
  if (!fieldMap) {
    return msg.reply(`*Editing ${label} is not supported yet.*`);
  }

  const parsed = parseArgs(messageBody, 1);
  const keys = Object.keys(parsed);
  if (!keys.length) {
    return msg.reply(usageFor(typeKey, fieldMap, label));
  }

  const update = {};
  const unknown = [];
  const invalid = [];
  for (const key of keys) {
    const mapping = fieldMap[key];
    if (!mapping) { unknown.push(key); continue; }
    const [field, validate] = mapping;
    let value = parsed[key];
    if (fieldMap === FIELD_MAPS.ss) value = normaliseSSValue(field, parsed[key]);
    if (validate && value !== '=SAME') {
      const v = validate(parsed[key]);
      if (v === undefined) { invalid.push(`${key}: ${parsed[key]}`); continue; }
      value = v;
    }
    update[field] = value;
  }

  if (!Object.keys(update).length) {
    let t = '*❌ Tiada field yang boleh dikemas kini.*\n';
    if (unknown.length) t += `\nTidak boleh edit: ${unknown.join(', ')}`;
    if (invalid.length) t += `\nNilai salah: ${invalid.join(', ')}`;
    t += `\n\n${usageFor(typeKey, fieldMap, label)}`;
    return msg.reply(t);
  }

  // Project SS "sama" -> carry the previous day's value forward.
  if (Object.values(update).includes('=SAME')) {
    return handleSSSameAs(msg, update);
  }

  const existing = await table.getById(id);
  if (!existing) {
    return msg.reply(`*${label} #${id} not found.*`);
  }

  const result = await table.update(id, update);
  if (!result.changes) {
    return msg.reply(`*${label} #${id} - tiada perubahan.*`);
  }

  const changed = Object.keys(update).map(k => `• *${k}* → ${update[k]}`).join('\n');
  const photos = getRecordPhotos(await table.getById(id));
  const text = `*✅ ${label} #${id} updated*\n\n${changed}`;
  if (photos.length) return replyWithPhoto(msg, text, photos);
  return msg.reply(text);
}

function kindFor(typeKey) {
  const t = TYPES[typeKey];
  if (!t) return null;
  return Object.keys(FIELD_LABEL).find(k => FIELD_LABEL[k] === t.label);
}

async function handleSSSameAs(msg, update) {
  const today = getToday();
  const yesterday = await diaryDB.getPrevious(today);
  if (!yesterday) {
    return msg.reply('❌ Tak ada rekod hari sebelumnya untuk disalin.');
  }
  const resolved = {};
  for (const [field, value] of Object.entries(update)) {
    if (value === '=SAME') {
      const col = { siteName: 'site_name', weather: 'weather', operators: 'operators', machineryEquipment: 'machinery_equipment', machinery: 'machinery', generalNotes: 'general_notes', safetyNotes: 'safety_notes' }[field];
      if (yesterday[col]) resolved[field] = yesterday[col];
    } else {
      resolved[field] = value;
    }
  }
  await diaryDB.upsert({ date: today, ...resolved });
  return msg.reply(
    `*✅ Project SS hari ini dikemas kini*\n\n` +
    Object.keys(resolved).map(k => `• *${k}*`).join('\n') +
    `\n\n_Hanya section ini - guna \`.edit ss ${today}\` untuk semak keseluruhan._`
  );
}

function usageFor(typeKey, fieldMap, label) {
  const fields = Object.entries(fieldMap).map(([k]) => k);
  return `*Usage:* \`.edit ${typeKey} <id>\`\n\n` +
    `*${label} fields:* ${fields.join(', ')}\n\n` +
    'Contoh:\n```\n' +
    `.edit ${typeKey} 1\n` +
    `${fields[0]}: ${exampleFor(fields[0])}\n` +
    `${fields[1] ? `${fields[1]}: ${exampleFor(fields[1])}\n` : ''}` +
    '```';
}

function exampleFor(field) {
  if (/priority/.test(field)) return 'urgent';
  if (/status/.test(field)) return 'in_progress';
  if (/percentage|percent|quantity|hours|ot\b/.test(field)) return '50';
  if (/machinery/.test(field)) return 'Excavator 13';
  if (/weather/.test(field)) return '🌤️☀️🌤️';
  return 'text';
}