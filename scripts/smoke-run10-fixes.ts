/**
 * Locks the run 10 (ceeaf2) fixes, docs/audit/run-ceeaf2-diagnosis.md.
 *
 * A. D1: wrongPasswordSubmits counts run 10's own wrong-password trace
 *    ("rejected a wrong password", feature "account"), which read 0 and let
 *    7 submits lock the account; sign-up and reset traces still count 0, by
 *    name or by the page they navigate to.
 * B. D1: needsTestAccount names that scenario a wrong-password negative.
 * C. D1: the post-run sign-in check runs whenever the run had credentials,
 *    whatever the count says, and says what it found.
 * D. D2: the README's emitted-check section leaves out a test whose spec
 *    file the framework no longer holds (run 10's "authenticate"), on run
 *    10's own emitted-check results.
 * E. D5: a checkpoint records the run's per-run settings and stage flags,
 *    and a resume restores them unless the resume command gives its own.
 * F. D5: the CLI, as a child process, resumes a checkpoint with
 *    `--resume <path>` alone under the recorded $6.00 ceiling and says so.
 * G. D5: the gateway path resumes under the recorded settings.
 *
 * $0: no model call; local servers only.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { needsTestAccount, wrongPasswordSubmits, lockoutWarningLine } from '../src/agent/test-credentials.js';
import { postRunLockoutCheck } from '../src/agent/login-preflight.js';
import { appendCheckReadme, checkReadmeSection, testsWithoutFile } from '../src/agent/emitted-check.js';
import { CHECKPOINT_VERSION, loadCheckpoint, writeCheckpoint, type Checkpoint } from '../src/agent/checkpoint.js';
import { applyCheckpointFlags, buildExploreOptions, checkpointEnvFor, defaultExploreRequest, parseExploreTokens, restoredEnvNames } from '../src/agent/explore-request.js';
import { runExploreRequest } from '../src/server/run-explore.js';
import type { ExploreOptions } from '../src/agent/runtime.js';
import type { RunReport, TraceStep } from '../src/agent/trace.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failed += 1;
}

for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_') || k === 'QA_CORE_COST_CEILING') delete process.env[k];

/* ─── A. the counter, on run 10's own trace ─────────────────────────────── */
const H = 'http://localhost:4200';
const nav = (url: string): TraceStep => ({ kind: 'navigate', url } as TraceStep);
const fill = (intent: string, css: string, extra: Record<string, unknown>): TraceStep => ({ kind: 'fill', target: { level: 'css', arg: css, intent }, value: '', ...extra } as unknown as TraceStep);
const click = (css: string): TraceStep => ({ kind: 'click', target: { level: 'css', arg: css, intent: 'submit' } } as unknown as TraceStep);
// Run 10's dropped trace of "rejected a wrong password" (droppedTraces[] in
// output/localhost/20261118T083203Z-ceeaf2/run-report.json): the account's
// email by marker, then a literal wrong password.
const RUN10_WRONG = {
  name: 'rejected a wrong password',
  feature: 'account',
  steps: [
    nav(`${H}/auth/login`),
    fill('email', '[data-test="email"]', { credential: 'user' }),
    fill('password', '[data-test="password"]', { value: 'WrongPassword!987' }),
    click('[data-test="login-submit"]'),
  ],
};
check('A1. run 10\'s "rejected a wrong password" under "account" counts 1 (it read 0)', wrongPasswordSubmits(RUN10_WRONG) === 1, String(wrongPasswordSubmits(RUN10_WRONG)));
check('A2. the same steps named with "login" still count 1', wrongPasswordSubmits({ ...RUN10_WRONG, name: 'rejected login with a wrong password' }) === 1);
check('A3. any feature tag: "catalogue" and none count 1 too', wrongPasswordSubmits({ ...RUN10_WRONG, feature: 'catalogue' }) === 1 && wrongPasswordSubmits({ name: RUN10_WRONG.name, steps: RUN10_WRONG.steps }) === 1);
const DUP = {
  name: 'rejected registration with an already-used email address',
  feature: 'account',
  steps: [nav(`${H}/auth/register`), fill('first name', '#first', { value: 'Alex' }), fill('email', '[data-test="email"]', { credential: 'user' }), fill('password', '[data-test="password"]', { value: 'SuperSecret!23A' }), click('[data-test="register-submit"]')],
};
check('A4. run 10\'s duplicate-email registration negative counts 0 (a sign-up flow by its name)', wrongPasswordSubmits(DUP) === 0);
check('A5. the same registration steps under a name with no sign-up word count 0 (by the /auth/register page)', wrongPasswordSubmits({ ...DUP, name: 'rejected an email that is already in use' }) === 0);
const RESET = { name: 'rejected an email on the reset form', steps: [nav(`${H}/auth/forgot-password`), fill('email', '[data-test="email"]', { credential: 'user' }), fill('password', '#new-password', { value: 'Another!Pass9' })] };
check('A6. a trace on /auth/forgot-password counts 0', wrongPasswordSubmits(RESET) === 0);
const HAPPY = { name: 'logged in with valid credentials', feature: 'account', steps: [nav(`${H}/auth/login`), fill('email', '[data-test="email"]', { credential: 'user' }), fill('password', '[data-test="password"]', { credential: 'pass' }), click('[data-test="login-submit"]')] };
check('A7. the happy login (both fields by marker) counts 0', wrongPasswordSubmits(HAPPY) === 0);
const OTHER_ID = { name: 'rejected a wrong password for an unknown user', steps: [nav(`${H}/auth/login`), fill('email', '[data-test="email"]', { value: 'nobody@example.invalid' }), fill('password', '[data-test="password"]', { value: 'x-Wrong-1' })] };
check('A8. a wrong password on an identifier that is not the account counts 0', wrongPasswordSubmits(OTHER_ID) === 0);
const EMPTY_PW = { name: 'rejected password field left empty', steps: [nav(`${H}/auth/login`), fill('email', '[data-test="email"]', { credential: 'user' }), click('[data-test="login-submit"]')] };
check('A9. run 10\'s empty-password negative (no password typed) counts 0', wrongPasswordSubmits(EMPTY_PW) === 0);

