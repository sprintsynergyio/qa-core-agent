/**
 * Locks run 9's fixes (invariant 81, docs/audit/run-b4e41b-diagnosis.md
 * D1, D3, D4 and D6).
 *
 *   A. RULE 10 in the gate: a class check that matches a framework state
 *      class (ng-invalid, set while the page is built) is rejected; aria-invalid
 *      and a /\bis-invalid\b/ pattern are not.
 *   B. RULE 10 at the tool, on a fixture form whose empty field carries
 *      ng-invalid from load (as Angular sets it): the run 9 pattern is refused
 *      before any probe with nothing recorded; aria-invalid="true" after the
 *      submit is recorded, and the same check fails before the submit.
 *   C. An element that is never found counts toward the recovery cap only:
 *      the run 9 shape (one invented css asserted twice under two intents)
 *      records a LOCATOR finding, never a product one, and the outcome cap
 *      counts nothing.
 *   D. A happy password reset (its email is generated, so unregistered) is
 *      dropped at plan time unless a cited rule says every address gets a
 *      confirmation; a negative reset and a happy non-reset are kept.
 *   E. A message the page shows and hides after 300 ms reaches the
 *      finding's reading, marked as shown then hidden; without the memory
 *      it does not.
 *   F. The README section for the check: run 9's shape lists the red a11y
 *      test and the unrun wrong-password test; an inconclusive run says so;
 *      a dropped test is not listed.
 *   G. The shared doctrine (both prompts) names the state class and the
 *      other-fields rule.
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { captureActualState, installMessageMemory, SHOWN_THEN_HIDDEN } from '../src/agent/actual-state.js';
import { runGate, frameworkStateClassReason, gateRuleLabel, FRAMEWORK_STATE_CLASS_STEER } from '../src/agent/gate.js';
import { contradictionReason, happyResetReason, rejectContradictions, type PlannedScenario } from '../src/agent/planner.js';
import { checkReadmeSection, type EmittedRun } from '../src/agent/emitted-check.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import { CRITIC_SYSTEM_PROMPT } from '../src/agent/critic.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { Assertion, Scenario, SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── A. RULE 10 in the gate ───────────────────────────────────────────── */
const field: SelectorRecord = { level: 'testid', arg: 'email', intent: 'email input' };
const attr = (attribute: string, value: string, pattern?: string): Assertion =>
  ({ type: 'toHaveAttribute', target: field, attribute, value, ...(pattern ? { pattern } : {}), timeout: 10000 });
const run9 = attr('class', '', '(ng-invalid|is-invalid|error)');
const r9 = frameworkStateClassReason(run9);
check('A1. the run 9 pattern /(ng-invalid|is-invalid|error)/ on class is rejected, naming ng-invalid and the steer',
  r9 !== null && r9.includes('"ng-invalid"') && r9.includes(FRAMEWORK_STATE_CLASS_STEER), r9 ?? 'null');
check('A2. a literal class value holding ng-dirty is rejected', frameworkStateClassReason(attr('class', 'form-control ng-dirty')) !== null);
check('A3. a /\\bis-invalid\\b/ pattern, a literal is-invalid and aria-invalid="true" pass',
  frameworkStateClassReason(attr('class', '', '\\bis-invalid\\b')) === null && frameworkStateClassReason(attr('class', 'is-invalid')) === null &&
  frameworkStateClassReason(attr('aria-invalid', 'true')) === null);
check('A4. a pattern /invalid/ matches ng-invalid too and is rejected', frameworkStateClassReason(attr('class', '', 'invalid')) !== null);
const scen: Scenario = {
  name: 'submitted login form with empty email field and saw required-field error', category: 'edge', feature: 'account',
  steps: [
    { kind: 'navigate', url: 'http://x/auth/login' },
    { kind: 'click', target: { level: 'testid', arg: 'login-submit', intent: 'login submit' } },
    { kind: 'assert', name: 'email invalid', assertion: run9 },
  ],
} as Scenario;
const g = runGate(scen);
check('A5. runGate rejects the run 9 scenario under RULE 10 with its label',
  g.violations.some((v) => v.rule === 10) && gateRuleLabel(10) === 'RULE 10 (framework state class)', JSON.stringify(g.violations));

