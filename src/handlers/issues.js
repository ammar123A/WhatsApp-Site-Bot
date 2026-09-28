import { issuesDB } from '../database.js';
import { getToday, parseArgs, buildIssuesMessage, buildIssueStats, replyWithPhoto, getRecordPhotos } from '../utils.js';
import { attachPendingPhotos } from './photos.js';
import config from '../../config.js';

// Handle issues commands
export async function handleIssues(msg, args) {
  const subCommand = args[0]?.toLowerCase();
  
  if (!subCommand || subCommand === 'open') {
    const issues = issuesDB.getOpenIssues();
    const msg_text = issues.length > 0 
      ? buildIssuesMessage(issues)
      : '*No open issues.* 🎉';
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'all') {
    const status = args[1]?.toLowerCase();
    let issues;
    if (status && config.issueStatus[status.toUpperCase()]) {
      issues = issuesDB.getByStatus(status);
    } else {
      issues = issuesDB.getRecent(parseInt(args[1]) || 20);
    }
    const msg_text = issues.length > 0 
      ? '*📋 ALL ISSUES*\n\n' + buildIssuesMessage(issues)
      : '*No issues found.*';
    return msg.reply(msg_text);
  }
  
  if (subCommand === 'stats') {
    const stats = issuesDB.getStats();
    return msg.reply(buildIssueStats(stats));
  }
  
  // View specific issue
  // If the command itself came as a photo caption, auto-link that photo.
  const issueId = parseInt(subCommand);
  if (issueId) {
    const issue = issuesDB.getById(issueId);
    if (!issue) {
      return msg.reply(`*Issue #${issueId} not found.*`);
    }

    if (msg.hasMedia) {
      const picked = attachPendingPhotos(issuesDB, issue.id);
      console.log(`  → auto-attached ${picked} photo(s) to issue #${issue.id} (caption command)`);
    }
    const freshIssue = issuesDB.getById(issueId);

    const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
    const statusEmoji = { open: '⬜', in_progress: '🔄', resolved: '✅', closed: '🔒' };

    let msg_text = `*ISSUE #${freshIssue.id}*\n\n`;
    msg_text += `${priorityEmoji[freshIssue.priority] || '⚪'} *${freshIssue.title}*\n`;
    msg_text += `📂 Category: ${freshIssue.category}\n`;
    msg_text += `📊 Priority: ${freshIssue.priority.toUpperCase()}\n`;
    msg_text += `${statusEmoji[freshIssue.status] || '❓'} Status: ${freshIssue.status.replace('_', ' ').toUpperCase()}\n`;
    msg_text += `📝 Description: ${freshIssue.description}\n`;
    if (freshIssue.location) msg_text += `📍 Location: ${freshIssue.location}\n`;
    if (freshIssue.reported_by) msg_text += `👤 Reported by: ${freshIssue.reported_by}\n`;
    if (freshIssue.assigned_to) msg_text += `👷 Assigned to: ${freshIssue.assigned_to}\n`;
    if (freshIssue.resolution) msg_text += `✅ Resolution: ${freshIssue.resolution}\n`;
    if (freshIssue.resolved_at) msg_text += `📅 Resolved at: ${freshIssue.resolved_at}\n`;

    return replyWithPhoto(msg, msg_text, getRecordPhotos(freshIssue));
  }
  
  return msg.reply('*Usage:* .issues [open|all|stats|id]');
}

// Handle addissue command
export async function handleAddIssue(msg, messageBody) {
  const args = parseArgs(messageBody, 1);
  
  if (!args.title || !args.description) {
    return msg.reply(
      '*Usage:* .addissue\n\n' +
      'Format:\n' +
      '```\n' +
      '.addissue\n' +
      'Title: Water leak\n' +
      'Description: Major leak at 2nd floor bathroom\n' +
      'Category: MEP\n' +
      'Priority: high\n' +
      'Location: Block A L2\n' +
      'By: Site Engineer\n' +
      '```\n\n' +
      `*Categories:* ${config.categories.join(', ')}\n` +
      '*Priority:* low, medium, high, urgent'
    );
  }
  
  const entry = {
    date: getToday(),
    title: args.title,
    description: args.description,
    category: args.category || 'Others',
    priority: args.priority || 'medium',
    status: 'open',
    location: args.location,
    reportedBy: args.by || args.reported,
    assignedTo: args.assigned || args.assign,
    photo: null
  };
  
  try {
    const result = issuesDB.add(entry);
    const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' };
    let photoNote = '';
    if (msg.hasMedia) {
      const picked = attachPendingPhotos(issuesDB, result.lastInsertRowid);
      if (picked > 0) {
        photoNote = `📸 *${picked} photo(s) auto-attached.*\n`;
      }
    }

    return msg.reply(
      '*✅ Issue Reported!*\n\n' +
      photoNote +
      `${priorityEmoji[entry.priority] || '⚪'} *#${result.lastInsertRowid} ${entry.title}*\n` +
      `📂 *Category:* ${entry.category}\n` +
      `📊 *Priority:* ${entry.priority.toUpperCase()}\n` +
      `📝 *Description:* ${entry.description}\n` +
      (entry.location ? `📍 *Location:* ${entry.location}\n` : '') +
      (entry.reportedBy ? `👤 *Reported by:* ${entry.reportedBy}\n` : '') +
      (entry.assignedTo ? `👷 *Assigned to:* ${entry.assignedTo}\n` : '')
    );
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
    const issue = issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    issuesDB.updateStatus(id, 'resolved', resolution);
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
    const issue = issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    issuesDB.update(id, { assignedTo: assignTo });
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
    const issue = issuesDB.getById(id);
    if (!issue) {
      return msg.reply(`*Issue #${id} not found.*`);
    }
    
    issuesDB.update(id, { priority });
    return msg.reply(`*✅ Issue #${id} priority updated to ${priority.toUpperCase()}.*`);
  } catch (error) {
    console.error('Error updating priority:', error);
    return msg.reply('*❌ Error updating priority.*');
  }
}
