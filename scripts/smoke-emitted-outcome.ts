/**
 * Locks what the run page says about the emitted-spec check (invariant 84).
 * Run ceeaf2's Summary read "16 of 20 passed, 4 failed twice and dropped";
 * only the two login tests were dropped. The a11y check stayed in the
 * framework and the auth setup's test left with the login tests.
 *
 *   A  run ceeaf2's recorded tests (scripts/lib/run-ceeaf2-emitted.json, copied
 *      from its run-report.json): 16 passed, 2 dropped, 1 kept (a11y),
 *      1 removed (authenticate); every test gets exactly one outcome
 *   B  the same failed setup with a happy login shipped is kept, not removed
 *   C  a data case in emittedFailed is dropped; one that is not is kept
 *   D  a skipped test is skipped; an inconclusive check drops nothing
 *   E  buildStages carries the counts and the per-test outcomes
 *   F  the page: the Summary line reads "16 of 20 passed, 2 failed twice and
 *      dropped, 1 failed and kept, 1 setup test removed with the login tests",
 *      never "4 failed twice and dropped", and lists the four tests with their
 *      outcomes
 * No model. The page section boots a gateway on a spare port with the built
 * dashboard, like smoke-run-detail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { countOutcomes, emittedTestOutcomes } from '../src/agent/emitted-outcome.js';
import { buildStages } from '../src/server/run-detail.js';
import { newRunId } from '../src/agent/output-layout.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'scripts', 'lib', 'run-ceeaf2-emitted.json'), 'utf8')) as {
  emittedRun: NonNullable<RunReport['emittedRun']>;
  emittedFailed: NonNullable<RunReport['emittedFailed']>;
  scenarios: Array<{ name: string; category: string; feature: string }>;
};
const scenarios = fixture.scenarios.map((s) => ({ ...s, steps: [{ kind: 'navigate', url: 'http://localhost:4200/' }] })) as unknown as RunReport['scenarios'];
const r10 = { emittedRun: fixture.emittedRun, emittedFailed: fixture.emittedFailed, scenarios } as Pick<RunReport, 'emittedRun' | 'emittedFailed' | 'scenarios'>;

/* A */
const a = emittedTestOutcomes(r10);
const ac = countOutcomes(a);
const by = (name: string) => a.find((t) => t.name === name)?.outcome;
check('A1. run ceeaf2: 20 tests, 16 passed, 2 dropped, 1 kept, 1 removed, 0 skipped', a.length === 20 && ac.passed === 16 && ac.dropped === 2 && ac.kept === 1 && ac.removed === 1 && ac.skipped === 0, JSON.stringify(ac));
check('A2. the two login tests are dropped', by('[happy] logged in with valid credentials') === 'dropped' && by('[negative] rejected a wrong password') === 'dropped');
check('A3. the a11y check is kept', by('a11y: landing page has no critical/serious WCAG 2 AA violations') === 'kept');
check('A4. the auth setup test is removed with the login tests', by('authenticate') === 'removed');
check('A5. the counts add up to the tests', ac.passed + ac.dropped + ac.kept + ac.removed + ac.skipped === a.length);

/* B */
const withLogin = {
  ...r10,
  scenarios: [...scenarios, { name: 'logged in', category: 'happy', feature: 'account', steps: [{ kind: 'fill', credential: 'pass', value: '', target: { intent: 'password' } }] }] as unknown as RunReport['scenarios'],
};
check('B1. with a happy login shipped, the failed setup test is kept, not removed', emittedTestOutcomes(withLogin).find((t) => t.name === 'authenticate')?.outcome === 'kept');
const setupByName = { ...r10, emittedRun: { ...fixture.emittedRun, tests: fixture.emittedRun.tests.map((t) => (t.name === 'authenticate' ? { ...t, file: 'other/other.spec.ts' } : t)) } };
check('B2. a test named authenticate in another file is not read as the setup (the file decides, never the name)', emittedTestOutcomes(setupByName).find((t) => t.name === 'authenticate')?.outcome === 'kept');

