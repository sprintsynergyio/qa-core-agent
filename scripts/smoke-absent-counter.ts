/**
 * Locks the absent counter (invariant 80, run 71d739 D5a).
 *
 * Run 8's product page has no cart badge before the first add: RULE 9
 * refused a count capture, a text capture of the badge could not resolve, and
 * "capture the badge text, add, assert_compare greater" could never be
 * recorded, so R6 dropped on a fix the page cannot satisfy. Now a text
 * capture, or a compare re-read, on a counter target (RULE 9's
 * isCounterSelector) that matches no element reads "0" and the step records
 * absentAsZero: true. Any other absent target fails loudly, as before.
 *
 * A fixture product page renders the badge only after the first add (300 ms
 * after the click). In broken mode the add does nothing, so the badge never
 * appears. A remove button takes the cart back to empty (the badge goes).
 *   A. the tool: capture before the add reads "0" (css and testid hints),
 *      add, compare greater passes; broken, the compare FAILS; a non-counter
 *      absent target still fails at capture with nothing recorded; a present
 *      counter records no flag; capture "1", remove, compare less passes,
 *      with and without the badge's hints on the compare.
 *   B. replay: the recorded scenario passes, and FAILS in broken mode; the
 *      remove scenario passes.
 *   C. the emitted spec, POM and single file, TS and JS, run with Playwright:
 *      the cart-count test passes, and FAILS in broken mode; the helper is
 *      written only when a step uses it; the TS helper compiles strict.
 *   D. an absent counter on both sides proves nothing (the PR #60 review).
 *      In wrong-locator mode the badge renders under data-test="cart-qty",
 *      so the recorded [data-test="cart-quantity"] matches nothing at
 *      capture and at every re-read while the real badge reads 2: the tool
 *      REFUSES compare unchanged and equal on the engine token
 *      (ABSENT_COUNTER_COMPARE_REFUSAL), pushes no step, counts nothing
 *      toward the retry cap and records no finding (D1, D2); the hand-built
 *      pre-fix shape (capture absentAsZero + unchanged absentAsZero) FAILS in
 *      replay (D3) and in all four emitted forms (D4), whose unchanged line
 *      is the normal re-read while the capture keeps the helper; an honest
 *      unchanged on a present badge passes in the tool, replay and all four
 *      emitted forms, plain and flagged (D5); the R6 shape, absent badge,
 *      add, compare greater, is unchanged (D6).
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { ABSENT_COUNTER_COMPARE_REFUSAL, createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { ABSENT_COUNTER_GRACE_MS, renderAbsentCounterHelper } from '../src/agent/absent-counter.js';
import { describeStep } from '../src/agent/critic.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture product page ─────────────────────────────────────────────── */
let broken = false;
// Wrong-locator mode (D): the badge renders under data-test="cart-qty", so a
// recording that targets [data-test="cart-quantity"] never finds it.
let badgeAttr: 'cart-quantity' | 'cart-qty' = 'cart-quantity';
const productHtml = (): string => `<!doctype html><html lang="en"><head><title>Pliers</title></head><body>
<nav><a href="/cart" data-test="nav-cart">Cart <span id="slot"></span></a></nav>
<main><h1 data-test="product-name">Combination Pliers</h1>
<button type="button" data-test="add-to-cart">Add to cart</button>
<button type="button" data-test="remove-all">Empty cart</button>
<button type="button" data-test="wishlist">Save to wishlist</button> <span id="wish"></span></main>
<script>
  const broken = ${broken};
  let count = 0;
  function render() {
    const slot = document.getElementById('slot');
    slot.innerHTML = count > 0 ? '<span data-test="${badgeAttr}">' + count + '</span>' : '';
  }
  document.querySelector('[data-test="add-to-cart"]').addEventListener('click', () => {
    if (broken) return;
    setTimeout(() => { count++; render(); }, 300);
  });
  document.querySelector('[data-test="remove-all"]').addEventListener('click', () => {
    setTimeout(() => { count = 0; render(); }, 300);
  });
  // The wishlist save never touches the cart: the action for an honest unchanged compare.
  document.querySelector('[data-test="wishlist"]').addEventListener('click', () => {
    document.getElementById('wish').textContent = 'Saved';
  });
</script></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url?.startsWith('/product') ? productHtml() : '<!doctype html><title>cart</title><h1>Cart</h1>');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const PRODUCT = `${base}/product`;

const BADGE = '[data-test="cart-quantity"]';
const browser = await chromium.launch({ headless: true });
const dirs: string[] = [];

try {
  const ctxB = await browser.newContext();
  await installEvalShim(ctxB);
  const page = await ctxB.newPage();
  const tool = createContext(page, 400);
  const last = (): TraceStep | undefined => tool.current?.steps.at(-1);
  // The harness discards an open trace that holds no assertion and cannot close.
  const discardOpenTrace = (): void => { tool.current = null; tool.captures.clear(); };

  /* ─── A. the tool ───────────────────────────────────────────────────────── */
  const CART = 'added a product and the header cart count increased';
  await runTool(tool, { name: 'begin_scenario', input: { name: CART, category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'get_dom', input: {} });
  const t0 = Date.now();
  const cap = await runTool(tool, { name: 'capture', input: { name: 'badge', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  const waited = Date.now() - t0;
  const capStep = last();
  check('A1. a text capture on the absent badge reads "0" and records absentAsZero on the step',
    cap.ok && (cap.data as { value: string }).value === '0' && capStep?.kind === 'capture' && capStep.absentAsZero === true && capStep.target.level === 'css' && capStep.target.arg === BADGE,
    JSON.stringify({ cap, capStep }));
  check(`A2. the capture waited the counter grace (${ABSENT_COUNTER_GRACE_MS} ms) before reading "0", and no longer`, waited >= ABSENT_COUNTER_GRACE_MS && waited < ABSENT_COUNTER_GRACE_MS + 2500, `${waited} ms`);
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  const greater = await runTool(tool, { name: 'assert_compare', input: { name: 'badge', relation: 'greater', intent: 'cart badge after add' } });
  const cmpStep = last();
  check('A3. add, then assert_compare greater passes (the badge now reads "1")', greater.ok && cmpStep?.kind === 'assert_compare' && cmpStep.relation === 'greater', JSON.stringify(greater));
  check('A4. the compare re-reads the flagged counter, so it records absentAsZero too', cmpStep?.kind === 'assert_compare' && cmpStep.absentAsZero === true, JSON.stringify(cmpStep));
  const ended = await runTool(tool, { name: 'end_scenario', input: {} });
  const cartScenario = tool.scenarios.find((s) => s.name === CART) as Scenario | undefined;
  check('A5. end_scenario accepts the scenario (capture, add, compare greater)', ended.ok && !!cartScenario, JSON.stringify(ended));
  if (!cartScenario) throw new Error('A5: the R6 scenario (absent badge, add, compare greater) was not recorded, so B, C and D6 cannot run');
  console.log(`   Critic line: ${describeStep(cartScenario!.steps.find((s) => s.kind === 'capture')!)}`);

  // A testid hint on a data-test host reads the host's attribute (hintBuiltRecord).
  await runTool(tool, { name: 'begin_scenario', input: { name: 'badge by testid', category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  const capTid = await runTool(tool, { name: 'capture', input: { name: 'badgeTid', source: 'text', testid: 'cart-quantity', intent: 'cart badge' } });
  const tidStep = last();
  check('A6. a testid hint on the absent badge reads "0" through the host test-id attribute (css [data-test="cart-quantity"])',
    capTid.ok && (capTid.data as { value: string }).value === '0' && tidStep?.kind === 'capture' && tidStep.absentAsZero === true && tidStep.target.arg === BADGE, JSON.stringify(tidStep));
  // A non-counter target that is absent fails loudly, as before.
  const before = tool.current?.steps.length ?? -1;
  const missing = await runTool(tool, { name: 'capture', input: { name: 'subtitle', source: 'text', css: '[data-test="product-subtitle"]', intent: 'product subtitle' } });
  check('A7. a NON-counter absent target still fails at capture, reads nothing as "0", records nothing', !missing.ok && (tool.current?.steps.length ?? -1) === before && !tool.captures.has('subtitle'), JSON.stringify(missing));
  // A present counter is read the usual way: no flag.
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  await page.waitForSelector(BADGE);
  const present = await runTool(tool, { name: 'capture', input: { name: 'badgeOne', source: 'text', css: BADGE, intent: 'cart badge after one add' } });
  const presentStep = last();
  check('A8. a counter on the page is read by its text with no flag (value "1")', present.ok && (present.data as { value: string }).value === '1' && presentStep?.kind === 'capture' && presentStep.absentAsZero === undefined, JSON.stringify(presentStep));
  // Capture "1", empty the cart (the badge goes), compare less: the absent re-read reads "0".
  await runTool(tool, { name: 'click', input: { testid: 'remove-all', intent: 'empty cart button' } });
  const less = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeOne', relation: 'less', intent: 'cart badge after emptying' } });
  const lessStep = last();
  check('A9. capture "1", empty the cart, compare less passes: the badge is gone and reads "0", the compare records absentAsZero',
    less.ok && lessStep?.kind === 'assert_compare' && lessStep.absentAsZero === true, JSON.stringify({ less, lessStep }));
  // The same compare naming the badge by its hints: an absent counter hint is
  // read off the hints, never resolved through the cascade (which would fail).
  const lessHints = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeOne', relation: 'less', css: BADGE, intent: 'cart badge after emptying' } });
  const lessHintsStep = last();
  check('A9b. the compare passing the absent badge\'s hints reads it as "0" too (never a could-not-resolve)',
    lessHints.ok && lessHintsStep?.kind === 'assert_compare' && lessHintsStep.absentAsZero === true, JSON.stringify({ lessHints }));
  await runTool(tool, { name: 'end_scenario', input: {} });
  const removeScenario = tool.scenarios.find((s) => s.name === 'badge by testid') as Scenario | undefined;

  // Broken add: the badge never appears, so the compare must FAIL.
  broken = true;
  await runTool(tool, { name: 'begin_scenario', input: { name: 'broken add', category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'capture', input: { name: 'badgeB', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  const brokenCmp = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeB', relation: 'greater', intent: 'cart badge after add' } });
  check('A10. broken add-to-cart: compare greater FAILS in the tool (captured "0", now "0")', !brokenCmp.ok && /captured "0", now "0"/.test(brokenCmp.error ?? ''), JSON.stringify(brokenCmp));
  broken = false;

  /* ─── B. replay ─────────────────────────────────────────────────────────── */
  const r1 = await replayScenarioOnce(browser, cartScenario!, undefined, 8000);
  check('B1. the recorded cart-count scenario replays green on a fresh context', r1.passed === true, JSON.stringify(r1));
  const r2 = await replayScenarioOnce(browser, removeScenario!, undefined, 8000);
  check('B2. the remove scenario (absent re-read after emptying) replays green', r2.passed === true, JSON.stringify(r2));
  broken = true;
  const r3 = await replayScenarioOnce(browser, cartScenario!, undefined, 4000);
  check('B3. broken add-to-cart: the same recording FAILS in replay at the compare', r3.passed === false && cartScenario!.steps[r3.failedStep ?? -1]?.kind === 'assert_compare', JSON.stringify(r3));
  broken = false;

  /* ─── C. the emitted spec ──────────────────────────────────────────────── */
  const TEST = 'added a product and the header cart count increased';
  const report = (language: 'ts' | 'js', scenarios: Scenario[]): RunReport => ({
    url: PRODUCT, language, scenarios,
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  } as RunReport);
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language, [cartScenario!]), shape, 'absent-counter');
      dirs.push(e.dir);
      emitted.push(e);
    }
  }
  for (const e of emitted) {
    const spec = [...e.files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y')).map(([, t]) => t).join('\n');
    const lines = spec.split('\n').map((l) => l.trim()).filter((l) => l.includes('readCounterText(') && !l.startsWith('async function') && !l.startsWith('//'));
    console.log(`   ${e.language} ${e.shape}:\n     ${lines.join('\n     ')}`);
    check(`C1. ${e.language} ${e.shape}: the capture reads through readCounterText with the ${ABSENT_COUNTER_GRACE_MS} ms grace and the compare polls readCounterText(…, 0)`,
      lines.some((l) => l.startsWith('const cap_badge = await readCounterText(') && l.includes(`, ${ABSENT_COUNTER_GRACE_MS});`))
      && lines.some((l) => l.startsWith('await expect.poll(async () => parseNumber(await readCounterText(') && l.includes(', 0)), { timeout: 10000 }).toBeGreaterThan(parseNumber(cap_badge));')), lines.join(' | '));
    if (e.shape === 'POM') {
      const helper = e.files.get(`helpers/absent-counter.${e.language}`);
      check(`C2. ${e.language} POM: helpers/absent-counter is written with the agent's own text and the spec imports it`,
        helper === renderAbsentCounterHelper(e.language) && (e.language === 'ts' ? spec.includes(`import { readCounterText } from '../../helpers/absent-counter';`) : spec.includes(`const { readCounterText } = require('../../helpers/absent-counter');`)), helper?.slice(0, 200));
      if (e.language === 'ts') {
        const tsc = spawnSync('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'helpers/absent-counter.ts'], { cwd: e.dir, encoding: 'utf8' });
        check('C3. ts POM: helpers/absent-counter.ts compiles under tsc --strict', tsc.status === 0, (tsc.stdout + tsc.stderr).slice(0, 400));
      }
    } else {
      check(`C2. ${e.language} single file: readCounterText is inlined`, spec.includes('async function readCounterText(locator, graceMs) {'));
    }
  }
  const plain = emitFramework(report('ts', [{ ...cartScenario!, steps: cartScenario!.steps.map((s) => (s.kind === 'capture' || s.kind === 'assert_compare') ? (({ absentAsZero: _a, ...rest }) => rest as TraceStep)(s) : s) }]), 'POM', 'absent-counter-plain');
  dirs.push(plain.dir);
  check('C4. a framework with no absentAsZero step has no helpers/absent-counter and no readCounterText anywhere', ![...plain.files.keys()].some((f) => f.includes('absent-counter')) && ![...plain.files.values()].some((t) => t.includes('readCounterText')));

  const runAll = async (label: string, expectPass: boolean): Promise<void> => {
    const runs = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'cart count increased') })));
    for (const { e, res } of runs) {
      const spec = res.specs.find((sp) => sp.title.includes(TEST));
      console.log(`   ${e.language} ${e.shape} ${broken ? 'broken add' : 'working add'}: playwright exit ${String(res.status)}; ${spec?.status ?? 'missing'}`);
      check(`${label}. ${e.language} ${e.shape}: with ${broken ? 'a broken' : 'a working'} add-to-cart the emitted cart-count test ${expectPass ? 'passes' : 'FAILS'}`,
        expectPass ? res.status === 0 && spec?.status === 'expected' : res.status !== 0 && spec?.status === 'unexpected', JSON.stringify(spec) + ' | ' + res.out);
    }
  };
  await runAll('C5', true);
  broken = true;
  await runAll('C6', false);
  broken = false;

  /* ─── D. an absent counter on both sides proves nothing (the PR #60 review) ─ */
  // Wrong-locator mode: the recorded [data-test="cart-quantity"] matches no
  // element at capture and at every re-read while the real badge (under
  // cart-qty) reads 2. Before the fix the capture read "0", the re-read read
  // "0", and unchanged held without checking anything.
  badgeAttr = 'cart-qty';
  // A10 left its "broken add" trace open (its compare failed, nothing closed
  // it): the harness discards it so D starts from a clean context.
  discardOpenTrace();
  const WRONG = 'wrong locator: the cart count stayed the same after two adds';
  const findingsBefore = tool.findings.length;
  const beganW = await runTool(tool, { name: 'begin_scenario', input: { name: WRONG, category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  const capW = await runTool(tool, { name: 'capture', input: { name: 'badgeW', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  const capStepW = last();
  if (capStepW?.kind !== 'capture') throw new Error(`D1: the capture recorded no capture step: ${JSON.stringify({ capW, capStepW })}`);
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  await page.locator('[data-test="cart-qty"]', { hasText: '2' }).waitFor({ timeout: 5000 });
  const stepsBefore = tool.current!.steps.length;
  const failuresBefore = new Map(tool._assertFailures);
  const unchangedW = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeW', relation: 'unchanged', intent: 'cart badge after two adds' } });
  const equalW = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeW', relation: 'equal', intent: 'cart badge after two adds' } });
  // A refusal is matched on the engine-owned token, never on its prose.
  const refused = (r: { ok: boolean; error?: string }, relation: string): boolean =>
    !r.ok && (r.error ?? '').startsWith(`assert_compare(${relation}): `) && (r.error ?? '').includes(ABSENT_COUNTER_COMPARE_REFUSAL);
  console.log(`   refusal: ${unchangedW.error}`);
  check('D1. wrong locator (the real badge reads 2 under cart-qty): the capture reads "0" absentAsZero, then compare unchanged is REFUSED on the engine token',
    beganW.ok && capW.ok && (capW.data as { value: string }).value === '0' && capStepW.absentAsZero === true && refused(unchangedW, 'unchanged'), JSON.stringify({ beganW, capW, unchangedW }));
  check('D1b. compare equal is refused the same way', refused(equalW, 'equal'), JSON.stringify(equalW));
  check('D1c. neither refusal pushes a step (the last recorded step is still the second add)', tool.current!.steps.length === stepsBefore && last()?.kind === 'click', JSON.stringify(last()));
  for (let i = 0; i < 3; i++) {
    const again = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeW', relation: 'unchanged', intent: 'cart badge after two adds' } });
    if (!refused(again, 'unchanged')) { check(`D2. refusal ${i + 1} of 3 repeats`, false, JSON.stringify(again)); break; }
  }
  const sameMap = (a: Map<string, number>, b: Map<string, number>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  check('D2. three more refusals record NO finding, leave the retry-cap counter unchanged, block nothing, and leave the scenario open with no new step',
    tool.findings.length === findingsBefore && sameMap(failuresBefore, tool._assertFailures) && !tool._blockUntilNewScenario && tool.current?.name === WRONG && tool.current.steps.length === stepsBefore,
    JSON.stringify({ findings: tool.findings.length - findingsBefore, failures: [...tool._assertFailures], blocked: tool._blockUntilNewScenario }));
  // The hand-built pre-fix shape: the recorded steps (navigate, capture
  // absentAsZero, add, add) plus the unchanged compare the old tool recorded,
  // absentAsZero on the same target. The open trace holds no assertion and
  // cannot close, so the harness discards it.
  const recordedW = [...tool.current!.steps];
  discardOpenTrace();
  const vacuousCompare = (relation: 'unchanged' | 'equal'): TraceStep => ({
    kind: 'assert_compare', varName: capStepW.varName, relation, source: 'text', target: capStepW.target, intent: capStepW.intent, readVar: `${capStepW.varName}_now`, absentAsZero: true,
  });
  const wrongScenario: Scenario = { name: WRONG, category: 'happy', feature: 'cart', steps: [...recordedW, vacuousCompare('unchanged')] };
  const wrongEqual: Scenario = { name: `${WRONG} (equal)`, category: 'happy', feature: 'cart', steps: [...recordedW, vacuousCompare('equal')] };
  const r4 = await replayScenarioOnce(browser, wrongScenario, undefined, 4000);
  check('D3. replay: capture absentAsZero + compare unchanged absentAsZero on the wrong-locator fixture FAILS at the compare (the normal re-read finds no element)',
    r4.passed === false && wrongScenario.steps[r4.failedStep ?? -1]?.kind === 'assert_compare', JSON.stringify(r4));
  const r4e = await replayScenarioOnce(browser, wrongEqual, undefined, 4000);
  check('D3b. the equal variant FAILS in replay the same way', r4e.passed === false && wrongEqual.steps[r4e.failedStep ?? -1]?.kind === 'assert_compare', JSON.stringify(r4e));

  // D5. Honest unchanged: the badge present reading "1", a wishlist save
  // that leaves the cart alone, compare unchanged.
  badgeAttr = 'cart-quantity';
  const HONEST = 'honest unchanged: the cart count stayed at one after a wishlist save';
  await runTool(tool, { name: 'begin_scenario', input: { name: HONEST, category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  await page.waitForSelector(BADGE);
  const capH = await runTool(tool, { name: 'capture', input: { name: 'badgeH', source: 'text', css: BADGE, intent: 'cart badge after one add' } });
  const capStepH = last();
  if (capStepH?.kind !== 'capture') throw new Error(`D5: the capture recorded no capture step: ${JSON.stringify({ capH, capStepH })}`);
  await runTool(tool, { name: 'click', input: { testid: 'wishlist', intent: 'save to wishlist button' } });
  const unchangedH = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeH', relation: 'unchanged', intent: 'cart badge after the wishlist save' } });
  const cmpStepH = last();
  const endedH = await runTool(tool, { name: 'end_scenario', input: {} });
  const honestScenario = tool.scenarios.find((s) => s.name === HONEST) as Scenario | undefined;
  check('D5. honest unchanged: the badge present reads "1" with no flag, a wishlist save leaves it, compare unchanged passes in the tool, no flag on the compare, end_scenario accepts',
    capH.ok && (capH.data as { value: string }).value === '1' && capStepH.absentAsZero === undefined && unchangedH.ok && cmpStepH?.kind === 'assert_compare' && cmpStepH.relation === 'unchanged' && cmpStepH.absentAsZero === undefined && endedH.ok && !!honestScenario,
    JSON.stringify({ capH, unchangedH, cmpStepH, endedH }));
  const r5 = await replayScenarioOnce(browser, honestScenario!, undefined, 8000);
  check('D5b. the honest unchanged scenario replays green', r5.passed === true, JSON.stringify(r5));
  // The same recording with the flags the tool sets when the badge was absent
  // at capture: the capture reads through the helper (the badge is present,
  // "1") and the unchanged compare re-reads the normal way, which passes on a
  // present counter and fails on an absent one (D3).
  const flag = (s: TraceStep): TraceStep => (s.kind === 'capture' || s.kind === 'assert_compare') ? { ...s, absentAsZero: true as const } : s;
  const honestFlagged: Scenario = { ...honestScenario!, name: `${HONEST} (flagged)`, steps: honestScenario!.steps.map(flag) };
  const r5f = await replayScenarioOnce(browser, honestFlagged, undefined, 8000);
  check('D5c. the flagged variant (capture and unchanged compare absentAsZero) replays green on the present badge: the normal re-read reads "1"', r5f.passed === true, JSON.stringify(r5f));

  // D4 and D5d. The three scenarios emitted in all four forms.
  const specText = (e: Emitted): string => [...e.files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y')).map(([, t]) => t).join('\n');
  const emittedD: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language, [wrongScenario, honestScenario!, honestFlagged]), shape, 'absent-counter-d');
      dirs.push(e.dir);
      emittedD.push(e);
    }
  }
  for (const e of emittedD) {
    const lines = specText(e).split('\n').map((l) => l.trim());
    const capLineW = lines.find((l) => l.startsWith(`const ${capStepW.varName} = `));
    const cmpLinesW = lines.filter((l) => l.includes(`.toBe(${capStepW.varName})`));
    const capLinesH = lines.filter((l) => l.startsWith(`const ${capStepH.varName} = `));
    const cmpLinesH = lines.filter((l) => l.includes(`.toBe(${capStepH.varName})`));
    console.log(`   ${e.language} ${e.shape} wrong locator:\n     ${capLineW}\n     ${cmpLinesW.join('\n     ')}`);
    console.log(`   ${e.language} ${e.shape} honest unchanged (plain, flagged):\n     ${capLinesH.join('\n     ')}\n     ${cmpLinesH.join('\n     ')}`);
    const normalRead = (l: string): boolean => l.includes('.textContent())?.trim()') && !l.includes('readCounterText(');
    check(`D4a. ${e.language} ${e.shape}: the wrong-locator capture still reads through readCounterText with the ${ABSENT_COUNTER_GRACE_MS} ms grace, and its unchanged compare re-reads the NORMAL way, never readCounterText`,
      !!capLineW && capLineW.includes('await readCounterText(') && capLineW.includes(`, ${ABSENT_COUNTER_GRACE_MS});`) && cmpLinesW.length === 1 && cmpLinesW.every(normalRead), `${capLineW} | ${cmpLinesW.join(' | ')}`);
    check(`D5d. ${e.language} ${e.shape}: the honest unchanged compare line is the normal re-read in the plain and the flagged test, and the flagged capture reads through the helper`,
      cmpLinesH.length === 2 && cmpLinesH.every(normalRead) && capLinesH.length === 2 && capLinesH.filter((l) => l.includes('await readCounterText(')).length === 1, `${capLinesH.join(' | ')} | ${cmpLinesH.join(' | ')}`);
    if (e.shape === 'POM') {
      check(`D4b. ${e.language} POM: the helper is still shipped and imported, because the captures use it`,
        e.files.get(`helpers/absent-counter.${e.language}`) === renderAbsentCounterHelper(e.language)
        && specText(e).includes(e.language === 'ts' ? `import { readCounterText } from '../../helpers/absent-counter';` : `const { readCounterText } = require('../../helpers/absent-counter');`), [...e.files.keys()].join(','));
    } else {
      check(`D4b. ${e.language} single file: readCounterText is still inlined, because the captures use it`, specText(e).includes('async function readCounterText(locator, graceMs) {'));
    }
  }
  // A framework whose only flagged step is an unchanged compare (the capture
  // unflagged) re-reads the normal way, so nothing uses the helper and it is
  // not shipped: no unused import, no dead inline function.
  const compareOnly: Scenario = { ...honestScenario!, name: `${HONEST} (compare flagged only)`, steps: honestScenario!.steps.map((s) => s.kind === 'assert_compare' ? { ...s, absentAsZero: true as const } : s) };
  for (const shape of ['POM', 'single file'] as const) {
    const e = emitFramework(report('ts', [compareOnly]), shape, 'absent-counter-d-cmp');
    dirs.push(e.dir);
    check(`D4c. ts ${shape}: a report whose only flagged step is an unchanged compare ships no helper and no readCounterText anywhere`,
      ![...e.files.keys()].some((f) => f.includes('helpers/absent-counter')) && ![...e.files.values()].some((t) => t.includes('readCounterText')), [...e.files.keys()].join(','));
  }
  const runD = async (label: string, grep: string, expectPass: boolean, expectTests: number): Promise<void> => {
    const runs = await Promise.all(emittedD.map(async (e) => ({ e, res: await runPlaywright(e.dir, grep) })));
    for (const { e, res } of runs) {
      const specs = res.specs.filter((sp) => sp.title.includes(grep));
      console.log(`   ${e.language} ${e.shape} (${badgeAttr}) "${grep}": playwright exit ${String(res.status)}; ${specs.map((sp) => sp.status).join(', ') || 'missing'}`);
      check(`${label}. ${e.language} ${e.shape}: ${expectTests} "${grep}" test(s) ${expectPass ? 'pass' : 'FAIL'} against the ${badgeAttr} fixture`,
        specs.length === expectTests && (expectPass ? res.status === 0 && specs.every((sp) => sp.status === 'expected') : res.status !== 0 && specs.every((sp) => sp.status === 'unexpected')),
        JSON.stringify(specs) + ' | ' + res.out);
    }
  };
  badgeAttr = 'cart-qty';
  await runD('D4', 'wrong locator', false, 1);
  badgeAttr = 'cart-quantity';
  await runD('D5e', 'honest unchanged', true, 2);

  // D6. The R6 shape is unchanged: absent badge, add, compare greater. The
  // read that held found the badge, so the refusal never applies: a fresh
  // recording is accepted, the A recording replays green, and every emitted
  // greater line of the C frameworks still polls readCounterText(…, 0).
  const R6 = 'R6 shape: added a product and the cart count went up';
  await runTool(tool, { name: 'begin_scenario', input: { name: R6, category: 'happy', feature: 'cart' } });
  await runTool(tool, { name: 'navigate', input: { url: PRODUCT } });
  await runTool(tool, { name: 'capture', input: { name: 'badgeR6', source: 'text', css: BADGE, intent: 'cart badge before add' } });
  await runTool(tool, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
  const greaterR6 = await runTool(tool, { name: 'assert_compare', input: { name: 'badgeR6', relation: 'greater', intent: 'cart badge after add' } });
  const endedR6 = await runTool(tool, { name: 'end_scenario', input: {} });
  const r6 = await replayScenarioOnce(browser, cartScenario!, undefined, 8000);
  check('D6. the R6 shape is unchanged: absent badge, add, compare greater is recorded (never refused), replays green, and every emitted greater line still polls readCounterText(…, 0)',
    greaterR6.ok && endedR6.ok && r6.passed === true && emitted.every((e) => specText(e).includes('await expect.poll(async () => parseNumber(await readCounterText(') && specText(e).includes(', 0)), { timeout: 10000 }).toBeGreaterThan(parseNumber(cap_badge));')), JSON.stringify({ greaterR6, endedR6, r6 }));
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: an absent counter reads "0" in the tool, replay and the emitted spec (POM and single file, TS and JS); a broken add fails in all of them; a non-counter absent target still fails at capture; an equal or unchanged compare on a counter absent on both reads is refused at the tool and fails in replay and the emitted spec.');
