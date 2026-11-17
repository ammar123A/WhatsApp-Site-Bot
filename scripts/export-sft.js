// Turns training/dataset.jsonl into a supervised fine-tuning file.
//
// Each row the bot logged is one real decision. We keep only the rows the bot
// actually acted on (valid:true and the action survived the guards), and turn
// them into instruction -> JSON-response pairs that teach the model this site's
// vocabulary, actions and Manglish style.
//
// Output: training/sft.jsonl   {"system":..., "user":..., "assistant":"{...}"}
//
//   node scripts/export-sft.js            all usable rows
//   node scripts/export-sft.js --min 20   refuse to write a useless tiny set
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, '..');
const datasetPath = join(root, 'training', 'dataset.jsonl');
const outPath = join(root, 'training', 'sft.jsonl');
const systemPath = join(root, 'training', 'system-prompt.txt');

const minRows = Number(process.argv.includes('--min') ? process.argv[process.argv.indexOf('--min') + 1] : 0);

const system = await readFile(systemPath, 'utf8').catch(() => '');
if (!system) {
  console.error('training/system-prompt.txt missing - run the bot once so it writes the sidecar.');
  process.exit(1);
}

const raw = await readFile(datasetPath, 'utf8').catch(() => '');
const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// A usable row: the model produced a real decision we acted on.
const usable = rows.filter(r => r.valid && r.action && r.prompt && r.output);

const seen = new Set();
const out = [];
for (const r of usable) {
  // Skip exact duplicates - the same message often repeats (people retype,
  // and we re-ask), and duplicates just teach the model to answer twice.
  const key = r.prompt.slice(-120) + '|' + r.action;
  if (seen.has(key)) continue;
  seen.add(key);

  // The user turn we stored includes the snapshot + knowledge + "Reply as JSON
  // now." For SFT we want only the part that varies with their message, so cut
  // everything from the PHOTO QUEUE marker onwards - that block is identical
  // boilerplate in every row and would dominate training.
  let user = r.prompt;
  const cut = user.indexOf('PHOTO QUEUE');
  if (cut > 0) user = user.slice(0, cut).trim();
  user = user.replace(/Recent group chat:\s*\n?/, '').trim();

  out.push({
    system,
    user,
    assistant: typeof r.output === 'string' ? r.output.trim() : JSON.stringify(r.output),
    meta: { action: r.action, model: r.model, ts: r.ts },
  });
}

if (out.length < minRows) {
  console.log(`only ${out.length} usable rows (need ${minRows}) - keep using the bot, then re-export.`);
  process.exit(0);
}

await writeFile(outPath, out.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');

const byAction = {};
for (const o of out) byAction[o.meta.action] = (byAction[o.meta.action] || 0) + 1;
console.log(`wrote ${out.length} SFT rows -> training/sft.jsonl`);
console.log('by action:', JSON.stringify(byAction));
console.log('\nTo train (GPU, single 4060):');
console.log('  python train_sft.py   # see that file for the Unsloth/LoRA setup');