/* C */
const dataRun = {
  emittedRun: { durationMs: 1, tests: [
    { name: '[data] contact — bad email', status: 'failed' as const, file: 'contact/contact.spec.ts', attempts: 2 },
    { name: '[data] contact — other case', status: 'failed' as const, file: 'contact/contact.spec.ts', attempts: 2 },
  ] },
  emittedFailed: [{ scenario: 'contact: bad email', error: 'x', dataCase: true }],
  scenarios: [] as RunReport['scenarios'],
};
const dr = emittedTestOutcomes(dataRun);
check('C1. a data case in emittedFailed is dropped, one that is not is kept', dr[0]?.outcome === 'dropped' && dr[1]?.outcome === 'kept', JSON.stringify(dr));

/* D */
const skipRun = { ...dataRun, emittedRun: { durationMs: 1, tests: [{ name: '[negative] rejected a wrong password', status: 'skipped' as const, file: 'account/account.spec.ts', error: 'would exceed the wrong-password cap (3)' }] }, emittedFailed: [] };
check('D1. a skipped test is skipped', emittedTestOutcomes(skipRun)[0]?.outcome === 'skipped');
const inconclusive = { ...r10, emittedFailed: [] };
const ic = countOutcomes(emittedTestOutcomes(inconclusive));
check('D2. with nothing in emittedFailed, no test reads dropped', ic.dropped === 0 && ic.kept === 3 && ic.removed === 1, JSON.stringify(ic));
check('D3. no emittedRun gives no outcomes', emittedTestOutcomes({ scenarios: [] }).length === 0);

/* E */
const fullReport = {
  url: 'http://localhost:4200/', language: 'ts', startedAt: '2026-11-18T08:32:03.000Z', finishedAt: '2026-11-18T09:00:00.000Z', steps: 1,
  scenarios, emittedRun: fixture.emittedRun, emittedFailed: fixture.emittedFailed,
  cost: { usd: 5, plannerUsd: 0.1, criticUsd: 0.2 },
} as unknown as RunReport;
const ec = buildStages(fullReport, [], 5.87).summary.emitted_check;
check('E1. buildStages: passed 16, failed 4, total 20, dropped 2, kept 1, removed 1, skipped 0', !!ec && ec.passed === 16 && ec.failed === 4 && ec.total === 20 && ec.dropped === 2 && ec.kept === 1 && ec.removed === 1 && ec.skipped === 0, JSON.stringify(ec && { ...ec, tests: undefined }));
check('E2. buildStages: every test carries its outcome', !!ec && ec.tests.length === 20 && ec.tests.every((t) => typeof t.outcome === 'string') && ec.tests.find((t) => t.name === 'authenticate')?.outcome === 'removed');

/* F: the page */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-emitted-outcome-'));
const runId = newRunId(new Date('2026-11-18T08:32:03Z'), 'ceeaf2');
const runDir = path.join(root, 'output', 'localhost', runId);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify({ ...fullReport, findings: [] }, null, 2));
fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({ source: 'cli', flags: {}, writtenAt: 'x' }));
const TOKEN = 'emitted-outcome-token';
const PORT = 18803;
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: 'unused' },
});
const killGw = (): void => { if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killGw);
let gwLog = '';
gw.stdout.on('data', (c) => { gwLog += String(c); });
gw.stderr.on('data', (c) => { gwLog += String(c); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('F0. gateway boots for the page test', /listening on http/.test(gwLog), gwLog.slice(0, 300));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(`http://127.0.0.1:${PORT}/runs/${runId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="emitted-check"]', { timeout: 20_000 }).catch(() => null);
const line = ((await page.textContent('[data-testid="emitted-check"] > span:nth-of-type(2)').catch(() => null)) ?? '').trim();
const items = await page.$$eval('[data-testid="emitted-check-tests"] li', (els) => els.map((e) => ({ text: e.textContent ?? '', outcome: e.getAttribute('data-outcome') })));
check('F1. the Summary line names each outcome from the record', line === '16 of 20 passed, 2 failed twice and dropped, 1 failed and kept, 1 setup test removed with the login tests (95.8s)', JSON.stringify(line));
check('F2. the line never says 4 were dropped', !/4 failed twice and dropped/.test(line));
check('F3. the four tests that did not pass are listed with their outcomes', items.length === 4
  && items.filter((i) => i.outcome === 'dropped').length === 2
  && items.some((i) => i.outcome === 'kept' && /^a11y: .*: failed, kept in the framework$/.test(i.text))
  && items.some((i) => i.outcome === 'removed' && i.text === 'authenticate: setup test, removed with the dropped login tests'), JSON.stringify(items));
await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log(`OK: the run page names each emitted-check outcome from the record (${pass} checks)`);
