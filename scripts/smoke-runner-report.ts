/**
 * The suite runner names the failing check of a failed smoke.
 *
 * On Nov 23 smoke-design-system failed on the owner's Mac and the runner's
 * report showed 20 lines of a size table and "42/43 checks passed": the one
 * FAIL line was printed before the table and fell outside the tail. The report
 * now lists every FAIL line first, whole, then the tail (scripts/lib/smoke-report.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureLines, failureReport, TAIL_LINES } from './lib/smoke-report.js';

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

// The Nov 23 shape: checks, one FAIL with a long detail, then a 30-line table and the count.
const longDetail = `settings at 390: 571px wide (${'x'.repeat(600)})`;
const output = [
  'OK  B3. light: the bundled files loaded',
  `FAIL B4. no page scrolls sideways at 390 : ${longDetail}`,
  '',
  'Size counts by route (visible text elements):',
  ...Array.from({ length: 30 }, (_, i) => `  light route-${i}  12px:${i} 13px:${i}`),
  '  OK  C5. formatDate renders the same string',
  '42/43 checks passed.',
];
const report = failureReport('smoke-design-system', 'exit 1, no OK line', output);
const text = report.join('\n');
check('A1. the old report (the last 20 lines alone) did not hold the FAIL line', !output.slice(-TAIL_LINES).some((l) => l.includes('FAIL')));
check('A2. the report names the failing check', report.some((l) => l.trim().startsWith('FAIL B4. no page scrolls sideways at 390')));
check('A3. the FAIL line is printed whole, however long', text.includes(longDetail));
check('A4. it says how many FAIL lines there are, before the tail', report.indexOf('1 FAIL line(s):') > 0 && report.indexOf('1 FAIL line(s):') < report.findIndex((l) => l.startsWith('last ')));
check('A5. the tail is still printed, 20 lines', report.includes(`last ${TAIL_LINES} line(s) of output:`) && text.includes('42/43 checks passed.'));
check('A6. the header carries the smoke name and the reason', report.includes('=== smoke-design-system: exit 1, no OK line ==='));

// A hint printed on its own indented line under the FAIL line travels with it.
const withHint = failureLines(['OK  A1. fine', 'FAIL C2. serverInfo.version equals package.json', '     0.4.0 vs 0.3.0', 'OK  C3. next check', '  FAIL D1. indented by a runner', 'plain line']);
check('B1. a hint line under a FAIL line is kept with it', withHint.length === 3 && withHint[1]!.trim() === '0.4.0 vs 0.3.0', JSON.stringify(withHint));
check('B2. an indented FAIL line counts, an OK line and a plain line do not', withHint[2] === 'FAIL D1. indented by a runner' && !withHint.some((l) => l.includes('OK') || l.includes('plain')));

// A smoke that crashed prints no FAIL line: the report says so, it never reads as "0 failures".
const crashed = failureReport('smoke-x', 'exit 1, no OK line', ['starting', 'TypeError: boom', '    at file.ts:1:1']);
check('C1. no FAIL line in the output is said in words', crashed.some((l) => l.startsWith('no FAIL line in the output')) && crashed.some((l) => l.includes('TypeError: boom')));
check('C2. a word that only contains FAIL is not a FAIL line', failureLines(['FAILED to connect is not a check line', 'the word FAIL in the middle']).length === 0);

// The runner uses it.
const runner = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke-all.ts'), 'utf8');
check('D1. smoke-all prints failureReport for every failed smoke and keeps the whole output, not a 20-line slice', runner.includes('failureReport(r.name, r.reason, r.output)') && !runner.includes('slice(-20)'));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a failed smoke\'s report lists every FAIL line whole, then the tail.');