/* ─── B. planning ────────────────────────────────────────────────────────── */
check('B1. "rejected a wrong password" under "account" needs the test account', needsTestAccount({ name: 'rejected a wrong password', category: 'negative', feature: 'account' }) === 'a wrong-password negative');
check('B2. a registration name with a wrong password stays a creation flow, not a wrong-password negative', needsTestAccount({ name: 'rejected registration with an invalid password', category: 'negative', feature: 'account' }) === null);

/* ─── C. the post-run sign-in check ─────────────────────────────────────── */
{
  const env = { QA_CORE_TEST_USER: 'u@example.test', QA_CORE_TEST_PASS: 'p' };
  const base = { url: `${H}/` } as RunReport;
  const mk = (count: number): RunReport => ({ ...base, wrongPasswordAttempts: { cap: 3, capSource: 'default 3', count, byStage: {}, refused: [] } } as RunReport);
  let calls = 0;
  const lines: string[] = [];
  const failedPf = (async () => { calls += 1; return { outcome: 'failed', tried: [`${H}/auth/login`], pageText: ['Account locked'], lines: [] }; }) as never;
  const r0 = mk(0);
  await postRunLockoutCheck({ report: r0, env, log: (l) => lines.push(l), preflight: failedPf });
  check('C1. with a count of 0 the check still signs in (it used to return before)', calls === 1, String(calls));
  check('C2. a failed sign-in at count 0 sets lockoutWarning with the 0-count wording', r0.lockoutWarning === lockoutWarningLine(0) && lockoutWarningLine(0) === 'the test account no longer signs in after this run (0 wrong-password attempts counted)' && lines.some((l) => l === `WARNING: ${lockoutWarningLine(0)}`), JSON.stringify({ w: r0.lockoutWarning, lines }));
  const okLines: string[] = [];
  await postRunLockoutCheck({ report: mk(0), env, log: (l) => okLines.push(l), preflight: (async () => ({ outcome: 'ok', tried: [], pageText: [], lines: [] })) as never });
  check('C3. a passing sign-in at count 0 says so', okLines.join('|') === 'post-run login check: the test account still signs in after 0 wrong-password attempts', okLines.join('|'));
  const unLines: string[] = [];
  const rU = mk(0);
  await postRunLockoutCheck({ report: rU, env, log: (l) => unLines.push(l), preflight: (async () => ({ outcome: 'unreached', tried: [`${H}/`, `${H}/login`], pageText: [], lines: [] })) as never });
  check('C4. no login page found: a "not checked" line naming the URLs, never a warning', unLines.join('|') === `post-run login check: not checked, no login page found (tried ${H}/, ${H}/login)` && rU.lockoutWarning === undefined, unLines.join('|'));
  let noCredCalls = 0;
  await postRunLockoutCheck({ report: mk(2), env: {}, log: () => {}, preflight: (async () => { noCredCalls += 1; return { outcome: 'ok', tried: [], pageText: [], lines: [] }; }) as never });
  check('C5. without credentials nothing is signed in to', noCredCalls === 0);
}

