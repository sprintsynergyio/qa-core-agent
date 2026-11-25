/**
 * Locks the login action: pages behind a sign-in (invariant 88;
 * src/agent/state-probe.ts, login-preflight.ts, plan-pages.ts, planner.ts,
 * account-safety.ts, tools.ts, auth-emit.ts, pom.ts, runtime.ts).
 *
 * Before this the agent found and tested public pages only. It signed in
 * when a scenario asked it to, and never looked for what the sign-in opens:
 * the account page, the profile, the invoices.
 *
 * The fixture site below has a public home and contact page, a login form,
 * and four pages that answer only with a session cookie: /account (where the
 * sign-in lands), /account/profile, /account/invoices and /account/messages.
 * Signed out, each of them redirects to the login page.
 *
 *   A. the probe signs in once, reads the links, and reveals the pages a
 *      requirements feature names, each reached by the sign-in and a click;
 *      a link that ends the session is never followed; the record and the
 *      lines hold no credential value
 *   B. no test account: a feature with no page whose tokens name an account
 *      page is recorded as not looked for, and its rules read not-revealed
 *      with that reason, never a quiet not-planned
 *   C. a login wall: a page the crawl found by a public link that redirects
 *      to the login page is planned once, signed in, from the probe's
 *      snapshot; a public page is never loaded to check it
 *   D. planning: the revealed page's rules go to its own call, every
 *      scenario starts on the login page, the block names the sign-in by
 *      credential marker, and a scenario that would change the account is
 *      dropped with a line
 *   E. the tools on the live site: the recording signs in by marker, the
 *      page it was on after the sign-in is stamped, a navigate to the
 *      revealed page is refused, and a new password, a new sign-in email and
 *      "Delete my account" are refused before the page is touched
 *   F. the emitted framework, run with Playwright in TS and JS: the tests
 *      behind the sign-in run on the saved session, open the stamped page,
 *      click through, and pass; a test of the page the sign-in lands on
 *      keeps its checks; without the stamp the same test fails (the red
 *      case), and the login test is the one the setup replays
 *   G. the whole run in process (explore(), a local stand-in for the
 *      Anthropic API): the preflight, the probe, the plan, the recording by
 *      marker and the replay with the env account
 *   H. no requirements map: the links that exist only after sign-in are the
 *      pages, up to the cap
 *   I. scripts/probe-login.ts as a child process: the same lines at $0, one
 *      sign-in, nothing written, no credential value printed
 *
 * No network beyond 127.0.0.1. No model call. Every runTool result is
 * checked (standing rule 7).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import type { DiscoveredPage } from '../src/agent/discovery.js';
import {
  runStateProbes,
  detectLoginFeatures,
  loginLinkLocator,
  loginLinkDenied,
  featureFromPath,
  LOGIN_PROBE_REVEAL_CAP,
  type ProbePageFactory,
} from '../src/agent/state-probe.js';
import { buildPlanTargets, planAcrossPages } from '../src/agent/plan-pages.js';
import { plan, reachedByBlock, unreachableFeatures, SIGN_IN_STEP, BEHIND_SIGN_IN_GUIDANCE, type PlannerClient } from '../src/agent/planner.js';
import { computeRuleCoverage, notRevealedFeatures } from '../src/agent/rule-coverage.js';
import { featureTokenMap, type RequirementsMap } from '../src/agent/requirements.js';
import { plannedPagesFor, reachedPagesOf } from '../src/agent/runtime.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { accountSafetyReason } from '../src/agent/account-safety.js';
import { AUTH_ENV_PASS, AUTH_ENV_USER, findHappyLoginScenario, sessionSteps, signedInAtStart } from '../src/agent/auth-emit.js';
import { CREDENTIALS_NOT_PROVIDED } from '../src/agent/test-credentials.js';
import { NO_LOGIN_PAGE_REASON } from '../src/agent/login-preflight.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';
import { startFakeAnthropic, type FakeContent } from './lib/fake-anthropic.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

// No model can be called: no key in this process, and the Planner client is a fixture.
delete process.env.ANTHROPIC_API_KEY;
for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_') || /^QA_CORE_.*MODEL/.test(k)) delete process.env[k];

const USER = 'fixture.customer@shop.test';
const PASS = 'Fixture!Pass-2026';

/* ─── the fixture site ──────────────────────────────────────────────────── */

type Variant = 'default' | 'wall' | 'robots';
const site = { variant: 'default' as Variant, hits: [] as Array<{ method: string; path: string; signedIn: boolean; ua: string }> };