/* ─── fixture site ─────────────────────────────────────────────────────── */
const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Login</title></head><body><main>
<h1>Login</h1>
<form id="f" novalidate onsubmit="event.preventDefault(); var e=document.getElementById('email'); e.setAttribute('aria-invalid', e.value ? 'false' : 'true'); if(!e.value){ e.classList.add('is-invalid'); document.getElementById('err').hidden=false; }">
<label for="email">Email</label><input id="email" data-test="email" class="form-control ng-untouched ng-pristine ng-invalid" aria-invalid="false">
<div id="err" data-test="email-error" class="alert alert-danger" hidden>Email is required</div>
<button type="submit" data-test="login-submit">Login</button></form>
</main></body></html>`;
const FADE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forgot</title></head><body><main>
<h1>Forgot Password</h1>
<button data-test="send" onclick="var a=document.getElementById('a'); a.hidden=false; setTimeout(function(){ a.hidden=true; }, 300);">Set New Password</button>
<div id="a" role="alert" class="alert alert-danger" hidden>The selected email is invalid.</div>
</main></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end((req.url ?? '').startsWith('/fade') ? FADE : FORM);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({ headless: true });
try {
  /* ─── B. RULE 10 at the tool ─────────────────────────────────────────── */
  {
    const bctx = await browser.newContext();
    await installEvalShim(bctx);
    const page = await bctx.newPage();
    const ctx = createContext(page, 40);
    const begun = await runTool(ctx, { name: 'begin_scenario', input: { name: 'submitted login form with empty email field and saw required-field error', category: 'edge', feature: 'account' } });
    const nav = await runTool(ctx, { name: 'navigate', input: { url: `${base}/login` } });
    const t0 = Date.now();
    const refusedBefore = await runTool(ctx, { name: 'assert', input: { type: 'toHaveAttribute', intent: 'email input invalid state', testid: 'email', attribute: 'class', regex: '(ng-invalid|is-invalid|error)', timeout: 10000 } });
    const refusedMs = Date.now() - t0;
    const stepsAfterRefusal = (ctx.current?.steps ?? []).filter((st) => st.kind === 'assert').length;
    check('B1. the run 9 class pattern is refused at the tool before any probe, nothing recorded',
      begun.ok && nav.ok && refusedBefore.ok === false && (refusedBefore.error ?? '').startsWith('RULE 10 (framework state class) rejected this assertion:') && refusedMs < 1500 && stepsAfterRefusal === 0,
      JSON.stringify({ refusedBefore, refusedMs, stepsAfterRefusal }));
    const early = await runTool(ctx, { name: 'assert', input: { type: 'toHaveAttribute', intent: 'email aria-invalid', testid: 'email', attribute: 'aria-invalid', value: 'true', timeout: 1000 } });
    check('B2. aria-invalid="true" before the submit FAILS (the check can go red)', early.ok === false && !(early.error ?? '').startsWith('RULE'), JSON.stringify(early));
    const click = await runTool(ctx, { name: 'click', input: { intent: 'login submit', testid: 'login-submit' } });
    const after = await runTool(ctx, { name: 'assert', input: { type: 'toHaveAttribute', intent: 'email aria-invalid', testid: 'email', attribute: 'aria-invalid', value: 'true', timeout: 10000 } });
    const errVisible = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'email error message', testid: 'email-error', timeout: 10000 } });
    const recorded = (ctx.current?.steps ?? []).filter((st) => st.kind === 'assert').length;
    check('B3. after the submit aria-invalid="true" and the visible error element are recorded', click.ok && after.ok && errVisible.ok && recorded === 2, JSON.stringify({ click, after, errVisible, recorded }));
    await bctx.close();
  }

  /* ─── C. never found is a locator problem, never a product finding ───── */
  {
    const bctx = await browser.newContext();
    await installEvalShim(bctx);
    const page = await bctx.newPage();
    const ctx = createContext(page, 40);
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'submitted forgot-password with a generated email and received a confirmation message', category: 'happy', feature: 'account' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${base}/login` } });
    const css = "[data-test='forgot-password-confirmation']";
    const first = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'forgot password confirmation message', css, timeout: 1000 } });
    const afterFirst = { findings: ctx.findings.length, outcomeCounts: ctx._assertFailures.size };
    const second = await runTool(ctx, { name: 'assert', input: { type: 'toBeVisible', intent: 'forgot password confirmation', css, timeout: 1000 } });
    const f = ctx.findings[0];
    check('C1. the first miss is "Could not resolve element", no finding and no outcome count',
      first.ok === false && (first.error ?? '').startsWith('Could not resolve element') && afterFirst.findings === 0 && afterFirst.outcomeCounts === 0,
      JSON.stringify({ first, afterFirst }));
    check('C2. the same css under a second intent reaches the recovery cap: one LOCATOR finding, no product finding',
      second.ok === false && ctx.findings.length === 1 && f?.kind === 'locator' && (f?.expected ?? '').startsWith('locate element: ') && ctx.findings.every((x) => x.kind !== 'product'),
      JSON.stringify({ second, findings: ctx.findings }));
    await bctx.close();
  }

  /* ─── E. a message shown then hidden reaches the reading ─────────────── */
  {
    const withMemory = await browser.newContext();
    await installEvalShim(withMemory);
    await installMessageMemory(withMemory);
    const p1 = await withMemory.newPage();
    await p1.goto(`${base}/fade`);
    await p1.locator('[data-test="send"]').click();
    await p1.waitForTimeout(900);
    const shownNow = await p1.locator('#a').isVisible();
    const read = await captureActualState(p1);
    check('E1. with the memory, the 300 ms alert is in the reading, marked shown then hidden',
      shownNow === false && read.messages.includes(`The selected email is invalid.${SHOWN_THEN_HIDDEN}`), JSON.stringify({ shownNow, read }));
    await withMemory.close();
    const without = await browser.newContext();
    await installEvalShim(without);
    const p2 = await without.newPage();
    await p2.goto(`${base}/fade`);
    await p2.locator('[data-test="send"]').click();
    await p2.waitForTimeout(900);
    const read2 = await captureActualState(p2);
    check('E2. without the memory the reading has no message (the run 9 shape)', read2.messages.length === 0, JSON.stringify(read2));
    await without.close();
  }
} finally {
  await browser.close();
  server.close();
}