/* ─── D. the README section on run 10's results ─────────────────────────── */
{
  // Run 10's emittedRun.tests, names, statuses and files verbatim.
  const T = (name: string, status: 'passed' | 'failed', file: string, attempts = 1, error?: string) => ({ name, status, file, attempts, ...(error ? { error } : {}) });
  const tests = [
    T('authenticate', 'failed', 'auth.setup.ts', 2, 'Error: expect(page).toHaveURL(expected) failed'),
    T('[happy] logged in with valid credentials', 'failed', 'account/account.spec.ts', 2, 'Error: expect(page).toHaveURL(expected) failed'),
    T('[negative] rejected a wrong password', 'failed', 'account/account.spec.ts', 2, 'Error: expect(locator).toContainText(expected) failed'),
    ...['[negative] rejected email field left empty', '[negative] rejected password field left empty', '[negative] rejected registration with an already-used email address', '[negative] rejected registration with an empty required field', '[negative] rejected an empty email field', '[negative] rejected a malformed email format', '[happy] filled all required fields and registered successfully'].map((n) => T(n, 'passed', 'account/account.spec.ts')),
    T('a11y: landing page has no critical/serious WCAG 2 AA violations', 'failed', 'a11y/landing.a11y.spec.ts', 2, 'Error: expect(received).toEqual(expected) // deep equality'),
    ...['[edge] added item to cart, opened cart, removed the product and the row disappeared from the cart table', '[happy] added item to cart, opened cart, changed quantity and the line total updated'].map((n) => T(n, 'passed', 'cart/cart.spec.ts')),
    ...['[happy] displayed hand tools with names, images, and prices', '[happy] sorted products by price low to high and verified ascending order', '[happy] clicked a product and landed on its detail page with matching name and price', '[happy] filtered by Hammer subcategory and only hammer products remained'].map((n) => T(n, 'passed', 'catalogue/catalogue.spec.ts')),
    ...['[negative] rejected submission when message field is empty', '[data] contact — rejected an email address without an @ sign', '[data] contact — submitted contact form with valid message and email'].map((n) => T(n, 'passed', 'contact/contact.spec.ts')),
  ];
  const run = { tests, durationMs: 95802 };
  const dropped = ['[happy] logged in with valid credentials', '[negative] rejected a wrong password'];
  // The re-scaffolded framework of run 10: no auth setup file.
  const fw = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-run10-readme-'));
  for (const f of ['account/account.spec.ts', 'a11y/landing.a11y.spec.ts', 'cart/cart.spec.ts', 'catalogue/catalogue.spec.ts', 'contact/contact.spec.ts']) {
    fs.mkdirSync(path.dirname(path.join(fw, 'tests', f)), { recursive: true });
    fs.writeFileSync(path.join(fw, 'tests', f), '// fixture\n');
  }
  fs.writeFileSync(path.join(fw, 'README.md'), '# localhost\n');
  check('D1. testsWithoutFile names "authenticate" only (its auth.setup.ts is gone)', JSON.stringify(testsWithoutFile(fw, run)) === '["authenticate"]', JSON.stringify(testsWithoutFile(fw, run)));
  const before = checkReadmeSection(`${H}/`, run, dropped);
  check('D2. red first: the old section names "authenticate" and counts 16 of 18', /16 of 18 test\(s\) passed/.test(before) && before.includes('"authenticate"'));
  appendCheckReadme(fw, `${H}/`, run, () => {}, dropped);
  const readme = fs.readFileSync(path.join(fw, 'README.md'), 'utf8');
  check('D3. the README section counts 16 of 17 and never names "authenticate"', /16 of 17 test\(s\) passed/.test(readme) && !readme.includes('authenticate'), readme);
  check('D4. the a11y spec is still listed as failed and kept', readme.includes('"a11y: landing page has no critical/serious WCAG 2 AA violations": failed twice; it stays in the framework'));
  fs.mkdirSync(path.join(fw, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'tests', 'auth.setup.ts'), '// fixture\n');
  check('D5. when the auth setup file is in the framework, it is listed as before', testsWithoutFile(fw, run).length === 0);
  fs.rmSync(fw, { recursive: true, force: true });
}

