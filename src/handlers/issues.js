import { issuesDB } from '../database.js';
import { getToday, parseArgs, buildCompactIssuesMessage, buildIssuesMessage, buildIssueStats, replyWithPhoto, replyListWithPhotos, getRecordPhotos, getSenderName } from '../utils.js';
import { attachPendingPhotos, getPhotoBatchSize } from './photos.js';
import { pendingCount } from './files.js';
import config from '../../config.js';

// Handle issues commands
export async function handleIssues(msg, args) {
  const subCommand = args[0]?.toLowerCase();

  if (!subCommand || subCommand === 'open') {
    const issues = await issuesDB.getOpenIssues();
    const msg_text = issues.length > 0
      ? buildCompactIssuesMessage(issues)
      : '*No open issues.* 🎉';
    return replyListWithPhotos(msg, msg_text, issues, 'Issue');
  }

  if (subCommand === 'all') {
    const status = args[1]?.toLowerCase();
    let issues;
    if (status && config.issueStatus[status.toUpperCase()]) {
      issues = await issuesDB.getByStatus(status);
    } else {
      issues = await issuesDB.getRecent(parseInt(args[1]) || 20);
    }
    const msg_text = issues.length > 0
      ? buildCompactIssuesMessage(issues)
      : '*No issues found.*';
    return replyListWithPhotos(msg, msg_text, issues, 'Issue');
  }
  
  if (subCommand === 'stats') {
    const stats = await issuesDB.getStats();
    return msg.reply(buildIssueStats(stats));
  }
  
  // View specific issue
  // If the command itself came as a photo caption, auto-link that photo.
  const issueId = parseInt(subCommand);
  if (issueId) {
    const issue = await issuesDB.getById(issueId);
    if (!issue) {
      return msg.reply(`*Issue #${issueId} not found.*`);
    }

    if (msg.hasMedia) {
      const picked = await attachPendingPhotos(issuesDB, issue.id, msg.from);
      console.log(`  → auto-attached ${picked} photo(s) to issue #${issue.id} (caption command)`);
    }
    const freshIssue = await issuesDB.getById(issueId);

    const statusEmoji = { open: '⬜', in_progress: '🔄', resolved: '✅', closed: '🔒' };

    // Trimmed on purpose: id, the issue, the status. Category, priority, location,
    // reporter and assignee were noise when you just want to recognise a record.
    let msg_text = `*ISSUE #${freshIssue.id}*\n`;
    msg_text += `*${freshIssue.title}*\n`;
    msg_text += `${statusEmoji[freshIssue.status] || '❓'} ${freshIssue.status.replace('_', ' ').toUpperCase()}\n`;
    if (freshIssue.description) msg_text += `\n${freshIssue.description}\n`;
    if (freshIssue.resolution) msg_text += `\n✅ ${freshIssue.resolution}\n`;

    return replyWithPhoto(msg, msg_text, getRecordPhotos(freshIssue));
  }

  return msg.reply('*Usage:* .issues [open|all|stats|id]');
}

export async function handleIssuesForDate(msg, date, { openOnly = true } = {}) {
  const rows = await issuesDB.getByDate(date);
  const issues = openOnly ? rows.filter((issue) => ['open', 'in_progress'].includes(String(issue.status).toLowerCase())) : rows;
  const text = issues.length > 0 ? buildCompactIssuesMessage(issues) : `*No issues on ${date}.*`;
  return replyListWithPhotos(msg, text, issues, 'Issue');
}

// Handle addissue command
export async function handleAddIssue(msg, messageBody) {
  if (getPhotoBatchSize(msg.from) === 0 && pendingCount(msg.from) === 0) {
    return msg.reply('*Gambar atau file bukti diperlukan.* Hantar evidence dulu sebelum issue direkod.');
  }
  const args = parseArgs(messageBody, 1);
  const title = args.title || args.problem;
  const description = args.description || args.detail;

  if (!title || !description) {
    return msg.reply(
      '*Usage:* `.addissue`\n\n' +
      '```\n' +
      '.addissue\n' +
      'Title: Water leak\n' +
      'Description: Major leak at 2nd floor bathroom\n' +
      'Location: Block A L2\n' +
      '```\n\n' +
      `*Categories:* ${config.categories.join(', ')}\n` +
      '*Priority:* low, medium, high, urgent\n' +
      '_Reported by bot detect sendiri._'
    );
  }
  
  const entry = {
    date: getToday(),
    title,
    description,
    category: args.category || 'Others',
    priority: args.priority || 'medium',
    status: 'open',
    location: args.location,
    reportedBy: getSenderName(msg),
    assignedTo: args.assigned || args.assign,
    photo: null
  };
  
  try {
    const result = await issuesDB.add(entry);
    if (msg.hasMedia) {
      const picked = await attachPendingPhotos(issuesDB, result.lastInsertRowid, msg.from);
      console.log(`📸 ${picked} photo(s) attached to issue #${result.lastInsertRowid}`);
    }
    console.log(`✅ issue #${result.lastInsertRowid} recorded`);
    return null; // silent on success
  } catch (error) {
    console.error('Error adding issue:', error);
    return msg.reply('*❌ Error reporting issue. Please try again.*');
  }
}

// Handle resolve command
export async function handleResolve(msg, args) {
  const id = parseInt(args[0]);
  if (!id) {
    return msg.reply('*Usage:* .resolve [id] [resolution description]');
  }
  
  const resolution = args.slice(1).join(' ') || 'Resolved';
  
  try {
    const issue = await issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    await issuesDB.updateStatus(id, 'resolved', resolution);
    return msg.reply(`*✅ Issue #${id} resolved!*\n\n*Resolution:* ${resolution}`);
  } catch (error) {
    console.error('Error resolving issue:', error);
    return msg.reply('*❌ Error resolving issue.*');
  }
}

// Handle assign command
export async function handleAssign(msg, args) {
  const id = parseInt(args[0]);
  if (!id || !args[1]) {
    return msg.reply('*Usage:* .assign [id] [name]');
  }
  
  const assignTo = args.slice(1).join(' ');
  
  try {
    const issue = await issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    await issuesDB.update(id, { assignedTo: assignTo });
    return msg.reply(`*✅ Issue #${id} assigned to ${assignTo}.*`);
  } catch (error) {
    console.error('Error assigning issue:', error);
    return msg.reply('*❌ Error assigning issue.*');
  }
}

// Handle updateissuepriority command
export async function handleUpdatePriority(msg, args) {
  const id = parseInt(args[0]);
  const priority = args[1]?.toLowerCase();
  
  if (!id || !priority || !['low', 'medium', 'high', 'urgent'].includes(priority)) {
    return msg.reply('*Usage:* .updatepriority [id] [low|medium|high|urgent]');
  }
  
  try {
    const issue = await issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    await issuesDB.update(id, { priority });
    return msg.reply(`*✅ Issue #${id} priority updated to ${priority.toUpperCase()}.*`);
  } catch (error) {
    console.error('Error updating priority:', error);
    return msg.reply('*❌ Error updating priority.*');
  }
}
