/**
 * Locks the citation page check (D8a, src/agent/rule-scope.ts): a rule that
 * names a page or form is credited only to a scenario planned on a page that
 * carries it by page evidence (path segments or an h1 heading). Run 9
 * (b4e41b) credited R12, a registration-form rule, to two login-form tests,
 * and R1, a home-page rule, to a price sort on a category page.
 *
 * A: the run 9 map and plan, judged page by page through applyCitationChecks.
 * B: the reason text, the any-place rule, h1 evidence, unknown words, and
 *    a scenario whose own name goes to the place (a click-through).
 * C: a rule retry is judged by the same check.
 * D: plan() on a served login page with a fixture client drops the R12
 *    citations and keeps R10, end to end.
 * E: the run 9 coverage moves: R1 uncovered, R12 still covered by the
 *    registration tests, nothing else changes.
 *
 * $0: a fixture client, a local page, no network.
 */
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { applyCitationChecks, plan, retryUncoveredRules, snapshotPage, type PlannedScenario } from '../src/agent/planner.js';
import { namedPlaces, pageScopeMismatchReason } from '../src/agent/rule-scope.js';
import { computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

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
} as unknown as RequirementsMap;

// Run 9's plan (run-report.json plan[]): the page each scenario tests on is
// reachedBy.pageUrl when set, else pageUrl. Only scenarios that cite a rule.
type Row = { page: string; s: PlannedScenario };
const sc = (category: string, feature: string, ruleIds: string[], name: string): PlannedScenario => ({ category, feature, ruleIds, name } as PlannedScenario);
const RUN9: Row[] = [
  { page: `${H}/category/hand-tools`, s: sc('happy', 'catalogue', ['R1', 'R4'], 'sorted products by price low to high and the list reordered by ascending price') },
  { page: `${H}/category/hand-tools`, s: sc('happy', 'catalogue', ['R3'], 'checked the "Hammer" category filter and only hammer products remained in the list') },
  { page: `${H}/product/01M7MP2XWJ4A5AWC8SAEJSP4M8`, s: sc('happy', 'cart', ['R6'], 'added product to cart from detail page and cart count badge increased') },
  { page: `${H}/checkout`, s: sc('happy', 'cart', ['R7', 'R8'], 'added item to cart, opened checkout, changed quantity and line total updated') },
  { page: `${H}/checkout`, s: sc('edge', 'cart', ['R9'], 'added item to cart, opened checkout, removed the product row and total recalculated to zero') },
  { page: `${H}/contact`, s: sc('negative', 'contact', ['R13'], 'rejected submission when message field is empty') },
  { page: `${H}/contact`, s: sc('negative', 'contact', ['R14'], 'rejected an email address without an @ sign') },
  { page: `${H}/auth/login`, s: sc('negative', 'account', ['R10'], 'rejected login with wrong password and stayed on login page') },
  { page: `${H}/auth/login`, s: sc('edge', 'account', ['R12'], 'submitted login form with empty email field and saw required-field error') },
  { page: `${H}/auth/login`, s: sc('edge', 'account', ['R12'], 'submitted login form with empty password field and saw required-field error') },
  { page: `${H}/auth/register`, s: sc('negative', 'account', ['R11'], 'rejected registration with an already-used email address') },
  { page: `${H}/auth/register`, s: sc('negative', 'account', ['R12'], 'rejected registration with an empty first name field') },
  { page: `${H}/auth/register`, s: sc('edge', 'account', ['R12'], 'rejected registration with an empty email field') },
  { page: `${H}/rentals`, s: sc('happy', 'catalogue', ['R5'], 'clicked a product and landed on its detail page with matching name and price') },
];