/* ─── D. a happy reset with a generated email ──────────────────────────── */
const ps = (name: string, category: PlannedScenario['category'], ruleIds?: string[]): PlannedScenario => ({ name, category, rationale: '', feature: 'account', ...(ruleIds ? { ruleIds } : {}) });
const happyReset = ps('submitted forgot-password with a generated email and received a confirmation message', 'happy');
const map: RequirementsMap = {
  features: [{ name: 'account', description: '', rules: [
    { id: 'R20', type: 'behavior', text: 'Requesting a password reset for any email address shows the same confirmation message.' },
    { id: 'R21', type: 'validation', text: 'A reset for an unregistered email is rejected with an error.' },
  ] }],
  roles: [],
} as unknown as RequirementsMap;
const r = happyResetReason(happyReset);
check('D1. a happy reset with no rule is dropped, with a reason that steers to the negative',
  r !== null && r.includes('generated, unregistered email') && r.includes('an unregistered email is refused') && contradictionReason(happyReset) === r, r ?? 'null');
check('D2. a happy reset citing a rule that every address gets a confirmation is kept',
  happyResetReason({ ...happyReset, ruleIds: ['R20'] }, map) === null);
check('D3. a happy reset citing only a rejection rule is still dropped', happyResetReason({ ...happyReset, ruleIds: ['R21'] }, map) !== null);
check('D4. a negative reset and a happy login are kept',
  happyResetReason(ps('submitted forgot-password with an unregistered email and saw an error', 'negative')) === null &&
  happyResetReason(ps('logged in with valid test account credentials', 'happy')) === null);
