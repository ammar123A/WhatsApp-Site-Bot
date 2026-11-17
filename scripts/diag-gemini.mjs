import fs from 'node:fs';

const env = {};
fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .forEach((l) => {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  });

console.log('GEMINI_MODEL =', env.GEMINI_MODEL);
const models = [env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'].filter(Boolean);
console.log('models =', JSON.stringify(models));

for (const model of models) {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: 'Reply as JSON.' }] },
          contents: [{ role: 'user', parts: [{ text: 'say hi' }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 50 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const j = await res.json().catch(() => ({}));
    console.log(
      String(res.status).padEnd(4),
      (Date.now() - t0 + 'ms').padEnd(8),
      model.padEnd(24),
      (j.error?.message || 'OK').slice(0, 120)
    );
  } catch (e) {
    console.log('ERR ', (Date.now() - t0 + 'ms').padEnd(8), model.padEnd(24), e.message.slice(0, 80));
  }
}
process.exit(0);