/* ─── A. run 9, page by page ─────────────────────────────────────────────── */
const after: PlannedScenario[] = [];
const drops: Array<{ scenario: string; ruleId: string; reason: string }> = [];
for (const row of RUN9) {
  const r = applyCitationChecks([row.s], MAP, { url: row.page });
  after.push(...r.scenarios);
  drops.push(...r.citationDrops);
}
const ids = (name: string): string => JSON.stringify(after.find((s) => s.name === name)?.ruleIds);
check('A1. the price sort on /category/hand-tools loses R1 (the home page) and keeps R4', ids(RUN9[0]!.s.name) === '["R4"]', ids(RUN9[0]!.s.name));
check('A2. both login-form tests on /auth/login lose R12 (the registration form)', ids(RUN9[8]!.s.name) === '[]' && ids(RUN9[9]!.s.name) === '[]', `${ids(RUN9[8]!.s.name)} ${ids(RUN9[9]!.s.name)}`);
check('A3. the two registration tests on /auth/register keep R12', ids(RUN9[11]!.s.name) === '["R12"]' && ids(RUN9[12]!.s.name) === '["R12"]');
check('A4. R10 (stays on the login page) is kept on /auth/login', ids(RUN9[7]!.s.name) === '["R10"]');
check('A5. R7 and R8 (the cart page) are kept on /checkout, which the cart tokens carry', ids(RUN9[3]!.s.name) === '["R7","R8"]');
check('A6. R13 and R14 (the contact form) are kept on /contact', ids(RUN9[5]!.s.name) === '["R13"]' && ids(RUN9[6]!.s.name) === '["R14"]');
check('A7. "its detail page" is never judged: R5 on /rentals and R6 on a product page keep their citations', ids(RUN9[13]!.s.name) === '["R5"]' && ids(RUN9[2]!.s.name) === '["R6"]');
check('A8. R3, R9 and R11 keep their citations', ids(RUN9[1]!.s.name) === '["R3"]' && ids(RUN9[4]!.s.name) === '["R9"]' && ids(RUN9[10]!.s.name) === '["R11"]');
check('A9. exactly three citations are dropped, every scenario survives', drops.length === 3 && after.length === RUN9.length, JSON.stringify(drops));
check('A10. without a page the check runs as before (category only)', JSON.stringify(applyCitationChecks([RUN9[8]!.s], MAP).scenarios[0]?.ruleIds) === '["R12"]');

/* ─── B. the reason text and the edges ───────────────────────────────────── */
const r12 = MAP.features[2]!.rules[2]!.text;
check('B1. the reason names the place and the planned path', pageScopeMismatchReason(r12, { url: `${H}/auth/login` }) === 'the rule names the registration form and this scenario is planned on /auth/login, which does not carry it by page evidence', String(pageScopeMismatchReason(r12, { url: `${H}/auth/login` })));
check('B2. the drop carries that reason for the log line', drops.some((d) => d.ruleId === 'R12' && d.reason === pageScopeMismatchReason(r12, { url: `${H}/auth/login` })));
check('B3. the home page is the root path ("/", "/home", "/index.html")', pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/` }) === null && pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/home` }) === null && pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/index.html` }) === null && pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/category/x` }) !== null);
const redirect = 'Registration with valid details redirects to the login page.';
check('B4. a place named only as the destination is not judged: "redirects to the login page" is kept on /auth/register', namedPlaces(redirect).length === 0 && pageScopeMismatchReason(redirect, { url: `${H}/auth/register` }) === null);
const both = 'Submitting the registration form redirects to the login page.';
check('B5. "the registration form ... redirects to the login page" judges the form only: kept on /auth/register, dropped on /auth/login', namedPlaces(both).length === 1 && pageScopeMismatchReason(both, { url: `${H}/auth/register` }) === null && /registration form and this scenario is planned on \/auth\/login/.test(String(pageScopeMismatchReason(both, { url: `${H}/auth/login` }))));
const twoPlaces = 'The login page and the sign-up page both show the site logo.';
check('B5b. two places named where the test runs: either page is enough, the reason names both', namedPlaces(twoPlaces).length === 2 && pageScopeMismatchReason(twoPlaces, { url: `${H}/auth/login` }) === null && pageScopeMismatchReason(twoPlaces, { url: `${H}/signup` }) === null && /registration form or the login page/.test(String(pageScopeMismatchReason(twoPlaces, { url: `${H}/contact` }))), String(pageScopeMismatchReason(twoPlaces, { url: `${H}/contact` })));
check('B5c. "stays on the login page" is where the test runs and is judged (R10 dropped on /contact)', pageScopeMismatchReason(MAP.features[2]!.rules[0]!.text, { url: `${H}/contact` }) !== null);
check('B6. an h1 heading carries the place when the path does not (/customer/new with h1 "Register")', pageScopeMismatchReason(r12, { url: `${H}/customer/new`, h1: ['Register'] }) === null && pageScopeMismatchReason(r12, { url: `${H}/customer/new`, h1: ['Welcome'] }) !== null);
check('B7. a rule that names no known place is never judged', pageScopeMismatchReason('Sorting by price low to high orders the visible products by ascending price.', { url: `${H}/anything` }) === null && namedPlaces('Clicking a product opens its detail page.').length === 0);
check('B8. sign up, log in, password reset and checkout pages are read', namedPlaces('The sign-up form ...')[0]?.feature === 'registration' && namedPlaces('The log in page ...')[0]?.feature === 'login' && namedPlaces('The password reset page ...')[0]?.feature === 'password-recovery' && namedPlaces('The checkout page ...')[0]?.feature === 'checkout');
check('B9. /signup carries the registration form; /auth/forgot-password carries the password reset page', pageScopeMismatchReason(r12, { url: `${H}/signup` }) === null && pageScopeMismatchReason('The password reset page accepts an email.', { url: `${H}/auth/forgot-password` }) === null);

