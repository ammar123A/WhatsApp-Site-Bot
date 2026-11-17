#!/usr/bin/env node
// Manage the bot's knowledge from the main PC.
//
//   node scripts/knowledge.js add "Kit paip 900mm一批 price RM180"        (one-off line)
//   node scripts/knowledge.js note supervisor "Gali dalam exceed 1.5m PAYAH - tunnel ke"
//   node scripts/knowledge.js show                                          (what's loaded)
//   node scripts/knowledge.js reload                                        (force re-read)
//   node scripts/knowledge.js check                                         (live sanity ask)
//
// Everything lands in knowledge/*.md, which the bot reads on the next tagged
// message. No restart needed: knowledge.js re-reads on mtime change.
import { appendFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'knowledge');
const cmd = process.argv[2] || 'show';

async function fileFor(topic) {
  const name = String(topic || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general';
  return join(DIR, `${name}.md`);
}

async function main() {
  await mkdir(DIR, { recursive: true });

  if (cmd === 'add' || cmd === 'note') {
    const rest = process.argv.slice(3);
    // "note <topic> <text>" writes to knowledge/<topic>.md; "add <text>" appends to general.
    let topic = 'general';
    let text;
    if (cmd === 'note') { topic = rest.shift() || 'general'; text = rest.join(' '); }
    else text = rest.join(' ');
    if (!text) { console.error('nothing to add'); process.exit(1); }

    const file = await fileFor(topic);
    const stamp = `\n- ${new Date().toISOString().slice(0, 10)}: ${text}`;
    if (existsSync(file)) await appendFile(file, stamp, 'utf8');
    else await writeFile(file, `# ${topic}\n${stamp}`, 'utf8');
    console.log(`added to ${file}`);
    return;
  }

  if (cmd === 'show' || cmd === 'reload') {
    const k = await import('../src/knowledge.js');
    const st = k.knowledgeStatus();
    console.log(`dir: ${st.dir}`);
    console.log(`files: ${st.files.join(', ') || '(none)'}`);
    console.log(`chars loaded: ${st.chars}`);
    if (cmd === 'reload') { k.reloadKnowledge(); console.log('reloaded (will apply to next tagged message)'); }
    return;
  }

  if (cmd === 'check') {
    const { askGemini } = await import('../src/llm.js');
    const q = process.argv.slice(3).join(' ') || 'apa jadi dengan kerja site hari ni?';
    console.log(`asking: ${q}`);
    const d = await askGemini({ userText: q, context: [], hasPendingPhoto: false, pendingPhotoCount: 0, recordSnapshot: '' });
    console.log(`action=${d.action}\nreply=${d.reply}`);
    return;
  }

  console.log('usage: knowledge.js add <text> | note <topic> <text> | show | reload | check [question]');
}

main().catch(e => { console.error(e); process.exit(1); });