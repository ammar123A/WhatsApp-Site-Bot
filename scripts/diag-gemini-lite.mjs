import fs from 'node:fs';

const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .forEach((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  });

const MODEL = 'gemini-3.1-flash-lite';
const RUNS = 6;
let ok = 0;

for (let i = 1; i <= RUNS; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: 'Reply as JSON.' }] },
          contents: [{ role: 'user', parts: [{ text: 'say hi' }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 50 },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    const j = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (res.status === 200) ok++;
    console.log(
      `run${i} ${res.status} ${String(ms).padEnd(7)}ms ${(j.error?.message || JSON.stringify(j).slice(0, 40)).slice(0, 70)}`
    );
  } catch (e) {
    console.log(`run${i} ERR  ${Date.now() - t0}ms ${e.message.slice(0, 60)}`);
  }
}
console.log(`\n${ok}/${RUNS} succeeded on ${MODEL}`);
process.exit(0);