/* ─── B10. the scenario's own name can carry the place (click-through) ──── */
const r7 = MAP.features[1]!.rules[1]!.text;
check('B10. on "/" a scenario named "opened the cart page from the header ..." keeps R7 (the cart page); the page alone does not', pageScopeMismatchReason(r7, { url: `${H}/` }, 'opened the cart page from the header and it listed the added product with its line total') === null && pageScopeMismatchReason(r7, { url: `${H}/` }) !== null);
check('B11. a feature token as a whole word is enough ("... and opened the cart"); a substring is not ("cartography")', pageScopeMismatchReason(r7, { url: `${H}/` }, 'added an item and opened the cart, which listed it') === null && pageScopeMismatchReason(r7, { url: `${H}/` }, 'browsed the cartography section') !== null);
check('B12. the home page needs its phrase in the name: "opened the home page and saw ..." keeps R1, the price sort does not', pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/category/x` }, 'opened the home page and saw products with a name, image and price') === null && pageScopeMismatchReason(MAP.features[0]!.rules[0]!.text, { url: `${H}/category/x` }, RUN9[0]!.s.name) !== null);
check('B13. the run 9 login-test names never name registration, so R12 still goes', pageScopeMismatchReason(r12, { url: `${H}/auth/login` }, RUN9[8]!.s.name) !== null && pageScopeMismatchReason(r12, { url: `${H}/auth/login` }, RUN9[9]!.s.name) !== null);

/* ─── C. the retry is judged by the same check ───────────────────────────── */
{
  let asks = 0;
  const budget = { remaining: 5 };
  const retry = await retryUncoveredRules({
    dropped: [sc('negative', 'account', ['R12'], 'a contradiction on the login page')],
    kept: [],
    map: MAP,
    budget,
    ask: async () => { asks += 1; return { text: '<plan>\n1. [account][negative][R12] submitted login form with an empty email and saw a required-field error — fails if it is accepted\n</plan>', costUsd: 0.001 }; },
    pageScope: (rule, scenario) => pageScopeMismatchReason(rule.text, { url: `${H}/auth/login` }, scenario.name),
  });
  check('C1. the retry asks once and adds nothing', asks === 1 && budget.remaining === 4 && retry.added.length === 0, JSON.stringify({ asks, budget, added: retry.added.length }));
  check('C2. the retry is recorded rejected with the page reason and its cost', retry.retries.length === 1 && retry.retries[0]!.outcome === 'rejected' && retry.retries[0]!.costUsd === 0.001 && /^this scenario cannot verify R12: the rule names the registration form/.test(retry.retries[0]!.reason ?? ''), JSON.stringify(retry.retries));
  let asks2 = 0;
  const retry2 = await retryUncoveredRules({
    dropped: [sc('negative', 'account', ['R12'], 'a contradiction on the register page')],
    kept: [],
    map: MAP,
    budget: { remaining: 5 },
    ask: async () => { asks2 += 1; return { text: '<plan>\n1. [account][negative][R12] rejected registration with an empty last name — fails if it is accepted\n</plan>', costUsd: 0.001 }; },
    pageScope: (rule, scenario) => pageScopeMismatchReason(rule.text, { url: `${H}/auth/register` }, scenario.name),
  });
  check('C3. on /auth/register the same rule is asked for and planned', asks2 === 1 && retry2.added.length === 1, JSON.stringify(retry2.retries));
}

/* ─── D. plan() on a served login page ──────────────────────────────────── */
{
  const PLAN = '<plan>\n'
    + '1. [account][negative][R10] rejected login with wrong password and stayed on login page — fails if the login succeeds\n'
    + '2. [account][edge][R12] submitted login form with empty email field and saw required-field error — fails if no error shows\n'
    + '3. [account][edge][R12] submitted login form with empty password field and saw required-field error — fails if no error shows\n'
    + '</plan>';
  const message = { id: 'm', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: PLAN, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } } as unknown as Anthropic.Message;
  const client = { messages: { create: async () => message } };
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    await page.setContent('<!doctype html><html><head><title>Login</title></head><body><main><h3>Login</h3><form><label for="email">Email address</label><input id="email" type="email"><label for="password">Password</label><input id="password" type="password"><button type="submit">Login</button></form></main></body></html>', { waitUntil: 'load' });
    const snapshot = await snapshotPage(page);
    const r = await plan({ url: `${H}/auth/login`, snapshot, client: client as never, apiKey: 'fixture', requirements: MAP });
    const byName = new Map(r.scenarios.map((s) => [s.name, s.ruleIds]));
    check('D1. plan() keeps all three scenarios', r.scenarios.length === 3, JSON.stringify(r.scenarios.map((s) => s.name)));
    check('D2. R10 stays, both R12 citations go', JSON.stringify(byName.get('rejected login with wrong password and stayed on login page')) === '["R10"]' && JSON.stringify(byName.get('submitted login form with empty email field and saw required-field error')) === '[]' && JSON.stringify(byName.get('submitted login form with empty password field and saw required-field error')) === '[]', JSON.stringify([...byName]));
    check('D3. citationDrops names both, with the page reason', r.citationDrops.length === 2 && r.citationDrops.every((d) => d.ruleId === 'R12' && /registration form .* \/auth\/login/.test(d.reason)), JSON.stringify(r.citationDrops));
  } finally {
    await browser.close();
  }
}

/* ─── E. the run 9 coverage ───────────────────────────────────────────────── */
{
  const before = computeRuleCoverage({ map: MAP, planned: RUN9.map((r) => r.s), scenarios: RUN9.map((r) => r.s) });
  const now = computeRuleCoverage({ map: MAP, planned: after, scenarios: after });
  const cov = (c: typeof before): string => c.covered.map((x) => x.ruleId).join(',');
  check('E1. before the check R1 and R12 read covered (the run 9 report)', cov(before) === 'R1,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12,R13,R14', cov(before));
  check('E2. after it R1 is uncovered and everything else reads as before', cov(now) === 'R3,R4,R5,R6,R7,R8,R9,R10,R11,R12,R13,R14' && now.uncovered.some((u) => u.ruleId === 'R1'), cov(now));
  const r12cov = now.covered.find((x) => x.ruleId === 'R12')?.scenarios ?? [];
  check('E3. R12 is credited to the two registration tests only', r12cov.length === 2 && r12cov.every((n) => /registration/.test(n)), JSON.stringify(r12cov));
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('OK: a rule that names a page or form is credited only on a page that carries it: run 9 loses R1 on the category sort and R12 on the two login tests, the registration tests keep R12, a scenario whose name goes to the place keeps it, and a retry is judged the same way.');
