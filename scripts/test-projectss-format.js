import { buildSSReport, buildSSReportForDate, formatSSDate, ssList, parseArgs, recordCaption } from '../src/utils.js';

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' -> ' + extra : ''}`);
  if (!cond) fail++;
};

// ── formatSSDate ──────────────────────────────────────────────────────────
check('date drops leading zeros', formatSSDate('22/09/2026') === '22/9/2026', formatSSDate('22/09/2026'));
check('single digit day', formatSSDate('02/09/2026') === '2/9/2026', formatSSDate('02/09/2026'));

// ── ssList ────────────────────────────────────────────────────────────────
const raw = 'Dumpy level - 1 nos\nGrinder (small) - 1 nos';
check('ssList strips numbering', ssList(raw).length === 2, JSON.stringify(ssList(raw)));
check('ssList strips bullets', ssList('- Excavator 13\n- \u2060Compactor 25 ton')[1] === 'Compactor 25 ton', JSON.stringify(ssList('- Excavator 13\n- \u2060Compactor 25 ton')));
check('ssList empty', ssList(null).length === 0);

// ── report format ─────────────────────────────────────────────────────────
const WEATHER = '🌤️☀️🌤️';
const report = buildSSReport({
  siteName: 'Flora Hijauen SBR',
  date: '22/09/2026',
  hyWorkers: [{ worker_name: 'Rippon', shift: '0800-1900' }, { worker_name: 'Hridoy', shift: '0800-1900' }],
  // Operators are plain strings now, typed into .addss
  operators: ['Reza (ex08)'],
  machineryEquipment: 'chainsaw - 1 nos\nDumpy level - 1 nos\nGrinder (small) - 1 nos',
  machinery: 'Excavator 13\nCompactor 25 ton',
  weather: WEATHER,
});
console.log('\n--- report ---\n' + report + '\n--------------\n');

check('site header', report.startsWith('*Flora Hijauen SBR*'));
check('date line', report.includes('Date : 22/9/2026'));
check('HY Workers section', report.includes('*HY Workers*'));
check('worker with shift only', report.includes('- Rippon : 0800-1900'));
check('no hours shown', !/\d+h\b/.test(report), report.split('\n').filter(l => /h\b/.test(l)).join('|'));
check('operator as plain line', report.includes('- Reza (ex08)'));
check('equipment numbered', report.includes('1) chainsaw - 1 nos') && report.includes('3) Grinder (small) - 1 nos'));
check('machinery bulleted', report.includes('- Excavator 13') && report.includes('- Compactor 25 ton'));
check('weather line', report.includes('*Weather* - ' + WEATHER));

// ── empty operator section stays empty (no "belum diisi" nag) ─────────────
const noOp = buildSSReport({
  siteName: 'Flora Hijauen SBR', date: '22/09/2026',
  hyWorkers: [{ worker_name: 'Rippon', shift: '0800-1900' }],
  operators: [], machineryEquipment: 'chainsaw - 1 nos', machinery: 'Excavator 13', weather: 'Cerah',
});
const opSection = noOp.split('*Operator*')[1].split('*Machinery & Equipment*')[0];
check('operator section blank when unset', !opSection.trim(), JSON.stringify(opSection));
check('blank operator still keeps header', noOp.includes('*Operator*'));

// ── operators come from the diary field, NOT attendance ───────────────────
const fromDate = await buildSSReportForDate({
  diary: {
    date: '22/09/2026', site_name: 'Flora Hijauen SBR', weather: 'Cerah',
    machinery: 'Excavator 13', machinery_equipment: 'chainsaw - 1 nos',
    operators: 'Reza (ex08)\nBudi (ex11)',
  },
  attendance: [
    { worker_name: 'Rippon', role: 'Welder', shift: '0800-1900' },
    { worker_name: 'Khairuddin Opo', role: 'Operator', shift: '0800-1900' },
  ],
});
const opPart2 = fromDate.split('*Operator*')[1].split('*Machinery & Equipment*')[0];
const hyPart2 = fromDate.split('*HY Workers*')[1].split('*Operator*')[0];
check('attendance no longer split by role', hyPart2.includes('Rippon') && hyPart2.includes('Khairuddin Opo'), hyPart2.replace(/\n/g, '|'));
check('operator list from diary', opPart2.includes('- Reza (ex08)') && opPart2.includes('- Budi (ex11)'));
check('hours/ot not used when shift missing', fromDate.includes('- Rippon : 0800-1900'));

// ── parseArgs multi-word keys ─────────────────────────────────────────────
const a = parseArgs('.addmaterial\nMaterial arrived onsite: Cement\nWhich site: Store\nReceived by: John', 1);
check('multi-word key parsed', a['material arrived onsite'] === 'Cement', JSON.stringify(a));
check('which site parsed', a['which site'] === 'Store');
check('received by parsed', a['received by'] === 'John');
const b = parseArgs('.addprogress\nWork: pasang pipe\nReported By: Contractor A', 1);
check('Work + Reported By parsed', b.work === 'pasang pipe' && b['reported by'] === 'Contractor A', JSON.stringify(b));

// ── per-record photo captions (list views send 1 photo + its description) ──
const capIssue = recordCaption({
  id: 4, title: 'Water leak', description: 'Leak at 2nd floor',
  location: 'Blok A', status: 'open', priority: 'high', reported_by: 'Azman',
  photos: JSON.stringify(['a.jpg']),
}, 'Issue');
check('caption names the kind + id', capIssue.startsWith('*Issue #4*'), capIssue);
check('caption carries the title', capIssue.includes('Water leak'));
check('caption carries the description', capIssue.includes('> Leak at 2nd floor'));
check('caption carries location', capIssue.includes('📍 Blok A'));
check('caption carries reporter', capIssue.includes('👤 Azman'));
check('single photo - no photo-count note', !capIssue.includes('photos for this record'), capIssue);

const capMany = recordCaption({
  id: 5, title: 'Burst pipe', description: 'pecah', photos: JSON.stringify(['a', 'b', 'c']),
});
check('multi photo - count noted', capMany.includes('(3 photos for this record)'), capMany);

const capMat = recordCaption({ id: 2, description: 'Cement delivered', quantity: 100, unit: 'bags', received_by: 'Ali' });
check('material caption shows qty', capMat.includes('📦 100 bags'), capMat);
check('material caption shows receiver', capMat.includes('👤 Ali'));

const capNoDesc = recordCaption({ id: 9, title: 'Only title' });
check('no empty lines when fields missing', !capNoDesc.includes('undefined'), capNoDesc);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
