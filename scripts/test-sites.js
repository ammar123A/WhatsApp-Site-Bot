// Site detection from group name (pure, no DB / no WhatsApp).
import { deriveSiteName, registerGroup, siteFor, listSites } from '../src/sites.js';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
}

console.log('--- derive site name from group name ---');
check('HY Sky Awani Prima', deriveSiteName('HY Sky Awani Prima'), 'Sky Awani Prima');
check('Sky Awani Prima', deriveSiteName('Sky Awani Prima'), 'Sky Awani Prima');
// Case is preserved as the group shows it - only the prefix is matched
// case-insensitively, so acronyms like "SDN BHD" are never mangled.
check('lowercase group keeps its case', deriveSiteName('hy sky awani prima'), 'sky awani prima');
check('HYSD KL Sentul', deriveSiteName('HYSD KL Sentul'), 'KL Sentul');
check('HY Sky Awani Prima - Group', deriveSiteName('HY Sky Awani Prima - Group'), 'Sky Awani Prima');
check('Projectcyber Jaya', deriveSiteName('Project Cyber Jaya'), 'Cyber Jaya');
check('SITE Putrajaya', deriveSiteName('SITE Putrajaya'), 'Putrajaya');
check('double prefix HY HY Shah Alam', deriveSiteName('HY HY Shah Alam'), 'Shah Alam');
check('keeps internal spaces', deriveSiteName('HY Taman Melati Grande'), 'Taman Melati Grande');
check('does not strip a real first word', deriveSiteName('HYPERION Tower'), 'HYPERION Tower');
check('no name', deriveSiteName(''), 'Unknown Site');
check('null name', deriveSiteName(null), 'Unknown Site');
check('strips zero-width junk', deriveSiteName('HY\u200b Sky Awani Prima'), 'Sky Awani Prima');
check('collapses whitespace', deriveSiteName('HY  Sky   Awani Prima'), 'Sky Awani Prima');
check('bot group name kept as-is', deriveSiteName('Kerani'), 'Kerani');

console.log('\n--- register groups independently ---');
registerGroup('120363@g.us', 'HY Sky Awani Prima');
registerGroup('120999@g.us', 'HY Taman Melati Grande');
registerGroup('121111@g.us', 'Sky Awani Prima');
check('group 1 site', siteFor('120363@g.us'), 'Sky Awani Prima');
check('group 2 site', siteFor('120999@g.us'), 'Taman Melati Grande');
check('group 3 site', siteFor('121111@g.us'), 'Sky Awani Prima');
check('three groups tracked', listSites().length, 3);
check('unknown group', siteFor('nope@g.us'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);