import { progressDB, materialsDB, issuesDB, diaryDB, attendanceDB, milestonesDB } from '../database.js';
import { getToday, getDayName, buildProgressMessage, buildMaterialsMessage, buildIssuesMessage, buildDiaryMessage, buildIssueStats, buildStockSummary } from '../utils.js';

// Generate comprehensive daily report
export async function handleDailyReport(msg) {
  const today = getToday();
  const dayName = getDayName();
  
  let report = `*📊 DAILY SITE REPORT*\n`;
  report += `📅 ${dayName}, ${today}\n`;
  report += `${'='.repeat(30)}\n\n`;
  
  // Progress section
  const progress = progressDB.getByDate(today);
  report += `*📝 PROGRESS*\n`;
  if (progress.length > 0) {
    let totalPercentage = 0;
    progress.forEach(p => {
      totalPercentage += p.percentage || 0;
      report += `> [${p.category}] ${p.percentage}% - ${p.description}\n`;
      if (p.location) report += `  📍 ${p.location}\n`;
    });
    report += `_Average: ${(totalPercentage / progress.length).toFixed(1)}%_\n`;
  } else {
    report += '> No progress recorded today\n';
  }
  report += '\n';
  
  // Materials section
  const materials = materialsDB.getByDate(today);
  report += `*📦 MATERIALS RECEIVED*\n`;
  if (materials.length > 0) {
    materials.forEach(m => {
      report += `> ${m.material_name}: ${m.quantity} ${m.unit}\n`;
      if (m.supplier) report += `  🏭 ${m.supplier}\n`;
    });
  } else {
    report += '> No materials received today\n';
  }
  report += '\n';
  
  // Issues section
  const openIssues = issuesDB.getOpenIssues();
  const todayIssues = issuesDB.getByDate(today);
  report += `*⚠️ ISSUES*\n`;
  report += `> Open: ${openIssues.length} | New Today: ${todayIssues.length}\n`;
  if (todayIssues.length > 0) {
    const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
    todayIssues.slice(0, 5).forEach(i => {
      report += `${priorityEmoji[i.priority] || '⚪'} #${i.id} ${i.title}\n`;
    });
    if (todayIssues.length > 5) {
      report += `_...and ${todayIssues.length - 5} more_\n`;
    }
  }
  report += '\n';
  
  // Attendance section
  const attendance = attendanceDB.getByDate(today);
  report += `*👷 ATTENDANCE*\n`;
  report += `> Total Workers: ${attendance.length}\n`;
  if (attendance.length > 0) {
    const contractors = {};
    attendance.forEach(a => {
      const c = a.contractor || 'Unknown';
      contractors[c] = (contractors[c] || 0) + 1;
    });
    for (const [c, count] of Object.entries(contractors)) {
      report += `> ${c}: ${count}\n`;
    }
  }
  report += '\n';
  
  // Diary section
  const diary = diaryDB.getByDate(today);
  if (diary) {
    report += `*📒 SITE DIARY*\n`;
    if (diary.weather) report += `> Weather: ${diary.weather}\n`;
    if (diary.temperature) report += `> Temp: ${diary.temperature}\n`;
    if (diary.visitors) report += `> Visitors: ${diary.visitors}\n`;
    if (diary.general_notes) report += `> ${diary.general_notes}\n`;
    if (diary.safety_notes) report += `> 🦺 ${diary.safety_notes}\n`;
  }
  report += '\n';
  
  // Milestones section
  const milestones = milestonesDB.getAll();
  if (milestones.length > 0) {
    report += `*🎯 MILESTONES*\n`;
    milestones.slice(0, 3).forEach(m => {
      report += `> ${m.title}: ${m.percentage}%\n`;
    });
    if (milestones.length > 3) {
      report += `_...${milestones.length - 3} more milestones_\n`;
    }
  }
  
  report += `\n${'='.repeat(30)}\n`;
  report += `_Generated at ${new Date().toLocaleTimeString()}_\n`;
  
  return msg.reply(report);
}

