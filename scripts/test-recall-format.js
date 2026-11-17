/**
 * The site team recalls records by number, so numbers must be visible, and
 * materials are recalled by DATE, not dumped as "everything so far".
 *
 * Pure/offline: no DB writes, no network. Builds fake rows and a fake msg.
 */
import {
  buildIssuesMessage,
  buildMaterialsMessage,
  parseRecordDate,
  ASK_WHICH_DATE,
  getToday
} from '../src/utils.js';
import { handleMaterials } from '../src/handlers/materials.js';

let pass = 0;
let fail = 0;

function check(label, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

/** Fake whatsapp message that just records what the bot replied. */
function fakeMsg() {
  const replies = [];
  return {
    replies,
    hasMedia: false,
    from: '60111111111@c.us',
    async reply(t) { replies.push(t); return t; }
  };
}

const issue = {
  id: 12,
  date: '02/10/2026',
  title: 'Paip atas bumbung pecah',
  description: 'Air menitis dekat Blok A',
  category: 'MEP',
  priority: 'urgent',
  status: 'open',
  location: 'Blok A',
  reported_by: 'Azman',
  assigned_to: null,
  photos: null
};

const mat = {
  id: 8,
  date: '01/10/2026',
  material_name: 'Cement',
  category: 'Cement',
  quantity: 100,
  unit: 'bags',
  supplier: 'ABC',
  location: 'Store',
  received_by: null
};

console.log('\nISSUE LIST - id, issue, status only');
{
  const out = buildIssuesMessage([issue]);
  check('shows the id', out.includes('#12'));
  check('shows the issue title', out.includes('Paip atas bumbung pecah'));
  check('shows the status', /OPEN/i.test(out));
  check('no category', !out.toLowerCase().includes('category'));
  check('no MEP leaked', !out.includes('MEP'));
  check('no priority', !out.toLowerCase().includes('priority') && !out.includes('urgent'));
  check('no location', !out.toLowerCase().includes('location'));
  check('no assignee', !out.toLowerCase().includes('assigned'));
}

console.log('\nMATERIAL LIST - id shown, real date shown');
{
  const out = buildMaterialsMessage([mat]);
  check('shows the id', out.includes('#8'));
  check('shows the record date, not today', out.includes('01/10/2026'));
  check('did not claim today', !out.includes(getToday()) || getToday() === '01/10/2026');
  check('quantity shown', /100 bags/.test(out));
}

console.log('\nDATE PARSING');
{
  check('hari ini -> today', parseRecordDate('hari ini') === getToday());
  check('today -> today', parseRecordDate('today') === getToday());
  check('explicit date', parseRecordDate('15/09/2026') === '15/09/2026');
  check('dotted date', parseRecordDate('15.09.2026') === '15/09/2026');
  check('semalam -> yesterday', parseRecordDate('semalam') !== getToday());
  check('nonsense -> null', parseRecordDate('tu je') === null);
  check('empty -> null', parseRecordDate('') === null);
}

console.log('\n.materials WITH NO DATE - asks which date');
{
  const msg = fakeMsg();
  await handleMaterials(msg, []);
  const out = msg.replies.join('\n');
  check('asked a question', /tarikh/i.test(out));
  check('question mentions today/semalam', /hari ini/i.test(out) && /semalam/i.test(out));
  check('used the shared question', out.includes(ASK_WHICH_DATE.split('(')[0].trim().replace('boss', '').trim()) || /tarikh mana/i.test(out));
}

console.log('\n.materials FOR A DATE WITH NO RECORDS');
{
  const msg = fakeMsg();
  await handleMaterials(msg, ['15/09/2026']);
  const out = msg.replies.join('\n');
  check('says nothing on that date', /takde material/i.test(out));
  check('repeats the date asked', out.includes('15/09/2026'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);