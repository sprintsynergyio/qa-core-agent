/**
 * Locks invariant 91: accessibility violations are recorded as findings.
 *
 * Before this the agent emitted an accessibility spec into the framework
 * and recorded nothing: a site with a missing alt text or unreadable
 * contrast produced a run with "0 findings". Now every run scans its pages
 * with axe and records what it found as product behavior to review.
 *
 *   A. the pure part: one finding per rule across pages, the lower-impact
 *      rules noted and never counted, a failed page contributing nothing,
 *      which pages a run scans and which it names as not scanned, the
 *      console lines
 *   B. the real scan on a served site: a missing alt text and low contrast
 *      are found, a clean page reads clean, a 404 and an unreachable page
 *      are recorded with their error and never read as clean, no element
 *      HTML is stored, every load is a signed-out GET
 *   C. a whole run through explore() with a local stand-in for the model
 *      API: report.accessibility, the lines on the console printed whole,
 *      the funnel untouched; a stopped run keeps the scan on its
 *      checkpoint and the resumed run does not scan again; a scan that
 *      throws is recorded as a failed scan and the run goes on; a
 *      plan-only run does not scan
 *   D. the index and the API: one row per rule with source a11y, counted
 *      in To review, seen across runs, status and notes kept on re-index;
 *      the run page payload, with a report from before the scan reading
 *      null, never an empty scan
 *   E. the dashboard: the run page section and the findings table tag, in
 *      both themes
 *
 * No model call leaves the machine and nothing is billed.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import {
  A11Y_PAGE_CAP, A11Y_TAGS, a11yFindingsOf, a11yObserved, a11yPagesFor, a11yScenarioName, accessibilityLines, accessibilitySummaryLine,
  lowerImpactRules, scanAccessibility, violationsFromAxe, type AccessibilityScan,
} from '../src/agent/a11y-scan.js';
import { loadCheckpoint, checkpointPath } from '../src/agent/checkpoint.js';
import { messageLine } from '../src/cli/render.js';
import { openDatabase, schemaVersion } from '../src/server/db/migrate.js';
import { indexOutput, findingKey } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { buildRunDetail } from '../src/server/run-detail.js';
import { newRunId } from '../src/agent/output-layout.js';
import { GLOSSARY } from '../dashboard/src/lib/glossary.js';
import type { RunReport } from '../src/agent/trace.js';
import { startFakeAnthropic, type FakeContent } from './lib/fake-anthropic.js';

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { passed++; console.log(`OK  ${label}`); }
  else { failed++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** The scan's lines, or none for a report with no scan (so a failing run still reaches every check). */
const linesOf = (scan: AccessibilityScan | undefined): string[] => (scan ? accessibilityLines(scan) : []);

