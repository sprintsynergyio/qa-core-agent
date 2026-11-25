/**
 * Locks claims and evidence (invariant 89, docs/audit/run-ceeaf2-diagnosis.md
 * D3 and line 8): a test name, and a rule counted as covered, must be backed
 * by the recording.
 *
 *   A. The vocabulary: what a name or a rule text claims, and the wordings
 *      that are no claim (a field called "first name", a thing only acted on,
 *      "valid message and email", "only matching product names").
 *   B. Run 10's own 16 shipped recordings (scripts/lib/run-ceeaf2-claims.json,
 *      typed values removed): exactly the three hand-graded names have a gap,
 *      and rule coverage reads 7 of 14, with R5, R7 and R9 cited but not
 *      exercised (the report said 10 of 14).
 *   C. The tool, on a fixture site: end_scenario refuses a recording whose
 *      name claims a name that no check reads, keeps the scenario open, and
 *      accepts it once the check is added; a second refusal drops it with the
 *      reason; "rejected" on aria-invalid of the typed field is refused and
 *      accepted with the error message; finish drops an open overclaim.
 *   D. With a plan, the plan's name is judged, never the model's echo; a
 *      recorded name that matches no planned name is not judged and says so
 *      once.
 *   E. The shared doctrine carries rule 12 in both prompts; the index and the
 *      console know the new reason.
 *   F. A cited rule that says more than the test's name: end_scenario asks
 *      once for the check, never counts a strike, ships the scenario, and
 *      rule coverage reports the rule as cited-not-exercised.
 * No network beyond 127.0.0.1, no model call.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { claimGaps, claimsIn, evidenceIn, ruleClaimGaps } from '../src/agent/claim-evidence.js';
import { computeRuleCoverage, renderRuleCoverage } from '../src/agent/rule-coverage.js';
import { createContext, runTool, claimBrokenReason, claimUnmatchedLine, CLAIM_CAP } from '../src/agent/tools.js';
import { plannedRulesFor } from '../src/agent/runtime.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { Page } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { NAME_CLAIM_RULE, ASSERTION_DOCTRINE } from '../src/agent/doctrine.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import type { TraceStep } from '../src/agent/trace.js';
import { CRITIC_SYSTEM_PROMPT } from '../src/agent/critic.js';
import { UNCOVERED_STATUS } from '../src/server/db/indexer.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};
const kinds = (text: string): string => claimsIn(text).map((c) => `${c.kind}/${c.need}`).sort().join(' ');

/* ─── A. the vocabulary ────────────────────────────────────────────────── */
const VOCAB: Array<[string, string]> = [
  ['displayed hand tools with names, images, and prices', 'image/read name/read price/read'],
  ['clicked a product and landed on its detail page with matching name and price', 'name/equal price/equal'],
  ['Clicking a product opens its detail page showing the same name and price as the listing.', 'name/equal price/equal'],
  ['The home page lists products with a name, an image and a price.', 'image/read name/read price/read'],
  ['The cart page lists each added product with quantity and line total.', 'quantity/read total/read'],
  ['Changing a quantity on the cart page updates the line total.', 'total/read'],
  ['Removing a product from the cart removes its row and updates the total.', 'total/read'],
  ['added item to cart, opened cart, changed quantity and the line total updated', 'total/read'],
  ['added product to cart from detail page, cart count in header increased', 'count/read'],
  ['removed the product row and total recalculated to zero', 'total/read'],
  ['rejected a malformed email format', 'rejection/outcome'],
  ['Registration with an already used email address is rejected with an error.', 'error/read rejection/outcome'],
  ['Submitting the registration form with an empty required field shows a required-field message.', 'error/read'],
  ['submitted login form with empty email field and saw required-field error', 'error/read'],
  ['rejected registration with malformed date-of-birth format and error displayed', 'error/read rejection/outcome'],
  ['clicked a product from the listing and the detail page name matched the listing name', 'name/equal'],
  // No claim: a field, a thing only acted on, a plain flow.
  ['sorted products by price low to high and verified ascending order', ''],
  ['Sorting by price low to high orders the visible products by ascending price.', ''],
  ['submitted contact form with valid message and email', ''],
  ['filled all required fields and registered successfully', ''],
  ['registered with first name, last name and email', ''],
  ['search for term filtered list to only matching product names', ''],
  ['searched for a product name and results showed only matching items', ''],
  ['filtered by Hammer subcategory and only hammer products remained', ''],
  ['logged in with valid credentials', ''],
];
for (const [text, want] of VOCAB) {
  const got = kinds(text);
  check(`A. ${JSON.stringify(text.slice(0, 70))} claims ${want || 'nothing'}`, got === want, `got ${got || 'nothing'}`);
}