/* ─── E. checkpoint settings and stage flags ─────────────────────────────── */
const PLAN = [{ name: 'checked the home page heading', category: 'happy', rationale: 'r', feature: 'home' }];
function cpFixture(url: string, flags: Partial<Checkpoint['flags']>): Checkpoint {
  return {
    version: CHECKPOINT_VERSION, url,
    flags: { lang: 'ts', pom: true, features: [], discover: false, urls: [], ...flags },
    plan: PLAN as never, fillableFields: 0, completedScenarios: [],
    spentUsd: { planner: 0.01, explorer: 3.7761, critic: 0, repair: 0 },
    phase: 'exploring', nextScenarioIndex: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as Checkpoint;
}
{
  const parsed = parseExploreTokens(['http://localhost:4200/', '--ceiling', '6', '--no-stabilize', '--stability', '2']);
  if (!parsed.ok) throw new Error(parsed.error);
  const opts = buildExploreOptions(parsed.request, { url: 'http://localhost:4200/', outDir: '/tmp/x' });
  check('E1. the run\'s per-run settings and stage flags go to the checkpoint', JSON.stringify(opts.checkpointFlags?.env) === '{"QA_CORE_COST_CEILING":"6"}'
    && JSON.stringify(opts.checkpointFlags?.stages) === JSON.stringify({ replay: true, stability: true, stabilityIterations: 2, stabilize: false, stabilizeAttempts: 3, emittedCheck: true }), JSON.stringify(opts.checkpointFlags));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-run10-cp-'));
  const file = writeCheckpoint(dir, cpFixture('http://localhost:4200/', { env: { QA_CORE_COST_CEILING: '6' }, stages: opts.checkpointFlags!.stages! }));
  const cp = loadCheckpoint(file);
  check('E2. the checkpoint loads them back', cp.flags.env?.QA_CORE_COST_CEILING === '6' && cp.flags.stages?.stabilityIterations === 2 && cp.flags.stages?.stabilize === false);
  const bare = parseExploreTokens(['--resume', file]);
  if (!bare.ok) throw new Error(bare.error);
  const r1 = applyCheckpointFlags(bare.request, cp);
  check('E3. `--resume <path>` alone restores the ceiling and the stage flags', r1.env.QA_CORE_COST_CEILING === '6' && r1.stabilityIterations === 2 && r1.stabilize === false && r1.replay === true, JSON.stringify({ env: r1.env, s: r1.stabilityIterations, z: r1.stabilize }));
  check('E4. the restored names are reported', JSON.stringify(restoredEnvNames(bare.request, cp.flags.env)) === '["QA_CORE_COST_CEILING"]');
  const top = parseExploreTokens(['--resume', file, '--ceiling', '8']);
  if (!top.ok) throw new Error(top.error);
  check('E5. a ceiling on the resume command wins (the top-up flow) and is not reported as restored', applyCheckpointFlags(top.request, cp).env.QA_CORE_COST_CEILING === '8' && restoredEnvNames(top.request, cp.flags.env).length === 0);
  const own = parseExploreTokens(['--resume', file, '--no-stability']);
  if (!own.ok) throw new Error(own.error);
  check('E6. stage flags on the resume command win over the checkpoint', applyCheckpointFlags(own.request, cp).stability === false);
  check('E7. an invalid or unknown recorded setting is never restored', JSON.stringify(checkpointEnvFor({ env: {} }, { QA_CORE_COST_CEILING: '-1', ANTHROPIC_API_KEY: 'x', QA_CORE_MAX_STEPS: '80' })) === '{"QA_CORE_MAX_STEPS":"80"}');
  const old = loadCheckpoint(writeCheckpoint(dir, cpFixture('http://localhost:4200/', {})));
  const r2 = applyCheckpointFlags(bare.request, old);
  check('E8. an older checkpoint with neither field resumes exactly as before', JSON.stringify(r2.env) === '{}' && r2.stabilityIterations === 3 && r2.stabilize === true && old.flags.env === undefined && old.flags.stages === undefined);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── F and G. the CLI and the gateway resume under the recorded ceiling ── */
const site = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>'); });
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-run10-resume-'));
try {
  const runDir = path.join(root, 'output', '127-0-0-1', '20261118T000000Z-aaaaaa');
  const stages = { replay: true, stability: true, stabilityIterations: 3, stabilize: true, stabilizeAttempts: 3, emittedCheck: true };
  const cpFile = writeCheckpoint(runDir, cpFixture(siteUrl, { env: { QA_CORE_COST_CEILING: '6' }, stages }));

  // F. the CLI as a child process, killed once the ceiling line prints (no model call is reached).
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('QA_CORE_') && !k.startsWith('ANTHROPIC_')) childEnv[k] = v;
  childEnv.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
  childEnv.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(process.cwd(), 'src/cli/explore.ts'), '--resume', cpFile], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const onData = (d: Buffer): void => { text += String(d); if (/Cost ceiling:/.test(text)) child.kill('SIGKILL'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => { clearTimeout(timer); resolve(text); });
  });
  check('F1. the CLI says the ceiling was restored from the checkpoint', out.includes('settings restored from the checkpoint: QA_CORE_COST_CEILING=6'), out.slice(0, 1500));
  check('F2. the run is under the recorded $6.00 ceiling, not the $2.00 default', /Cost ceiling: \$6\.00 total/.test(out) && !/Cost ceiling: \$2\.00/.test(out), out.split('\n').filter((l) => l.includes('Cost ceiling')).join(' | '));

  // G. the gateway path with the explore seam.
  const seen: { ceiling?: string; stages?: unknown; envAfter?: string } = {};
  const notes: string[] = [];
  const fakeExplore = async (opts: ExploreOptions): Promise<RunReport> => {
    seen.ceiling = process.env.QA_CORE_COST_CEILING;
    seen.stages = opts.checkpointFlags?.stages;
    throw new Error('fixture stop after the options were read');
  };
  try {
    await runExploreRequest({ request: { ...defaultExploreRequest(), resume: path.relative(root, cpFile) }, projectRoot: root, exploreImpl: fakeExplore, onNote: (t) => notes.push(t) });
  } catch { /* the fixture stops the run */ }
  seen.envAfter = process.env.QA_CORE_COST_CEILING;
  check('G1. the gateway runs a resume under the recorded ceiling', seen.ceiling === '6', JSON.stringify(seen));
  check('G2. the recorded stage flags reach the run and the next checkpoint', JSON.stringify(seen.stages) === JSON.stringify(stages), JSON.stringify(seen.stages));
  check('G3. the gateway note names the restored setting', notes.some((n) => n.includes('settings restored from the checkpoint: QA_CORE_COST_CEILING=6')), notes.join(' | '));
  check('G4. the override is removed from process.env after the run', seen.envAfter === undefined);
} finally {
  site.close();
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('OK: run 10 fixes: the wrong-password counter counts run 10\'s own trace and the post-run sign-in check always runs with credentials; the README never names a test the framework lost; a resume keeps the run\'s ceiling and stage flags.');
