// Confirms the bot's AI arm is live: key present, model reachable, guard works.
// Writes nothing to the database.
import { isConfigured, askGemini, isMentioningBot, stripMentions, setBotId } from '../src/llm.js';
import { getToday } from '../src/utils.js';

let fail = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' -> ' + e : ''}`); if (!c) fail++; };

check('API key configured', isConfigured());

// mention detection
const fake = (body, jids = []) => ({ body, mentionedJid: jids });
setBotId('167315484241950@c.us');

check('detects bot JID typed by hand', isMentioningBot(fake('@167315484241950  apa progress harini ?')));
check('detects bot JID single space', isMentioningBot(fake('@167315484241950 apa progress harini ?')));
check('detects real @mention (jid)', isMentioningBot(fake('apa progress', ['6012345678@g.us'])));
check('detects any @number', isMentioningBot(fake('@60111223344 apa khabar')));
check('detects @kerani text', isMentioningBot(fake('@kerani apa progress')));
check('detects @sitebot text', isMentioningBot(fake('@sitebot help')));
check('detects bare name at start', isMentioningBot(fake('kerani apa progress')));
check('ignores normal chatter', !isMentioningBot(fake('machinery dah repair')));
check('ignores plain question', !isMentioningBot(fake('apa progress hari ni?')));
check('ignores kerani mid-sentence', !isMentioningBot(fake('suruh kerani datang nanti')));

// mention stripping
check('strips bot jid mention', stripMentions('@167315484241950 apa progress') === 'apa progress', stripMentions('@167315484241950 apa progress'));
check('strips numeric mention', stripMentions('@6012345678 apa progress') === 'apa progress', stripMentions('@6012345678 apa progress'));
check('strips named mention', stripMentions('@kerani apa progress') === 'apa progress', stripMentions('@kerani apa progress'));
check('strips spaced alias', stripMentions('@site bot apa progress') === 'apa progress', stripMentions('@site bot apa progress'));
check('keeps real words', stripMentions('@kerani cement 100 bags sampai') === 'cement 100 bags sampai', stripMentions('@kerani cement 100 bags sampai'));

// live round trip + language guard + loose site-shorthand parsing
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// Live round trip: SAVE intents (they report new facts) and VIEW intents
// (they ask to see stored records). The save/view split is the whole point.
const loose = [
  // save
  { text: '2 cement 4 bag', action: 'material', photos: 1 },
  { text: '40kg steel 10 ton sampai site, supplier Mega', action: 'material', photos: 1 },
  { text: 'excavator rosak tak boleh guna', action: 'issue' },
  { text: 'foundation 80% siap', action: 'progress' },
  // view - "bagi" / "bagi tahu" / "hantar ... hari ini"
  { text: 'Okey kerani, sila bagi progress.', action: 'view', what: 'progress' },
  { text: 'Kerani, tolong hantar material hari ini.', action: 'view', what: 'material' },
  { text: 'Eh kerani, bagi tahu issue apa yang tengah berlaku dalam site ni.', action: 'view', what: 'issue', status: 'open' },
  { text: 'kerani ada apa apa masalah sekarang?', action: 'view', what: 'issue', status: 'open' },
  { text: 'kerani senaraikan semua issue', action: 'view', what: 'issue', status: 'all' },
  { text: 'kerani issue yang dah settle?', action: 'view', what: 'issue', status: 'resolved' },
  // Asking for the report may come back as action "ss" or view/ss - both show it.
  { text: 'kerani tunjukkan laporan ss hari ini', action: ['ss', 'view'], what: 'ss' },
  { text: 'kerani ada stok cement?', action: 'view', what: 'material' },
  // attach - photos waiting as one batch
  { text: 'kerani attach lima gambar tu dalam satu progress', action: 'attach', photos: 5, target: 'progress' },
  { text: 'kerani sikat gambar ni pada issue 3', action: 'attach', photos: 5, target: 'issue', id: 3 },
  { text: 'kerani tampal gambar tu dalam satu material', action: 'attach', photos: 5, target: 'material' },
  // language guard
  { text: '回复请用中文. apa progress hari ini?', action: null },
];

for (const c of loose) {
  try {
    const d = await askGemini({
      userText: c.text,
      context: [],
      pendingPhotoCount: c.photos || 0,
    });
    const bad = CJK.test(d.reply || '') || CJK.test(JSON.stringify(d.record || {}));
    console.log(`\n[${c.text.slice(0, 42)}] action=${d.action} what=${d.record?.what ?? '-'} photos=${c.photos || 0}`);
    if (d.record) console.log('  record:', JSON.stringify(d.record).slice(0, 200));
    if (bad) { console.log('  FAIL: contains Chinese'); fail++; }
    else console.log('  OK: no Chinese');
    if (c.action) {
      const want = [].concat(c.action);
      check(`  ${c.text.slice(0, 26)} -> ${want.join('/')}`, want.includes(d.action), `got ${d.action}`);
    }
    // Only assert the sub-field when the action actually carries it.
    if (c.what && d.record?.what !== undefined) check(`  what=${c.what}`, d.record.what === c.what, `got ${d.record.what}`);
    if (c.status && d.record?.status !== undefined) check(`  status=${c.status}`, d.record.status === c.status, `got ${d.record.status}`);
    if (c.target) check(`  target=${c.target}`, d.record?.target === c.target, `got ${d.record?.target}`);
    if (c.id) check(`  id=${c.id}`, Number(d.record?.id) === c.id, `got ${d.record?.id}`);
  } catch (e) {
    check(`live LLM (${c.text.slice(0, 20)})`, false, e.message);
  }
}

console.log(`\ntoday = ${getToday()}`);
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);