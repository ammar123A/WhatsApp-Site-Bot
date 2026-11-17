import fs from 'node:fs';

const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .forEach((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  });

const MODEL = env.GEMINI_MODEL;
console.log('probing', MODEL, 'x6 with 8s cap');
let ok = 0;
for (let i = 1; i <= 6; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
        signal: AbortSignal.timeout(8000),
      }
    );
    await res.json().catch(() => ({}));
    if (res.status === 200) ok++;
    console.log(`run${i} ${res.status} ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`run${i} TIMEOUT/ERR ${Date.now() - t0}ms ${e.message.slice(0, 45)}`);
  }
}
console.log(`${ok}/6 ok`);
process.exit(0);