const rc = rejectContradictions([happyReset, ps('logged in with valid test account credentials', 'happy')]);
check('D5. rejectContradictions drops the happy reset without a map and keeps the rest',
  rc.rejected.length === 1 && rc.rejected[0]!.scenario.name === happyReset.name && rc.kept.length === 1, JSON.stringify(rc.rejected.map((x) => x.scenario.name)));

/* ─── F. the README section for the check ──────────────────────────────── */
const wp = '[negative] rejected login with wrong password and stayed on login page';
const runShape: EmittedRun = {
  durationMs: 14778,
  tests: [
    { name: 'authenticate', status: 'passed', attempts: 1 },
    { name: '[happy] logged in with valid test account credentials', status: 'passed', attempts: 1 },
    { name: 'a11y: landing page has no critical/serious WCAG 2 AA violations', status: 'failed', attempts: 2, error: 'Error: expect(received).toEqual(expected) // deep equality\n- Expected  -   1' },
    { name: wp, status: 'skipped', attempts: 0, error: 'would exceed the wrong-password cap (3)' },
  ],
};
const sec = checkReadmeSection('http://localhost:4200/', runShape);
check('F1. run 9 shape: 2 of 4 passed, the a11y test listed as failed twice and kept, the wrong-password test listed as not run with the cap',
  sec.startsWith('## Emitted-spec check') && sec.includes('2 of 4 test(s) passed') &&
  sec.includes('"a11y: landing page has no critical/serious WCAG 2 AA violations": failed twice; it stays in the framework and fails against the site as it is today. First error: Error: expect(received).toEqual(expected) // deep equality') &&
  sec.includes(`"${wp}": not run: would exceed the wrong-password cap (3). It stays in the framework as generated.`), sec);
const secIncon = checkReadmeSection('http://localhost:4200/', { tests: [], durationMs: 0, inconclusive: true, reason: 'timed out after 180s; the framework is kept as generated' });
check('F2. an inconclusive check says so with its reason', secIncon.includes('the check was inconclusive: timed out after 180s'), secIncon);
const secDrop = checkReadmeSection('http://x/', { durationMs: 1, tests: [{ name: 'gone', status: 'failed', attempts: 2, error: 'x' }, { name: 'kept', status: 'passed', attempts: 1 }] }, ['gone']);
check('F3. a test the check dropped is not listed and not counted', secDrop.includes('1 of 1 test(s) passed') && !secDrop.includes('"gone"'), secDrop);

/* ─── G. the doctrine in both prompts ──────────────────────────────────── */
const ruleText = "A class a form library sets on an invalid field while the page is built (Angular's ng-invalid, ng-dirty, ng-touched) is not a failure signal";
const otherFields = 'Every field other than the one under test holds a value the site accepts';
check('G1. both prompts carry the state-class sentence and the other-fields sentence',
  EXPLORER_SYSTEM_PROMPT.includes(ruleText) && CRITIC_SYSTEM_PROMPT.includes(ruleText) && EXPLORER_SYSTEM_PROMPT.includes(otherFields) && CRITIC_SYSTEM_PROMPT.includes(otherFields));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: run 9 fixes: RULE 10 (framework state class) at the gate and the tool, a never-found element stays a locator failure, a happy reset with a generated email is dropped at plan time, a shown-then-hidden message reaches the finding, the README states the emitted-spec check, the doctrine names the state class and the other-fields rule.');
