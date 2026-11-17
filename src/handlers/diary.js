import { diaryDB, attendanceDB, workOrdersDB, milestonesDB, filesDB } from '../database.js';
import { getToday, parseArgs, parseRecordDate, buildDiaryMessage, getDayName } from '../utils.js';
import { replyWithPhoto } from '../utils.js';
import { getPhotoBatchSize } from './photos.js';
import { pendingCount, linkPendingFiles } from './files.js';
import config from '../../config.js';

// NOTE: the old .diary / .adddiary view has been replaced by the Project SS
// report (see handlers/projectss.js - commands .projectss / .addss).

// Handle attendance commands
export async function handleAttendance(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  const requestedDate = parseRecordDate(args.join(' '));
  
  if (!subCommand || subCommand === 'today' || requestedDate) {
    const date = requestedDate || getToday();
    const today = date;
    const count = await attendanceDB.getDailyCount(date);
    const attendance = await attendanceDB.getByDate(date);
    // A morning photo may be resent or a second attendance update may arrive
    // on the same day. Attendance views are a daily worker list, not an audit
    // log, so keep one name per date while leaving every raw row in the DB.
    const seenWorkers = new Set();
    const dailyWorkers = attendance.filter((worker) => {
      // Older buggy versions could store the words from a question as workers
      // (for example "?" and "today"). Keep those historical junk rows out of
      // every attendance reply; real names may contain spaces, punctuation or
      // accents, but never consist solely of query/date words.
      const rawName = String(worker.worker_name || '').trim();
      if (!rawName || /^[?؟.,!]+$/.test(rawName) || /^(today|yesterday|hari\s*ini|harini|semalam|attendance|workers?)$/i.test(rawName)) return false;
      const key = rawName.toLowerCase();
      if (!key || seenWorkers.has(key)) return false;
      seenWorkers.add(key);
      return true;
    });

    // Attendance is intentionally just date + names. Contractor, role, shift,
    // totals and ids are internal fields, not part of the normal reply.
    const text = `*Attendance*\n📅 ${date}\n\n` +
      (dailyWorkers.length
        ? dailyWorkers.map((worker) => `> ${worker.worker_name}`).join('\n')
        : `Tiada attendance pada ${date}.`);

    // Attendance photos are linked to the first row when a group photo names
    // several workers. Gather all linked photo files and send them after the
    // date/name list, so "workers?" recalls the actual morning photo too.
    const photoPaths = [];
    for (const worker of dailyWorkers) {
      const linked = await filesDB.getByLink('attendance', worker.id).catch(() => []);
      for (const file of linked) {
        if (file.category === 'photos' && file.path) {
          photoPaths.push(file.bucket ? `${file.bucket}::${file.path}` : file.path);
        }
      }
    }
    return photoPaths.length
      ? replyWithPhoto(msg, text, [...new Set(photoPaths)], { textFirst: true })
      : msg.reply(text);
    
    let msg_text = `*👷 ATTENDANCE - ${today}*\n\n`;
    msg_text += `Total Workers: ${count.count}\n\n`;
    
    if (attendance.length > 0) {
      const grouped = {};
      attendance.forEach(a => {
        const contractor = a.contractor || 'Unknown';
        if (!grouped[contractor]) grouped[contractor] = [];
        grouped[contractor].push(a);
      });
      
      for (const [contractor, workers] of Object.entries(grouped)) {
        msg_text += `*${contractor}*\n`;
        workers.forEach(w => {
          msg_text += `> *#${w.id}* ${w.worker_name}${w.shift ? ` : ${w.shift}` : ''}${w.role ? ` (${w.role})` : ''}\n`;
        });
        msg_text += '\n';
      }
    }
    
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'summary') {
    const workerName = args[1];
    if (!workerName) {
      return msg.reply('*Usage:* .attendance summary [worker name]');
    }

    const rows = await attendanceDB.getByWorker(workerName);
    if (!rows.length) {
      return msg.reply(`*No attendance record found for "${workerName}".*`);
    }

    const lines = [`*👷 WORKER SUMMARY - ${workerName}*\n`];
    for (const r of rows.slice(-15)) {
      lines.push(`- #${r.id} ${r.date}${r.shift ? ` : ${r.shift}` : ''}`);
    }
    return msg.reply(lines.join('\n'));
  }
  
  return msg.reply('*Usage:* .attendance [today|summary]');
}