/* ─── B. run 10's own recordings ───────────────────────────────────────── */
const here = path.dirname(fileURLToPath(import.meta.url));
const run10 = JSON.parse(fs.readFileSync(path.join(here, 'lib', 'run-ceeaf2-claims.json'), 'utf8')) as {
  plan: Array<{ name: string; ruleIds: string[] }>;
  scenarios: Scenario[];
  map: RequirementsMap;
};
const withGap = run10.scenarios.filter((s) => claimGaps(s.name, s.steps, 'name').length > 0).map((s) => s.name).sort();
const HAND_GRADED = [
  'clicked a product and landed on its detail page with matching name and price',
  'displayed hand tools with names, images, and prices',
  'rejected a malformed email format',
];
check('B1. of run 10\'s 16 shipped names, exactly the three hand-graded overclaims have a gap',
  run10.scenarios.length === 16 && JSON.stringify(withGap) === JSON.stringify(HAND_GRADED), JSON.stringify(withGap));
const gapOf = (name: string): string => claimGaps(name, run10.scenarios.find((s) => s.name === name)!.steps, 'name').map((g) => `${g.kind}:${g.missing}`).join(' | ');
check('B2. "with names, images, and prices": the name is the one thing not read (the image and the price are)',
  gapOf(HAND_GRADED[1]!) === 'name:no check reads the name', gapOf(HAND_GRADED[1]!));
check('B3. "with matching name and price": the name is compared, the price is not',
  gapOf(HAND_GRADED[0]!) === 'price:no compare proves the price is the same in both places', gapOf(HAND_GRADED[0]!));
check('B4. "rejected a malformed email format": aria-invalid on the field it typed into and a URL that stays prove no rejection',
  gapOf(HAND_GRADED[2]!).startsWith('rejection:no check after the last action could fail'), gapOf(HAND_GRADED[2]!));
const emptyEmail = run10.scenarios.find((s) => s.name === 'rejected an empty email field')!;
check('B5. "rejected an empty email field" (aria-invalid on a field left empty, and the error element) is backed',
  claimGaps(emptyEmail.name, emptyEmail.steps, 'name').length === 0 && evidenceIn(emptyEmail.steps).errorRead === true);

const before = computeRuleCoverage({ map: run10.map, planned: run10.plan, scenarios: run10.scenarios.map((s) => ({ name: s.name, ruleIds: s.ruleIds })) });
const now = computeRuleCoverage({ map: run10.map, planned: run10.plan, scenarios: run10.scenarios });
check('B6. given without steps the rules are credited as the report did: 10 of 14', before.covered.length === 10 && before.uncovered.length === 4, `${before.covered.length}`);
const notExercised = now.uncovered.filter((u) => u.reason === 'cited-not-exercised').map((u) => u.ruleId).sort();
check('B7. with the recordings: 7 of 14 covered; R5, R7 and R9 read cited-not-exercised',
  now.covered.length === 7 && JSON.stringify(notExercised) === JSON.stringify(['R5', 'R7', 'R9']), `${now.covered.length} ${JSON.stringify(notExercised)}`);
const r5 = now.uncovered.find((u) => u.ruleId === 'R5');
check('B8. R5\'s detail names the citing test and the claim no test backs',
  !!r5?.detail && r5.detail.includes('cited by "clicked a product and landed on its detail page with matching name and price"') && r5.detail.includes('no compare proves the price is the same in both places'), r5?.detail);
check('B9. R4 (a sort, two cards) and R8 (the line total after a quantity change) stay covered',
  now.covered.some((c) => c.ruleId === 'R4') && now.covered.some((c) => c.ruleId === 'R8'));
const lines = renderRuleCoverage(now);
check('B10. the console line reads 7 of 14 and names R7 with its reason and detail',
  lines[0] === 'Rule coverage: 7 of 14 rules covered' && lines.some((l) => l.includes('R7 (cited-not-exercised: cited by') && l.includes('no check reads the quantity')), lines.slice(0, 6).join('\n'));
