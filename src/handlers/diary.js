import { diaryDB, attendanceDB, workOrdersDB, milestonesDB } from '../database.js';
import { getToday, parseArgs, buildDiaryMessage, getDayName } from '../utils.js';
import config from '../../config.js';

// Handle diary commands
export async function handleDiary(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand) {
    const today = getToday();
    const diary = diaryDB.getByDate(today);
    const msg_text = diary 
      ? buildDiaryMessage(diary)
      : '*No diary entry for today.*\n\nUse .adddiary to add entry.';
    return msg.reply(msg_text);
  }
  
  // Get diary for specific date
  const dateStr = args.join('/');
  const diary = diaryDB.getByDate(dateStr);
  if (diary) {
    return msg.reply(buildDiaryMessage(diary));
  }
  
  return msg.reply(`*No diary found for ${dateStr}.*`);
}

// Handle adddiary command
export async function handleAddDiary(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  const entry = {
    date: getToday(),
    weather: args.weather,
    temperature: args.temp || args.temperature,
    visitors: args.visitors,
    generalNotes: args.notes || args.general,
    safetyNotes: args.safety
  };
  
  if (!entry.weather && !entry.visitors && !entry.generalNotes && !entry.safetyNotes) {
    return msg.reply(
      '*Usage:* .adddiary\n\n' +
      'Format:\n' +
      '```\n' +
      '.adddiary\n' +
      'Weather: Sunny\n' +
      'Temp: 32C\n' +
      'Visitors: Client PM\n' +
      'Notes: Work progressing well\n' +
      'Safety: All PPE in use\n' +
      '```'
    );
  }
  
  try {
    diaryDB.upsert(entry);
    return msg.reply(
      '*✅ Diary Updated!*\n\n' +
      `📅 *Date:* ${entry.date}\n` +
      (entry.weather ? `☁️ *Weather:* ${entry.weather}\n` : '') +
      (entry.temperature ? `🌡️ *Temperature:* ${entry.temperature}\n` : '') +
      (entry.visitors ? `👥 *Visitors:* ${entry.visitors}\n` : '') +
      (entry.generalNotes ? `📝 *Notes:* ${entry.generalNotes}\n` : '') +
      (entry.safetyNotes ? `🦺 *Safety:* ${entry.safetyNotes}\n` : '')
    );
  } catch (error) {
    console.error('Error updating diary:', error);
    return msg.reply('*❌ Error updating diary. Please try again.*');
  }
}

// Handle attendance commands
export async function handleAttendance(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'today') {
    const today = getToday();
    const count = attendanceDB.getDailyCount(today);
    const attendance = attendanceDB.getByDate(today);
    
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
          msg_text += `> ${w.worker_name} (${w.role || '-'}) - ${w.hours_worked}h`;
          if (w.overtime > 0) msg_text += ` + ${w.overtime}h OT`;
          msg_text += '\n';
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
    
    const summary = attendanceDB.getWorkerSummary(workerName);
    if (!summary) {
      return msg.reply(`*No attendance record found for "${workerName}" in the last 30 days.*`);
    }
    
    return msg.reply(
      `*👷 WORKER SUMMARY - ${summary.worker_name}*\n\n` +
      `Days Worked: ${summary.days_worked}\n` +
      `Total Hours: ${summary.total_hours}\n` +
      `Total OT: ${summary.total_overtime}h`
    );
  }
  
  return msg.reply('*Usage:* .attendance [today|summary]');
}

// Handle addattendance command
export async function handleAddAttendance(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.name) {
    return msg.reply(
      '*Usage:* .addattendance\n\n' +
      'Format:\n' +
      '```\n' +
      '.addattendance\n' +
      'Name: Ali\n' +
      'Contractor: ABC\n' +
      'Role: Foreman\n' +
      'Hours: 9\n' +
      'OT: 2\n' +
      'Notes: Working overtime\n' +
      '```'
    );
  }
  
  const entry = {
    date: getToday(),
    workerName: args.name,
    contractor: args.contractor,
    role: args.role,
    status: args.status || 'present',
    hoursWorked: parseFloat(args.hours) || 8,
    overtime: parseFloat(args.ot) || 0,
    notes: args.notes
  };
  
  try {
    attendanceDB.add(entry);
    return msg.reply(
      '*✅ Attendance Added!*\n\n' +
      `👷 *Worker:* ${entry.workerName}\n` +
      (entry.contractor ? `🏢 *Contractor:* ${entry.contractor}\n` : '') +
      (entry.role ? `💼 *Role:* ${entry.role}\n` : '') +
      `⏰ *Hours:* ${entry.hoursWorked}\n` +
      (entry.overtime > 0 ? `🕐 *Overtime:* ${entry.overtime}h\n` : '')
    );
  } catch (error) {
    console.error('Error adding attendance:', error);
    return msg.reply('*❌ Error adding attendance. Please try again.*');
  }
}

// Handle work orders
export async function handleWorkOrders(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'pending') {
    const orders = workOrdersDB.getPending();
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
    const result = workOrdersDB.add(entry);
    return msg.reply(
      '*✅ Work Order Created!*\n\n' +
      `📋 *#${result.lastInsertRowid} ${entry.title}*\n` +
      `📂 *Category:* ${entry.category}\n` +
      `📊 *Priority:* ${entry.priority.toUpperCase()}\n` +
      (entry.assignedTo ? `👷 *Assigned to:* ${entry.assignedTo}\n` : '') +
      (entry.dueDate ? `📅 *Due Date:* ${entry.dueDate}\n` : '')
    );
  } catch (error) {
    console.error('Error adding work order:', error);
    return msg.reply('*❌ Error creating work order. Please try again.*');
  }
}

// Handle milestones
export async function handleMilestones(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'list') {
    const milestones = milestonesDB.getAll();
    let msg_text = '*🎯 PROJECT MILESTONES*\n\n';
    
    if (milestones.length === 0) {
      msg_text += '_No milestones defined._';
    } else {
      const statusEmoji = { pending: '⬜', in_progress: '🔄', completed: '✅', delayed: '🔴' };
      milestones.forEach(m => {
        msg_text += `${statusEmoji[m.status] || '❓'} *${m.title}*\n`;
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
    const result = milestonesDB.add(entry);
    return msg.reply(
      '*✅ Milestone Added!*\n\n' +
      `🎯 *${entry.title}*\n` +
      (entry.description ? `📝 ${entry.description}\n` : '') +
      (entry.targetDate ? `📅 Due: ${entry.targetDate}\n` : '')
    );
  } catch (error) {
    console.error('Error adding milestone:', error);
    return msg.reply('*❌ Error adding milestone. Please try again.*');
  }
}
