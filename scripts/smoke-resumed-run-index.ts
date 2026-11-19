/**
 * Locks how the index treats the two host-memory records a resumed run
 * writes (invariant 85). Run ceeaf2 stopped on API credit at 08:40:24Z with
 * $3.7761 spent and was resumed at 08:43:51Z; its one report says $5.8701
 * and starts at the resume. The first process's record fell 3 min 27 s
 * before the report's start, outside the 2 minute match window, so the
 * index imported it as an "older run" and the localhost card read
 * "$20.58 spent this month" (the three reports sum to $16.80) and
 * "1 older run kept a summary only".
 *
 *   A  coveredSpanStart: the earlier of the report's start and the run id's
 *   B  the localhost shape (runs 71d739, b4e41b, ceeaf2 with their recorded
 *      times and costs, and the four records they wrote): 3 runs, no legacy
 *      row, spend equal to the three reports
 *   C  a record from before the run folder existed is still imported, a
 *      record of another host inside the span is still imported, and a run
 *      id that carries no time keeps the old rule
 *   D  a second index pass removes a row an older index had imported
 * No model, no browser.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput, coveredSpanStart, runRowFromLegacyRecord, LEGACY_MATCH_MS } from '../src/server/db/indexer.js';
import { totalCost } from '../src/agent/cost-total.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* A */
const idStart = Date.parse('2026-11-18T08:32:03.000Z');
const reportStart = '2026-11-18T08:43:51.322Z';
check('A1. a resumed run: the span starts at the run id time, before the report start', coveredSpanStart('20261118T083203Z-ceeaf2', reportStart) === idStart);
check('A2. an unresumed run: the report start a few seconds after the id changes nothing material', coveredSpanStart('20261117T120141Z-b4e41b', '2026-11-17T12:01:45.859Z') === Date.parse('2026-11-17T12:01:41.000Z'));
check('A3. a run id that carries no time uses the report start', coveredSpanStart('legacy-automation-framework', reportStart) === Date.parse(reportStart));
check('A4. no report start uses the id time; neither known is NaN', coveredSpanStart('20261118T083203Z-ceeaf2', null) === idStart && Number.isNaN(coveredSpanStart('custom-out', null)));

/* fixture: the localhost project as it is on disk */
const URL_ = 'http://localhost:4200/';
function mkReport(startedAt: string, finishedAt: string, shipped: number, cost: { usd: number; plannerUsd: number; criticUsd: number }): RunReport {
  const scenarios = Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, feature: 'catalogue', category: 'happy' as const, steps: [{ kind: 'navigate' as const, url: URL_ }] }));
  return {
    url: URL_, language: 'ts', scenarios, cascadeStats: {} as never,
    cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, repairUsd: 0, requirementsUsd: 0, ...cost },
    steps: 10, startedAt, finishedAt, findings: [],
    plan: scenarios.map((s) => ({ name: s.name, category: 'happy', rationale: 'r', feature: 'catalogue' })),
  } as unknown as RunReport;
}
// Times and totals copied from the three run-report.json files (totalCost: 6.1979, 4.7337, 5.8701).
const RUNS = [
  { id: '20261102T130321Z-71d739', report: mkReport('2026-11-02T13:03:25.353Z', '2026-11-02T13:18:22.883Z', 10, { usd: 6.0000, plannerUsd: 0.0500, criticUsd: 0.1479 }) },
  { id: '20261117T120141Z-b4e41b', report: mkReport('2026-11-17T12:01:45.859Z', '2026-11-17T12:13:53.921Z', 18, { usd: 4.5500, plannerUsd: 0.0500, criticUsd: 0.1337 }) },
  { id: '20261118T083203Z-ceeaf2', report: mkReport(reportStart, '2026-11-18T08:52:07.935Z', 16, { usd: 5.6765792500000005, plannerUsd: 0.05284, criticUsd: 0.1407297 }) },
];
const reportsTotal = RUNS.reduce((n, r) => n + totalCost(r.report), 0);
check('B0. the fixture reports sum to $16.80, as the three real reports do', reportsTotal.toFixed(2) === '16.80', reportsTotal.toFixed(4));