const r7 = run10.map.features.flatMap((f) => f.rules).find((r) => r.id === 'R7')!;
const citing = run10.scenarios.filter((s) => (s.ruleIds ?? []).includes('R7')).map((s) => s.steps);
check('B11. a rule\'s claim is backed when any one citing recording backs it',
  ruleClaimGaps(r7.text, citing).length === 1 &&
  ruleClaimGaps(r7.text, [...citing, [{ kind: 'assert', name: '', assertion: { type: 'toHaveValue', target: { level: 'css', arg: '[data-test="product-quantity"]', intent: '' }, value: '3' } }]]).length === 0);

/* ─── fixture site ─────────────────────────────────────────────────────── */
const LISTING = `<!doctype html><html><body><h1>Tools</h1>
<a class="card" data-test="product-1" href="/p/1"><img src="/a.png" alt=""><h5 data-test="product-name">Claw Hammer</h5><span data-test="product-price">$12.50</span></a>
<a class="card" data-test="product-2" href="/p/2"><img src="/b.png" alt=""><h5 data-test="product-name">Pliers</h5><span data-test="product-price">$9.10</span></a>
</body></html>`;
const FORM = `<!doctype html><html><body><h1>Reset</h1>
<form id="f" novalidate><input id="email" data-test="email" type="email" aria-invalid="false">
<div id="err" data-test="email-error" style="display:none">Email format is invalid</div>
<button type="submit" data-test="submit">Send</button></form>
<script>
const e=document.getElementById('email');
e.addEventListener('input',()=>{ e.setAttribute('aria-invalid', String(!/^[^@ ]+@[^@ ]+\\.[^@ ]+$/.test(e.value))); });
document.getElementById('f').addEventListener('submit',(ev)=>{ ev.preventDefault(); if(e.getAttribute('aria-invalid')==='true') document.getElementById('err').style.display='block'; });
</script></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url?.startsWith('/reset') ? FORM : LISTING);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await chromium.launch();
const call = (ctx: ReturnType<typeof createContext>, name: string, input: Record<string, unknown>) => runTool(ctx, { name, input });

try {
  /* ─── C. the tool ────────────────────────────────────────────────────── */
  const NAME = 'displayed products with names, images, and prices';
  const record = async (ctx: ReturnType<typeof createContext>): Promise<void> => {
    await call(ctx, 'begin_scenario', { name: NAME, category: 'happy' });
    await call(ctx, 'navigate', { url: `${base}/` });
    await call(ctx, 'assert', { type: 'toHaveCount', css: 'a.card', count: 1, atLeast: true, intent: 'product cards' });
    await call(ctx, 'assert', { type: 'toHaveText', css: 'a.card:first-of-type [data-test="product-price"]', regex: '^\\$\\d+\\.\\d{2}$', intent: 'first price' });
    await call(ctx, 'assert', { type: 'toHaveAttribute', css: 'a.card:first-of-type img', attribute: 'src', regex: '\\S', intent: 'first image' });
  };
  {
    const context = await browser.newContext();
    await installEvalShim(context);
    const ctx = createContext(await context.newPage(), 60);
    await record(ctx);
    const refused = await call(ctx, 'end_scenario', {});
    check('C1. end_scenario refuses the recording: the name says names and no check reads one',
      refused.ok === false && /Claim check REFUSED attempt 1\/2/.test(refused.error ?? '') && (refused.error ?? '').includes('no check reads the name'), refused.error);
    check('C2. the scenario is still open with its steps, nothing is shipped or dropped',
      ctx.current !== null && ctx.current.steps.length === 4 && ctx.scenarios.length === 0 && ctx.brokenByGate.length === 0);
    const added = await call(ctx, 'assert', { type: 'toHaveText', css: 'a.card:first-of-type [data-test="product-name"]', regex: '\\S', intent: 'first name' });
    const closed = await call(ctx, 'end_scenario', {});
    check('C3. with a read of the name element added, end_scenario accepts and the scenario ships',
      added.ok === true && closed.ok === true && ctx.scenarios.length === 1 && ctx.scenarios[0]!.name === NAME && ctx.brokenByGate.length === 0, closed.error ?? added.error);
    await context.close();
  }
  {
    const context = await browser.newContext();
    await installEvalShim(context);
    const ctx = createContext(await context.newPage(), 60);
    await record(ctx);
    await call(ctx, 'end_scenario', {});
    const second = await call(ctx, 'end_scenario', {});
    const broken = ctx.brokenByGate[0];
    check(`C4. a second refusal (cap ${CLAIM_CAP}) drops the scenario with the reason and keeps its trace`,
      second.ok === false && /Claim check BROKEN after 2 attempts/.test(second.error ?? '') && ctx.current === null && ctx.scenarios.length === 0 &&
      !!broken && broken.scenario === NAME && broken.reason === 'the name claims more than the recording proves: "with names images and prices" (no check reads the name)' &&
      ctx.gateBrokenTraces.get(NAME)?.steps.length === 4, `${second.error} | ${JSON.stringify(broken)}`);
    await context.close();
  }
  {
    const context = await browser.newContext();
    await installEvalShim(context);
    const ctx = createContext(await context.newPage(), 60);
    const REJ = 'rejected a malformed email format';
    await call(ctx, 'begin_scenario', { name: REJ, category: 'negative' });
    await call(ctx, 'navigate', { url: `${base}/reset` });
    await call(ctx, 'fill', { css: '[data-test="email"]', value: 'not-an-email', intent: 'email' });
    await call(ctx, 'click', { css: '[data-test="submit"]', intent: 'submit' });
    const aria = await call(ctx, 'assert', { type: 'toHaveAttribute', css: '#email', attribute: 'aria-invalid', value: 'true', intent: 'email invalid' });
    await call(ctx, 'assert', { type: 'toHaveURL', pattern: '/reset' });
    const refused = await call(ctx, 'end_scenario', {});
    check('C5. run 10\'s shape: aria-invalid on the field typed into (located another way) and the URL that stays are refused as proof of "rejected"',
      aria.ok === true && refused.ok === false && (refused.error ?? '').includes('no check after the last action could fail if the submit were accepted'), refused.error ?? aria.error);
    const err = await call(ctx, 'assert', { type: 'toBeVisible', css: '[data-test="email-error"]', intent: 'email error' });
    const closed = await call(ctx, 'end_scenario', {});
    check('C6. with the error message asserted visible, the same scenario is accepted', err.ok === true && closed.ok === true && ctx.scenarios.length === 1, closed.error ?? err.error);
    await context.close();
  }
  {
    const context = await browser.newContext();
    await installEvalShim(context);
    const ctx = createContext(await context.newPage(), 60);
    await record(ctx);
    const fin = await call(ctx, 'finish', {});
    check('C7. finish with the overclaim still open drops it with the claim reason, never ships it',
      fin.ok === true && ctx.scenarios.length === 0 && ctx.brokenByGate.length === 1 && ctx.brokenByGate[0]!.reason.startsWith('the name claims more than the recording proves:'), JSON.stringify(ctx.brokenByGate));
    await context.close();
  }

  /* ─── D. the plan's name is the one judged ───────────────────────────── */
  {
    const context = await browser.newContext();
    await installEvalShim(context);
    const ctx = createContext(await context.newPage(), 80);
    ctx.plannedNames = ['displayed products with names and prices', 'opened the listing'];
    // The model's echo drops the claim words; the plan's name still holds them.
    await call(ctx, 'begin_scenario', { name: 'displayed products', category: 'happy' });
    await call(ctx, 'navigate', { url: `${base}/` });
    await call(ctx, 'assert', { type: 'toHaveText', css: 'a.card:first-of-type [data-test="product-price"]', regex: '^\\$\\d+\\.\\d{2}$', intent: 'first price' });
    const refused = await call(ctx, 'end_scenario', {});
    check('D1. an echo without the claim words is judged by the planned name it matches',
      refused.ok === false && (refused.error ?? '').includes('no check reads the name'), refused.error);
    await call(ctx, 'assert', { type: 'toHaveText', css: 'a.card:first-of-type [data-test="product-name"]', regex: '\\S', intent: 'first name' });
    const closed = await call(ctx, 'end_scenario', {});
    check('D2. and accepted once the name is read', closed.ok === true && ctx.scenarios.length === 1, closed.error);

    // A recorded name that claims and matches no planned name: not judged, one note.
    const stray = 'checked the footer with prices';
    await call(ctx, 'begin_scenario', { name: stray, category: 'happy' });
    await call(ctx, 'navigate', { url: `${base}/` });
    await call(ctx, 'assert', { type: 'toBeVisible', css: 'h1', intent: 'heading' });
    const first = await call(ctx, 'end_scenario', {});
    const notes = ctx.notes.filter((n) => n === claimUnmatchedLine(stray));
    check('D3. a recorded name that matches no planned name is not judged, and one note says so',
      first.ok === true && notes.length === 1, `${first.error} | ${JSON.stringify(ctx.notes)}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