/* ─── A. the pure part ────────────────────────────────────────────────────── */
const CONTRAST_HELP = 'Elements must meet minimum color contrast ratio thresholds';
const ALT_HELP = 'Images must have alternative text';
const SITE_URL = 'https://shop.example';
const FIXTURE: AccessibilityScan = {
  tags: [...A11Y_TAGS],
  pages: [
    { url: `${SITE_URL}/`, violations: [
      { id: 'color-contrast', impact: 'serious', help: CONTRAST_HELP, helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', nodes: 1, targets: ['p.hint'] },
      { id: 'image-alt', impact: 'critical', help: ALT_HELP, helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt', nodes: 2, targets: ['img.hero', 'img.logo'] },
      { id: 'form-field-multiple-labels', impact: 'moderate', help: 'Form field must not have multiple label elements', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/form-field-multiple-labels', nodes: 1, targets: ['#a'] },
    ] },
    { url: `${SITE_URL}/contact`, violations: [
      { id: 'color-contrast', impact: 'serious', help: CONTRAST_HELP, helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', nodes: 2, targets: ['p.note', 'small'] },
    ] },
    { url: `${SITE_URL}/clean`, violations: [] },
    // A page that failed to scan carries no violation and must never read as clean.
    { url: `${SITE_URL}/missing`, violations: [{ id: 'label', impact: 'critical', help: 'ignored', helpUrl: '', nodes: 9, targets: ['x'] }], error: 'the page answered HTTP 404' },
  ],
  notScanned: [{ url: `${SITE_URL}/checkout`, reason: 'reached by an action, never by its URL' }],
};
{
  const f = a11yFindingsOf(FIXTURE);
  check('A1. one finding per rule at critical or serious impact, across the pages that show it, in the order the scan met them',
    same(f.map((x) => [x.ruleId, x.impact, x.nodes, x.pages.map((p) => p.url.replace(SITE_URL, '')), x.target]), [['color-contrast', 'serious', 3, ['/', '/contact'], 'p.hint'], ['image-alt', 'critical', 2, ['/'], 'img.hero']]), JSON.stringify(f));
  check('A2. a lower-impact rule is noted and never a finding', same(lowerImpactRules(FIXTURE), ['form-field-multiple-labels']) && !f.some((x) => x.ruleId === 'form-field-multiple-labels'));
  check('A3. a page that failed to scan contributes nothing, whatever it carries', !f.some((x) => x.ruleId === 'label'));
  check('A4. a report with no scan has no finding and no summary line', same(a11yFindingsOf(undefined), []) && same(a11yFindingsOf(null), []) && accessibilitySummaryLine(undefined) === null);
  check('A5. the finding is named by its rule and observed from scan data only',
    a11yScenarioName(f[0]!) === 'Accessibility: color-contrast' && a11yObserved(f[0]!) === 'serious impact; 3 elements on 2 pages (/, /contact); first: p.hint' && a11yObserved(f[1]!) === 'critical impact; 2 elements on 1 page (/); first: img.hero',
    JSON.stringify([a11yScenarioName(f[0]!), a11yObserved(f[0]!), a11yObserved(f[1]!)]));
  // The same rule at serious impact on one page and critical on another reads critical.
  const mixed: AccessibilityScan = { tags: [], notScanned: [], pages: [
    { url: `${SITE_URL}/a`, violations: [{ id: 'aria-roles', impact: 'serious', help: 'h', helpUrl: '', nodes: 1, targets: ['a'] }] },
    { url: `${SITE_URL}/b`, violations: [{ id: 'aria-roles', impact: 'critical', help: 'h', helpUrl: '', nodes: 1, targets: ['b'] }] },
  ] };
  check('A6. a rule serious on one page and critical on another reads critical', a11yFindingsOf(mixed)[0]?.impact === 'critical' && a11yFindingsOf(mixed).length === 1);
  const lines = accessibilityLines(FIXTURE);
  check('A7. the console lines: the count, each finding, the failed page, the pages not loaded',
    same(lines, [
      'Accessibility scan: 3 pages scanned, 1 page could not be scanned; 2 rules violated at critical or serious impact (product behavior to review); 1 lower-impact rule noted (form-field-multiple-labels)',
      `Accessibility finding: color-contrast (serious): ${CONTRAST_HELP} · 3 elements on /, /contact`,
      `Accessibility finding: image-alt (critical): ${ALT_HELP} · 2 elements on /`,
      'Accessibility scan failed on /missing: the page answered HTTP 404',
      'Accessibility scan did not load: /checkout (reached by an action, never by its URL)',
    ]), JSON.stringify(lines));
  const nothing: AccessibilityScan = { tags: [], notScanned: [], pages: [{ url: `${SITE_URL}/`, violations: [], error: 'net::ERR_CONNECTION_REFUSED' }] };
  check('A8. a scan that loaded no page says nothing was checked, never "no violation" (standing rule 2)',
    accessibilityLines(nothing)[0] === 'Accessibility scan: 0 pages scanned, 1 page could not be scanned; nothing was checked', accessibilityLines(nothing)[0]);
  const clean: AccessibilityScan = { tags: [], notScanned: [], pages: [{ url: `${SITE_URL}/`, violations: [] }] };
  check('A9. a clean scan says so in one line', same(accessibilityLines(clean), ['Accessibility scan: 1 page scanned; no critical or serious violation']), JSON.stringify(accessibilityLines(clean)));
  const long = `Accessibility scan did not load: ${Array.from({ length: 12 }, (_, i) => `/category/a-long-category-name-${i} (the scan loads at most 8 pages a run)`).join('; ')}`;
  check('A10. the CLI prints every scan line whole, however long', long.length > 400 && messageLine(long) === long && lines.every((l) => messageLine(l) === l));
  const v = violationsFromAxe([{ id: 'image-alt', impact: 'critical', help: ALT_HELP, helpUrl: 'u', nodes: [{ target: ['img.a'] }, { target: ['iframe#f', 'img.b'] }, { target: ['img.c'] }, { target: ['img.d'] }] }, { id: 'odd', nodes: [] }]);
  check('A11. axe output is reduced to the rule, its impact, the element count and at most three selectors (a framed element as its chain)',
    same(v[0], { id: 'image-alt', impact: 'critical', help: ALT_HELP, helpUrl: 'u', nodes: 4, targets: ['img.a', 'iframe#f img.b', 'img.c'] }) && v[1]?.impact === null && v[1]?.nodes === 0, JSON.stringify(v));
}
{
  const t = a11yPagesFor({
    entryUrl: `${SITE_URL}/`,
    pages: [
      { url: `${SITE_URL}/` }, { url: `${SITE_URL}/contact/` }, { url: `${SITE_URL}/contact?ref=nav` },
      { url: `${SITE_URL}/checkout`, source: 'action' }, { url: `${SITE_URL}/product/01JKLMNOPQRSTUVWXYZ0123456`, volatile: true },
    ],
    plan: [{ pageUrl: `${SITE_URL}/auth/login`, reachedBy: { pageUrl: `${SITE_URL}/account/profile` } }],
  });
  check('A12. the entry page first, each page once, a page reached by an action and a generated-id page named and never loaded',
    same(t.urls.map((u) => u.replace(SITE_URL, '')), ['/', '/contact/']) && same(t.notScanned.map((n) => [n.url.replace(SITE_URL, ''), n.reason]), [
      ['/checkout', 'reached by an action, never by its URL'],
      ['/product/01JKLMNOPQRSTUVWXYZ0123456', 'a generated-id page, reached by clicking, never by its URL'],
      ['/account/profile', 'reached by an action, never by its URL'],
    ]), JSON.stringify(t));
  const many = a11yPagesFor({ entryUrl: `${SITE_URL}/`, pages: Array.from({ length: 11 }, (_, i) => ({ url: `${SITE_URL}/p${i}` })) });
  check(`A13. at most ${A11Y_PAGE_CAP} pages are loaded and the rest are named with the reason`,
    many.urls.length === A11Y_PAGE_CAP && many.notScanned.length === 4 && many.notScanned.every((n) => n.reason === `the scan loads at most ${A11Y_PAGE_CAP} pages a run`), JSON.stringify(many));
  const fromPlan = a11yPagesFor({ entryUrl: `${SITE_URL}/`, plan: [{ pageUrl: `${SITE_URL}/` }, { pageUrl: `${SITE_URL}/cart` }, { pageUrl: `${SITE_URL}/cart` }, {}] });
  check('A14. with no discovery, the pages the plan names; a single-page run scans its entry page', same(fromPlan.urls.map((u) => u.replace(SITE_URL, '')), ['/', '/cart']) && same(a11yPagesFor({ entryUrl: `${SITE_URL}/`, plan: [{}] }).urls, [`${SITE_URL}/`]));
}

/* ─── the served site for B, C and E ─────────────────────────────────────── */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const shell = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#fff;color:#111"><main><h1>${title}</h1>${body}</main></body></html>`;
const SITE: Record<string, string> = {
  '/': shell('Toolshop', '<img src="/p.png" width="40" height="40"><p style="color:#bbb;background:#fff">Free delivery on every order this week.</p><a href="/contact">Contact us</a>'),
  '/contact': shell('Contact', '<p style="color:#bbb;background:#fff">We answer within one working day.</p><p style="color:#c4c4c4;background:#fff">Calls are recorded.</p><form><label for="email">Email</label><input id="email" type="email"><button type="submit">Send</button></form>'),
  '/clean': shell('About', '<p>We sell tools.</p><img src="/p.png" alt="A hammer" width="40" height="40">'),
};
// A page whose two language attributes disagree: a moderate violation under the same tags.
SITE['/labels'] = shell('Labels', '<p>We also ship abroad.</p>').replace('<html lang="en">', '<html lang="en" xml:lang="fr">');
const loads: Array<{ method: string; path: string; cookie: string | undefined }> = [];
const server = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0]!;
  if (p === '/p.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
  if (p === '/favicon.ico' || p === '/robots.txt' || p === '/sitemap.xml') { res.writeHead(404); res.end(); return; }
  loads.push({ method: req.method ?? '', path: p, cookie: req.headers.cookie });
  const html = SITE[p];
  // A page that sets a cookie: the scan must still be signed out on the next page.
  if (!html) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// A port nothing listens on: an unreachable page.
const dead = http.createServer();
await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/`;
await new Promise<void>((resolve) => dead.close(() => resolve()));

let realScan: AccessibilityScan | undefined;
try {
  /* ─── B. the real scan ──────────────────────────────────────────────────── */
  {
    loads.length = 0;
    const scan = await scanAccessibility({ urls: [`${base}/`, `${base}/contact`, `${base}/clean`, `${base}/labels`, `${base}/missing`, deadUrl], notScanned: [{ url: `${base}/checkout`, reason: 'reached by an action, never by its URL' }], delayMs: 20 });
    realScan = scan;
    const page = (p: string) => scan.pages.find((x) => x.url === `${base}${p}`);
    const ids = (p: string) => (page(p)?.violations ?? []).map((v) => `${v.id}:${v.impact}:${v.nodes}`);
    console.log('\n--- B: the lines of the real scan ---');
    for (const l of accessibilityLines(scan)) console.log(l.replaceAll(base, '<site>').replaceAll(deadUrl, '<dead>/'));
    console.log('---');
    check('B1. the home page: the image with no alt text (critical) and the unreadable text (serious)', same(ids('/').sort(), ['color-contrast:serious:1', 'image-alt:critical:1']), JSON.stringify(ids('/')));
    check('B2. the contact page: two unreadable texts under one rule', same(ids('/contact'), ['color-contrast:serious:2']), JSON.stringify(ids('/contact')));
    check('B3. a clean page reads clean: scanned, no violation, no error', !!page('/clean') && page('/clean')!.violations.length === 0 && page('/clean')!.error === undefined, JSON.stringify(page('/clean')));
    check('B4. a lower-impact violation is recorded on its page and noted, never a finding', same(ids('/labels'), ['html-xml-lang-mismatch:moderate:1']) && same(lowerImpactRules(scan), ['html-xml-lang-mismatch']), JSON.stringify(ids('/labels')));
    check('B5. a 404 is recorded with its status and no violation, never as a clean page', page('/missing')?.error === 'the page answered HTTP 404' && page('/missing')!.violations.length === 0, JSON.stringify(page('/missing')));
    const deadPage = scan.pages.find((x) => x.url === deadUrl);
    check('B6. an unreachable page is recorded with the browser\'s error and the scan goes on', !!deadPage?.error && /ERR_CONNECTION_REFUSED/.test(deadPage.error) && scan.pages.length === 6, JSON.stringify(deadPage));
    const f = a11yFindingsOf(scan);
    check('B7. two findings: the contrast rule across two pages with three elements, the alt-text rule on one',
      same(f.map((x) => [x.ruleId, x.impact, x.nodes, x.pages.map((p) => p.url.replace(base, ''))]).sort(), [['color-contrast', 'serious', 3, ['/', '/contact']], ['image-alt', 'critical', 1, ['/']]]), JSON.stringify(f));
    check('B8. each finding carries axe\'s own help sentence, its help link and the first element\'s selector',
      f.every((x) => x.help.length > 10 && /^https:\/\/dequeuniversity\.com\/rules\/axe\//.test(x.helpUrl) && !!x.target) && f.find((x) => x.ruleId === 'image-alt')?.target === 'img' && f.find((x) => x.ruleId === 'image-alt')?.help === ALT_HELP && f.find((x) => x.ruleId === 'color-contrast')?.help === CONTRAST_HELP, JSON.stringify(f.map((x) => [x.help, x.helpUrl, x.target])));
    check('B9. no element HTML is stored: selectors only', !JSON.stringify(scan).includes('<') && !JSON.stringify(scan).includes('Free delivery'));
    check('B10. the scan records the tags it ran and the pages it was told not to load', same(scan.tags, ['wcag2a', 'wcag2aa']) && same(scan.notScanned, [{ url: `${base}/checkout`, reason: 'reached by an action, never by its URL' }]));
    check('B11. every page was loaded once, in order, with a GET and no cookie (signed out)',
      same(loads.map((l) => `${l.method} ${l.path}`), ['GET /', 'GET /contact', 'GET /clean', 'GET /labels', 'GET /missing']) && loads.every((l) => l.cookie === undefined), JSON.stringify(loads));
    const head = accessibilityLines(scan)[0]!;
    check('B12. the first line counts what was scanned and what could not be',
      head === 'Accessibility scan: 4 pages scanned, 2 pages could not be scanned; 2 rules violated at critical or serious impact (product behavior to review); 1 lower-impact rule noted (html-xml-lang-mismatch)', head);
    // An analysis that throws on one page: that page says so and the others are scanned.
    let n = 0;
    const partial = await scanAccessibility({ urls: [`${base}/clean`, `${base}/`], delayMs: 0, analyse: async () => { n++; if (n === 1) throw new Error('axe crashed\n  at somewhere'); return [{ id: 'image-alt', impact: 'critical', help: ALT_HELP, helpUrl: 'u', nodes: [{ target: ['img'] }] }]; } });
    check('B13. an analysis that throws on one page is that page\'s error (first line only) and the next page is still scanned',
      partial.pages[0]?.error === 'axe crashed' && partial.pages[0]!.violations.length === 0 && partial.pages[1]?.violations[0]?.id === 'image-alt' && a11yFindingsOf(partial).length === 1, JSON.stringify(partial.pages));
  }

  /* ─── C. a whole run ────────────────────────────────────────────────────── */
  {
    // The Planner's own line format separates the name from the rationale with this character.
    const SEP = ' \u2014 ';
    const planText = (lines: string[]): string => `<plan>\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n</plan>`;
    const NAMES = ['opened the shop and saw the heading', 'opened the contact page and saw the email field', 'opened the about page and saw the heading'];
    const PLANS = [
      planText([`[shop][happy] ${NAMES[0]}${SEP}the entry page`]),
      planText([`[contact][happy] ${NAMES[1]}${SEP}the form`]),
      planText([`[about][happy] ${NAMES[2]}${SEP}the page`]),
    ];
    const tool = (name: string, input: Record<string, unknown>): FakeContent[] => [{ type: 'tool_use', name, input }];
    const skipWhy = 'fixture run: the smoke checks the accessibility scan, so no scenario is recorded';
    const skipAll: FakeContent[][] = [...NAMES.map((n) => tool('skip_scenario', { name: n, reason: skipWhy })), tool('finish', { summary: 'done' })];
    const urls = [`${base}/`, `${base}/contact`, `${base}/clean`];
    const prevBase = process.env.ANTHROPIC_BASE_URL;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('QA_CORE_TEST_'))) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
    const agentCwd = process.cwd();
    const { explore } = await import('../src/agent/runtime.js');
    const runOnce = async (label: string, script: { planner: string[]; explorer: FakeContent[][] }, extra: Record<string, unknown>): Promise<{ report: RunReport | undefined; paused: boolean; thrown: string; messages: string[]; outDir: string; api: Awaited<ReturnType<typeof startFakeAnthropic>> }> => {
      const api = await startFakeAnthropic({ ...script, critic: [] });
      process.env.ANTHROPIC_BASE_URL = api.baseUrl;
      const outDir = (extra.outDir as string | undefined) ?? fs.mkdtempSync(path.join(os.tmpdir(), `qa-core-a11y-${label}-`));
      process.chdir(outDir);
      const messages: string[] = [];
      let report: RunReport | undefined;
      let paused = false;
      let thrown = '';
      try {
        const r = await explore({ url: `${base}/`, language: 'ts', outDir, urls, skipCritic: true, skipStability: true, stabilize: false, onEvent: (e: { type: string; text?: string }) => { if (e.type === 'message' && typeof e.text === 'string') messages.push(e.text); }, ...extra } as never) as RunReport & { paused?: boolean };
        if (r.paused) paused = true; else report = r;
      } catch (err) { thrown = (err as Error).stack ?? String(err); }
      finally { process.chdir(agentCwd); await api.close(); }
      return { report, paused, thrown, messages, outDir, api };
    };
    try {
      // C1: the real scan inside a run.
      loads.length = 0;
      const run = await runOnce('run', { planner: PLANS, explorer: skipAll }, {});
      console.log('\n--- C run: the accessibility lines ---');
      for (const m of run.messages.filter((x) => x.startsWith('Accessibility'))) console.log(m.replaceAll(base, '<site>'));
      console.log('---');
      check('C0. the run ended with a report and every scripted call was made with no tool error', !!run.report && run.thrown === '' && run.api.toolErrors.length === 0 && run.api.calls.planner === 3 && run.api.calls.explorer === skipAll.length && run.api.calls.other === 0, run.thrown || JSON.stringify(run.api.calls));
      const onDisk = JSON.parse(fs.readFileSync(path.join(run.outDir, 'run-report.json'), 'utf8')) as RunReport;
      const f = a11yFindingsOf(onDisk.accessibility);
      check('C1. run-report.json carries the scan of the run\'s three pages and its two findings',
        same((onDisk.accessibility?.pages ?? []).map((p) => [p.url.replace(base, ''), p.error ?? null]), [['/', null], ['/contact', null], ['/clean', null]]) && same(f.map((x) => x.ruleId).sort(), ['color-contrast', 'image-alt']), JSON.stringify(onDisk.accessibility));
      check('C2. the scan is not in the funnel: no scenario finding was added and the reconciliation balances as before',
        same(onDisk.findings, []) && same(onDisk.reconciliation?.findings, []) && onDisk.reconciliation?.balanced === true && onDisk.reconciliation.planned === 3 && onDisk.reconciliation.skipped.length === 3,
        JSON.stringify([onDisk.findings, onDisk.reconciliation && { planned: onDisk.reconciliation.planned, findings: onDisk.reconciliation.findings, balanced: onDisk.reconciliation.balanced }]));
      const scanLines = run.messages.filter((x) => x.startsWith('Accessibility'));
      check('C3. the console printed the scan\'s own lines, each whole',
        same(scanLines, linesOf(onDisk.accessibility)) && scanLines.length === 3 && scanLines[0] === 'Accessibility scan: 3 pages scanned; 2 rules violated at critical or serious impact (product behavior to review)' && scanLines.every((l) => messageLine(l) === l), JSON.stringify(scanLines));
      const lastPlanner = run.messages.map((m, i) => (m.startsWith('Planner') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
      check('C4. the scan runs after planning: its first line follows the last planner line', lastPlanner >= 0 && scanLines.length > 0 && run.messages.indexOf(scanLines[0]!) > lastPlanner);
      check('C5. the scan loaded the run\'s pages and nothing else, signed out', loads.every((l) => l.method === 'GET' && ['/', '/contact', '/clean'].includes(l.path) && l.cookie === undefined), JSON.stringify(loads));
      const { runSummaryLines } = await import('../src/cli/render.js');
      const summary = (runSummaryLines as unknown as (r: RunReport) => string[])(onDisk);
      check('C6. the end-of-run summary repeats the scan lines', linesOf(onDisk.accessibility).length === 3 && linesOf(onDisk.accessibility).every((l) => summary.includes(l)), JSON.stringify(summary.filter((l) => l.startsWith('Accessibility'))));
      fs.rmSync(run.outDir, { recursive: true, force: true });

      // C7 to C10: a run the cost ceiling stops keeps the scan on its checkpoint; the resumed run does not scan again.
      let scanCalls = 0;
      let target: { urls: string[]; notScanned: Array<{ url: string; reason: string }> } | undefined;
      const seamScan: AccessibilityScan = { tags: [...A11Y_TAGS], notScanned: [], pages: [{ url: `${base}/`, violations: [{ id: 'image-alt', impact: 'critical', help: ALT_HELP, helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt', nodes: 1, targets: ['img'] }] }] };
      const stoppedRun = await runOnce('stop', { planner: PLANS, explorer: skipAll }, { maxUsd: 0.0002, a11yScan: async (t: typeof target) => { scanCalls++; target = t; return seamScan; } });
      const cpFile = checkpointPath(stoppedRun.outDir);
      check('C7. a run the cost ceiling stopped scanned once, with the run\'s pages as the target', scanCalls === 1 && same(target?.urls, urls) && same(target?.notScanned, []) && stoppedRun.report?.stopped?.kind === 'cost_ceiling', stoppedRun.thrown || JSON.stringify([scanCalls, target, stoppedRun.report?.stopped]));
      check('C8. the stopped run\'s report and its checkpoint both carry the scan', same(stoppedRun.report?.accessibility, seamScan) && fs.existsSync(cpFile) && same(loadCheckpoint(cpFile).accessibility, seamScan));
      const resumed = await runOnce('resume', { planner: [], explorer: skipAll }, { outDir: stoppedRun.outDir, maxUsd: 2, resume: loadCheckpoint(cpFile), a11yScan: async () => { scanCalls++; throw new Error('the resumed run must not scan again'); } });
      check('C9. the resumed run does not scan again and its report carries the first process\'s scan', scanCalls === 1 && same(resumed.report?.accessibility, seamScan) && resumed.thrown === '' && !resumed.report?.stopped, resumed.thrown || JSON.stringify([scanCalls, resumed.report?.stopped]));
      check('C10. the resumed run prints no second scan line', resumed.messages.filter((m) => m.startsWith('Accessibility')).length === 0, JSON.stringify(resumed.messages.filter((m) => m.startsWith('Accessibility'))));
      fs.rmSync(stoppedRun.outDir, { recursive: true, force: true });

      // C11: a scan that throws never stops the run and never reads as a clean scan.
      const broken = await runOnce('broken', { planner: PLANS, explorer: skipAll }, { a11yScan: async () => { throw new Error('boom\n  at somewhere'); } });
      const bScan = broken.report?.accessibility;
      check('C11. a scan that throws is recorded as a failed scan on every page, the console says nothing was checked, and the run goes on',
        !!broken.report && broken.thrown === '' && (bScan?.pages ?? []).length === 3 && (bScan?.pages ?? []).every((p) => p.error === 'the scan failed: boom' && p.violations.length === 0)
        && broken.messages.includes('Accessibility scan: 0 pages scanned, 3 pages could not be scanned; nothing was checked') && broken.report.reconciliation?.balanced === true, broken.thrown || JSON.stringify(bScan));
      fs.rmSync(broken.outDir, { recursive: true, force: true });

      // C12: a plan-only run stops before the scan.
      let reviewCalls = 0;
      const review = await runOnce('review', { planner: PLANS, explorer: [] }, { review: true, a11yScan: async () => { reviewCalls++; return seamScan; } });
      check('C12. a plan-only run (--review) does not scan', review.paused && reviewCalls === 0 && review.thrown === '', review.thrown || String(reviewCalls));
      fs.rmSync(review.outDir, { recursive: true, force: true });
    } finally {
      process.chdir(agentCwd);
      if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  }
} finally {
  server.close();
}

/* ─── D. the index and the API ────────────────────────────────────────────── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-a11y-index-'));
const output = path.join(root, 'output');
const HOST_URL = 'https://shop.example/';
const mkReport = (startedAt: string, o: { scan?: AccessibilityScan; findings?: Array<Record<string, unknown>>; uncovered?: number }): Record<string, unknown> => {
  const findings = o.findings ?? [];
  const names = ['opened the shop and saw the heading', 'sent the contact form and saw the thanks message'];
  return {
    url: HOST_URL, language: 'ts', startedAt, finishedAt: startedAt, steps: 12,
    scenarios: names.map((name) => ({ name, feature: 'shop', category: 'happy', steps: [{ kind: 'navigate', url: HOST_URL }] })),
    cascadeStats: {}, cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.1, plannerUsd: 0.01, criticUsd: 0.02, repairUsd: 0 },
    plan: [...names, ...findings.map((f) => String(f.scenario))].map((name) => ({ name, category: 'happy', rationale: 'r', feature: 'shop' })),
    review: { verdicts: names.map((scenario) => ({ scenario, verdict: 'pass', reasons: ['asserts the outcome'], required_fixes: [] })), summary: 'ok', repair: [] },
    findings,
    reconciliation: { planned: 2 + findings.length, generated: 2, dropped: [], incomplete: [], findings: findings.map((f) => ({ name: f.scenario, expected: f.expected, url: f.url, messages: [] })), skipped: [], accountedFor: 2 + findings.length, added: 0, balanced: true, stable: 2, recovered: 0, flaky: 0, broken: 0 },
    ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: [names[0]] }], uncovered: Array.from({ length: o.uncovered ?? 0 }, (_, i) => ({ ruleId: `R${i + 2}`, text: 'a rule', reason: 'not-planned' })) },
    ...(o.scan ? { accessibility: o.scan } : {}),
  };
};
const PRODUCT = { scenario: 'sent the contact form with a short message and saw an error', category: 'negative', expected: 'a visible error message', url: `${HOST_URL}contact`, messages: ['Thanks for your message'], kind: 'product' };
const LOCATOR = { scenario: 'opened the newsletter popup', category: 'happy', expected: 'locate element: newsletter popup', url: HOST_URL, messages: ['Selector could not be resolved or recovered after 2 attempts'], kind: 'locator' };
// Run 1 (older): no scan at all, a report from before the scan existed.
// Run 2: both rules. Run 3 (newest): the alt text was fixed, the contrast rule now shows on one page only.
const later: AccessibilityScan = { tags: [...A11Y_TAGS], notScanned: [], pages: [
  { url: `${SITE_URL}/`, violations: [{ id: 'color-contrast', impact: 'serious', help: CONTRAST_HELP, helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', nodes: 1, targets: ['p.hint'] }] },
  { url: `${SITE_URL}/contact`, violations: [] },
] };
const RUNS = [
  { id: newRunId(new Date('2026-11-01T10:00:00Z'), 'noscan'), report: mkReport('2026-11-01T10:00:00.000Z', { findings: [PRODUCT] }) },
  { id: newRunId(new Date('2026-11-10T10:00:00Z'), 'scan-a'), report: mkReport('2026-11-10T10:00:00.000Z', { scan: FIXTURE, findings: [PRODUCT, LOCATOR], uncovered: 1 }) },
  { id: newRunId(new Date('2026-11-20T10:00:00Z'), 'scan-b'), report: mkReport('2026-11-20T10:00:00.000Z', { scan: later }) },
];
for (const r of RUNS) {
  const dir = path.join(output, 'shop-example', r.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(r.report, null, 2));
  fs.writeFileSync(path.join(dir, 'shop-automation-framework.zip'), 'PKzip');
  fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify({ source: 'cli', flags: {}, writtenAt: 'x' }));
}
const [noScanId, scanAId, scanBId] = RUNS.map((r) => r.id) as [string, string, string];
const dbPath = path.join(root, 'data', 'qa-core.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
let db = openDatabase(dbPath);
indexOutput(db, root);
type Row = { id: string; scenario: string; expected: string; observed: string | null; page_url: string | null; kind: string; source: string; status: string; notes: string | null; first_seen_run_id: string; last_seen_run_id: string };
const rowsOf = (d: typeof db): Row[] => d.prepare('SELECT id, scenario, expected, observed, page_url, kind, source, status, notes, first_seen_run_id, last_seen_run_id FROM findings ORDER BY scenario').all() as Row[];
{
  const rows = rowsOf(db);
  const a11y = rows.filter((r) => r.source === 'a11y');
  check('D1. the schema is at version 9 and findings carries source (NOT NULL, default scenario)', schemaVersion(db) === 9 && (db.prepare('PRAGMA table_info(findings)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>).some((c) => c.name === 'source' && c.notnull === 1 && c.dflt_value === "'scenario'"));
  check('D2. one row per accessibility rule, named by the rule, expected axe\'s own sentence, kind product, source a11y',
    same(a11y.map((r) => [r.scenario, r.expected, r.kind, r.source, r.status]), [['Accessibility: color-contrast', CONTRAST_HELP, 'product', 'a11y', 'open'], ['Accessibility: image-alt', ALT_HELP, 'product', 'a11y', 'open']]), JSON.stringify(a11y));
  const none: Row = { id: '', scenario: '', expected: '', observed: null, page_url: null, kind: '', source: '', status: '', notes: null, first_seen_run_id: '', last_seen_run_id: '' };
  const cc = a11y.find((r) => r.scenario === 'Accessibility: color-contrast') ?? none;
  const alt = a11y.find((r) => r.scenario === 'Accessibility: image-alt') ?? none;
  check('D3. the same rule in a later run is the same finding: first seen in the first scan, last seen in the newest, and it says what the newest run saw',
    cc.first_seen_run_id === scanAId && cc.last_seen_run_id === scanBId && cc.observed === 'serious impact; 1 element on 1 page (/); first: p.hint' && cc.page_url === `${SITE_URL}/`, JSON.stringify(cc));
  check('D4. a rule the newest run no longer shows keeps what its last run saw', alt.first_seen_run_id === scanAId && alt.last_seen_run_id === scanAId && alt.observed === 'critical impact; 2 elements on 1 page (/); first: img.hero', JSON.stringify(alt));
  const seen = (id: string): number => (db.prepare('SELECT COUNT(*) AS n FROM finding_runs WHERE finding_id = ?').get(id) as { n: number }).n;
  check('D5. times seen is counted from the runs: the contrast rule twice, the alt-text rule once', seen(cc.id) === 2 && seen(alt.id) === 1 && cc.id === findingKey('shop-example', 'Accessibility: color-contrast', CONTRAST_HELP));
  check('D6. scenario findings keep source scenario and their kind; the failed page and the lower-impact rule made no row',
    same(rows.filter((r) => r.source === 'scenario').map((r) => [r.scenario, r.kind]), [[LOCATOR.scenario, 'locator'], [PRODUCT.scenario, 'product']]) && rows.length === 4, JSON.stringify(rows.map((r) => [r.scenario, r.source])));
  const runRows = db.prepare('SELECT id, findings FROM runs ORDER BY started_at').all() as Array<{ id: string; findings: number }>;
  check('D7. the runs table\'s findings column stays the funnel bucket: the scan adds nothing to it', same(runRows.map((r) => r.findings), [1, 2, 0]), JSON.stringify(runRows));
}
const TOKEN = 'a11y-token';
const api = createApiHandler({ db, root, token: TOKEN });
const apiServer = http.createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404); res.end(); });
await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', () => r()));
const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
const getJson = async (p: string): Promise<any> => (await fetch(apiBase + p, { headers: auth })).json();
{
  const list = await getJson('/api/findings?project_id=shop-example') as { findings?: Array<Record<string, any>> } | Array<Record<string, any>>;
  const all = (Array.isArray(list) ? list : list.findings ?? []) as Array<Record<string, any>>;
  check('D8. /api/findings returns each row with its source', all.length === 4 && same(all.filter((f) => f.source === 'a11y').map((f) => f.scenario).sort(), ['Accessibility: color-contrast', 'Accessibility: image-alt']) && all.filter((f) => f.source === 'scenario').length === 2, JSON.stringify(all.map((f) => [f.scenario, f.source, f.kind])));
  const cc = all.find((f) => f.scenario === 'Accessibility: color-contrast') ?? {};
  check('D9. the row says how often and when: seen 2 times, in both scanned runs, newest first', cc.times_seen === 2 && same(cc.run_ids, [scanBId, scanAId]) && cc.last_seen_run_id === scanBId, JSON.stringify([cc.times_seen, cc.run_ids]));
  const projects = await getJson('/api/projects') as { projects: Array<Record<string, any>>; totals: Record<string, any> };
  const card = projects.projects.find((p) => p.id === 'shop-example')!;
  check('D10. To review counts the product finding and the two accessibility findings, never the element not found', card.unresolved_findings === 3 && card.locator_failures === 1 && projects.totals.to_review === 3, JSON.stringify([card.unresolved_findings, card.locator_failures, projects.totals]));
  // A person triages the alt-text finding; a re-index keeps the status and the notes.
  const alt = all.find((f) => f.scenario === 'Accessibility: image-alt') ?? { id: 'none' };
  const patched = await fetch(`${apiBase}/api/findings/${encodeURIComponent(alt.id)}`, { method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'fixed', notes: 'alt text added in the CMS' }) });
  indexOutput(db, root);
  const after = rowsOf(db).find((r) => r.scenario === 'Accessibility: image-alt') ?? { status: '', notes: null, source: '' };
  const card2 = ((await getJson('/api/projects')) as { projects: Array<Record<string, any>> }).projects.find((p) => p.id === 'shop-example')!;
  check('D11. a status and notes a person set survive a re-index, and a fixed accessibility finding leaves To review', patched.status === 200 && after.status === 'fixed' && after.notes === 'alt text added in the CMS' && after.source === 'a11y' && card2.unresolved_findings === 2, JSON.stringify([patched.status, after, card2.unresolved_findings]));
}
{
  const d = buildRunDetail(db, root, scanAId);
  const sm = (d.body as any).stages.summary;
  check('D12. the run page payload carries the scan: the findings, the lower-impact rule, the failed page, the page not loaded',
    sm.a11y_count === 2 && sm.accessibility?.scanned === 3
    && same(sm.accessibility.findings.map((f: any) => [f.rule_id, f.impact, f.help, f.nodes, f.pages, f.target]), [['color-contrast', 'serious', CONTRAST_HELP, 3, [`${SITE_URL}/`, `${SITE_URL}/contact`], 'p.hint'], ['image-alt', 'critical', ALT_HELP, 2, [`${SITE_URL}/`], 'img.hero']])
    && same(sm.accessibility.lower, ['form-field-multiple-labels']) && same(sm.accessibility.errors, [{ url: `${SITE_URL}/missing`, error: 'the page answered HTTP 404' }]) && same(sm.accessibility.not_scanned, FIXTURE.notScanned), JSON.stringify(sm.accessibility));
  check('D13. needs attention = product findings + accessibility findings + uncovered rules; the element not found stays out; the funnel is the report\'s',
    sm.findings_count === 1 && sm.locator_count === 1 && sm.uncovered_count === 1 && sm.attention === 4 && sm.status === 'attention' && sm.funnel.findings === 2 && sm.funnel.findings_product === 1 && sm.funnel.findings_locator === 1 && sm.funnel.balanced === true, JSON.stringify([sm.findings_count, sm.locator_count, sm.uncovered_count, sm.attention, sm.status, sm.funnel]));
  const old = (buildRunDetail(db, root, noScanId).body as any).stages.summary;
  check('D14. a report from before the scan reads null, never an empty scan, and its attention is unchanged', old.accessibility === null && old.a11y_count === 0 && old.attention === 1 && old.findings_count === 1, JSON.stringify([old.accessibility, old.a11y_count, old.attention]));
  const clean = (buildRunDetail(db, root, scanBId).body as any).stages.summary;
  check('D15. a run whose only issue is an accessibility finding reads attention', clean.findings_count === 0 && clean.a11y_count === 1 && clean.attention === 1 && clean.status === 'attention', JSON.stringify([clean.a11y_count, clean.attention, clean.status]));
}
{
  // Files are truth: delete the database, re-index, the derived columns come back identical (status and notes are a person's and start again).
  const before = rowsOf(db).map((r) => ({ ...r, status: '', notes: '' }));
  apiServer.close();
  db.close();
  for (const f of fs.readdirSync(path.dirname(dbPath))) fs.rmSync(path.join(path.dirname(dbPath), f));
  db = openDatabase(dbPath);
  indexOutput(db, root);
  check('D16. delete the database and re-index: the same finding rows', same(rowsOf(db).map((r) => ({ ...r, status: '', notes: '' })), before));
  // A v8 database gains the column by ADD COLUMN with its rows kept, every existing row a scenario finding.
  const v8File = path.join(root, 'data', 'v8.sqlite');
  const cur = openDatabase(v8File);
  indexOutput(cur, root);
  cur.exec("DELETE FROM finding_runs WHERE finding_id IN (SELECT id FROM findings WHERE source = 'a11y')");
  cur.exec("DELETE FROM findings WHERE source = 'a11y'");
  cur.exec('ALTER TABLE findings DROP COLUMN source');
  cur.exec('DELETE FROM schema_version WHERE version = 9');
  const hadRows = (cur.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n;
  cur.close();
  const migrated = openDatabase(v8File);
  const kept = migrated.prepare('SELECT source, COUNT(*) AS n FROM findings GROUP BY source').all() as Array<{ source: string; n: number }>;
  check('D17. a version 8 database migrates by a plain ADD COLUMN: its rows kept, each a scenario finding', schemaVersion(migrated) === 9 && hadRows === 2 && same(kept, [{ source: 'scenario', n: 2 }]), JSON.stringify([hadRows, kept]));
  indexOutput(migrated, root);
  check('D18. and the next index pass adds the accessibility rows', same((migrated.prepare("SELECT scenario FROM findings WHERE source = 'a11y' ORDER BY scenario").all() as Array<{ scenario: string }>).map((r) => r.scenario), ['Accessibility: color-contrast', 'Accessibility: image-alt']));
  migrated.close();
  fs.rmSync(v8File, { force: true });
}
db.close();

/* ─── E. the dashboard ────────────────────────────────────────────────────── */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18795;
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core-gw.sqlite'), ANTHROPIC_API_KEY: 'unused' },
});
const killGw = (): void => { if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killGw);
process.on('uncaughtException', (err) => { console.error(err); killGw(); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); killGw(); process.exit(1); });
let gwLog = '';
gw.stdout.on('data', (c) => { gwLog += String(c); });
gw.stderr.on('data', (c) => { gwLog += String(c); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('E0. the gateway boots for the page test', /listening on http/.test(gwLog), gwLog.slice(0, 300));

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript({ content: `
window.__contrast = function (root) {
  function lum(rgb) { var m = (rgb.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 3).map(function (v) { var c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }
  function parse(c) { var m = (c.match(/[\\d.]+/g) || ['0','0','0','1']).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; }
  function bgOf(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) { var p = parse(getComputedStyle(e).backgroundColor); if (p.a > 0) layers.push(p); if (p.a >= 1) break; }
    var r = 0, g = 0, b = 0;
    for (var i = layers.length - 1; i >= 0; i--) { var l = layers[i]; r = l.r * l.a + r * (1 - l.a); g = l.g * l.a + g * (1 - l.a); b = l.b * l.a + b * (1 - l.a); }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  var out = {};
  Array.prototype.forEach.call(document.querySelectorAll(root + ' [data-testid], ' + root), function (el) {
    var own = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim().length > 0; });
    if (!own) return;
    var a = lum(getComputedStyle(el).color), bb = lum(bgOf(el));
    var ratio = Math.round(((Math.max(a, bb) + 0.05) / (Math.min(a, bb) + 0.05)) * 10) / 10;
    var key = el.getAttribute('data-testid') || root;
    if (out[key] === undefined || ratio < out[key]) out[key] = ratio;
  });
  return out;
};` });
  const setTheme = async (theme: 'dark' | 'light'): Promise<void> => {
    await page.evaluate((t) => { document.documentElement.classList.toggle('light', t === 'light'); localStorage.setItem('qa-core.theme', t); }, theme);
    await page.waitForTimeout(150);
  };
  await page.goto(`http://127.0.0.1:${PORT}/runs/${scanAId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="a11y-section"]');
  const text = (sel: string) => page.evaluate((s) => Array.from(document.querySelectorAll(s)).map((n) => (n.textContent ?? '').trim()), sel);
  check('E1. run page: the hero counts 4 and its line names the accessibility issues beside the findings and the uncovered rules',
    (await text('[data-testid="hero-attention"]'))[0]?.startsWith('4') === true && (await text('[data-testid="hero-attention-sub"]'))[0] === '1 finding · 2 accessibility issues · 1 uncovered rule · 1 element not found', JSON.stringify([await text('[data-testid="hero-attention"]'), await text('[data-testid="hero-attention-sub"]')]));
  check('E2. run page: the section lists one entry per rule with its impact, axe\'s sentence, the elements and the pages by path',
    same(await text('[data-testid="a11y-rule"]'), ['color-contrast', 'image-alt']) && same(await text('[data-testid="a11y-impact"]'), ['serious', 'critical']) && same(await text('[data-testid="a11y-help"]'), [CONTRAST_HELP, ALT_HELP])
    && same(await text('[data-testid="a11y-nodes"]'), ['3 elements', '2 elements']) && same(await text('[data-testid="a11y-pages"]'), ['/, /contact', '/']) && same(await text('[data-testid="a11y-target"]'), ['p.hint', 'img.hero']) && (await text('[data-testid="a11y-count"]'))[0] === '2',
    JSON.stringify([await text('[data-testid="a11y-rule"]'), await text('[data-testid="a11y-nodes"]'), await text('[data-testid="a11y-pages"]')]));
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="a11y-link"]')).map((a) => [(a as HTMLAnchorElement).href, (a as HTMLAnchorElement).target, (a as HTMLAnchorElement).rel]));
  check('E3. run page: each entry links to the rule\'s own help page in a new tab', same(links, [['https://dequeuniversity.com/rules/axe/4.10/color-contrast', '_blank', 'noreferrer'], ['https://dequeuniversity.com/rules/axe/4.10/image-alt', '_blank', 'noreferrer']]), JSON.stringify(links));
  check('E4. run page: what was scanned, the lower-impact rule, the page that failed and the page not loaded are all said',
    (await text('[data-testid="a11y-scanned"]'))[0]?.startsWith('3 pages scanned.') === true && (await text('[data-testid="a11y-lower"]'))[0] === 'Lower-impact rules noted, not counted: form-field-multiple-labels.'
    && (await text('[data-testid="a11y-errors"]'))[0] === 'Could not be scanned: /missing (the page answered HTTP 404).' && (await text('[data-testid="a11y-not-scanned"]'))[0] === 'Not scanned: /checkout (reached by an action, never by its URL).',
    JSON.stringify([await text('[data-testid="a11y-scanned"]'), await text('[data-testid="a11y-lower"]'), await text('[data-testid="a11y-errors"]'), await text('[data-testid="a11y-not-scanned"]')]));
  const colors = await page.evaluate(() => ({ a11y: getComputedStyle(document.querySelector('[data-testid="a11y-heading"]')!).color, findings: getComputedStyle(document.querySelector('[data-testid="findings-section"] h3')!).color, rows: document.querySelectorAll('[data-testid="scenario-row"]').length, a11yInTable: Array.from(document.querySelectorAll('[data-testid="scenario-row"]')).some((r) => (r.textContent ?? '').includes('color-contrast')), funnel: document.querySelector('[data-testid="funnel-row"][data-key="findings"]')?.getAttribute('data-n') ?? null }));
  check('E5. run page: the section is the findings colour, an accessibility finding is never a scenario row, and the funnel\'s findings row stays the report\'s 2', colors.a11y === colors.findings && !colors.a11yInTable && colors.rows > 0 && colors.funnel === '2', JSON.stringify(colors));
  const glossary = await page.evaluate(() => document.querySelector('[data-testid="a11y-heading"] [data-glossary]')?.getAttribute('data-glossary') ?? null);
  check('E6. run page: the heading\'s tooltip is the glossary entry, which says an automated check finds some problems, not all', glossary === 'accessibilityScan' && /finds some accessibility problems, not all of them/.test(GLOSSARY.accessibilityScan.text), String(glossary));
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(theme);
    const c = await page.evaluate(() => (window as unknown as { __contrast: (s: string) => Record<string, number> }).__contrast('[data-testid="a11y-section"]')) as Record<string, number>;
    check(`E7-${theme}. run page: every text in the section keeps at least 4.5:1 against its background (${theme})`, Object.keys(c).length >= 8 && Object.values(c).every((v) => v >= 4.5), JSON.stringify(c));
  }
  await setTheme('light');
  if (process.env.QA_CORE_SMOKE_SHOTS) {
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(theme);
      await page.locator('[data-testid="a11y-section"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.QA_CORE_SMOKE_SHOTS, `run-a11y-${theme}.png`), fullPage: true });
    }
    await setTheme('light');
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(150);
  const narrow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check('E8. run page: no sideways scroll at 390 with the section on screen', narrow.w <= narrow.c, JSON.stringify(narrow));
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto(`http://127.0.0.1:${PORT}/runs/${noScanId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="a11y-section"]');
  check('E9. run page: a run from before the scan says it has no scan, shows no count, and its hero line is the old one',
    (await text('[data-testid="a11y-no-scan"]'))[0] === 'This run has no accessibility scan. It was made before the scan existed.' && (await text('[data-testid="a11y-count"]')).length === 0 && (await text('[data-testid="a11y-finding"]')).length === 0
    && (await text('[data-testid="hero-attention-sub"]'))[0] === '1 finding · 0 uncovered rules', JSON.stringify([await text('[data-testid="a11y-no-scan"]'), await text('[data-testid="hero-attention-sub"]')]));

  await page.goto(`http://127.0.0.1:${PORT}/runs/${scanBId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="a11y-section"]');
  check('E10. run page: the newest run shows its one accessibility finding and "No findings recorded" for scenarios',
    same(await text('[data-testid="a11y-rule"]'), ['color-contrast']) && (await text('[data-testid="hero-attention-sub"]'))[0] === '0 findings · 1 accessibility issue · 0 uncovered rules', JSON.stringify([await text('[data-testid="a11y-rule"]'), await text('[data-testid="hero-attention-sub"]')]));

  // The project page: the accessibility findings sit in the violet list with a tag, and count in To review.
  await page.goto(`http://127.0.0.1:${PORT}/projects/shop-example#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="finding-row"]');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="project-findings"] [data-testid="finding-row"]')).map((r) => ({
    scenario: r.querySelector('[data-testid="finding-scenario"]')?.textContent ?? '', tag: r.querySelector('[data-testid="finding-a11y"]')?.textContent ?? null,
    glossary: r.querySelector('[data-testid="finding-a11y"]')?.getAttribute('data-glossary') ?? null, expected: r.querySelector('[data-testid="finding-expected"]')?.textContent ?? '',
    seen: r.querySelector('[data-testid="finding-times-seen"]')?.textContent ?? '', status: (r as HTMLElement).dataset.status,
  })));
  const byName = (n: string) => rows.find((r) => r.scenario === n);
  check('E11. project page: both accessibility findings are in the violet list, tagged "Accessibility", with axe\'s sentence as what was expected and how often each was seen',
    rows.length === 3 && byName('Accessibility: color-contrast')?.tag === 'Accessibility' && byName('Accessibility: color-contrast')?.expected === CONTRAST_HELP && byName('Accessibility: color-contrast')?.seen === '2'
    && byName('Accessibility: image-alt')?.tag === 'Accessibility' && byName('Accessibility: image-alt')?.seen === '1' && byName(PRODUCT.scenario)?.tag === null, JSON.stringify(rows));
  check('E12. project page: the tag\'s tooltip is the glossary entry and the heading counts the three', byName('Accessibility: image-alt')?.glossary === 'accessibilityFinding' && /counts in To review/.test(GLOSSARY.accessibilityFinding.text) && (await text('[data-testid="findings-heading"]'))[0]?.endsWith('3') === true, JSON.stringify([byName('Accessibility: image-alt')?.glossary, await text('[data-testid="findings-heading"]')]));
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(theme);
    const c = await page.evaluate(() => { const el = document.querySelector('[data-testid="finding-a11y"]'); if (!el) return {}; el.setAttribute('data-testid', 'finding-a11y'); return (window as unknown as { __contrast: (s: string) => Record<string, number> }).__contrast('[data-testid="finding-a11y"]'); }) as Record<string, number>;
    check(`E13-${theme}. project page: the tag keeps at least 4.5:1 (${theme})`, Object.values(c).length > 0 && Object.values(c).every((v) => v >= 4.5), JSON.stringify(c));
  }
  check('E14. no page raised an error', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  killGw();
}
fs.rmSync(root, { recursive: true, force: true });
void realScan;

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('OK: accessibility violations are findings: every run scans its pages with axe, signed out and with no model call, records one finding per rule at critical or serious impact, names what it could not or did not scan, keeps the scan out of the test funnel, and the index, the API and the dashboard show each finding as product behavior to review.');
