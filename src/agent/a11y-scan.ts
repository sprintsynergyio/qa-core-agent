/**
 * The accessibility scan (invariant 91): what axe-core finds on the pages a
 * run planned, recorded on the run report as product behavior to review.
 *
 * Before this the only accessibility check was the emitted
 * tests/a11y/landing.a11y.spec, one page, whose failure reads "Expected [],
 * Received +107 lines": run ceeaf2's failed twice on real violations, stayed
 * in the framework red, and nothing recorded what the violations were (run
 * b4e41b D6: "The a11y violations are still not recorded as findings").
 *
 * The scan is deterministic and costs no model call: one browser, one clean
 * signed-out context, each page loaded once, in order, with the crawl's own
 * delay between loads, then axe with the tags the emitted spec uses. It
 * never fails a run: a page that cannot be loaded or analysed is recorded
 * with its error, never as a page with no violation (standing rule 2), and
 * a page the scan does not load is named with the reason.
 *
 * An accessibility finding is NOT a scenario finding. It is not planned, so
 * it never sits in `report.findings` or in the reconciliation funnel: it
 * lives on `report.accessibility` and every reader derives the findings
 * from there through `a11yFindingsOf`. One finding per axe rule violated at
 * critical or serious impact (the two the emitted spec blocks on), across
 * every page that shows it: the same header contrast problem on seven pages
 * is one thing to review, not seven.
 *
 * What is stored for an element is its selector, never its HTML, so no page
 * text (and nothing a signed-out page happens to print) reaches the report.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { CRAWL_DELAY_MS } from './discovery.js';
import { installEvalShim } from './eval-shim.js';
import { samePage } from './planned-page.js';
import { settleForSnapshot } from './planner.js';

/** The axe tags scanned: the ones the emitted a11y spec uses. */
export const A11Y_TAGS = ['wcag2a', 'wcag2aa'] as const;
/** The impacts that make a violation a finding: the ones the emitted a11y spec fails on. */
export const A11Y_FINDING_IMPACTS = ['critical', 'serious'] as const;
/** How many pages one run scans, the entry page first. */
export const A11Y_PAGE_CAP = 8;
/** How many element selectors a violation keeps per page. */
export const A11Y_TARGETS_KEPT = 3;
/** How long one page may take to load before the scan records an error for it. */
export const A11Y_LOAD_TIMEOUT_MS = 20000;

/** The prefix of an accessibility finding's name in the index and on the dashboard. */
export const A11Y_SCENARIO_PREFIX = 'Accessibility: ';

/** One axe rule violated on one page. */
export interface A11yViolation {
  /** The axe rule id (color-contrast, image-alt, label, ...). */
  id: string;
  /** axe's impact: critical, serious, moderate or minor; null when axe gave none. */
  impact: string | null;
  /** axe's one-sentence statement of the rule. */
  help: string;
  /** axe's page about the rule. */
  helpUrl: string;
  /** How many elements violate the rule on this page. */
  nodes: number;
  /** The selectors of the first few of them, as axe reports them. */
  targets: string[];
}

/** One page of the scan: what axe found, or why it could not look. */
export interface A11yPageScan {
  url: string;
  violations: A11yViolation[];
  /** Set when the page could not be loaded or analysed; `violations` is then [] and means nothing. */
  error?: string;
}

/** The whole scan, as the run report carries it. */
export interface AccessibilityScan {
  tags: string[];
  pages: A11yPageScan[];
  /** Pages of the run the scan did not load, each with the reason. */
  notScanned: Array<{ url: string; reason: string }>;
}

/** One accessibility finding: one axe rule violated at critical or serious impact, across the pages that show it. */
export interface A11yFinding {
  ruleId: string;
  /** The highest impact the rule was violated at on any page. */
  impact: string;
  help: string;
  helpUrl: string;
  /** Every page that shows it, in scan order, with its element count. */
  pages: Array<{ url: string; nodes: number }>;
  /** The elements over all pages. */
  nodes: number;
  /** The first element's selector on the first page. */
  target?: string;
}

function pathOf(url: string): string {
  try { const u = new URL(url); return u.pathname || '/'; } catch { return url; }
}

/** True when a violation's impact makes it a finding. */
export function isFindingImpact(impact: string | null | undefined): boolean {
  return typeof impact === 'string' && (A11Y_FINDING_IMPACTS as readonly string[]).includes(impact);
}

/**
 * The accessibility findings of a scan: one per rule violated at critical
 * or serious impact, in the order the scan first met each rule. A report
 * with no scan has none. A page that failed to scan contributes nothing.
 */
