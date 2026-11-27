/**
 * Locks rule placement (invariant 90, run b4e41b D7): a rule no page's plan
 * cited is planned on a page whose own snapshot shows what the rule needs,
 * a price a test says is the same on two pages must be shown on the page it
 * starts on, and a rule whose test was skipped or became a finding says so.
 *
 * Runs 8 to 10 never tested the search rule (R2): it was planned on two
 * pages with no search box and dropped by page fit, while the home page,
 * which has the box, was tagged "cart" and never offered the rule. R1 names
 * the home page and was never planned there. R5 ("the same name and price")
 * was planned on /rentals, whose cards carry no price: run 9 skipped it and
 * its coverage read planned-but-dropped with no detail.
 *
 * A: which planned page a rule fits, on run 9's map and its seven pages.
 * B: page fit: the same-price rule, and "required-field message".
 * C: the placement pass through planAcrossPages, with run 10's plan shape.
 * D: the one-rule call (planRuleOnPage) with a fixture client on a real
 *    snapshot: what it sends, what it accepts and rejects, what it costs.
 * E: rule coverage: skipped, finding, element not found, the placement
 *    detail, and the index and checkpoint.
 * F: three served pages, the real plan() and the real one-rule call behind
 *    a fixture client: R2 and R1 land on the home page, R5 on the category.
 * G: a whole run through explore() with a local stand-in for the model
 *    API: the report, the checkpoint, the console lines and the coverage.
 *
 * $0: fixture clients, local pages, no network.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { costOf } from '../src/agent/pricing.js';
import { stageModel } from '../src/agent/stage-models.js';
import { GLOBAL_PLAN_CAP, placementCandidates, placementDetails, placementVictim, planAcrossPages, rulePlacementLine, type PlaceRuleArgs, type PlanTarget } from '../src/agent/plan-pages.js';
import { pageFitReason, pageWideControlsNamed, plan, planRuleOnPage, rulePlacementAsk, ruleFitReason, snapshotPage, RULE_PLACEMENT_CAP, type PageSnapshot, type PlannedScenario, type PlanResult } from '../src/agent/planner.js';
import { computeRuleCoverage, renderRuleCoverage } from '../src/agent/rule-coverage.js';
import { CHECKPOINT_VERSION, loadCheckpoint, writeCheckpoint } from '../src/agent/checkpoint.js';
import { UNCOVERED_STATUS } from '../src/server/db/indexer.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { RulePlacement, RunReport } from '../src/agent/trace.js';
import { messageLine } from '../src/cli/render.js';
import { startFakeAnthropic, type FakeContent } from './lib/fake-anthropic.js';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failed += 1;
}

const H = 'http://localhost:4200';

// Run 9's requirements map, verbatim (requirements-map.json of b4e41b).
const MAP: RequirementsMap = {
  roles: [],
  truncated: false,
  features: [
    { name: 'catalogue', description: '', rules: [
      { id: 'R1', type: 'behavior', text: 'The home page lists products with a name, an image and a price.' },
      { id: 'R2', type: 'behavior', text: 'Typing a term in the search box and submitting shows only products whose name contains the term.' },
      { id: 'R3', type: 'behavior', text: 'The category filter narrows the list to products in the selected category.' },
      { id: 'R4', type: 'behavior', text: 'Sorting by price low to high orders the visible products by ascending price.' },
      { id: 'R5', type: 'navigation', text: 'Clicking a product opens its detail page showing the same name and price as the listing.' },
    ] },
    { name: 'cart', description: '', rules: [
      { id: 'R6', type: 'behavior', text: 'Adding a product from its detail page increases the cart count shown in the header.' },
      { id: 'R7', type: 'behavior', text: 'The cart page lists each added product with quantity and line total.' },
      { id: 'R8', type: 'behavior', text: 'Changing a quantity on the cart page updates the line total.' },
      { id: 'R9', type: 'behavior', text: 'Removing a product from the cart removes its row and updates the total.' },
    ] },
    { name: 'account', description: '', rules: [
      { id: 'R10', type: 'behavior', text: 'Login with a wrong password shows an error and the user stays on the login page.' },
      { id: 'R11', type: 'validation', text: 'Registration with an already used email address is rejected with an error.' },
      { id: 'R12', type: 'validation', text: 'Submitting the registration form with an empty required field shows a required-field message.' },
    ] },
    { name: 'contact', description: '', rules: [
      { id: 'R13', type: 'validation', text: 'The contact form rejects submission when the message field is empty and shows a validation message.' },
      { id: 'R14', type: 'validation', text: 'The contact form rejects an email address without an @ sign.' },
    ] },
  ],
} as RequirementsMap;
const featureOf = (id: string) => MAP.features.find((f) => f.rules.some((r) => r.id === id))!;
const ruleOf = (id: string) => featureOf(id).rules.find((r) => r.id === id)!;

type Flags = PageSnapshot['flags'];
const NO_FLAGS: Flags = { hasPrice: false, hasSort: false, hasFilter: false, hasPagination: false, hasSearch: false };
const snap = (url: string, title: string, flags: Partial<Flags> = {}, inputs: PageSnapshot['inputs'] = []): PageSnapshot =>
  ({ title, url, headings: [], inputs, buttons: [], fillableCount: inputs.length, textSample: '', tableHeaders: [], flags: { ...NO_FLAGS, ...flags }, frames: [] });

// Run 9's seven public pages in plan order, with the tag the page filter
// gave each (discovery.pages of b4e41b: "/" was tagged cart). What each
// page shows is what runs 8 to 10 recorded: no search box on the category
// page or on /rentals (two page-fit drops), no price on /rentals.
const PAGES: Array<{ path: string; feature: string; snapshot: PageSnapshot }> = [
  { path: '/category/hand-tools', feature: 'catalogue', snapshot: snap(`${H}/category/hand-tools`, 'Hand Tools', { hasPrice: true, hasSort: true, hasFilter: true, hasPagination: true }) },
  { path: '/contact', feature: 'contact', snapshot: snap(`${H}/contact`, 'Contact') },
  { path: '/auth/login', feature: 'account', snapshot: snap(`${H}/auth/login`, 'Login') },
  { path: '/auth/register', feature: 'account', snapshot: snap(`${H}/auth/register`, 'Register') },
  { path: '/rentals', feature: 'catalogue', snapshot: snap(`${H}/rentals`, 'Rentals') },
  { path: '/', feature: 'cart', snapshot: snap(`${H}/`, 'Toolshop', { hasPrice: true, hasSort: true, hasFilter: true, hasPagination: true, hasSearch: true }) },
  { path: '/auth/forgot-password', feature: 'account', snapshot: snap(`${H}/auth/forgot-password`, 'Forgot Password') },
];
const TARGETS: PlanTarget[] = PAGES.map((p) => ({ page: { url: `${H}${p.path}`, feature: p.feature, source: 'browser-crawl' } as PlanTarget['page'], features: [p.feature] }));
const SNAPSHOTS = new Map(PAGES.map((p, i) => [i, p.snapshot]));
const paths = (r: { candidates: number[] }): string => r.candidates.map((i) => PAGES[i]!.path).join(' ');
const cand = (id: string) => placementCandidates({ rule: ruleOf(id), feature: featureOf(id), targets: TARGETS, snapshots: SNAPSHOTS });

/* ─── A. which page a rule fits ───────────────────────────────────────────── */
{
  const r2 = cand('R2');
  check('A1. R2 (the search box) fits the home page only, the page tagged "cart"', paths(r2) === '/', paths(r2));
  check('A2. its reason names what the other pages lack, by path', /names search which the page snapshot does not show \(\/category\/hand-tools, .*\/rentals/.test(r2.why), r2.why);
  const r1 = cand('R1');
  check('A3. R1 (names the home page) fits the home page only', paths(r1) === '/' && /the rule names the home page, which the page does not carry by page evidence \(\/category\/hand-tools/.test(r1.why), `${paths(r1)} | ${r1.why}`);
  const r5 = cand('R5');
  check('A4. R5 (the same name and price) fits the category page first, then home, never /rentals', paths(r5) === '/category/hand-tools /' && /shows no price to compare \(.*\/rentals/.test(r5.why), `${paths(r5)} | ${r5.why}`);
  check('A5. R11 (registration) is placed on /auth/register only, never on the login page of the same feature', paths(cand('R11')) === '/auth/register', paths(cand('R11')));
  check('A6. R10 (the login page) and R13 (the contact form) fit their own pages', paths(cand('R10')) === '/auth/login' && paths(cand('R13')) === '/contact', `${paths(cand('R10'))} | ${paths(cand('R13'))}`);
  const r7 = cand('R7');
  check('A7. R7 (the cart page) fits no planned page and says why', r7.candidates.length === 0 && r7.considered > 0 && /the rule names the cart page/.test(r7.why), JSON.stringify(r7));
  // A rule that names nothing, on a feature with no tagged page: nothing ties it to a page.
  const loose = placementCandidates({ rule: { id: 'R30', type: 'behavior', text: 'Saved items are kept for thirty days.' }, feature: { name: 'wishlist', description: '', rules: [] }, targets: TARGETS, snapshots: SNAPSHOTS });
  check('A8. a rule that names no control and no place, with no tagged page, is tied to no page', loose.considered === 0 && loose.candidates.length === 0, JSON.stringify(loose));
  check('A9. a rule text is read for page-wide controls only: an outcome word is not a field',
    JSON.stringify(pageWideControlsNamed('Submitting the order sends a confirmation email to the delivery address.')) === '[]'
    && JSON.stringify(pageWideControlsNamed(ruleOf('R4').text)) === '["sort","price"]' && JSON.stringify(pageWideControlsNamed(ruleOf('R2').text)) === '["search"]',
    JSON.stringify([pageWideControlsNamed(ruleOf('R4').text), pageWideControlsNamed(ruleOf('R2').text)]));
  // A page reached by action is considered only for its own feature.
  const withRevealed: PlanTarget[] = [...TARGETS, { page: { url: `${H}/checkout`, feature: 'cart', source: 'action' } as PlanTarget['page'], features: ['cart'], reachedBy: { origin: `${H}/product/1`, actions: [] } }];
  const snaps2 = new Map(SNAPSHOTS); snaps2.set(7, snap(`${H}/checkout`, 'Checkout', { hasPrice: true, hasSearch: true }));
  const r2b = placementCandidates({ rule: ruleOf('R2'), feature: featureOf('R2'), targets: withRevealed, snapshots: snaps2 });
  check('A10. a page reached by action is never a candidate for another feature\'s rule', r2b.candidates.map((i) => withRevealed[i]!.page.url).join(' ') === `${H}/`, JSON.stringify(r2b.candidates));
  const noSnap = placementCandidates({ rule: ruleOf('R2'), feature: featureOf('R2'), targets: TARGETS, snapshots: new Map() });
  check('A11. a page with no snapshot is not considered', noSnap.considered === 0, JSON.stringify(noSnap));
}

/* ─── B. page fit ─────────────────────────────────────────────────────────── */
{
  const rentals = PAGES[4]!.snapshot;
  const category = PAGES[0]!.snapshot;
  const sc = (name: string): PlannedScenario => ({ name, category: 'happy', rationale: '' });
  const r5name = 'clicked a product and landed on its detail page with matching name and price';
  const onRentals = pageFitReason(sc(r5name), rentals);
  check('B1. run 9 and 10\'s R5 name is dropped on /rentals: the price it says is the same is not shown there',
    onRentals?.control === 'price' && onRentals.reason === 'says the price is the same on both pages, and the page snapshot shows no price to compare', JSON.stringify(onRentals));
  check('B2. the same name is kept on the category page, which shows prices', pageFitReason(sc(r5name), category) === null);
  check('B3. a click-through that only reads the price on the page it reaches is still kept (invariant 61)',
    pageFitReason(sc('clicked a product and landed on its detail page showing name and price'), rentals) === null);
  check('B4. a scenario that reads a price on the page itself is still dropped there',
    pageFitReason(sc('loaded the rentals page and saw products with a price'), rentals)?.reason === 'names price which the page snapshot does not show');
  const forgot = snap(`${H}/auth/forgot-password`, 'Forgot Password', {}, [{ tag: 'input', type: 'email', label: 'Email address' } as PageSnapshot['inputs'][number]]);
  check('B5. "saw a required-field message" names an outcome, not the message field',
    pageFitReason(sc('submitted the form with an empty email field and saw a required-field message'), forgot) === null,
    JSON.stringify(pageFitReason(sc('submitted the form with an empty email field and saw a required-field message'), forgot)));
  check('B6. "left the message field empty" still names the message field', pageFitReason(sc('left the message field empty and submitted'), forgot)?.control === 'message');
  check('B7. ruleFitReason reads the rule text the same way', ruleFitReason(ruleOf('R5').text, rentals) !== null && ruleFitReason(ruleOf('R5').text, category) === null && ruleFitReason(ruleOf('R12').text, forgot) === null);
}

/* ─── C. the placement pass ───────────────────────────────────────────────── */
// Run 10's plan shape, per page: R1's citation on the category sort is gone
// (invariant 82), R2 was dropped by page fit on both catalogue pages, R5 is
// now dropped on /rentals (B1). The home page planned nothing.
const line = (feature: string, category: PlannedScenario['category'], ruleIds: string[], name: string): PlannedScenario => ({ name, category, rationale: '', feature, ruleIds });
const RUN10: Record<string, PlannedScenario[]> = {
  '/category/hand-tools': [
    line('catalogue', 'happy', ['R4'], 'sorted products by price low to high and the list reordered by ascending price'),
    line('catalogue', 'happy', ['R3'], 'checked the "Hammer" category filter and only hammer products remained in the list'),
  ],
  '/contact': [
    line('contact', 'happy', [], 'submitted contact form with valid email and non-empty message'),
    line('contact', 'negative', ['R13'], 'rejected submission when message field is empty'),
    line('contact', 'negative', ['R14'], 'rejected an email address without an @ sign'),
  ],
  '/auth/login': [
    line('account', 'happy', [], 'logged in with valid test account credentials'),
    line('account', 'negative', ['R10'], 'rejected login with wrong password and stayed on login page'),
  ],
  '/auth/register': [
    line('account', 'negative', ['R11'], 'rejected registration with an already-used email address'),
    line('account', 'negative', ['R12'], 'rejected registration with an empty first name field'),
  ],
  '/rentals': [],
  '/': [],
  '/auth/forgot-password': [
    line('account', 'negative', [], 'submitted forgot-password with an empty email field and saw a required-field error'),
    line('account', 'negative', [], 'submitted forgot-password with a malformed email and the form rejected it'),
  ],
};
const emptyPlan = (scenarios: PlannedScenario[], snapshot: PageSnapshot): PlanResult => ({ scenarios, pageTitle: snapshot.title, costUsd: 0.001, dropped: [], rejected: [], citationDrops: [], pageFitRejected: [], contradictionRejected: [], ruleRetries: [], fillableFields: 0, snapshot });
const planFn = (extra: Record<string, PlannedScenario[]> = {}) => async (a: { url: string }): Promise<PlanResult> => {
  const p = PAGES.find((x) => `${H}${x.path}` === a.url)!;
  return emptyPlan([...(RUN10[p.path] ?? []), ...(extra[p.path] ?? [])], p.snapshot);
};
const PLACED: Record<string, string> = {
  R1: 'loaded the home page and saw products with a name, an image and a price',
  R2: 'searched for "pliers" and every listed product name contained the term',
  R5: 'clicked a product and landed on its detail page with matching name and price',
};
const placeRule = (calls: PlaceRuleArgs[], answers: Record<string, Partial<Awaited<ReturnType<NonNullable<Parameters<typeof planAcrossPages>[0]['placeRule']>>>>> = {}) =>
  async (a: PlaceRuleArgs) => {
    calls.push(a);
    const scripted = answers[a.rule.id];
    if (scripted) return { ruleId: a.rule.id, costUsd: 0.002, outcome: 'none' as const, ...scripted };
    const name = PLACED[a.rule.id] ?? `planned for ${a.rule.id}`;
    return { ruleId: a.rule.id, costUsd: 0.002, outcome: 'planned' as const, scenario: name, added: { name, category: 'happy' as const, rationale: '', ruleIds: [a.rule.id] } };
  };
{
  const messages: string[] = [];
  const calls: PlaceRuleArgs[] = [];
  const r = await planAcrossPages({ targets: TARGETS, planFn: planFn(), onMessage: (m) => messages.push(m), map: MAP, placeRule: placeRule(calls), skipPlacementFeatures: new Set(['cart']) });
  const at = (id: string) => r.combined.find((s) => (s.ruleIds ?? []).includes(id));
  console.log('\n--- C: the placement lines ---');
  for (const m of messages.filter((x) => x.startsWith('Planner rule placement'))) console.log(m);
  console.log('---');
  check('C1. R1, R2 and R5 each get one call, on the page that fits', JSON.stringify(calls.map((c) => [c.rule.id, c.url.replace(H, '')])) === '[["R1","/"],["R2","/"],["R5","/category/hand-tools"]]', JSON.stringify(calls.map((c) => [c.rule.id, c.url])));
  check('C2. the call is given that page\'s own snapshot', calls[0]?.snapshot === PAGES[5]!.snapshot && calls[2]?.snapshot === PAGES[0]!.snapshot);
  check('C3. R2 is in the plan on the home page, under its own feature, not the page\'s "cart" tag',
    at('R2')?.pageUrl === `${H}/` && at('R2')?.feature === 'catalogue' && at('R2')?.name === PLACED.R2, JSON.stringify(at('R2')));
  check('C4. R1 is on the home page and R5 on the category page', at('R1')?.pageUrl === `${H}/` && at('R5')?.pageUrl === `${H}/category/hand-tools`, JSON.stringify([at('R1')?.pageUrl, at('R5')?.pageUrl]));
  check('C5. each placement is recorded with its page, scenario and cost', r.rulePlacements.length === 3 && r.rulePlacements.every((p) => p.outcome === 'planned' && p.costUsd === 0.002 && p.feature === 'catalogue')
    && r.rulePlacements[1]?.pageUrl === `${H}/` && r.rulePlacements[1]?.scenario === PLACED.R2, JSON.stringify(r.rulePlacements));
  check('C6. the console line names the rule, the page, the scenario and the cost',
    messages.includes(`Planner rule placement R2 on ${H}/: planned "${PLACED.R2}" · $0.0020`), messages.filter((m) => m.includes('placement')).join(' | '));
  check('C7. the planner cost includes the three calls', Math.abs(r.plannerUsd - (7 * 0.001 + 3 * 0.002)) < 1e-9, String(r.plannerUsd));
  check('C8. a probed feature (cart) is left to its probe: R6 to R9 get no call and no record', !calls.some((c) => /^R[6-9]$/.test(c.rule.id)) && !r.rulePlacements.some((p) => p.feature === 'cart'));
  check('C9. a rule already cited gets no call', !calls.some((c) => ['R3', 'R4', 'R10', 'R11', 'R12', 'R13', 'R14'].includes(c.rule.id)));

  // Without a map or the call, the result is exactly the per-page plan.
  const plain = await planAcrossPages({ targets: TARGETS, planFn: planFn(), onMessage: () => {} });
  check('C10. without the map and the call the pass does not run', plain.rulePlacements.length === 0 && plain.combined.length === r.combined.length - 3 && JSON.stringify(plain.combined) === JSON.stringify(r.combined.slice(0, plain.combined.length)));

  // No page fits: R2 with a home page that has no search box.
  const noSearch = new Map(SNAPSHOTS);
  const targets2 = TARGETS;
  const pagesNoSearch = PAGES.map((p) => (p.path === '/' ? { ...p, snapshot: snap(`${H}/`, 'Toolshop', { hasPrice: true }) } : p));
  void noSearch;
  const calls2: PlaceRuleArgs[] = [];
  const messages2: string[] = [];
  const r2 = await planAcrossPages({
    targets: targets2,
    planFn: async (a) => { const p = pagesNoSearch.find((x) => `${H}${x.path}` === a.url)!; return emptyPlan(RUN10[p.path] ?? [], p.snapshot); },
    onMessage: (m) => messages2.push(m), map: MAP, placeRule: placeRule(calls2), skipPlacementFeatures: new Set(['cart']),
  });
  const noPage = r2.rulePlacements.find((p) => p.ruleId === 'R2');
  check('C11. with no search box anywhere R2 gets no call and is recorded as fitting no planned page, with the reason',
    !calls2.some((c) => c.rule.id === 'R2') && noPage?.outcome === 'no-page' && /names search which the page snapshot does not show/.test(noPage.reason ?? '') && noPage.costUsd === 0, JSON.stringify(noPage));
  const longLine = rulePlacementLine(noPage!);
  check('C12b. the CLI prints a placement line whole, however long', longLine.length > 240 ? messageLine(longLine) === longLine : messageLine(`${longLine}${' x'.repeat(150)}`) === `${longLine}${' x'.repeat(150)}`, String(longLine.length));
  check('C12. the line and the coverage detail say so',
    messages2.some((m) => m.startsWith('Planner rule placement R2: no planned page fits: names search which the page snapshot does not show (')) && /^no planned page fits: names search/.test(placementDetails(r2.rulePlacements).R2 ?? ''),
    messages2.filter((m) => m.includes('R2')).join(' | '));

  // A rejected and an empty answer are recorded, never planned.
  const calls3: PlaceRuleArgs[] = [];
  const r3 = await planAcrossPages({
    targets: TARGETS, planFn: planFn(), onMessage: () => {}, map: MAP, skipPlacementFeatures: new Set(['cart']),
    placeRule: placeRule(calls3, { R1: { outcome: 'rejected', scenario: 'searched the home page', reason: 'names search which the page snapshot does not show' }, R2: { outcome: 'none', reason: 'the call returned no parseable scenario' } }),
  });
  const p1 = r3.rulePlacements.find((p) => p.ruleId === 'R1');
  const p2 = r3.rulePlacements.find((p) => p.ruleId === 'R2');
  check('C13. a rejected answer is recorded with its reason and cost, and nothing is planned for the rule',
    p1?.outcome === 'rejected' && p1.reason === 'names search which the page snapshot does not show' && p1.costUsd === 0.002 && !r3.combined.some((s) => (s.ruleIds ?? []).includes('R1')), JSON.stringify(p1));
  check('C14. an empty answer is recorded as none', p2?.outcome === 'none' && !r3.combined.some((s) => (s.ruleIds ?? []).includes('R2')), JSON.stringify(p2));
  check('C15. both give rule coverage a detail', /^placement on \/ rejected: names search/.test(placementDetails(r3.rulePlacements).R1 ?? '') && placementDetails(r3.rulePlacements).R2 === 'placement on / returned no scenario', JSON.stringify(placementDetails(r3.rulePlacements)));

  // A rule a cap cut is the cap's, never placed.
  const cutMap: RequirementsMap = { ...MAP, features: MAP.features.filter((f) => f.name === 'contact') };
  const five = [1, 2, 3, 4].map((i) => line('contact', 'negative', [], `rejected contact variant ${i} with a missing field`));
  const calls4: PlaceRuleArgs[] = [];
  const r4 = await planAcrossPages({
    targets: [TARGETS[1]!],
    planFn: async () => emptyPlan([...five, line('contact', 'negative', ['R13'], 'rejected submission when message field is empty')].map((s, i) => (i === 0 ? { ...s, ruleIds: ['R14'] } : s)), PAGES[1]!.snapshot),
    onMessage: () => {}, map: cutMap, placeRule: placeRule(calls4),
  });
  check('C16. a rule whose only scenario the per-page cap cut is not placed again', r4.planTrimmed.length > 0 && calls4.length === 0 && r4.rulePlacements.length === 0, JSON.stringify([r4.planTrimmed, calls4.map((c) => c.rule.id)]));
}

// The plan cap: a placed rule replaces the last scenario that cites no rule.
{
  // Twenty scenarios that differ enough to survive the cross-page dedup: each has its own subject, and its own rule id when it cites one.
  const SUBJECTS = ['subject', 'phone', 'company', 'country', 'city', 'postcode', 'address', 'date', 'coupon', 'newsletter', 'terms', 'attachment', 'order', 'invoice', 'refund', 'warranty', 'delivery', 'pickup', 'callback', 'feedback'];
  let k = 0;
  const filler = (n: number, withRule: boolean): PlannedScenario[] => Array.from({ length: n }, () => {
    const i = k++ % SUBJECTS.length;
    return line('contact', i % 2 ? 'negative' : 'happy', withRule ? [`R${50 + i}`] : [], `contact filler about ${SUBJECTS[i]} ${withRule ? 'for its own rule' : 'with no rule'}`);
  });
  const capTargets: PlanTarget[] = Array.from({ length: 5 }, (_, i) => ({ page: { url: `${H}/contact/${i + 1}`, feature: 'contact', source: 'user' } as PlanTarget['page'], features: ['contact'] }));
  const home: PlanTarget = { page: { url: `${H}/`, feature: 'cart', source: 'user' } as PlanTarget['page'], features: ['cart'] };
  const run = async (withRule: boolean, budgetMap = MAP) => {
    const messages: string[] = [];
    const calls: PlaceRuleArgs[] = [];
    let n = 0;
    k = 0;
    const r = await planAcrossPages({
      // The home page is planned first (nothing planned there), then five pages fill the plan to its cap.
      targets: [home, ...capTargets],
      planFn: async (a) => { n += 1; return a.url === `${H}/` ? emptyPlan([], PAGES[5]!.snapshot) : emptyPlan(filler(4, withRule), snap(a.url, 'Contact')); },
      onMessage: (m) => messages.push(m), map: budgetMap, placeRule: placeRule(calls), skipPlacementFeatures: new Set(['cart', 'account', 'contact']),
    });
    void n;
    return { r, messages, calls };
  };
  const a = await run(false);
  check('C17. at the plan cap a placed rule replaces a scenario that cites no rule, and the plan stays at the cap',
    a.r.combined.length === GLOBAL_PLAN_CAP && ['R1', 'R2', 'R3', 'R4', 'R5'].every((id) => a.r.combined.some((s) => (s.ruleIds ?? []).includes(id))), String(a.r.combined.length));
  const cuts = a.r.planTrimmed.filter((c) => c.cause === 'global-cap');
  check('C18. each replaced scenario is named on the console and recorded as a global-cap cut, a negative one first',
    cuts.length === 5 && cuts.every((c) => c.ruleIds.length === 0) && a.messages.includes('Planner: the plan is at its cap of 20; cut "contact filler about feedback with no rule" (cited no rule) to make room for R1.')
    && a.r.planCapHit, JSON.stringify([cuts.map((c) => c.name), a.messages.filter((m) => m.includes('make room'))]));
  check('C19. placementVictim: the last negative or edge scenario with no rule, then the last happy one, else none',
    placementVictim([line('a', 'happy', [], 'x'), line('a', 'negative', [], 'y'), line('a', 'happy', [], 'z')]) === 1 && placementVictim([line('a', 'happy', [], 'x'), line('a', 'happy', ['R1'], 'z')]) === 0 && placementVictim([line('a', 'happy', ['R1'], 'z')]) === -1);
  const b = await run(true);
  const full = b.r.rulePlacements.find((p) => p.ruleId === 'R2');
  check('C20. when every planned scenario cites a rule nothing is replaced: no call, recorded as plan-full',
    b.calls.length === 0 && full?.outcome === 'plan-full' && b.r.combined.length === GLOBAL_PLAN_CAP && b.messages.includes('Planner rule placement R2: not placed, the plan is at its cap of 20 and every planned scenario cites a rule'), JSON.stringify([b.calls.length, full]));

  // The call budget: six uncited rules that each fit a page, five calls.
  const six: RequirementsMap = { ...MAP, features: [{ name: 'catalogue', description: '', rules: Array.from({ length: 6 }, (_, i) => ({ id: `R4${i}`, type: 'behavior' as const, text: `Typing term ${i} in the search box shows matching products.` })) }] };
  const callsB: PlaceRuleArgs[] = [];
  const rb = await planAcrossPages({ targets: [home], planFn: async () => emptyPlan([], PAGES[5]!.snapshot), onMessage: () => {}, map: six, placeRule: placeRule(callsB) });
  check(`C21. at most ${RULE_PLACEMENT_CAP} placement calls per run; the sixth rule is recorded as not tried`,
    RULE_PLACEMENT_CAP === 5 && callsB.length === 5 && rb.rulePlacements.length === 6 && rb.rulePlacements[5]?.outcome === 'no-budget'
    && !!rb.rulePlacements[5] && rulePlacementLine(rb.rulePlacements[5]) === 'Planner rule placement R45: not tried, the placement budget of 5 calls is spent'
    && placementDetails(rb.rulePlacements).R45 === 'placement not tried: the budget of 5 calls was spent', JSON.stringify(rb.rulePlacements.map((p) => p.outcome)));
}

/* ─── E. rule coverage ────────────────────────────────────────────────────── */
{
  const small: RequirementsMap = { ...MAP, features: [MAP.features[0]!] };
  const r5name = 'clicked a product and landed on its detail page with matching name and price';
  const planned: PlannedScenario[] = [
    line('catalogue', 'happy', ['R4'], 'sorted products by price low to high and the list reordered by ascending price'),
    line('catalogue', 'happy', ['R3'], 'checked the "Hammer" category filter and only hammer products remained in the list'),
    line('catalogue', 'happy', ['R5'], r5name),
  ];
  // Run 9's shape: R5's only scenario was skipped on /rentals. The reason is the kind the Explorer wrote there, longer than the cut.
  const skipReason = 'The /rentals page on this build has no product cards (zero products listed), so there is no product to click and no listing name or price to compare with a detail page; the scenario cannot be expressed on this page at all.';
  const before = computeRuleCoverage({ map: small, planned, scenarios: [] });
  const u = (c: ReturnType<typeof computeRuleCoverage>, id: string) => c.uncovered.find((x) => x.ruleId === id);
  check('E1. without the skip list a skipped rule read planned-but-dropped with no detail (the run 9 report)', u(before, 'R5')?.reason === 'planned-but-dropped' && u(before, 'R5')?.detail === undefined, JSON.stringify(u(before, 'R5')));
  // The Explorer echoed the name with a small rephrase: matched by key, never exact text.
  const skipped = [{ scenario: 'Clicked a product and landed on its detail page, with matching name and price.', reason: skipReason }];
  const now = computeRuleCoverage({ map: small, planned, scenarios: [], skipped });
  check('E2. with it the rule reads planned-but-skipped and carries the recorded reason, cut at 160 characters with a mark',
    u(now, 'R5')?.reason === 'planned-but-skipped' && u(now, 'R5')?.detail === `${JSON.stringify(r5name)} skipped: ${skipReason.slice(0, 160)}…`, JSON.stringify(u(now, 'R5')));
  check('E3. the console line carries it', renderRuleCoverage(now).some((l) => l.startsWith(`    • R5 (planned-but-skipped: ${JSON.stringify(r5name)} skipped: The /rentals page on this build has no product cards`)), renderRuleCoverage(now).join('\n'));
  const finding = computeRuleCoverage({ map: small, planned, scenarios: [], findings: [{ scenario: planned[0]!.name, kind: 'product' }] });
  check('E4. a rule whose test ended as a product finding reads finding-recorded and names the scenario',
    u(finding, 'R4')?.reason === 'finding-recorded' && u(finding, 'R4')?.detail === `the expected outcome did not occur on the page; product behavior to review: ${JSON.stringify(planned[0]!.name)}`, JSON.stringify(u(finding, 'R4')));
  const locator = computeRuleCoverage({ map: small, planned, scenarios: [], findings: [{ scenario: planned[0]!.name, kind: 'locator' }] });
  check('E5. an element the agent could not find is never read as a finding on the rule: planned-but-dropped, saying so',
    u(locator, 'R4')?.reason === 'planned-but-dropped' && u(locator, 'R4')?.detail === `the agent could not find an element: ${JSON.stringify(planned[0]!.name)}`, JSON.stringify(u(locator, 'R4')));
  const both = computeRuleCoverage({ map: small, planned: [...planned, line('catalogue', 'happy', ['R5'], 'opened a product from the list and compared its price')], scenarios: [], skipped, dropReasons: new Map([['opened a product from the list and compared its price', 'critic reject: weak assertion']]) });
  check('E6. a real drop beside a skip stays planned-but-dropped with the drop cause', u(both, 'R5')?.reason === 'planned-but-dropped' && u(both, 'R5')?.detail === 'critic reject', JSON.stringify(u(both, 'R5')));
  const shipped = computeRuleCoverage({ map: small, planned, scenarios: [{ name: r5name, ruleIds: ['R5'] }], skipped });
  check('E7. a shipped test still covers the rule whatever the skip list says', shipped.covered.some((c) => c.ruleId === 'R5'));
  const placed = computeRuleCoverage({ map: small, planned, scenarios: [], placements: { R2: 'no planned page fits: names search which the page snapshot does not show (/category/hand-tools, /rentals)' } });
  check('E8. a rule no planned page fits reads not-planned with what no page shows',
    u(placed, 'R2')?.reason === 'not-planned' && u(placed, 'R2')?.detail === 'no planned page fits: names search which the page snapshot does not show (/category/hand-tools, /rentals)' && u(placed, 'R1')?.detail === undefined, JSON.stringify(u(placed, 'R2')));
  const same = computeRuleCoverage({ map: small, planned, scenarios: [], skipped: [], findings: [], placements: {} });
  check('E9. with nothing skipped, found or placed the classification is unchanged', JSON.stringify(same) === JSON.stringify(before));
  check('E10. the index keeps the coarse status for both new reasons', UNCOVERED_STATUS['planned-but-skipped'] === 'planned_but_dropped' && UNCOVERED_STATUS['finding-recorded'] === 'planned_but_dropped');

  // The checkpoint carries the placements, so a resumed report has them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-rule-placement-cp-'));
  const placements: RulePlacement[] = [{ ruleId: 'R2', feature: 'catalogue', pageUrl: `${H}/`, outcome: 'planned', scenario: PLACED.R2!, costUsd: 0.002 }];
  const cpFile = writeCheckpoint(dir, { version: CHECKPOINT_VERSION, url: `${H}/`, flags: { lang: 'ts', pom: true, features: [], discover: true, urls: [] }, plan: planned, planTrimmed: [], rulePlacements: placements, fillableFields: 0, completedScenarios: [], spentUsd: { explorer: 0, planner: 0, critic: 0, repair: 0 }, phase: 'plan' } as never);
  const back = loadCheckpoint(cpFile);
  check('E11. the checkpoint round-trips the placements', JSON.stringify((back as { rulePlacements?: RulePlacement[] }).rulePlacements) === JSON.stringify(placements), JSON.stringify((back as { rulePlacements?: unknown }).rulePlacements));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── the served site for D, F and G ──────────────────────────────────────── */
const card = (name: string, price: string | null, id: string): string => `<a class="card" data-test="product-${id}" href="/product/${id}"><img src="/p.png" alt="${name}"><h5 data-test="product-name">${name}</h5>${price ? `<span data-test="product-price">$${price}</span>` : ''}</a>`;
const shell = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a> <a href="/category/hand-tools">Hand Tools</a> <a href="/rentals">Rentals</a></nav><main>${body}</main></body></html>`;
const SITE: Record<string, string> = {
  '/': shell('Toolshop', `<h1>Toolshop</h1><form role="search"><input type="search" id="search-query" placeholder="Search" data-test="search-query"><button type="submit" data-test="search-submit">Search</button></form><label>Sort <select data-test="sort"><option>Name (A - Z)</option><option>Price (Low - High)</option></select></label><div class="list">${card('Combination Pliers', '14.15', '1')}${card('Claw Hammer', '11.48', '2')}</div>`),
  '/category/hand-tools': shell('Hand Tools', `<h2>Category: Hand Tools</h2><label>Sort <select data-test="sort"><option>Name (A - Z)</option><option>Price (Low - High)</option></select></label><fieldset><legend>Filters</legend><label><input type="checkbox" data-test="category-hammer"> Hammer</label></fieldset><div class="list">${card('Combination Pliers', '14.15', '1')}${card('Claw Hammer', '11.48', '2')}</div>`),
  '/rentals': shell('Rentals', `<h2>Rentals</h2><div class="list">${card('Excavator', null, '9')}${card('Bulldozer', null, '8')}</div>`),
};
const server = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0]!;
  if (p === '/robots.txt') { res.writeHead(404); res.end(); return; }
  const html = SITE[p];
  if (!html) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const DASH = '—';
const planText = (lines: string[]): string => `<plan>\n${lines.map((l, i) => `${i + 1}. ${l.replaceAll(' — ', ` ${DASH} `)}`).join('\n')}\n</plan>`;
const USAGE = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const message = (text: string): Anthropic.Message => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: stageModel('planner'), content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE } as unknown as Anthropic.Message);
const CATALOGUE: RequirementsMap = { ...MAP, features: [{ ...MAP.features[0]!, rules: MAP.features[0]!.rules.filter((r) => ['R1', 'R2', 'R4', 'R5'].includes(r.id)) }] };
const HOME_PLAN = ['[catalogue][happy][-] opened the shop and saw the heading — the entry page'];
const CATEGORY_PLAN = [
  '[catalogue][happy][R4] sorted products by price low to high and the list reordered by ascending price — fails if the sort breaks',
  '[catalogue][happy][R2] searched for pliers and results showed only matching product names — fails if search breaks',
];
const RENTALS_PLAN = ['[catalogue][happy][R5] clicked a product and landed on its detail page with matching name and price — fails if the detail differs'];
const PLACE_LINE: Record<string, string> = {
  R1: `[catalogue][happy][R1] ${PLACED.R1} — fails if the list is empty`,
  R2: `[catalogue][happy][R2] ${PLACED.R2} — fails if search breaks`,
  R5: `[catalogue][happy][R5] ${PLACED.R5} — fails if the detail differs`,
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  const page = await ctx.newPage();
  const snapshotOf = async (p: string): Promise<PageSnapshot> => { await page.goto(`${base}${p}`); return snapshotPage(page); };
  const homeSnap = await snapshotOf('/');
  const categorySnap = await snapshotOf('/category/hand-tools');
  const rentalsSnap = await snapshotOf('/rentals');
  check('F0. the real snapshots: a search box and prices on the home page, no search box on the category page, no price on /rentals',
    homeSnap.flags.hasSearch && homeSnap.flags.hasPrice && !categorySnap.flags.hasSearch && categorySnap.flags.hasPrice && categorySnap.flags.hasSort && !rentalsSnap.flags.hasPrice && !rentalsSnap.flags.hasSearch,
    JSON.stringify([homeSnap.flags, categorySnap.flags, rentalsSnap.flags]));

  /* ─── D. the one-rule call ──────────────────────────────────────────────── */
  {
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client = (text: string) => ({ messages: { create: async (params: Anthropic.MessageCreateParamsNonStreaming) => { requests.push(params); return message(text); } } });
    const rule = ruleOf('R2');
    const feature = featureOf('R2');
    const ok = await planRuleOnPage({ url: `${base}/`, snapshot: homeSnap, rule, feature, map: MAP, client: client(planText([PLACE_LINE.R2!])) as never, apiKey: 'fixture' });
    const req = requests[0]!;
    const system = (req.system as Anthropic.TextBlockParam[]).map((b) => b.text);
    const user = String(req.messages[0]!.content);
    check('D1. the call returns the scenario, citing the rule', ok.outcome === 'planned' && ok.added?.name === PLACED.R2 && JSON.stringify(ok.added?.ruleIds) === '["R2"]' && ok.added?.feature === 'catalogue', JSON.stringify(ok));
    check('D2. it sends the cached planner prompt first and a requirements block holding this one rule only',
      system.length === 2 && (req.system as Array<{ cache_control?: unknown }>)[0]!.cache_control !== undefined && system[1]!.includes(rule.text) && !system[1]!.includes(ruleOf('R1').text) && !system[1]!.includes(ruleOf('R10').text), system[1]!.slice(0, 300));
    check('D3. the ask names the rule, the page and the feature tag, after the page snapshot',
      user.includes(rulePlacementAsk(rule, feature, `${base}/`)) && user.indexOf('Page snapshot:') < user.indexOf('Plan ONE scenario verifying rule R2') && user.includes('"hasSearch": true') && !/contradicted/.test(rulePlacementAsk(rule, feature, `${base}/`)), user.slice(-400));
    check('D4. the cost is the planner model\'s price for the call', ok.costUsd === costOf(stageModel('planner'), USAGE) && ok.costUsd > 0, String(ok.costUsd));
    const noId = await planRuleOnPage({ url: `${base}/`, snapshot: homeSnap, rule, feature, map: MAP, client: client(planText([`[catalogue][happy][-] ${PLACED.R2} — fails if search breaks`])) as never, apiKey: 'fixture' });
    check('D5. a line that omits the rule id gets it', JSON.stringify(noId.added?.ruleIds) === '["R2"]', JSON.stringify(noId.added));
    const wrongPage = await planRuleOnPage({ url: `${base}/category/hand-tools`, snapshot: categorySnap, rule, feature, map: MAP, client: client(planText([PLACE_LINE.R2!])) as never, apiKey: 'fixture' });
    check('D6. the returned scenario is judged by page fit on its own name: a search test on a page with no search box is rejected',
      wrongPage.outcome === 'rejected' && wrongPage.added === undefined && wrongPage.reason === 'names search which the page snapshot does not show' && wrongPage.costUsd > 0, JSON.stringify(wrongPage));
    const scope = await planRuleOnPage({ url: `${base}/category/hand-tools`, snapshot: categorySnap, rule: ruleOf('R1'), feature, map: MAP, client: client(planText(['[catalogue][happy][R1] saw products with a name, an image and a price — fails if the list is empty'])) as never, apiKey: 'fixture' });
    check('D7. and by the page a rule names: the home-page rule on the category page is rejected', scope.outcome === 'rejected' && /cannot verify R1: the rule names the home page/.test(scope.reason ?? ''), JSON.stringify(scope));
    const negative = await planRuleOnPage({ url: `${base}/`, snapshot: homeSnap, rule, feature, map: MAP, client: client(planText([`[catalogue][negative][R2] ${PLACED.R2} — fails if search breaks`])) as never, apiKey: 'fixture' });
    check('D8. and by its category: a negative scenario cannot verify a rule that states no rejection', negative.outcome === 'rejected' && negative.added === undefined, JSON.stringify(negative));
    const none = await planRuleOnPage({ url: `${base}/`, snapshot: homeSnap, rule, feature, map: MAP, client: client('I cannot plan this.') as never, apiKey: 'fixture' });
    check('D9. an answer with no plan line is recorded as none, with its cost', none.outcome === 'none' && none.added === undefined && none.reason === 'the call returned no parseable scenario' && none.costUsd > 0, JSON.stringify(none));
  }

  /* ─── F. three served pages, the real plan() and the real call ──────────── */
  {
    // The fixture client answers by what the request asks: a placement ask by its rule, a page plan by its URL.
    const asked: string[] = [];
    const client = { messages: { create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      const user = String(params.messages[0]!.content);
      const placement = /Plan ONE scenario verifying rule (R\d+) on this page \((\S+)\)/.exec(user);
      if (placement) { asked.push(`place ${placement[1]} ${placement[2]!.replace(base, '')}`); return message(planText([PLACE_LINE[placement[1]!]!])); }
      const url = /^URL: (\S+)/.exec(user)?.[1] ?? '';
      asked.push(`plan ${url.replace(base, '')}`);
      return message(planText(url.endsWith('/rentals') ? RENTALS_PLAN : url.endsWith('/hand-tools') ? CATEGORY_PLAN : HOME_PLAN));
    } } };
    // The tags run 9's page filter gave: the home page is "cart", so its call is offered no catalogue rule.
    const withCart: RequirementsMap = { ...CATALOGUE, features: [...CATALOGUE.features, { name: 'cart', description: '', rules: [] }] };
    const targets: PlanTarget[] = [
      { page: { url: `${base}/category/hand-tools`, feature: 'catalogue', source: 'browser-crawl' } as PlanTarget['page'], requirements: CATALOGUE, features: ['catalogue'] },
      { page: { url: `${base}/rentals`, feature: 'catalogue', source: 'browser-crawl' } as PlanTarget['page'], requirements: CATALOGUE, features: ['catalogue'] },
      { page: { url: `${base}/`, feature: 'cart', source: 'browser-crawl' } as PlanTarget['page'], requirements: { ...withCart, features: withCart.features.filter((f) => f.name === 'cart') }, features: ['cart'] },
    ];
    const messages: string[] = [];
    const r = await planAcrossPages({
      targets,
      planFn: (a) => plan({ ...a, client: client as never, apiKey: 'fixture' }),
      onMessage: (m) => messages.push(m),
      map: withCart,
      placeRule: (a) => planRuleOnPage({ ...a, map: withCart, client: client as never, apiKey: 'fixture' }),
    });
    console.log('\n--- F: the planner lines ---');
    for (const m of messages) console.log(m.replaceAll(base, '<site>'));
    console.log('---');
    const at = (id: string) => r.combined.find((s) => (s.ruleIds ?? []).includes(id));
    check('F1. page fit drops the search test on the category page and the same-price test on /rentals, as runs 9 and 10 planned them',
      messages.some((m) => m.startsWith('Rejected page-fit scenario: "searched for pliers and results showed only matching product names"') && m.includes('names search which the page snapshot does not show'))
      && messages.some((m) => m.startsWith('Rejected page-fit scenario: "clicked a product and landed on its detail page with matching name and price"') && m.includes('shows no price to compare')),
      messages.filter((m) => m.startsWith('Rejected')).join(' | '));
    check('F2. the calls: three page plans, then R1 and R2 on the home page and R5 on the category page',
      JSON.stringify(asked) === JSON.stringify(['plan /category/hand-tools', 'plan /rentals', 'plan /', 'place R1 /', 'place R2 /', 'place R5 /category/hand-tools']), JSON.stringify(asked));
    check('F3. R2, the rule no run tested, is planned on the page that has the search box',
      at('R2')?.pageUrl === `${base}/` && at('R2')?.feature === 'catalogue' && at('R2')?.name === PLACED.R2, JSON.stringify(at('R2')));
    check('F4. R1 is planned on the home page and R5 on a page that shows prices', at('R1')?.pageUrl === `${base}/` && at('R5')?.pageUrl === `${base}/category/hand-tools`, JSON.stringify([at('R1'), at('R5')]));
    check('F5. every rule of the feature is cited by a planned scenario on a page that fits it', ['R1', 'R2', 'R4', 'R5'].every((id) => !!at(id)) && r.rulePlacements.every((p) => p.outcome === 'planned'), JSON.stringify(r.rulePlacements));
  }
  await ctx.close();

  /* ─── G. a whole run ────────────────────────────────────────────────────── */
  {
    const tool = (name: string, input: Record<string, unknown>): FakeContent[] => [{ type: 'tool_use', name, input }];
    const skipWhy = 'fixture run: the smoke checks planning, so no scenario is recorded';
    const names = ['opened the shop and saw the heading', 'sorted products by price low to high and the list reordered by ascending price', PLACED.R1!, PLACED.R2!, PLACED.R5!];
    const explorer: FakeContent[][] = [...names.map((n) => tool('skip_scenario', { name: n, reason: skipWhy })), tool('finish', { summary: 'done' })];
    // The planner calls in order: "/", the category page, /rentals, then the placements in rule order.
    const api = await startFakeAnthropic({
      planner: [planText(HOME_PLAN), planText(CATEGORY_PLAN), planText(RENTALS_PLAN), planText([PLACE_LINE.R1!]), planText([PLACE_LINE.R2!]), planText([PLACE_LINE.R5!])],
      explorer,
      critic: [],
    });
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('QA_CORE_TEST_'))) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.ANTHROPIC_BASE_URL = api.baseUrl;
    process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-rule-placement-run-'));
    const agentCwd = process.cwd();
    process.chdir(outDir);
    const runMessages: string[] = [];
    try {
      const { explore } = await import('../src/agent/runtime.js');
      let report: RunReport | undefined;
      let thrown = '';
      try {
        report = await explore({
          url: `${base}/`, language: 'ts', outDir, requirements: CATALOGUE, requirementsUsd: 0,
          urls: [`${base}/`, `${base}/category/hand-tools`, `${base}/rentals`],
          skipCritic: true, skipStability: true, stabilize: false,
          onEvent: (e) => { if (e.type === 'message') runMessages.push(e.text); },
        }) as RunReport;
      } catch (err) { thrown = (err as Error).message; }
      console.log('\n--- G run: the planner lines ---');
      for (const m of runMessages.filter((x) => x.startsWith('Planner') || x.startsWith('Rejected') || x.startsWith('discovery:'))) console.log(m.replaceAll(base, '<site>'));
      console.log('---');
      check('G0. the run ended with a report', !!report && thrown === '', thrown);
      const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'run-report.json'), 'utf8')) as RunReport;
      check('G1. every scripted call was made and every tool call returned ok (standing rule 7)',
        api.toolErrors.length === 0 && api.calls.planner === 6 && api.calls.explorer === explorer.length && api.calls.other === 0, JSON.stringify({ errors: api.toolErrors, calls: api.calls }));
      const planned = (id: string) => (onDisk.plan ?? []).find((p) => (p.ruleIds ?? []).includes(id));
      // No page carries a tag on a --urls run, so R5 takes the first page in plan order that shows prices: the home page.
      check('G2. the report\'s plan holds R1, R2 and R5 on the home page, the first page in plan order that fits each',
        planned('R2')?.pageUrl === `${base}/` && planned('R1')?.pageUrl === `${base}/` && planned('R5')?.pageUrl === `${base}/` && (onDisk.plan ?? []).length === 5, JSON.stringify((onDisk.plan ?? []).map((p) => [p.pageUrl, p.ruleIds, p.name])));
      check('G3. run-report.json records the three placements, with page, scenario and cost',
        JSON.stringify((onDisk.rulePlacements ?? []).map((p) => [p.ruleId, p.outcome, (p.pageUrl ?? '').replace(base, ''), p.scenario])) === JSON.stringify([['R1', 'planned', '/', PLACED.R1], ['R2', 'planned', '/', PLACED.R2], ['R5', 'planned', '/', PLACED.R5]])
        && (onDisk.rulePlacements ?? []).every((p) => p.costUsd > 0), JSON.stringify(onDisk.rulePlacements));
      check('G4. the console printed each placement line whole', runMessages.some((m) => m.startsWith(`Planner rule placement R2 on ${base}/: planned "${PLACED.R2}" · $`)), runMessages.filter((m) => m.includes('placement')).join(' | '));
      const placementCost = (onDisk.rulePlacements ?? []).reduce((n, p) => n + p.costUsd, 0);
      check('G5. the planner cost on the report includes the placement calls', (onDisk.cost.plannerUsd ?? 0) >= placementCost && placementCost > 0, JSON.stringify([onDisk.cost.plannerUsd, placementCost]));
      const unc = onDisk.ruleCoverage?.uncovered ?? [];
      check('G6. every scenario was skipped, and each rule says so with the recorded reason, never planned-but-dropped',
        unc.length === 4 && unc.every((u) => u.reason === 'planned-but-skipped' && (u.detail ?? '').endsWith(`skipped: ${skipWhy}`)), JSON.stringify(unc.map((u) => [u.ruleId, u.reason, u.detail])));
      check('G7. the funnel balances with five skipped', onDisk.reconciliation?.balanced === true && onDisk.reconciliation.skipped.length === 5 && onDisk.reconciliation.planned === 5, JSON.stringify(onDisk.reconciliation && { p: onDisk.reconciliation.planned, s: onDisk.reconciliation.skipped.length, b: onDisk.reconciliation.balanced }));
    } finally {
      process.chdir(agentCwd);
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      await api.close();
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  server.close();
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('OK: a rule no page cited is planned on a page that shows what it needs: the search rule and the home-page rule land on the home page, the same-price rule on a page with prices and never on one without, at most five calls a run, a full plan gives up only a scenario with no rule, and a skipped or failed test says so in rule coverage.');
