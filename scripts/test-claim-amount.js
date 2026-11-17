/**
 * Personal claim amount parsing. Offline, no DB, no network.
 *
 * The parser decides what money goes on a claim, so a wrong answer here is money
 * that is either missed or claimed twice. Every case below is something a person
 * would actually type under a receipt photo.
 */
import { parseClaimAmount, monthLabel, money, CLAIM_DAY } from '../src/handlers/claims.js';

let pass = 0;
let fail = 0;

function check(label, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

const amt = (label, caption, expected, how = null) => {
  const got = parseClaimAmount(caption);
  const ok = Math.abs(got.amount - expected) < 0.001;
  check(`${label} -> ${expected}`, ok, `got ${got.amount} (${got.how})`);
  if (how) check(`${label} reads as ${how}`, got.how === how, `got "${got.how}"`);
};

console.log('\nTHE USER\'S OWN EXAMPLE');
amt('caption "40"', '40', 40, 'only number');
amt('no caption at all', '', 0, 'no caption');
amt('whitespace only', '   ', 0, 'no caption');

console.log('\nTHE OBVIOUS WAYS PEOPLE WRITE MONEY');
amt('plain', '40', 40);
amt('ringgit suffix', '40 ringgit', 40);
amt('RM prefix', 'RM40', 40);
amt('RM spaced', 'RM 40', 40);
amt('mixed case', 'rm 40', 40);
amt('decimals with a dot', '40.50', 40.5);
amt('decimals with a comma', '40,50', 40.5);
amt('thousands with a comma', '1,250', 1250);
amt('thousands and cents', '1,250.50', 1250.5);
amt('one decimal comma', '12,5', 12.5);
amt('four figures', '1250.75', 1250.75);

console.log('\nA DATE OR TIME IN THE CAPTION IS NOT MONEY');
amt('dated caption', 'resit 04/10/2026', 0);
amt('dated caption with amount', '04/10/2026 - 40 ringgit', 40, 'labelled');
amt('slashed date only', '10/10', 0);
amt('time only', '14:30', 0);
amt('date with dashes', '2026-10-04', 0);

console.log('\nQUANTITY x PRICE');
amt('2 x 20', '2 x 20', 40, 'multiplied');
amt('3 x 12.50', '3 x 12.50', 37.5, 'multiplied');
amt('quantity wins over a stray number later', '2 x 20 ringgit', 40, 'multiplied');

console.log('\nCAPTION WITH WORDS BUT NO MONEY');
amt('just a note', 'resit minyak', 0, 'caption has no number');
amt('filename-like', 'IMG-001', 0);

console.log('\nSEVERAL NUMBERS: TAKE THE FIRST, SAY SO');
{
  const got = parseClaimAmount('40 ringgit 2 bottle');
  check('first of several is 40', Math.abs(got.amount - 40) < 0.001, `got ${got.amount}`);
  check('and it is flagged as ambiguous', got.how === 'labelled', got.how);
}

console.log('\nHUGE OR JUNK NUMBERS DO NOT BREAK IT');
amt('a thousand', '1000', 1000);
amt('no digits', 'abc', 0);
amt('just a dot', '.', 0);
// A claim is money SPENT, so it is never negative. "-15" is read as 15: the
// stray hyphen in "40 - 15 change" must not subtract from a claim total.
amt('a stray hyphen does not go negative', '-15', 15);

console.log('\nLABELS AND FORMATTING');
check('money always shows 2 decimals', money(40) === '40.00', money(40));
check('money rounds to 2 decimals', money(40.005) === '40.01' || money(40.005) === '40.00', money(40.005));
check('money on null is 0.00', money(null) === '0.00', money(null));
check('month label reads properly', monthLabel('2026-10') === 'Oct 2026', monthLabel('2026-10'));
check('month label handles january', monthLabel('2026-01') === 'Jan 2026', monthLabel('2026-01'));
check('month label on junk is passed through', monthLabel('nope') === 'nope', monthLabel('nope'));
check('claim day is the 28th', CLAIM_DAY === 28, String(CLAIM_DAY));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);