const html = (title: string, signedIn: boolean, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>
<nav>
  <a href="/">Home</a>
  <a href="#" data-test="nav-categories">Categories</a>
  <a href="/contact">Contact</a>
  ${site.variant === 'wall' ? '<a href="/account/orders">Orders</a> <a href="/help-center">Support</a>' : ''}
  ${signedIn
    ? `<a href="/account" data-test="nav-account">My account</a> <a href="/auth/logout" data-test="nav-sign-out">Sign out</a>`
    : `<a href="/auth/login" data-test="nav-sign-in">Sign in</a>`}
</nav>
<main>${body}</main></body></html>`;

const accountLinks = `<a href="/account/profile" data-test="nav-profile">Profile</a>
<a href="/account/invoices" data-test="nav-invoices">Invoices</a>
<a href="/account/messages">Messages</a>`;

const readBody = (req: http.IncomingMessage): Promise<URLSearchParams> => new Promise((resolve) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => resolve(new URLSearchParams(raw)));
});

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const signedIn = /(?:^|;\s*)session=ok/.test(req.headers.cookie ?? '');
    site.hits.push({ method: req.method ?? 'GET', path: p, signedIn, ua: String(req.headers['user-agent'] ?? '') });
    const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const toLogin = (): void => send(302, '', { location: '/auth/login' });
    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(site.variant === 'robots' ? 'User-agent: *\nDisallow: /account/invoices\n' : 'User-agent: *\nDisallow:\n');
      return;
    }
    if (p === '/') return send(200, html('Shop', signedIn, '<h1>Shop</h1><p>Hand tools and more.</p>'));
    if (p === '/contact') return send(200, html('Contact', signedIn, '<h1>Contact</h1><form><label>Message <textarea id="message" name="message"></textarea></label><button id="send" type="submit">Send</button></form>'));
    if (p === '/help-center') return send(200, html('Help', signedIn, '<h1>Help center</h1><p>Answers to common questions.</p>'));
    if (p === '/auth/login' && req.method === 'POST') {
      const form = await readBody(req);
      if (form.get('email') === USER && form.get('password') === PASS) return send(302, '', { location: '/account', 'set-cookie': 'session=ok; Path=/' });
      return send(200, html('Sign in', false, `<h1>Sign in</h1><div role="alert" id="login-error">Invalid email or password</div>${loginForm}`));
    }
    if (p === '/auth/login') return send(200, html('Sign in', signedIn, `<h1>Sign in</h1>${loginForm}`));
    if (p === '/auth/logout') return send(302, '', { location: '/', 'set-cookie': 'session=; Path=/; Max-Age=0' });
    if (p.startsWith('/account')) {
      if (!signedIn) return toLogin();
      if (req.method === 'POST') return send(200, html('Saved', true, '<h1>Saved</h1>'));
      if (p === '/account') return send(200, html('My account', true, `<h1>My account</h1><p id="greeting">Welcome back, Jane</p>${accountLinks}<form method="post" action="/account/delete"><button id="delete-account" type="submit">Delete my account</button></form>`));
      if (p === '/account/profile') {
        return send(200, html('Profile', true, `<h1>Profile</h1><p id="signed-in-as">Signed in as ${USER}</p>
<form method="post" action="/account/profile">
  <label>First name <input id="first-name" name="first_name" value="Jane"></label>
  <label>Email <input id="email" type="email" name="email" value="${USER}"></label>
  <label>Current password <input id="current-password" type="password" name="current"></label>
  <label>New password <input id="new-password" type="password" name="new"></label>
  <button id="save" type="submit">Save</button>
</form>`));
      }
      if (p === '/account/invoices') return send(200, html('Invoices', true, '<h1>Invoices</h1><table><thead><tr><th>Invoice</th><th>Total</th></tr></thead><tbody><tr><td>INV-1</td><td>$12.00</td></tr></tbody></table>'));
      if (p === '/account/messages') return send(200, html('Messages', true, '<h1>Messages</h1><p>No messages.</p>'));
      if (p === '/account/orders' && site.variant === 'wall') return send(200, html('Orders', true, '<h1>Order history</h1><ul><li>Order 1001</li></ul>'));
    }
    send(404, html('Not found', signedIn, '<h1>Not found</h1>'));
  })();
});
const loginForm = `<form method="post" action="/auth/login">
  <label>Email <input id="email" type="email" name="email"></label>
  <label>Password <input id="password" type="password" name="password"></label>
  <button id="login" type="submit">Login</button>
</form>`;
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ─── the requirements ──────────────────────────────────────────────────── */

const map: RequirementsMap = {
  features: [
    { name: 'login', description: 'Signing in.', rules: [
      { id: 'R10', text: 'Signing in with a registered account opens the account page.', type: 'behavior' },
      { id: 'R11', text: 'Login with a wrong password shows the error Invalid email or password.', type: 'validation' },
    ] },
    { name: 'account', description: 'The page a signed-in customer lands on.', rules: [
      { id: 'R60', text: 'The account page greets the signed-in customer by first name.', type: 'behavior' },
    ] },
    { name: 'profile', description: 'The customer profile.', rules: [
      { id: 'R20', text: 'The profile page shows the first name of the signed-in customer.', type: 'behavior' },
      { id: 'R21', text: 'Saving the profile with an empty first name shows an error.', type: 'validation' },
    ] },
    { name: 'invoices', description: 'Invoices of the customer.', rules: [
      { id: 'R30', text: 'The invoices page lists each invoice with its total.', type: 'behavior' },
    ] },
    { name: 'orders', description: 'Past orders.', rules: [
      { id: 'R40', text: 'The order history page lists past orders.', type: 'behavior' },
    ] },
    { name: 'contact', description: 'The contact form.', rules: [
      { id: 'R50', text: 'Submitting the contact form with an empty message shows an error.', type: 'validation' },
    ] },
  ],
  roles: [],
  truncated: false,
};
const tokens = featureTokenMap(map);
const crawl = (paths: string[]): DiscoveredPage[] => paths.map((p) => ({ url: `${base}${p}`, source: 'crawl' as const }));
const publicPages = crawl(['/', '/contact', '/auth/login']);

const browser: Browser = await chromium.launch({ headless: true });
const contexts: Array<{ close(): Promise<void> }> = [];
const openPage: ProbePageFactory = async () => {
  const ctx = await browser.newContext();
  await installEvalShim(ctx);
  contexts.push(ctx);
  const page = await ctx.newPage();
  return { page, close: () => ctx.close() };
};
const probeOpts = { delayMs: 0, anchorWaitMs: 200, settleCapMs: 800, revealWaitMs: 400 };
const access = { url: `${base}/`, user: USER, pass: PASS };
const dirs: string[] = [];

try {
  /* ─── A. the probe, with the account ───────────────────────────────────── */
  const detected = detectLoginFeatures(map, publicPages, tokens);
  check('A1. detection: account, profile, invoices and orders have no page; login and contact have one page each; a model tag is never read',
    JSON.stringify(detected.map((f) => [f.feature.name, f.carriedBy.length, f.gatedTokens])) === JSON.stringify([['login', 1, false], ['account', 0, true], ['profile', 0, true], ['invoices', 0, true], ['orders', 0, true], ['contact', 1, false]])
    && detectLoginFeatures(map, [...publicPages.slice(0, 2), { ...publicPages[2]!, feature: 'profile' }], tokens).find((f) => f.feature.name === 'profile')?.carriedBy.length === 0,
    JSON.stringify(detected.map((f) => [f.feature.name, f.carriedBy, f.gatedTokens])));

  site.hits = [];
  const run = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts, login: { access } });
  console.log('\n--- A: the lines ---');
  for (const l of run.lines) console.log(l.replaceAll(base, '<site>'));
  console.log('---');
  const rev = (f: string) => run.revealed.find((r) => r.feature === f);
  const probeOf = (f: string) => run.probes.find((p) => p.feature === f);
  check('A2. the account page (where the sign-in lands), the profile and the invoices are revealed; orders is not',
    JSON.stringify(run.revealed.map((r) => [r.feature, new URL(r.page.url).pathname]).sort()) === JSON.stringify([['account', '/account'], ['invoices', '/account/invoices'], ['profile', '/account/profile']]),
    JSON.stringify(run.revealed.map((r) => [r.feature, r.page.url])));
  check('A3. the profile is reached from the login page by the sign-in and a click on the link, never by its URL',
    JSON.stringify(rev('profile')?.page.reachedBy) === JSON.stringify({ origin: `${base}/auth/login`, feature: 'profile', actions: [{ kind: 'login' }, { kind: 'click', control: 'getByTestId("nav-profile")' }] }),
    JSON.stringify(rev('profile')?.page.reachedBy));
  check('A4. the page the sign-in lands on is reached by the sign-in alone',
    JSON.stringify(rev('account')?.page.reachedBy.actions) === JSON.stringify([{ kind: 'login' }]), JSON.stringify(rev('account')?.page.reachedBy));
  check('A5. every revealed page is behind the sign-in: all of its rules are planned on it, none on the login page',
    run.revealed.every((r) => r.viaLogin === true && r.originRuleIds.length === 0) && JSON.stringify(rev('profile')?.revealedRuleIds) === '["R20","R21"]',
    JSON.stringify(run.revealed.map((r) => [r.feature, r.originRuleIds, r.revealedRuleIds])));
  check('A6. the snapshots are the signed-in pages (the profile form with its first name field, the invoices table)',
    !!rev('profile')?.snapshot.inputs.some((i) => i.id === 'first-name') && JSON.stringify(rev('invoices')?.snapshot.tableHeaders) === '["Invoice","Total"]',
    JSON.stringify([rev('profile')?.snapshot.inputs, rev('invoices')?.snapshot.tableHeaders]));
  check('A7. the account\'s email, which the profile page shows, is not in the snapshot the Planner reads',
    !JSON.stringify(rev('profile')?.snapshot).includes(USER) && JSON.stringify(rev('profile')?.snapshot).includes('Signed in as [the test account]'), rev('profile')?.snapshot.textSample);
  check('A8. the probe record: outcome revealed, the login page and the landing page recorded',
    probeOf('profile')?.outcome === 'revealed' && probeOf('profile')?.revealed === `${base}/account/profile`
    && JSON.stringify(probeOf('profile')?.login) === JSON.stringify({ loginUrl: `${base}/auth/login`, landing: `${base}/account` }), JSON.stringify(probeOf('profile')));
  check('A9. the probe line names the page, the login page and the steps',
    run.lines.includes('State probe "profile": revealed /account/profile from /auth/login (sign in, getByTestId("nav-profile"))')
    && run.lines.includes('State probe "account": revealed /account from /auth/login (sign in)'), JSON.stringify(run.lines));
  check('A10. orders: signed in, no link names it; the record and the line say so',
    probeOf('orders')?.outcome === 'no-new-link' && probeOf('orders')?.detail === 'no page revealed: signed in on /auth/login, no link on /account names orders'
    && run.lines.includes('State probe "orders": no page revealed; tried /account (signed in, no link on /account names orders); any of its 1 rule still uncited after planning will report not-revealed'),
    JSON.stringify([probeOf('orders'), run.lines.filter((l) => l.includes('"orders"'))]));
  check('A11. login and contact have a page of their own: no record, no line',
    !probeOf('login') && !probeOf('contact'), JSON.stringify(run.probes.map((p) => p.feature)));
  check('A12. the login probe line: where it signed in, where it landed, what it revealed, and the page no feature names',
    run.lines[run.lines.length - 1] === 'Login probe: signed in on /auth/login, landed on /account; revealed /account (account), /account/profile (profile), /account/invoices (invoices); also behind the sign-in, named by no requirements feature: /account/messages',
    run.lines[run.lines.length - 1]);
  check('A13. the run record of the probe',
    JSON.stringify(run.loginProbe) === JSON.stringify({ outcome: 'ok', loginUrl: `${base}/auth/login`, landing: `${base}/account`, newLinks: ['/account', '/account/profile', '/account/invoices', '/account/messages'], revealed: ['/account', '/account/profile', '/account/invoices'], unnamed: ['/account/messages'] }),
    JSON.stringify(run.loginProbe));
  const posts = site.hits.filter((h) => h.method === 'POST');
  check('A14. one sign-in, with the correct password; nothing else was posted; the session was never ended and the account never deleted',
    posts.length === 1 && posts[0]!.path === '/auth/login' && !site.hits.some((h) => h.path === '/auth/logout' || h.path === '/account/delete'), JSON.stringify(site.hits.map((h) => `${h.method} ${h.path}`)));
  check('A15. no credential value in the probes, the revealed pages or the lines',
    !JSON.stringify([run.probes, run.revealed.map((r) => r.page), run.lines, run.loginProbe]).includes(USER) && !JSON.stringify([run.probes, run.revealed, run.lines]).includes(PASS));
  check('A16. a link that ends the session, or names deleting, is never followed; a link whose text is the account\'s own email is named by its path',
    loginLinkDenied({ label: 'Sign out' }) === 'sign out' && loginLinkDenied({ label: 'Log out', testid: 'nav-logout' }) === 'log out' && loginLinkDenied({ label: 'Delete account' }) === 'delete' && loginLinkDenied({ label: 'Profile' }) === null
    && loginLinkLocator({ role: 'link', label: USER.toUpperCase(), href: `${base}/account` }, USER) === 'locator("a[href$=\\"/account\\"]")'
    && loginLinkLocator({ role: 'link', label: 'Profile', testid: 'nav-profile', href: `${base}/account/profile` }, USER) === 'getByTestId("nav-profile")',
    loginLinkLocator({ role: 'link', label: USER.toUpperCase(), href: `${base}/account` }, USER));
  check('A17. the feature with no page of its own is no longer called unreachable: its probe says what happened',
    unreachableFeatures(map, [{ feature: 'contact' }, { feature: 'login' }], run.probes).length === 0 && unreachableFeatures(map, [{ feature: 'contact' }, { feature: 'login' }]).length === 4);

  // A menu toggle (href="#") resolves to the page it sits on. It is no link to a page.
  const catMap: RequirementsMap = { ...map, features: [{ name: 'categories', description: 'Product categories.', rules: [{ id: 'R80', text: 'The categories menu lists every category.', type: 'behavior' }] }, ...map.features.filter((f) => f.name === 'login')] };
  const cat = await runStateProbes({ map: catMap, candidates: publicPages, featureTokens: featureTokenMap(catMap), openPage, ...probeOpts, login: { access } });
  check('A20. a "Categories" menu toggle with href="#" on the signed-in page is never taken for a page behind the sign-in',
    cat.revealed.length === 0 && cat.probes.find((pr) => pr.feature === 'categories')?.detail === 'no page revealed: signed in on /auth/login, no link on /account names categories',
    JSON.stringify([cat.revealed.map((r) => [r.feature, r.page.url]), cat.probes.map((pr) => [pr.feature, pr.outcome, pr.detail])]));

  // robots.txt is honored for the revealed path.
  site.variant = 'robots';
  const robotsRun = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts, robots: { disallow: ['/account/invoices'] }, login: { access } });
  site.variant = 'default';
  const inv = robotsRun.probes.find((p) => p.feature === 'invoices');
  check('A18. a page behind the sign-in that robots.txt disallows is never opened; the record names the rule',
    inv?.outcome === 'robots' && JSON.stringify(inv.robotsBlocked) === JSON.stringify({ origin: `${base}/auth/login`, path: '/account/invoices', rule: '/account/invoices' })
    && !robotsRun.revealed.some((r) => r.feature === 'invoices') && robotsRun.revealed.some((r) => r.feature === 'profile'), JSON.stringify(inv));

  // A sign-in that does not work: every feature with no page says so, and nothing reads as revealed.
  const failed = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts, login: { access: { ...access, pass: 'not-the-password' } } });
  check('A19. the sign-in gave no positive signal: outcome error on every feature with no page, with the reason, and no page revealed',
    failed.revealed.length === 0 && failed.probes.length === 4 && failed.probes.every((p) => p.outcome === 'error' && p.detail === 'no page revealed: the sign-in on /auth/login gave no positive signal')
    && failed.lines[failed.lines.length - 1] === 'Login probe: the sign-in on /auth/login gave no positive signal; no page behind the sign-in was looked for.',
    JSON.stringify([failed.probes.map((p) => [p.feature, p.outcome, p.detail]), failed.lines[failed.lines.length - 1]]));

  /* ─── B. no test account ───────────────────────────────────────────────── */
  site.hits = [];
  const none = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts, login: { unavailable: CREDENTIALS_NOT_PROVIDED } });
  check('B1. no account: nothing is loaded, and the four features with no page are recorded as not looked for',
    site.hits.length === 0 && JSON.stringify(none.probes.map((p) => [p.feature, p.outcome, p.detail])) === JSON.stringify(['account', 'profile', 'invoices', 'orders'].map((f) => [f, 'no-credentials', 'test credentials not provided'])),
    JSON.stringify(none.probes));
  check('B2. the line says it was not looked for, and why',
    none.lines.includes('State probe "profile": not looked for behind the sign-in (test credentials not provided); any of its 2 rules still uncited after planning will report not-revealed'), JSON.stringify(none.lines));
  const cov = computeRuleCoverage({ map, planned: [], scenarios: [], notRevealed: notRevealedFeatures(none.probes) });
  const u = (id: string) => cov.uncovered.find((x) => x.ruleId === id);
  check('B3. rule coverage: R20 reads not-revealed with the reason; R50, whose feature has a page, does not',
    u('R20')?.reason === 'not-revealed' && u('R20')?.detail === 'test credentials not provided' && u('R50')?.reason !== 'not-revealed', JSON.stringify([u('R20'), u('R50')]));
  const noPage = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts, login: { unavailable: NO_LOGIN_PAGE_REASON } });
  check('B4. credentials set and no login page found: the same record with that reason',
    noPage.probes.length === 4 && noPage.probes.every((p) => p.outcome === 'no-credentials' && p.detail === NO_LOGIN_PAGE_REASON), JSON.stringify(noPage.probes.map((p) => p.detail)));
  const off = await runStateProbes({ map, candidates: publicPages, featureTokens: tokens, openPage, ...probeOpts });
  check('B5. without the login option nothing changes: no record, no line', off.probes.length === 0 && off.lines.length === 0, JSON.stringify(off.lines));

  /* ─── C. a login wall ──────────────────────────────────────────────────── */
  site.variant = 'wall';
  const wallCandidates = crawl(['/', '/contact', '/auth/login', '/account/orders', '/help-center']);
  const wallMap: RequirementsMap = { ...map, features: [...map.features.filter((f) => ['login', 'orders', 'contact'].includes(f.name)), { name: 'support', description: 'Help for customers.', rules: [{ id: 'R70', text: 'The support page answers common questions.', type: 'behavior' }] }] };
  const wallTokens = featureTokenMap(wallMap);
  site.hits = [];
  const wall = await runStateProbes({ map: wallMap, candidates: wallCandidates, featureTokens: wallTokens, openPage, ...probeOpts, login: { access } });
  console.log('\n--- C: the lines ---');
  for (const l of wall.lines) console.log(l.replaceAll(base, '<site>'));
  console.log('---');
  const orders = wall.probes.find((p) => p.feature === 'orders');
  check('C1. /account/orders is linked signed out and redirects to the login page there: it is a page behind the sign-in',
    orders?.outcome === 'revealed' && orders.login?.gated === true && orders.detail === 'revealed /account/orders after sign-in on /auth/login (signed out, /account/orders ends on the login page)'
    && orders.tried.some((t) => t.result === 'signed out, /account/orders ends on /auth/login'), JSON.stringify(orders));
  check('C2. its snapshot is the signed-in page, not the login form', wall.revealed.find((r) => r.feature === 'orders')?.snapshot.headings.some((h) => h.label === 'Order history') === true
    && wall.revealed.find((r) => r.feature === 'orders')?.snapshot.inputs.length === 0, JSON.stringify(wall.revealed.find((r) => r.feature === 'orders')?.snapshot.headings));
  const support = wall.probes.find((p) => p.feature === 'support');
  check('C3. a page that loads without a sign-in is not behind it: the record says so and nothing is revealed for it',
    support?.outcome === 'no-new-link' && support.detail === 'no page revealed: /help-center loads without a sign-in and is linked signed out, so it is not a page behind the sign-in'
    && !wall.revealed.some((r) => r.feature === 'support'), JSON.stringify(support));
  const signedOutLoads = site.hits.filter((h) => !h.signedIn && h.method === 'GET').map((h) => h.path);
  check('C4. the contact page, a public page with a page of its own, is never loaded to check it',
    !site.hits.some((h) => h.path === '/contact'), JSON.stringify(signedOutLoads));
  const wallPlan = buildPlanTargets({ pages: wallCandidates, map: wallMap, revealed: wall.revealed, blocked: wall.blocked, candidates: wallCandidates });
  check('C5. the wall page is planned once, signed in, from the probe\'s snapshot; its signed-out load is not planned',
    wallPlan.targets.filter((t) => t.page.url === `${base}/account/orders`).length === 1
    && wallPlan.targets.find((t) => t.page.url === `${base}/account/orders`)?.reachedBy?.actions[0]?.kind === 'login'
    && !!wallPlan.targets.find((t) => t.page.url === `${base}/account/orders`)?.snapshot
    && wallPlan.pages.filter((pg) => pg.url === `${base}/account/orders`).every((pg) => pg.source === 'action'),
    JSON.stringify(wallPlan.targets.map((t) => [t.page.url, t.page.source, !!t.reachedBy])));
  site.variant = 'default';

  /* ─── D. planning ──────────────────────────────────────────────────────── */
  const targets = buildPlanTargets({ pages: publicPages, map, revealed: run.revealed, blocked: run.blocked, candidates: publicPages });
  const order = targets.targets.map((t) => new URL(t.page.url).pathname);
  check('D1. the pages behind the sign-in are planned right after the login page, each on its own call',
    JSON.stringify(order) === JSON.stringify(['/', '/contact', '/auth/login', '/account', '/account/profile', '/account/invoices']), JSON.stringify(order));
  const loginTarget = targets.targets.find((t) => t.page.url === `${base}/auth/login`);
  check('D2. the login page\'s own call carries none of their rules and is not tagged with their features',
    !(loginTarget?.requirements?.features ?? []).some((f) => ['account', 'profile', 'invoices'].includes(f.name) && f.rules.length > 0) && !loginTarget?.originOf, JSON.stringify(loginTarget?.requirements?.features.map((f) => [f.name, f.rules.length])));
  const profileTarget = targets.targets.find((t) => t.page.url === `${base}/account/profile`);
  check('D3. the profile call carries R20 and R21 and the probe\'s snapshot',
    JSON.stringify(profileTarget?.requirements?.features.map((f) => [f.name, f.rules.map((r) => r.id)])) === '[["profile",["R20","R21"]]]' && !!profileTarget?.snapshot, JSON.stringify(profileTarget?.requirements));
  const block = reachedByBlock(`${base}/account/profile`, profileTarget!.reachedBy!);
  check('D4. the Planner block: start on the login page, sign in by credential marker, click the link, never open the URL, never change the account',
    block.includes(`reached from ${base}/auth/login by these steps: ${SIGN_IN_STEP}, then click getByTestId("nav-profile")`)
    && block.includes('the Explorer never navigates to /account/profile directly') && block.endsWith(BEHIND_SIGN_IN_GUIDANCE) && SIGN_IN_STEP.includes('credential "user"') && SIGN_IN_STEP.includes('credential "pass"'), block);
  check('D5. a page reached by a click alone gets no sign-in lines', !reachedByBlock(`${base}/checkout`, { origin: `${base}/`, actions: [{ kind: 'click', control: 'getByTestId("add-to-cart")' }] }).includes('sign-in'));

  const PLAN: Record<string, string> = {
    '/': '1. [shop][happy][-] opened the shop and saw the heading — the entry page renders',
    '/contact': '1. [contact][negative][R50] submitted the contact form with an empty message and saw an error — required message',
    '/auth/login': '1. [login][happy][R10] logged in with the test account and landed on the account page — the happy path\n2. [login][negative][R11] logged in with a wrong password and saw the error — wrong password',
    '/account': '1. [account][happy][R60] signed in and saw the greeting on the account page — greeting',
    '/account/profile': '1. [profile][happy][R20] signed in, opened the profile and saw the first name — first name shown\n2. [profile][negative][R21] signed in, opened the profile, cleared the first name, saved and saw an error — required first name\n3. [profile][edge][-] signed in, opened the profile and changed the account password to a new one — password change',
    '/account/invoices': '1. [invoices][happy][R30] signed in, opened the invoices and saw each invoice with its total — the list',
  };
  const systems: Record<string, string> = {};
  const messages: string[] = [];
  const planned = await planAcrossPages({
    targets: targets.targets,
    planFn: async (a) => {
      // Route by the page the call is for, never by text matching: each call names its own URL.
      const key = new URL(a.url).pathname;
      const client: PlannerClient = { messages: { create: async (body) => { systems[key] = JSON.stringify(body); return { content: [{ type: 'text', text: `<plan>\n${PLAN[key]}\n</plan>` }], usage: { input_tokens: 10, output_tokens: 10 } } as never; } } };
      return plan({ ...a, apiKey: 'fixture', client, ...(a.snapshot ? {} : { snapshot: await snapshotOf(a.url) }) });
    },
    featureTokens: tokens,
    onMessage: (m) => messages.push(m),
  });
  console.log('\n--- D: the plan ---');
  for (const s of planned.combined) console.log(`  [${s.feature}] ${s.name}  (page ${new URL(s.pageUrl ?? base).pathname}${s.reachedBy ? `, reaches ${new URL(s.reachedBy.pageUrl).pathname}` : ''})`);
  for (const m of messages.filter((x) => x.startsWith('Rejected') || x.startsWith('Dropped'))) console.log(`  ${m.replaceAll(base, '<site>')}`);
  console.log('---');
  const byRule = (id: string) => planned.combined.find((s) => (s.ruleIds ?? []).includes(id));
  check('D6. every scenario behind the sign-in starts on the login page and reaches its page by the sign-in',
    ['R60', 'R20', 'R21', 'R30'].every((id) => byRule(id)?.pageUrl === `${base}/auth/login` && byRule(id)?.reachedBy?.actions[0]?.kind === 'login')
    && byRule('R20')?.reachedBy?.pageUrl === `${base}/account/profile` && byRule('R10')?.reachedBy === undefined, JSON.stringify(planned.combined.map((s) => [s.name, s.pageUrl, s.reachedBy?.pageUrl])));
  check('D7. the scenario that would change the account password is dropped with a line and never reaches the plan',
    planned.accountSafetyRejected.length === 1 && planned.accountSafetyRejected[0]!.reason === 'would change the test account password'
    && !planned.combined.some((s) => s.name.includes('changed the account password'))
    && messages.includes(`Rejected account-safety scenario: "signed in, opened the profile and changed the account password to a new one" on ${base}/account/profile: would change the test account password; every later stage and run signs in with the same account`),
    JSON.stringify([planned.accountSafetyRejected, messages.filter((m) => m.startsWith('Rejected'))]));
  check('D8. the profile call\'s prompt holds the sign-in block and never the account\'s email',
    (systems['/account/profile'] ?? '').includes('This page is behind the sign-in') && !(systems['/account/profile'] ?? '').includes(USER), (systems['/account/profile'] ?? '').slice(0, 300));
  check('D9. the account safety check reads the planned name by word pattern, and leaves ordinary profile work alone',
    accountSafetyReason('signed in and updated the email address on the profile') === 'would change the test account sign-in identifier'
    && accountSafetyReason('signed in and deleted the account from the profile') === 'would remove the test account'
    && accountSafetyReason('signed in, set a new password and saved') === 'would change the test account password'
    && accountSafetyReason('signed in, opened the profile and saw the first name') === null
    && accountSafetyReason('signed in, cleared the first name, saved and saw an error') === null
    && accountSafetyReason('signed in and saw the email shown on the profile') === null);

  /* ─── E. the tools, on the live site ───────────────────────────────────── */
  const toolBrowserCtx = await browser.newContext();
  await installEvalShim(toolBrowserCtx);
  const toolPage: Page = await toolBrowserCtx.newPage();
  const ctx = createContext(toolPage, 400);
  ctx.testCredentials = { user: USER, pass: PASS };
  ctx.knownAccounts = new Set([USER.toLowerCase()]);
  ctx.plannedNames = planned.combined.map((p) => p.name);
  const discoveryRecord = { method: 'crawl' as const, pages: [], warnings: [], stateProbes: run.probes };
  ctx.plannedPages = plannedPagesFor(planned.combined, reachedPagesOf(discoveryRecord), map);
  const call = async (label: string, name: string, input: Record<string, unknown>, expectOk = true) => {
    const r = await runTool(ctx, { name, input });
    if (expectOk) check(`${label} ${name} ok`, r.ok === true, r.error);
    return r;
  };
  const signIn = async (label: string): Promise<void> => {
    await call(label, 'navigate', { url: `${base}/auth/login` });
    await call(label, 'fill', { css: '#email', intent: 'email input', credential: 'user' });
    await call(label, 'fill', { css: '#password', intent: 'password input', credential: 'pass' });
    await call(label, 'click', { css: '#login', intent: 'login button' });
  };
  const r20 = byRule('R20')!;
  await call('E1.', 'begin_scenario', { name: r20.name, category: 'happy', feature: 'profile' });
  await signIn('E1.');
  await call('E1.', 'click', { testid: 'nav-profile', intent: 'profile link' });
  await call('E1.', 'assert', { type: 'toHaveValue', css: '#first-name', intent: 'first name field', value: 'Jane' });
  const e1 = await call('E1.', 'end_scenario', {});
  const recorded = ctx.scenarios[ctx.scenarios.length - 1]!;
  check('E2. the recording is accepted: it starts on the login page and reaches the profile by a click',
    e1.ok === true && recorded.steps[0]?.kind === 'navigate' && recorded.steps.filter((s) => s.kind === 'navigate').length === 1, JSON.stringify(recorded.steps.map((s) => s.kind)));
  check('E3. both sign-in fields are recorded as markers with no value',
    recorded.steps.filter((s) => s.kind === 'fill').every((s) => s.kind === 'fill' && s.value === '' && (s.credential === 'user' || s.credential === 'pass')) && !JSON.stringify(recorded).includes(USER) && !JSON.stringify(recorded).includes(PASS),
    JSON.stringify(recorded.steps.filter((s) => s.kind === 'fill')));
  check('E4. the page the browser was on after the sign-in is stamped on the scenario (the page the profile link sits on)',
    recorded.signedInUrl === `${base}/account`, String(recorded.signedInUrl));

  const r60 = byRule('R60')!;
  await call('E5.', 'begin_scenario', { name: r60.name, category: 'happy', feature: 'account' });
  await signIn('E5.');
  await call('E5.', 'assert', { type: 'toContainText', css: '#greeting', intent: 'greeting', regex: 'Welcome back, \\w+' });
  await call('E5.', 'end_scenario', {});
  const landing = ctx.scenarios[ctx.scenarios.length - 1]!;
  check('E5. a test of the page the sign-in lands on is stamped too (its checks follow the submit)', landing.signedInUrl === `${base}/account`, String(landing.signedInUrl));

  const r10 = byRule('R10')!;
  await call('E6.', 'begin_scenario', { name: r10.name, category: 'happy', feature: 'login' });
  await signIn('E6.');
  await call('E6.', 'assert', { type: 'toHaveURL', pattern: '/account' });
  await call('E6.', 'end_scenario', {});
  const loginTest = ctx.scenarios[ctx.scenarios.length - 1]!;
  check('E6. the login test itself, which is not planned behind the sign-in, carries no stamp', loginTest.signedInUrl === undefined, String(loginTest.signedInUrl));

  // A navigate to the revealed page is refused.
  await call('E7.', 'begin_scenario', { name: byRule('R30')!.name, category: 'happy', feature: 'invoices' });
  await signIn('E7.');
  await call('E7.', 'navigate', { url: `${base}/account/invoices` });
  await call('E7.', 'assert', { type: 'toBeVisible', css: 'table', intent: 'invoices table' });
  const refusedNav = await call('E7.', 'end_scenario', {}, false);
  check('E7. a scenario that opens the invoices page by its URL is refused at end_scenario', refusedNav.ok === false && /\/account\/invoices/.test(refusedNav.error ?? ''), refusedNav.error);

  // Account safety, read off the page.
  const r21 = byRule('R21')!;
  const openProfile = async (label: string): Promise<void> => {
    await call(label, 'begin_scenario', { name: r21.name, category: 'negative', feature: 'profile' });
    await signIn(label);
    await call(label, 'click', { testid: 'nav-profile', intent: 'profile link' });
  };
  site.hits = [];
  await openProfile('E8.');
  const current = await call('E8.', 'fill', { css: '#current-password', intent: 'current password', credential: 'pass' });
  check('E8. the current password, by marker, is allowed', current.ok === true, current.error);
  const newPw = await call('E8.', 'fill', { css: '#new-password', intent: 'new password', value: 'Another!Pass-2027' }, false);
  check('E9. a typed value in a password field after the sign-in is refused, the field is never touched, and the scenario is skipped with the reason',
    newPw.ok === false && ctx.current === null && ctx.skipped.some((s) => s.scenario === r21.name && s.reason === 'account safety: would change the test account password')
    && (await toolPage.locator('#new-password').inputValue()) === '', JSON.stringify([newPw.error, ctx.skipped]));
  ctx.skipped.length = 0;
  await openProfile('E10.');
  const newEmail = await call('E10.', 'fill', { css: '#email', intent: 'email field', value: 'someone.else@shop.test' }, false);
  check('E10. a different value typed over the field that holds the account\'s own email is refused and skipped',
    newEmail.ok === false && ctx.skipped.some((s) => s.reason === 'account safety: would change the test account sign-in identifier') && (await toolPage.locator('#email').inputValue()) === USER, JSON.stringify([newEmail.error, ctx.skipped]));
  ctx.skipped.length = 0;
  await openProfile('E11.');
  const firstName = await call('E11.', 'fill', { css: '#first-name', intent: 'first name field', value: '' });
  check('E11. an ordinary field on the same form is filled as usual', firstName.ok === true && ctx.current !== null, firstName.error);
  await call('E11.', 'skip_scenario', { name: r21.name, reason: 'fixture: the smoke checks the refusals only' });
  ctx.skipped.length = 0;
  await call('E12.', 'begin_scenario', { name: r60.name, category: 'happy', feature: 'account' });
  await signIn('E12.');
  const del = await call('E12.', 'click', { css: '#delete-account', intent: 'delete button' }, false);
  check('E12. "Delete my account" is never clicked once signed in; the scenario is skipped with the reason and nothing was posted',
    del.ok === false && ctx.skipped.some((s) => s.reason === 'account safety: would remove the test account') && !site.hits.some((h) => h.method === 'POST' && h.path !== '/auth/login'), JSON.stringify([del.error, site.hits.filter((h) => h.method === 'POST').map((h) => h.path)]));
  ctx.skipped.length = 0;
  // Signed out, the same guard does nothing: a wrong-password negative still types its password.
  await call('E13.', 'begin_scenario', { name: byRule('R11')!.name, category: 'negative', feature: 'login' });
  await call('E13.', 'navigate', { url: `${base}/auth/login` });
  await call('E13.', 'fill', { css: '#email', intent: 'email input', credential: 'user' });
  const wrong = await call('E13.', 'fill', { css: '#password', intent: 'password input', value: 'wrong-password-1' });
  check('E13. signed out, a typed wrong password is recorded as before', wrong.ok === true && ctx.current?.steps.some((s) => s.kind === 'fill' && s.value === 'wrong-password-1') === true, wrong.error);
  await call('E13.', 'skip_scenario', { name: byRule('R11')!.name, reason: 'fixture: the smoke checks the guard only' });
  await toolBrowserCtx.close();

  /* ─── F. the emitted framework ─────────────────────────────────────────── */
  const contactTest: Scenario = { name: 'opened the contact page and saw the heading', category: 'happy', feature: 'contact', steps: [
    { kind: 'navigate', url: `${base}/contact` },
    { kind: 'assert', name: 'heading', assertion: { type: 'toHaveText', target: { level: 'css', arg: 'h1', intent: 'contact heading' }, text: 'Contact', timeout: 10000 } } as TraceStep,
  ] } as Scenario;
  // The profile test first, the login test last: the setup must still replay the login test.
  const shipped: Scenario[] = [recorded, landing, contactTest, loginTest];
  const reportOf = (language: 'ts' | 'js', scenarios: Scenario[]): RunReport => ({
    url: `${base}/contact`, language, scenarios,
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  } as RunReport);
  check('F1. the setup replays the login test, wherever it sits in the report, never a test of a page behind the sign-in',
    findHappyLoginScenario(reportOf('ts', shipped))?.name === loginTest.name && findHappyLoginScenario(reportOf('ts', [recorded, landing]))?.name === recorded.name,
    String(findHappyLoginScenario(reportOf('ts', shipped))?.name));
  check('F2. on the session the profile test opens the stamped page, then clicks through; the sign-in steps are gone',
    JSON.stringify(sessionSteps(recorded)?.map((s) => s.kind)) === '["navigate","click","assert"]' && (sessionSteps(recorded)?.[0] as { url?: string }).url === `${base}/account`,
    JSON.stringify(sessionSteps(recorded)));
  check('F3. the test of the landing page keeps its check (before this it was stripped to an empty test)',
    JSON.stringify(sessionSteps(landing)?.map((s) => s.kind)) === '["navigate","assert"]', JSON.stringify(sessionSteps(landing)));
  const noStamp = { ...landing, signedInUrl: undefined };
  check('F4. a recording with every check after the submit and no stamp (an older report) does not run on the session: it keeps its own sign-in',
    sessionSteps(noStamp) === null && signedInAtStart(noStamp, true) === false && signedInAtStart(landing, true) === true);

  process.env[AUTH_ENV_USER] = USER;
  process.env[AUTH_ENV_PASS] = PASS;
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    const e = emitFramework(reportOf(language, shipped), 'POM', 'login-action');
    dirs.push(e.dir);
    emitted.push(e);
    const config = e.files.get(`playwright.config.${language}`) ?? '';
    const profileSpec = e.files.get(`tests/profile/profile.spec.${language}`) ?? '';
    const accountSpec = e.files.get(`tests/account/account.spec.${language}`) ?? '';
    const setup = [...e.files.entries()].find(([f]) => f.includes('auth.setup'))?.[1] ?? '';
    check(`F5. ${language}: the profile and account specs run on the saved session; the contact spec does not`,
      config.includes('storageState: "playwright/.auth/user.json"') && /testMatch: \[[^\]]*'profile\/\*\*\/\*\.spec\./.test(config) && /testMatch: \[[^\]]*'account\/\*\*\/\*\.spec\./.test(config), config.slice(config.indexOf('projects: ['), config.indexOf('projects: [') + 1400));
    const profilePageClass = e.files.get(`pages/profile-page.${language}`) ?? '';
    check(`F6. ${language}: the profile test opens the page the sign-in landed on (the page class url), never the profile URL, and holds no sign-in step`,
      profilePageClass.includes(`"${base}/account"`) && profileSpec.includes('await profilePage.goto();')
      && ![profileSpec, profilePageClass].some((t) => t.includes('/account/profile') || t.includes(AUTH_ENV_PASS) || t.includes('/auth/login')), `${profileSpec.slice(0, 900)}\n${profilePageClass.slice(0, 600)}`);
    check(`F7. ${language}: the account spec keeps its check`, accountSpec.includes('toContainText') && !accountSpec.includes(AUTH_ENV_PASS), accountSpec.slice(0, 700));
    check(`F8. ${language}: the setup signs in with the env account on the login page and saves the session`, setup.includes(`process.env.${AUTH_ENV_PASS} ?? ''`) && setup.includes('/auth/login') && setup.includes('storageState'), setup.slice(0, 500));
    check(`F9. ${language}: no credential value in any emitted file`, ![...e.files.values()].some((t) => t.includes(USER) || t.includes(PASS)));
  }
  // The red case: the same profile test without the stamp opens the spec's own URL, where the profile link is not.
  const redReport = reportOf('ts', [{ ...recorded, signedInUrl: undefined } as Scenario, contactTest, loginTest]);
  const red = emitFramework(redReport, 'POM', 'login-action-red');
  dirs.push(red.dir);
  const runs = await Promise.all([...emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, '.') })), (async () => ({ e: red, res: await runPlaywright(red.dir, '.') }))()]);
  for (const { e, res } of runs.slice(0, 2)) {
    console.log(`   ${e.language}: playwright exit ${String(res.status)}; ${res.specs.map((sp) => `${sp.title}: ${sp.status}`).join('; ')}`);
    const byTitle = (t: string) => res.specs.find((sp) => sp.title.includes(t));
    check(`F10. ${e.language}: Playwright exits 0 and every test passes: the setup, the login test, the two tests behind the sign-in and the contact test`,
      res.status === 0 && res.specs.length >= 5 && res.specs.every((sp) => sp.status === 'expected')
      && byTitle('saw the first name')?.status === 'expected' && byTitle('saw the greeting')?.status === 'expected' && byTitle('authenticate')?.status === 'expected', res.out.slice(-1500));
  }
  const redRun = runs[2]!.res;
  console.log(`   red case: playwright exit ${String(redRun.status)}; ${redRun.specs.map((sp) => `${sp.title}: ${sp.status}`).join('; ')}`);
  check('F11. the red case: without the stamp the profile test opens the wrong page and fails, so the stamp is what makes it pass',
    redRun.status !== 0 && redRun.specs.find((sp) => sp.title.includes('saw the first name'))?.status === 'unexpected', redRun.out.slice(-800));
  delete process.env[AUTH_ENV_USER];
  delete process.env[AUTH_ENV_PASS];

  /* ─── H. no requirements map ───────────────────────────────────────────── */
  const open = await runStateProbes({ map: undefined, candidates: publicPages, openPage, ...probeOpts, login: { access } });
  console.log('\n--- H: the lines ---');
  for (const l of open.lines) console.log(l.replaceAll(base, '<site>'));
  console.log('---');
  check(`H1. with no map the links that exist only after sign-in are the pages, up to the cap of ${LOGIN_PROBE_REVEAL_CAP}, each filed under its last path segment`,
    JSON.stringify(open.revealed.map((r) => [r.feature, new URL(r.page.url).pathname])) === JSON.stringify([['account', '/account'], ['profile', '/account/profile'], ['invoices', '/account/invoices']])
    && featureFromPath(`${base}/account/order-history`) === 'order-history', JSON.stringify(open.revealed.map((r) => [r.feature, r.page.url])));
  check('H2. the page past the cap is named, not dropped quietly; no rule split line is printed without rules',
    open.lines[open.lines.length - 1] === 'Login probe: signed in on /auth/login, landed on /account; revealed /account (account), /account/profile (profile), /account/invoices (invoices); also behind the sign-in, not opened: /account/messages'
    && !open.lines.some((l) => l.includes('rule split')), JSON.stringify(open.lines));
  const named = await runStateProbes({ map: undefined, candidates: publicPages, openPage, ...probeOpts, login: { access, names: ['invoices'] } });
  check('H3. with a feature list and no map, only the link a listed feature names is revealed',
    JSON.stringify(named.revealed.map((r) => [r.feature, new URL(r.page.url).pathname])) === '[["invoices","/account/invoices"]]', JSON.stringify(named.revealed.map((r) => [r.feature, r.page.url])));
  const openTargets = buildPlanTargets({ pages: publicPages, revealed: open.revealed, blocked: open.blocked, candidates: publicPages });
  check('H4. they are planned after the login page, each reached by the sign-in',
    openTargets.targets.slice(-3).every((t) => t.reachedBy?.actions[0]?.kind === 'login' && t.reachedBy.origin === `${base}/auth/login`), JSON.stringify(openTargets.targets.map((t) => [t.page.url, !!t.reachedBy])));

  /* ─── I. the $0 script ─────────────────────────────────────────────────── */
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-probe-login-'));
    dirs.push(tmp);
    const mapFile = path.join(tmp, 'requirements-map.json');
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const runScript = (args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> => new Promise((resolve) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, ANTHROPIC_API_KEY: 'a-key-the-script-must-remove' };
      for (const k of Object.keys(childEnv)) if (k.startsWith('QA_CORE_TEST_') && !(k in env)) delete childEnv[k];
      const child = spawn(process.execPath, [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(process.cwd(), 'scripts', 'probe-login.ts'), ...args], { cwd: tmp, env: childEnv });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    site.hits = [];
    const withAccount = await runScript([`${base}/`, '--map', mapFile], { QA_CORE_TEST_USER: USER, QA_CORE_TEST_PASS: PASS });
    console.log('\n--- I: the script\'s output ---');
    console.log(withAccount.out.replaceAll(base, '<site>').trimEnd());
    console.log('---');
    check('I1. the script exits 0 and prints the lines a run would print, the login probe line last among them',
      withAccount.code === 0 && withAccount.out.includes('State probe "profile": revealed /account/profile from /auth/login (sign in, getByTestId("nav-profile"))')
      && withAccount.out.includes('Login probe: signed in on /auth/login, landed on /account; revealed /account (account), /account/profile (profile), /account/invoices (invoices)')
      && withAccount.out.includes('pages a run would plan behind an action or the sign-in: 3'), `${withAccount.out}\n${withAccount.err}`);
    check('I2. it names the credential variables and never a value', withAccount.out.includes('test credentials: QA_CORE_TEST_USER / QA_CORE_TEST_PASS') && ![withAccount.out, withAccount.err].some((t) => t.includes(USER) || t.includes(PASS)));
    check('I3. it signed in once and wrote nothing', site.hits.filter((h) => h.method === 'POST').length === 1 && JSON.stringify(fs.readdirSync(tmp)) === '["requirements-map.json"]', JSON.stringify(fs.readdirSync(tmp)));
    site.hits = [];
    const noAccount = await runScript([`${base}/`, '--map', mapFile], {});
    check('I4. with no account it posts nothing and prints the features it would record as not looked for',
      noAccount.code === 0 && site.hits.every((h) => h.method === 'GET') && noAccount.out.includes('State probe "profile": not looked for behind the sign-in (test credentials not provided)')
      && noAccount.out.includes('pages a run would plan behind an action or the sign-in: 0'), `${noAccount.out}\n${noAccount.err}`);
    const srs = await runScript([`${base}/`, '--map', path.join(tmp, 'srs.md')], {});
    check('I5. an SRS document is refused before anything runs (a map build is a model call)', srs.code === 2 && srs.err.includes('would need a model call'), srs.err);
  }

  /* ─── G. the whole run in process ──────────────────────────────────────── */
  {
    const DASH = '—';
    const line = (text: string): string => `<plan>\n${text.replaceAll(' — ', ` ${DASH} `)}\n</plan>`;
    const smallMap: RequirementsMap = { ...map, features: map.features.filter((f) => ['login', 'profile'].includes(f.name)) };
    const profileName = 'signed in, opened the profile and saw the first name';
    const loginName = 'logged in with the test account and landed on the account page';
    const tool = (name: string, input: Record<string, unknown>): FakeContent[] => [{ type: 'tool_use', name, input }];
    const signInCalls: FakeContent[][] = [
      tool('navigate', { url: `${base}/auth/login` }),
      tool('fill', { css: '#email', intent: 'email input', credential: 'user' }),
      tool('fill', { css: '#password', intent: 'password input', credential: 'pass' }),
      tool('click', { css: '#login', intent: 'login button' }),
    ];
    const explorer: FakeContent[][] = [
      tool('skip_scenario', { name: 'opened the shop and saw the heading', reason: 'fixture run: the smoke checks the pages behind the sign-in' }),
      tool('skip_scenario', { name: 'opened the contact page and saw the heading', reason: 'fixture run: the smoke checks the pages behind the sign-in' }),
      tool('begin_scenario', { name: loginName, category: 'happy', feature: 'login' }),
      ...signInCalls,
      tool('assert', { type: 'toHaveURL', pattern: '/account' }),
      tool('end_scenario', {}),
      tool('begin_scenario', { name: profileName, category: 'happy', feature: 'profile' }),
      ...signInCalls,
      tool('click', { testid: 'nav-profile', intent: 'profile link' }),
      tool('assert', { type: 'toHaveValue', css: '#first-name', intent: 'first name field', value: 'Jane' }),
      tool('end_scenario', {}),
      tool('finish', { summary: 'done' }),
    ];
    // The plan calls in target order: "/", /contact, /auth/login, then the profile behind the sign-in.
    const api = await startFakeAnthropic({
      planner: [
        line('1. [shop][happy][-] opened the shop and saw the heading — the entry page'),
        line('1. [contact][happy][-] opened the contact page and saw the heading — the contact page'),
        line(`1. [login][happy][R10] ${loginName} — the happy path`),
        line(`1. [profile][happy][R20] ${profileName} — first name shown`),
      ],
      explorer,
      critic: [],
    });
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = api.baseUrl;
    process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
    process.env.QA_CORE_TEST_USER = USER;
    process.env.QA_CORE_TEST_PASS = PASS;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-login-action-run-'));
    const agentCwd = process.cwd();
    process.chdir(outDir);
    const runMessages: string[] = [];
    site.hits = [];
    try {
      const { explore } = await import('../src/agent/runtime.js');
      const report = await explore({
        url: `${base}/`, language: 'ts', outDir, requirements: smallMap, requirementsUsd: 0,
        skipCritic: true, skipStability: true, stabilize: false,
        onEvent: (e) => { if (e.type === 'message') runMessages.push(e.text); },
      }) as RunReport;
      const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'run-report.json'), 'utf8')) as RunReport;
      const discoveryJson = JSON.parse(fs.readFileSync(path.join(outDir, 'discovery.json'), 'utf8')) as { loginProbe?: unknown; pages: Array<{ url: string; source: string }> };
      console.log('\n--- G run: the probe and planner lines ---');
      for (const m of runMessages.filter((x) => x.startsWith('State probe') || x.startsWith('Login probe') || x.startsWith('Planner [') || x.startsWith('discovery:') || x.startsWith('login preflight'))) console.log(m.replaceAll(base, '<site>'));
      console.log('---');
      check('G1. every scripted call was made and every tool call returned ok (standing rule 7)',
        api.toolErrors.length === 0 && api.calls.planner === 4 && api.calls.explorer === explorer.length && api.calls.other === 0, JSON.stringify({ errors: api.toolErrors, calls: api.calls }));
      check('G2. the run\'s own probe revealed the profile behind the sign-in and the line reached the console',
        runMessages.includes('State probe "profile": revealed /account/profile from /auth/login (sign in, getByTestId("nav-profile"))')
        && runMessages.some((m) => m.startsWith('Login probe: signed in on /auth/login, landed on /account; revealed /account/profile (profile)')),
        JSON.stringify(runMessages.filter((m) => m.includes('probe'))));
      check('G3. run-report.json and discovery.json record the page as reached by action, and what the login probe saw',
        (onDisk.discovery?.pages ?? []).some((pg) => pg.url === `${base}/account/profile` && pg.source === 'action' && pg.reachedBy?.actions[0]?.kind === 'login')
        && onDisk.discovery?.loginProbe?.outcome === 'ok' && JSON.stringify(onDisk.discovery?.loginProbe) === JSON.stringify(discoveryJson.loginProbe)
        && !(onDisk.discovery?.candidates ?? []).some((c) => c.url.includes('/account')), JSON.stringify(onDisk.discovery?.loginProbe));
      const planEntry = (onDisk.plan ?? []).find((p) => (p.ruleIds ?? []).includes('R20'));
      check('G4. the profile scenario is planned on the login page with reachedBy, on its own planner call',
        planEntry?.pageUrl === `${base}/auth/login` && planEntry.reachedBy?.pageUrl === `${base}/account/profile`
        && runMessages.some((m) => m.startsWith(`Planner [4/4] ${base}/account/profile (reached by action from ${base}/auth/login): 1 scenario(s)`)), JSON.stringify(planEntry));
      const shippedProfile = onDisk.scenarios.find((s) => s.feature === 'profile');
      check('G5. the scenario was recorded by marker, stamped, replayed with the env account in a fresh context, and shipped',
        !!shippedProfile && shippedProfile.signedInUrl === `${base}/account` && onDisk.replay?.passed === 2 && onDisk.replay.failed === 0 && onDisk.scenarios.length === 2,
        JSON.stringify([shippedProfile?.signedInUrl, onDisk.replay, onDisk.scenarios.map((s) => s.name)]));
      check('G6. rule coverage: R20 is covered by the profile test, R10 by the login test',
        (onDisk.ruleCoverage?.covered ?? []).some((c) => c.ruleId === 'R20') && (onDisk.ruleCoverage?.covered ?? []).some((c) => c.ruleId === 'R10'), JSON.stringify(onDisk.ruleCoverage));
      const files = fs.readdirSync(outDir).map((f) => path.join(outDir, f)).filter((f) => fs.statSync(f).isFile());
      check('G7. no file of the run folder holds a credential value, and no session file was written',
        files.every((f) => { const t = fs.readFileSync(f, 'utf8'); return !t.includes(USER) && !t.includes(PASS); }) && !fs.existsSync(path.join(outDir, 'playwright')), files.map((f) => path.basename(f)).join(', '));
      check('G8. the probe signed in with the correct password: no wrong-password attempt was counted',
        (onDisk.wrongPasswordAttempts?.count ?? 0) === 0 && site.hits.filter((h) => h.method === 'POST' && h.path === '/auth/login').length >= 4, JSON.stringify(onDisk.wrongPasswordAttempts));
      check('G9. the in-memory report and the file agree on the probe', JSON.stringify(report.discovery?.stateProbes) === JSON.stringify(onDisk.discovery?.stateProbes));
    } finally {
      process.chdir(agentCwd);
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.QA_CORE_TEST_USER;
      delete process.env.QA_CORE_TEST_PASS;
      await api.close();
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }
} finally {
  cleanup(dirs);
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  server.close();
}

/** A snapshot of a public page, for the fixture Planner calls that are given none. */
async function snapshotOf(url: string): Promise<import('../src/agent/planner.js').PageSnapshot> {
  const { snapshotPage, settleForSnapshot } = await import('../src/agent/planner.js');
  const h = await openPage();
  try {
    await h.page.goto(url, { waitUntil: 'load' });
    await settleForSnapshot(h.page, 800);
    return await snapshotPage(h.page);
  } finally {
    await h.close();
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the login probe signs in once and reveals the pages behind the sign-in, each reached by the sign-in and a click and never by its URL; with no account they are recorded as not looked for; a login wall is planned once, signed in; a scenario that would change the account is never planned or recorded; the emitted tests run on the saved session from the page the sign-in landed on, TS and JS; and a whole run records, replays and ships a test behind the sign-in with no credential value on disk.');
