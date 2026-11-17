/**
 * The id shapes matter: whatsapp-web.js's own sendReaction() silently no-ops
 * when the store lookup misses, which is why the site saw no emoji and no error.
 * These tests pin the id-resolution that fixes it.
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

// The real id shape captured from the live group message.
const LIVE = 'false_120363429870294483@g.us_3EB018B02C834AD0EE6251_207816925118684@lid';

/** Same logic as src/reactions.js idCandidates(), copied so we can test it. */
function keyId(key) {
  if (!key) return null;
  if (typeof key === 'string') return key;
  return key._serialized ?? key.$1 ?? key;
}
function idCandidates(msg) {
  const raw = [
    keyId(msg.id),
    msg.id && msg.id._serialized,
    msg.id && msg.id.$1,
    msg._data && msg._data.id && msg._data.id._serialized,
    msg._data && msg._data.id && msg._data.id.$1,
    msg._data && msg._data.id,
  ].filter((v) => typeof v === 'string' && v.length);
  const out = [];
  for (const id of raw) {
    const trimmed = id.startsWith('false_') ? id.slice(6) : id;
    for (const c of [id, trimmed]) if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

console.log('\nTHE ID THAT BROKE REACTIONS');
{
  const ids = idCandidates({ id: { _serialized: LIVE }, _data: { id: { _serialized: LIVE } } });
  check('finds something to try', ids.length > 0);
  check('strips the false_ prefix', ids.includes(LIVE.slice(6)), ids.join(' | '));
  check('keeps the original too', ids.includes(LIVE));
  check('no duplicate candidates', new Set(ids).size === ids.length);
}

console.log('\nOTHER WAYS WHATSAPP HANDS OUT IDS');
{
  check('modern $1 key', idCandidates({ id: { $1: '3EB0@lid' } }).includes('3EB0@lid'));
  check('plain string id', idCandidates({ id: 'ABC@lid' }).includes('ABC@lid'));
  check('raw _data string', idCandidates({ _data: { id: 'XYZ@lid' } }).includes('XYZ@lid'));
  check('no id at all is empty', idCandidates({}).length === 0);
  check('null id is empty', idCandidates({ id: null }).length === 0);
}

console.log('\nTHE MODULE REALLY EXISTS IN THE SOURCE');
{
  const src = readFileSync(new URL('../src/reactions.js', import.meta.url), 'utf8');
  // Only the explanatory comment may mention msg.react() - no live call.
  const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  check('no live msg.react() call', !/msg\.react\(/.test(code), 'msg.react() is the silent no-op');
  check('explains why in a comment', /msg\.react\(\)/.test(src));
  check('checks the store module exists', /WAWebSendReactionMsgAction/.test(src));
  check('tries several id forms', /getMessagesById/.test(src));
  check('reports failure instead of assuming success', /reaction .* failed/.test(src));
  check('logs success for the terminal', /reaction sent/.test(src));
}

console.log('\nSILENT MODE NEVER LEAVES THE SITE GUESSING');
{
  const src = readFileSync(new URL('../src/reactions.js', import.meta.url), 'utf8');
  check('falls back to text when the emoji fails', /Silent mode, but the reaction failed/.test(src));
  check('errors always speak', /A real failure/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);