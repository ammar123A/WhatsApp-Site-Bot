// Read-only verification: multi-worker parse + shift-only report.
// Does NOT write or delete anything.
import { parseWorkers as parseWorkersForTest } from '../src/handlers/diary.js';
import { buildSSReportForDate } from '../src/utils.js';

let fail = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' -> ' + e : ''}`); if (!c) fail++; };

const body = `.addattendance
Name: Ali
Contractor: ABC
Role: Foreman
Shift: 0800-1900
Name: Abu
Contractor: hys
Role: Foreman
Shift: 0800-1900`;

const w = parseWorkersForTest(body);
console.log('parsed:', JSON.stringify(w, null, 1));
check('two workers parsed', w.length === 2, String(w.length));
check('first worker fields', w[0].name === 'Ali' && w[0].contractor === 'ABC' && w[0].role === 'Foreman' && w[0].shift === '0800-1900');
check('second worker fields', w[1].name === 'Abu' && w[1].contractor === 'hys' && w[1].shift === '0800-1900');
check('hours not captured', !('hours' in w[0]) && !('ot' in w[0]));

// hours/ot lines must be ignored, not crash
const w2 = parseWorkersForTest(`.addattendance
Name: Reza
Hours: 9
OT: 2
Shift: 0800-1900`);
check('hours/ot ignored', w2.length === 1 && w2[0].shift === '0800-1900', JSON.stringify(w2));

// report with those workers
const rep = await buildSSReportForDate({
  diary: { date: '30/9/2026', site_name: 'Flora Hijauen SBR', operators: 'Reza (ex08)', machinery: 'Excavator 13', machinery_equipment: 'chainsaw - 1 nos', weather: 'Cerah' },
  attendance: [
    { worker_name: 'Ali', shift: '0800-1900' },
    { worker_name: 'Abu', shift: '0800-1900' },
  ],
});
console.log('\n--- report ---\n' + rep + '\n--------------\n');
check('worker shift only', rep.includes('- Ali : 0800-1900') && rep.includes('- Abu : 0800-1900'));
check('operator from diary', rep.includes('- Reza (ex08)'));
check('no hours anywhere', !/\d+\s*h\b/.test(rep));

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);