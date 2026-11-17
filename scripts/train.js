#!/usr/bin/env node
// Training helper - runs from the MAIN PC.
//
//   node scripts/train.js status      dataset + GPU readiness
//   node scripts/train.js export      build training/sft.jsonl
//   node scripts/train.js train       fine-tune here on the 4060
//
// Everything is local now: the dataset accumulates in training/dataset.jsonl as
// the bot answers, `export` shapes it, and `train` fine-tunes on this machine's
// own GPU.
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SFT = join(ROOT, 'training', 'sft.jsonl');
const DATASET = join(ROOT, 'training', 'dataset.jsonl');
const cmd = process.argv[2] || 'status';
const sh = (c) => execSync(c, { cwd: ROOT, stdio: 'inherit', shell: 'cmd.exe' });

async function main() {
  if (cmd === 'status') {
    const rows = existsSync(DATASET) ? readFileSync(DATASET, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const sft = existsSync(SFT) ? readFileSync(SFT, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    console.log(`dataset rows: ${rows}`);
    console.log(`sft rows:     ${sft}`);
    console.log(`fine-tunable: ${sft >= 30 ? 'yes' : `not yet (${sft}/30 - keep using the bot, rows accumulate automatically)`}`);
    try { sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'); } catch {}
    return;
  }

  if (cmd === 'export') { sh('node scripts/export-sft.js'); return; }

  if (cmd === 'train') {
    if (!existsSync(SFT)) { console.error('run: node scripts/train.js export'); process.exit(1); }
    console.log('This needs: pip install unsloth torch datasets trl peft  (CUDA build).');
    sh('python train_sft.py');
    return;
  }
}

main().catch(e => { console.error(e); process.exit(1); });