export function a11yFindingsOf(scan: AccessibilityScan | undefined | null): A11yFinding[] {
  const out = new Map<string, A11yFinding>();
  for (const page of scan?.pages ?? []) {
    if (page.error) continue;
    for (const v of page.violations ?? []) {
      if (!isFindingImpact(v.impact)) continue;
      const have = out.get(v.id);
      if (!have) {
        out.set(v.id, { ruleId: v.id, impact: v.impact!, help: v.help, helpUrl: v.helpUrl, pages: [{ url: page.url, nodes: v.nodes }], nodes: v.nodes, ...(v.targets[0] ? { target: v.targets[0] } : {}) });
        continue;
      }
      have.pages.push({ url: page.url, nodes: v.nodes });
      have.nodes += v.nodes;
      if (v.impact === 'critical') have.impact = 'critical';
    }
  }
  return [...out.values()];
}

/** The violations below the finding impacts, counted by rule: noted, never findings. */
export function lowerImpactRules(scan: AccessibilityScan | undefined | null): string[] {
  const findings = new Set(a11yFindingsOf(scan).map((f) => f.ruleId));
  const out: string[] = [];
  for (const page of scan?.pages ?? []) for (const v of page.violations ?? []) if (!isFindingImpact(v.impact) && !findings.has(v.id) && !out.includes(v.id)) out.push(v.id);
  return out;
}

/** What the index and the dashboard show as the finding's name: the rule. */
export function a11yScenarioName(f: { ruleId: string }): string {
  return `${A11Y_SCENARIO_PREFIX}${f.ruleId}`;
}

/** What they show as observed: the impact, the elements, the pages by path, the first element. Scan data only. */
export function a11yObserved(f: A11yFinding): string {
  const paths = f.pages.map((p) => pathOf(p.url));
  return `${f.impact} impact; ${f.nodes} element${f.nodes === 1 ? '' : 's'} on ${paths.length} page${paths.length === 1 ? '' : 's'} (${paths.join(', ')})` + (f.target ? `; first: ${f.target}` : '');
}

/**
 * Which pages a run scans, and which it names as not scanned. The entry
 * page first, then the run's pages in order (the discovery set when there
 * is one, else the pages the plan names), each once, up to the cap. A page
 * reached by an action and a generated-id page are never loaded by URL
 * (invariants 42 and 71), so they are named with that reason.
 */
export function a11yPagesFor(opts: {
  entryUrl: string;
  pages?: Array<{ url: string; source?: string; volatile?: boolean }>;
  plan?: Array<{ pageUrl?: string; volatilePage?: boolean; reachedBy?: { pageUrl: string } }>;
}): { urls: string[]; notScanned: Array<{ url: string; reason: string }> } {
  const urls: string[] = [opts.entryUrl];
  const notScanned: Array<{ url: string; reason: string }> = [];
  const named = (url: string): boolean => urls.some((u) => samePage(u, url)) || notScanned.some((n) => samePage(n.url, url));
  const skip = (url: string, reason: string): void => { if (!named(url)) notScanned.push({ url, reason }); };
  const consider = (url: string, kind: 'plain' | 'action' | 'volatile'): void => {
    if (named(url)) return;
    if (kind === 'action') return skip(url, 'reached by an action, never by its URL');
    if (kind === 'volatile') return skip(url, 'a generated-id page, reached by clicking, never by its URL');
    if (urls.length >= A11Y_PAGE_CAP) return skip(url, `the scan loads at most ${A11Y_PAGE_CAP} pages a run`);
    urls.push(url);
  };
  if (opts.pages && opts.pages.length > 0) {
    for (const p of opts.pages) consider(p.url, p.source === 'action' ? 'action' : p.volatile ? 'volatile' : 'plain');
  } else {
    for (const s of opts.plan ?? []) if (s.pageUrl) consider(s.pageUrl, s.volatilePage ? 'volatile' : 'plain');
  }
  for (const s of opts.plan ?? []) if (s.reachedBy?.pageUrl) consider(s.reachedBy.pageUrl, 'action');
  return { urls, notScanned };
}

/** What one page's analysis returns: axe's violations, in axe's own shape (the part the scan reads). */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  help?: string;
  helpUrl?: string;
  nodes?: Array<{ target?: unknown }>;
}

/** One selector as text: axe gives a list (one entry per frame or shadow root on the way in). */
function targetText(target: unknown): string {
  if (Array.isArray(target)) return target.map((t) => (Array.isArray(t) ? t.join(' ') : String(t))).join(' ');
  return typeof target === 'string' ? target : '';
}