// Handle addattendance command - accepts MANY workers in one message.
// Every "Name:" line starts a new worker block:
//   .addattendance
//   Name: Ali
//   Contractor: ABC
//   Role: Foreman
//   Shift: 0800-1900
//   Name: Abu
//   Contractor: hys
//   Role: Foreman
//   Shift: 0800-1900
// Hours and OT were dropped - the site team only reports the shift.
export function parseWorkers(body) {
  const lines = String(body || '').split('\n').slice(1); // drop ".addattendance"
  const workers = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.name) workers.push(cur);
    cur = null;
  };

  // Short form: `.addattendance ali, abu, bakar` or `.addattendance ali dan abu`.
  const inline = String(body || '').split('\n')[0]
    .replace(/^\s*\.\S+\s*/i, '')
    .trim();
  if (inline && !/:/.test(inline)) {
    return inline.split(/,|\s+dan\s+|\s+and\s+/i)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  for (const raw of lines) {
    const line = raw.replace(/\u2060/g, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    const key = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : null;
    const value = colon >= 0 ? line.slice(colon + 1).trim() : '';

    if (key === 'name') {
      flush();
      cur = { name: value };
      continue;
    }
    if (!cur) continue; // ignore stray lines before the first Name:
    if (key === 'contractor' || key === 'kontraktor') cur.contractor = value;
    else if (key === 'role') cur.role = value;
    else if (key === 'shift') cur.shift = value;
    else if (key === 'status') cur.status = value;
    else if (key === 'notes' || key === 'note') cur.notes = value;
    // hours / ot intentionally ignored
  }
  flush();
  return workers;
}

export async function handleAddAttendance(msg, messageBody) {
  const hasEvidence = getPhotoBatchSize(msg.from) > 0 || pendingCount(msg.from) > 0;
  if (!hasEvidence) {
    return msg.reply('*Gambar atau file attendance diperlukan.* Hantar gambar worker dulu, kemudian letak nama mereka.');
  }
  const workers = parseWorkers(messageBody);

  if (!workers.length) {
    return msg.reply(
      '*Usage:* .addattendance\n\n' +
      'Boleh tambah banyak worker sekali:\n' +
      '```\n' +
      '.addattendance\n' +
      'Name: Ali\n' +
      'Contractor: ABC\n' +
      'Role: Foreman\n' +
      'Shift: 0800-1900\n' +
      'Name: Abu\n' +
      'Contractor: hys\n' +
      'Role: Foreman\n' +
      'Shift: 0800-1900\n' +
      '```\n\n' +
      '_Worker automatik masuk dalam Project SS._'
    );
  }

  const today = getToday();
  const saved = [];
  const failed = [];

  for (const w of workers) {
    try {
      const result = await attendanceDB.add({
        date: today,
        workerName: w.name,
        contractor: w.contractor,
        role: w.role,
        status: w.status || 'present',
        shift: w.shift,
        notes: w.notes,
      });
      saved.push({ id: result.lastInsertRowid, ...w });
    } catch (error) {
      console.error('Error adding attendance:', error);
      failed.push(w.name);
    }
  }

  // Silent on success (the bot stays quiet unless something failed).
  if (!failed.length) {
    if (saved[0]?.id) await linkPendingFiles(msg.from, 'attendance', saved[0].id);
    return null;
  }

  const lines = [
    `⚠️ *${failed.length}/${workers.length} worker tak dapat simpan.*`,
    '',
    ...failed.map(n => `- ${n}`),
    '',
    `_*${saved.length} worker berjaya disimpan._`,
  ];
  return msg.reply(lines.join('\n'));
}

// Handle work orders
export async function handleWorkOrders(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'pending') {
    const orders = await workOrdersDB.getPending();
    let msg_text = '*📋 PENDING WORK ORDERS*\n\n';
    
    if (orders.length === 0) {
      msg_text += '_No pending work orders._';
    } else {
      const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
      orders.forEach(order => {
        msg_text += `${priorityEmoji[order.priority] || '⚪'} *#${order.id} ${order.title}*\n`;
        msg_text += `📂 ${order.category} | 📅 Due: ${order.due_date || '-'}\n`;
        if (order.assigned_to) msg_text += `👷 Assigned: ${order.assigned_to}\n`;
        msg_text += '\n';
      });
    }
    
    return msg.reply(msg_text);
  }
  
  return msg.reply('*Usage:* .workorders [pending]');
}

// Handle addworkorder command
export async function handleAddWorkOrder(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.title) {
    return msg.reply(
      '*Usage:* .addworkorder\n\n' +
      'Format:\n' +
      '```\n' +
      '.addworkorder\n' +
      'Title: Install HVAC\n' +
      'Description: Install AC units at Level 3\n' +
      'Category: MEP\n' +
      'Priority: high\n' +
      'Assign: Mechanical Team\n' +
      'Due: 01/09/2026\n' +
      '```'
    );
  }
  
  const entry = {
    date: getToday(),
    title: args.title,
    description: args.description,
    category: args.category || 'Others',
    priority: args.priority || 'medium',
    assignedTo: args.assign || args.assigned,
    dueDate: args.due,
    notes: args.notes
  };
  
  try {
    const result = await workOrdersDB.add(entry);
    console.log(`✅ work order #${result.lastInsertRowid} recorded`);
    return null; // silent on success
  } catch (error) {
    console.error('Error adding work order:', error);
    return msg.reply('*❌ Error creating work order. Please try again.*');
  }
}

// Handle milestones
export async function handleMilestones(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'list') {
    const milestones = await milestonesDB.getAll();
    let msg_text = '*🎯 PROJECT MILESTONES*\n\n';
    
    if (milestones.length === 0) {
      msg_text += '_No milestones defined._';
    } else {
      const statusEmoji = { pending: '⬜', in_progress: '🔄', completed: '✅', delayed: '🔴' };
      milestones.forEach(m => {
        msg_text += `${statusEmoji[m.status] || '❓'} *#${m.id} ${m.title}*\n`;
        msg_text += `> ${m.percentage}% | Due: ${m.target_date || '-'}\n`;
        if (m.actual_date) msg_text += `> Completed: ${m.actual_date}\n`;
        msg_text += '\n';
      });
    }
    
    return msg.reply(msg_text);
  }
  
  return msg.reply('*Usage:* .milestones [list]');
}

// Handle addmilestone command
export async function handleAddMilestone(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.title) {
    return msg.reply(
      '*Usage:* .addmilestone\n\n' +
      'Format:\n' +
      '```\n' +
      '.addmilestone\n' +
      'Title: Foundation Complete\n' +
      'Description: All foundation works\n' +
      'Due: 01/09/2026\n' +
      '```'
    );
  }
  
  const entry = {
    title: args.title,
    description: args.description,
    targetDate: args.due
  };
  
  try {
    const result = await milestonesDB.add(entry);
    console.log(`✅ milestone #${result.lastInsertRowid} recorded`);
    return null; // silent on success
  } catch (error) {
    console.error('Error adding milestone:', error);
    return msg.reply('*❌ Error adding milestone. Please try again.*');
  }
}