/* ─── F. a cited rule's own claim: asked once, never a strike ───────────── */
{
  const R9 = { id: 'R9', text: 'Removing a product from the cart removes its row and updates the total.' };
  const REMOVED = 'removed the product and the row disappeared from the cart table';
  const plan = [{ name: REMOVED, category: 'edge', ruleIds: ['R9', 'R99'] }, { name: 'opened the listing', category: 'happy' }] as unknown as PlannedScenario[];
  const rules = plannedRulesFor(plan, { features: [{ name: 'cart', description: '', rules: [{ ...R9, type: 'behavior' }] }], roles: [], truncated: false } as RequirementsMap);
  check('F1. plannedRulesFor: a planned scenario carries the text of each rule it cites that the map holds, others carry none',
    rules.size === 1 && JSON.stringify(rules.get(REMOVED)) === JSON.stringify([R9]), JSON.stringify([...rules]));
  const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
  const ctx = createContext(stubPage, 60);
  ctx.plannedNames = plan.map((p) => p.name);
  ctx.plannedRules = rules;
  const css = (arg: string) => ({ level: 'css' as const, arg, intent: '' });
  const steps: TraceStep[] = [
    { kind: 'navigate', url: 'http://x/cart' },
    { kind: 'click', target: css('.remove') },
    { kind: 'assert', name: '', assertion: { type: 'toHaveCount', target: css('tbody tr'), count: 0, timeout: 10000 } },
  ];
  await runTool(ctx, { name: 'begin_scenario', input: { name: REMOVED, category: 'edge', feature: 'cart' } });
  ctx.current!.steps.push(...steps);
  const asked = await runTool(ctx, { name: 'end_scenario', input: {} });
  check('F2. the name is honest and the cited rule says more: end_scenario asks once, naming R9 and the total, and keeps the scenario open',
    asked.ok === false && /^Rule check, asked once/.test(asked.error ?? '') && (asked.error ?? '').includes('R9 says') && (asked.error ?? '').includes('no check reads the total') &&
    ctx.current !== null && ctx.brokenByGate.length === 0, asked.error);
  const again = await runTool(ctx, { name: 'end_scenario', input: {} });
  check('F3. asked again with nothing added, the scenario is accepted and shipped: a rule\'s gap is never a strike',
    again.ok === true && ctx.scenarios.length === 1 && ctx.brokenByGate.length === 0 && ctx._claimAttempts.size === 0, again.error);
  const cov = computeRuleCoverage({
    map: { features: [{ name: 'cart', description: '', rules: [{ ...R9, type: 'behavior' }] }], roles: [], truncated: false } as RequirementsMap,
    planned: plan, scenarios: ctx.scenarios.map((s) => ({ ...s, ruleIds: ['R9'] })),
  });
  check('F4. and rule coverage reports that rule as cited-not-exercised, never covered',
    cov.covered.length === 0 && cov.uncovered[0]?.reason === 'cited-not-exercised', JSON.stringify(cov));
}

/* ─── E. the doctrine, the index, the reason text ──────────────────────── */
check('E1. doctrine rule 12 is the name-claim rule, in both prompts word for word',
  ASSERTION_DOCTRINE.includes(`12. ${NAME_CLAIM_RULE}`) && EXPLORER_SYSTEM_PROMPT.includes(NAME_CLAIM_RULE) && CRITIC_SYSTEM_PROMPT.includes(NAME_CLAIM_RULE));
check('E2. the index has a status for the new reason', typeof UNCOVERED_STATUS['cited-not-exercised'] === 'string');
check('E3. the drop reason names every gap', claimBrokenReason(claimGaps('rejected with an error', [{ kind: 'navigate', url: 'http://x/' }], 'name')).includes('"rejected"') );

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: claims and evidence: the vocabulary reads what a name or a rule claims and ignores fields and things only acted on; run 10\'s three overclaims and its three partly covered rules are named from its own recordings; end_scenario refuses an unbacked claim, keeps the scenario open, accepts the added check and drops on the second refusal; the plan\'s name is the one judged; doctrine rule 12 is in both prompts.');