// Generate weekly report
export async function handleWeeklyReport(msg) {
  const today = getToday();
  
  // Calculate week range (Monday to Sunday)
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  
  const formatDate = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
  };
  
  const weekStart = formatDate(monday);
  const weekEnd = today;
  
  let report = `*📊 WEEKLY SITE REPORT*\n`;
  report += `📅 ${weekStart} - ${weekEnd}\n`;
  report += `${'='.repeat(30)}\n\n`;
  
  // Progress summary
  const progress = progressDB.getByDateRange(weekStart, weekEnd);
  report += `*📝 PROGRESS SUMMARY*\n`;
  if (progress.length > 0) {
    const byCategory = {};
    progress.forEach(p => {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    });
    
    for (const [cat, entries] of Object.entries(byCategory)) {
      const avg = entries.reduce((sum, e) => sum + (e.percentage || 0), 0) / entries.length;
      report += `> [${cat}] Avg: ${avg.toFixed(1)}% (${entries.length} entries)\n`;
    }
  } else {
    report += '> No progress recorded this week\n';
  }
  report += '\n';
  
  // Materials summary
  const materials = materialsDB.getByDateRange(weekStart, weekEnd);
  report += `*📦 MATERIALS SUMMARY*\n`;
  report += `> Total Deliveries: ${materials.length}\n`;
  if (materials.length > 0) {
    const byCategory = {};
    materials.forEach(m => {
      if (!byCategory[m.category]) byCategory[m.category] = 0;
      byCategory[m.category]++;
    });
    for (const [cat, count] of Object.entries(byCategory)) {
      report += `> ${cat}: ${count} deliveries\n`;
    }
  }
  report += '\n';
  
  // Issues summary
  const issueStats = issuesDB.getStats();
  report += `*⚠️ ISSUES SUMMARY*\n`;
  report += `> Total: ${issueStats.total}\n`;
  report += `> Open: ${issueStats.open} | In Progress: ${issueStats.in_progress}\n`;
  report += `> Resolved: ${issueStats.resolved} | Closed: ${issueStats.closed}\n`;
  if (issueStats.urgent_open > 0) {
    report += `> 🔴 Urgent Open: ${issueStats.urgent_open}\n`;
  }
  report += '\n';
  
  // Attendance summary
  report += `*👷 ATTENDANCE SUMMARY*\n`;
  report += `_Weekly average calculated from daily records_\n\n`;
  
  // Milestones
  const milestones = milestonesDB.getAll();
  if (milestones.length > 0) {
    report += `*🎯 MILESTONE PROGRESS*\n`;
    milestones.forEach(m => {
      const statusEmoji = { pending: '⬜', in_progress: '🔄', completed: '✅', delayed: '🔴' };
      report += `${statusEmoji[m.status] || '❓'} ${m.title}: ${m.percentage}%\n`;
    });
  }
  
  report += `\n${'='.repeat(30)}\n`;
  report += `_Generated at ${new Date().toLocaleTimeString()}_\n`;
  
  return msg.reply(report);
}

// Generate stock report
export async function handleStockReport(msg) {
  const stocks = materialsDB.getStockSummary();
  
  let report = `*📊 STOCK REPORT*\n`;
  report += `📅 ${getToday()}\n`;
  report += `${'='.repeat(30)}\n\n`;
  
  if (stocks.length === 0) {
    report += '_No stock data available._';
  } else {
    const grouped = {};
    stocks.forEach(s => {
      if (!grouped[s.category]) grouped[s.category] = [];
      grouped[s.category].push(s);
    });
    
    for (const [category, items] of Object.entries(grouped)) {
      report += `*${category}*\n`;
      items.forEach(item => {
        report += `> ${item.material_name}: ${item.total_qty} ${item.unit}\n`;
      });
      report += '\n';
    }
  }
  
  report += `${'='.repeat(30)}\n`;
  
  return msg.reply(report);
}