/** axe's violations as the report keeps them: no element HTML, a few selectors. */
export function violationsFromAxe(violations: AxeViolation[]): A11yViolation[] {
  return violations.map((v) => ({
    id: v.id,
    impact: typeof v.impact === 'string' ? v.impact : null,
    help: v.help ?? '',
    helpUrl: v.helpUrl ?? '',
    nodes: (v.nodes ?? []).length,
    targets: (v.nodes ?? []).map((n) => targetText(n.target)).filter(Boolean).slice(0, A11Y_TARGETS_KEPT),
  }));
}

/** Run axe on a loaded page with the scan's tags. */
async function analysePage(page: Page): Promise<AxeViolation[]> {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const results = await new AxeBuilder({ page }).withTags([...A11Y_TAGS]).analyze();
  return results.violations as AxeViolation[];
}

/**
 * Scan the pages. Never throws: a page that fails is recorded with its
 * error, and a browser that cannot start records that error on every page.
 * `analyse` and `browser` are test seams; absent, the scan starts its own
 * headless Chromium and runs axe.
 */
export async function scanAccessibility(opts: {
  urls: string[];
  notScanned?: Array<{ url: string; reason: string }>;
  delayMs?: number;
  browser?: Browser;
  analyse?: (page: Page) => Promise<AxeViolation[]>;
}): Promise<AccessibilityScan> {
  const scan: AccessibilityScan = { tags: [...A11Y_TAGS], pages: [], notScanned: [...(opts.notScanned ?? [])] };
  const analyse = opts.analyse ?? analysePage;
  const delayMs = opts.delayMs ?? CRAWL_DELAY_MS;
  let browser = opts.browser;
  const own = !browser;
  const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 200);
  try {
    browser = browser ?? await chromium.launch({ headless: true });
  } catch (err) {
    for (const url of opts.urls) scan.pages.push({ url, violations: [], error: `the browser did not start: ${firstLine(err)}` });
    return scan;
  }
  try {
    // One clean, signed-out context for the whole scan.
    const context = await browser.newContext();
    await installEvalShim(context);
    try {
      for (let i = 0; i < opts.urls.length; i++) {
        const url = opts.urls[i]!;
        if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const page = await context.newPage();
        try {
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: A11Y_LOAD_TIMEOUT_MS });
          if (response && response.status() >= 400) {
            scan.pages.push({ url, violations: [], error: `the page answered HTTP ${response.status()}` });
            continue;
          }
          // The Planner's own settle: a client-rendered page is analysed once its content is there.
          await settleForSnapshot(page);
          scan.pages.push({ url, violations: violationsFromAxe(await analyse(page)) });
        } catch (err) {
          scan.pages.push({ url, violations: [], error: firstLine(err) });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  } catch (err) {
    // The context itself failed: every page not yet recorded gets the error.
    for (const url of opts.urls) if (!scan.pages.some((p) => p.url === url)) scan.pages.push({ url, violations: [], error: firstLine(err) });
  } finally {
    if (own) await browser.close().catch(() => {});
  }
  return scan;
}

/** How many of something, in words. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The console lines of a scan: one summary line, one line per finding, then
 * what was not scanned and what failed. The first line never reads as "no
 * violation" when a page failed to scan.
 */
export function accessibilityLines(scan: AccessibilityScan): string[] {
  const ok = scan.pages.filter((p) => !p.error);
  const failed = scan.pages.filter((p) => p.error);
  const findings = a11yFindingsOf(scan);
  const lower = lowerImpactRules(scan);
  const head = `Accessibility scan: ${count(ok.length, 'page', 'pages')} scanned` +
    (failed.length > 0 ? `, ${count(failed.length, 'page', 'pages')} could not be scanned` : '') +
    (ok.length === 0
      ? '; nothing was checked'
      : findings.length > 0
        ? `; ${count(findings.length, 'rule', 'rules')} violated at critical or serious impact (product behavior to review)`
        : '; no critical or serious violation') +
    (lower.length > 0 ? `; ${count(lower.length, 'lower-impact rule', 'lower-impact rules')} noted (${lower.join(', ')})` : '');
  const lines = [head];
  for (const f of findings) lines.push(`Accessibility finding: ${f.ruleId} (${f.impact}): ${f.help} · ${count(f.nodes, 'element', 'elements')} on ${f.pages.map((p) => pathOf(p.url)).join(', ')}`);
  for (const p of failed) lines.push(`Accessibility scan failed on ${pathOf(p.url)}: ${p.error}`);
  if (scan.notScanned.length > 0) lines.push(`Accessibility scan did not load: ${scan.notScanned.map((n) => `${pathOf(n.url)} (${n.reason})`).join('; ')}`);
  return lines;
}

/** The one-line form for a run summary. */
export function accessibilitySummaryLine(scan: AccessibilityScan | undefined | null): string | null {
  if (!scan) return null;
  return accessibilityLines(scan)[0]!;
}