function build(records: unknown[], extra: (root: string) => void = () => {}): { root: string; db: ReturnType<typeof openDatabase> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-resumed-index-'));
  for (const r of RUNS) {
    const dir = path.join(root, 'output', 'localhost', r.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(r.report));
    fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify({ source: 'cli', flags: {}, writtenAt: 'x' }));
  }
  fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
  fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'localhost.json'), JSON.stringify({ host: 'localhost', recentRuns: records }));
  extra(root);
  return { root, db: openDatabase(path.join(root, 'data', 'qa-core.sqlite')) };
}
const rec = (at: string, cost: number, durationSec: number, scenarios: number, url = URL_) => ({ at, url, scenarios, cost, model: 'claude-opus-4-7', durationSec });
// One record per process: runs 8 and 9 at their finish, run 10's first process at its billing stop, run 10's resume at its finish.
const FIRST_PROCESS = rec('2026-11-18T08:40:24.427Z', 3.7761, 497, 17);
const REAL_RECORDS = [
  rec('2026-11-02T13:18:22.900Z', 6.1979, 897, 10),
  rec('2026-11-17T12:13:53.950Z', 4.7337, 728, 18),
  FIRST_PROCESS,
  rec('2026-11-18T08:52:07.950Z', 5.8701, 496, 16),
];
const rowsOf = (db: ReturnType<typeof openDatabase>) => db.prepare('SELECT id, status, cost_total, project_id FROM runs ORDER BY id').all() as Array<{ id: string; status: string; cost_total: number; project_id: string }>;
const spend = (rows: Array<{ cost_total: number; project_id: string }>, project: string) => rows.filter((r) => r.project_id === project).reduce((n, r) => n + Number(r.cost_total), 0);

/* B */
{
  const { root, db } = build(REAL_RECORDS);
  const res = indexOutput(db, root);
  const rows = rowsOf(db);
  check('B1. the gap between the stop and the resume is wider than the match window (the old rule missed it)', Date.parse(reportStart) - Date.parse(FIRST_PROCESS.at) > LEGACY_MATCH_MS);
  check('B2. three runs, none of them a legacy row', rows.length === 3 && rows.every((r) => r.status !== 'legacy'), JSON.stringify(rows));
  check('B3. all four records are covered by a report', res.legacyRecords === 0 && res.legacyCovered === 4, JSON.stringify(res));
  check('B4. the project spend is the three reports, $16.80, never $20.58', spend(rows, 'localhost').toFixed(2) === '16.80' && Math.abs(spend(rows, 'localhost') - reportsTotal) < 1e-9, spend(rows, 'localhost').toFixed(4));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}

/* C */
{
  const before = rec('2026-11-18T08:20:00.000Z', 0.5, 60, 2);                        // 12 minutes before the run folder existed
  const otherHost = rec('2026-11-18T08:40:00.000Z', 0.9, 60, 3, 'https://www.saucedemo.com/'); // inside the span, another site
  const { root, db } = build([...REAL_RECORDS, before, otherHost]);
  indexOutput(db, root);
  const rows = rowsOf(db);
  const legacy = rows.filter((r) => r.status === 'legacy');
  check('C1. a record from before the run folder existed is still imported', legacy.some((r) => r.id === runRowFromLegacyRecord('localhost', before, 'localhost').id), JSON.stringify(legacy));
  check('C2. a record of another host inside the span is still imported, under its own project', legacy.some((r) => r.project_id === 'saucedemo-com') && legacy.length === 2, JSON.stringify(legacy));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}
{
  // The same resumed report in a folder whose name carries no time (--out): the old rule applies, the record is imported.
  const custom = { id: 'my-run', report: RUNS[2]!.report };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-resumed-index-'));
  const dir = path.join(root, 'output', 'localhost', custom.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(custom.report));
  fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
  fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'localhost.json'), JSON.stringify({ host: 'localhost', recentRuns: [FIRST_PROCESS] }));
  const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
  indexOutput(db, root);
  const rows = rowsOf(db);
  check('C3. a run id that carries no time keeps the old rule (the record is imported, nothing is guessed)', rows.filter((r) => r.status === 'legacy').length === 1, JSON.stringify(rows));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}

/* D */
{
  const { root, db } = build(REAL_RECORDS);
  // What an index built before this rule holds: the first process as a legacy row.
  indexOutput(db, root);
  const stale = runRowFromLegacyRecord('localhost', FIRST_PROCESS, 'localhost');
  const cols = Object.keys(stale);
  db.prepare(`INSERT INTO runs (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(stale as unknown as Record<string, unknown>);
  check('D1. the stale row is in place and the spend reads $20.58', spend(rowsOf(db), 'localhost').toFixed(2) === '20.58', spend(rowsOf(db), 'localhost').toFixed(4));
  indexOutput(db, root);
  const rows = rowsOf(db);
  check('D2. the next index pass removes it: three runs, $16.80', rows.length === 3 && rows.every((r) => r.status !== 'legacy') && spend(rows, 'localhost').toFixed(2) === '16.80', JSON.stringify(rows));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log(`OK: a resumed run's first-process record is covered by its report and never counted as an older run (${pass} checks)`);
