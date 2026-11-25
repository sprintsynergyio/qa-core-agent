import type { Page } from 'playwright';
import {
  CRAWL_DELAY_MS,
  DISCOVERY_UA,
  robotsAllows,
  robotsRuleFor,
  waitForAnchors,
  type DiscoveredPage,
  type ReachAction,
  type RobotsInfo,
} from './discovery.js';
import { pagesCarryingFeature, segmentMatchesTokens, tokensFor } from './page-filter.js';
import { normalizeWords, settleForSnapshot, snapshotPage, type PageSnapshot } from './planner.js';
import type { RequirementFeature, RequirementRule, RequirementsMap } from './requirements.js';
import { emitLocatorCall } from './selectors.js';
import { currencyAmountIn } from './parse-number.js';
import { generatedIdFragment, isVolatilePath } from './volatile-id.js';
import { LOGIN_PATHS, signInOn, type PreflightLoginResult } from './login-preflight.js';

/**
 * State probe: the action-first discovery rung for pages that exist only
 * after an action (invariant 71, docs/design/state-dependent-pages.md).
 *
 * On practicesoftwaretesting.com the header cart link renders only after an
 * add-to-cart, so no crawl of a fresh session finds the cart page (runs 4 to
 * 6). A requirements feature with rules and no page carrying it by page
 * evidence is probed in a real browser with no model call: a trigger control
 * from STATE_TRIGGERS is clicked on a candidate page, and a same-origin
 * anchor that appears after the click and matches the feature's tokens is
 * the revealed page. The revealed page is recorded as reached by that
 * action (origin plus actions), never as a URL to navigate to.
 *
 * The probe only ADDS a revealed page. When it reveals nothing, planning is
 * exactly as before; only the feature's rules still uncited after planning
 * read not-revealed, with the probe's detail.
 *
 * Matching is on normalized words against fixed tables and the feature's own
 * tokens, never on a string the model wrote (standing rule 1).
 */

/** Most pages the probe loads per feature. A page the browser crawl read costs no load. */
export const STATE_PROBE_PAGE_CAP = 4;
/** Most trigger clicks per feature. */
export const STATE_PROBE_CLICK_CAP = 2;
/** How long the probe waits after a trigger click for a new link to appear. */
export const STATE_PROBE_REVEAL_WAIT_MS = 3000;

/**
 * Trigger phrases per feature token set. A feature whose path tokens
 * (tokensFor plus featureTokenMap) meet a row's tokens is probed with that
 * row's phrases. The table grows by evidence from runs, never by guessing.
 * Pages behind a sign-in have no row here: the login probe finds them
 * (invariant 88, probeLogin below).
 */
export const STATE_TRIGGERS: ReadonlyArray<{ tokens: string[]; phrases: string[] }> = [
  { tokens: ['cart', 'basket', 'checkout'], phrases: ['add to cart', 'add to basket', 'add to bag'] },
  { tokens: ['wishlist'], phrases: ['add to wishlist', 'add to favourites'] },
  { tokens: ['compare'], phrases: ['add to compare'] },
];

/**
 * Never clicked, whatever the trigger table says: a control whose normalized
 * words name payment, an order, deletion or a subscription. Each phrase
 * matches as whole words, its last word with any ending ("pay" matches
 * "payment", "delete" matches "deleted"). Checked before any click.
 */
export const STATE_TRIGGER_DENY: readonly string[] = [
  'place order',
  'pay',
  'buy now',
  'checkout now',
  'delete',
  'remove account',
  'subscribe',
  'confirm purchase',
];

/** One button or link as the probe reads it off a rendered page. */
export interface PageControl {
  /** Position in document.querySelectorAll(CONTROL_SELECTOR), so the probe clicks this exact element. */
  index: number;
  tag: string;
  /** 'link' for an anchor, 'button' otherwise. */
  role: 'button' | 'link';
  label: string;
  testid?: string;
  /** Absolute href, anchors only. */
  href?: string;
  /** True when the control carries the disabled attribute or aria-disabled="true" (an out-of-stock "Add to cart"). Never clicked. */
  disabled?: boolean;
}

/** A control whose words contain a trigger phrase, with the deny verdict. */
export interface TriggerControl extends PageControl {
  phrase: string;
  /** The deny phrase the control names; such a control is never clicked. */
  denied?: string;
  /** The locator as emitLocatorCall writes it, without the page receiver. */
  control: string;
}

/** The record every probe writes, revealed or not. */
export interface StateProbe {
  feature: string;
  outcome: 'revealed' | 'no-trigger' | 'no-new-link' | 'robots' | 'no-credentials' | 'error';
  /** Every page that qualified as an origin (a trigger that revealed a link), best first. */
  origins: string[];
  /** Every page and control the probe tried, in order, with what happened. */
  tried: Array<{ url: string; control?: string; result: string }>;
  /** The revealed page's URL, when outcome is revealed. */
  revealed?: string;
  /** One line: "revealed /checkout from /" or "no page revealed: tried /, /product/..." */
  detail: string;
  /** Every rule of the feature and its side: planned on the origin, or on the revealed page (splitRulesByPage). */
  rulesSplit: Array<{ ruleId: string; side: 'origin' | 'revealed' }>;
  /** Set when a cap stopped the probe with candidates left: the cap and every candidate path it did not try. */
  capped?: string;
  /**
   * Set when the trigger was found by the item hop (invariant 78): a
   * candidate with no trigger linked to item pages none of which was a
   * candidate, the probe followed the first one, and that item page is the
   * origin. `listing` is the page hopped from, `item` the item page used,
   * `control` the item link clicked. The item page is reached by that click
   * and never navigated to by its URL.
   */
  hop?: { listing: string; item: string; control: string };
  /**
   * Set when a trigger click revealed a link whose path robots.txt
   * disallows (invariant 78): the origin found, the revealed path and the
   * Disallow rule. The origin rules are still planned on that origin; the
   * revealed-side rules still uncited after planning read robots-disallowed.
   */
  robotsBlocked?: { origin: string; path: string; rule: string };
  /**
   * Set when the page was looked for behind the sign-in (invariant 88): the
   * login page the probe signed in on and the page the sign-in landed on.
   * `gated` is true when the revealed link also exists signed out and a
   * signed-out load of it ended on the login page.
   */
  login?: { loginUrl: string; landing: string; gated?: boolean };
}

/** A page handle in a fresh browser context. */
export interface ProbePageHandle {
  page: Page;
  close(): Promise<void>;
}

/** Opens a page in a FRESH context (no cookies, no storage). Injectable so smokes drive the probe against a fixture site. */
export type ProbePageFactory = () => Promise<ProbePageHandle>;

const CONTROL_SELECTOR = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

/**
 * Read the page's visible buttons and links. Function declarations only:
 * tsx wraps arrow functions assigned to consts with __name, which breaks in
 * page.evaluate (invariant 5). Exported so the browser crawl keeps them.
 */
export async function readControls(page: Pick<Page, 'evaluate'>): Promise<PageControl[]> {
  return page.evaluate((sel) => {
    const out: Array<{ index: number; tag: string; role: 'button' | 'link'; label: string; testid?: string; href?: string; disabled?: boolean }> = [];
    const els = Array.from(document.querySelectorAll(sel));
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as HTMLElement;
      if (el.getClientRects().length === 0) continue;
      const tag = el.tagName.toLowerCase();
      const label = (el.getAttribute('aria-label') || (el.innerText || '').trim() || (el as HTMLInputElement).value || el.getAttribute('title') || '').replace(/\s+/g, ' ').slice(0, 80);
      const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const href = tag === 'a' ? (el as HTMLAnchorElement).href : '';
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      out.push({ index: i, tag, role: tag === 'a' ? 'link' : 'button', label, ...(testid ? { testid } : {}), ...(href ? { href } : {}), ...(disabled ? { disabled: true } : {}) });
    }
    return out;
  }, CONTROL_SELECTOR);
}

/** The locator a control is recorded under: its test id, else its role and accessible name. */
export function controlLocator(c: Pick<PageControl, 'role' | 'label' | 'testid'>): string {
  const call = c.testid
    ? emitLocatorCall('testid', c.testid)
    : emitLocatorCall('role', { role: c.role, ...(c.label ? { name: c.label } : {}) });
  return call.replace(/^page\./, '');
}

/** True when the normalized words contain the phrase as whole words. */
function hasPhrase(words: string, phrase: string): boolean {
  return ` ${words} `.includes(` ${normalizeWords(phrase)} `);
}

/** The deny phrase a control's words name, or null. The phrase's last word may carry any ending. */
export function deniedBy(words: string): string | null {
  for (const phrase of STATE_TRIGGER_DENY) {
    const parts = normalizeWords(phrase).split(' ');
    const last = parts.pop()!;
    const rx = new RegExp(`(^| )${[...parts, `${last}[a-z]*`].join(' ')}( |$)`);
    if (rx.test(words)) return phrase;
  }
  return null;
}

/**
 * The controls whose normalized label or test id contains one of the
 * phrases, each with the phrase that matched and the deny verdict. A
 * disabled control is skipped: it can never be clicked (disabledTriggers
 * names it). Pure, so it reads a crawl's kept controls as well as a fresh
 * page's.
 */
export function findTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  return matchTriggers(controls.filter((c) => !c.disabled), phrases);
}

/** The disabled controls that would otherwise be triggers (an out-of-stock "Add to cart"), so the probe can say so. */
export function disabledTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  return matchTriggers(controls.filter((c) => c.disabled), phrases);
}

function matchTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  const out: TriggerControl[] = [];
  for (const c of controls) {
    const words = normalizeWords(`${c.label} ${c.testid ?? ''}`);
    const phrase = phrases.find((p) => hasPhrase(normalizeWords(c.label), p) || hasPhrase(normalizeWords(c.testid ?? ''), p));
    if (!phrase) continue;
    const denied = deniedBy(words);
    out.push({ ...c, phrase, ...(denied ? { denied } : {}), control: controlLocator(c) });
  }
  return out;
}

/** The trigger phrases for a feature's tokens, from STATE_TRIGGERS. Empty when no row applies. */
export function triggerPhrasesFor(tokens: string[]): string[] {
  const set = new Set(tokens.map((t) => t.toLowerCase()));
  return [...new Set(STATE_TRIGGERS.filter((row) => row.tokens.some((t) => set.has(t))).flatMap((row) => row.phrases))];
}

/** A feature's path tokens: the name's own plus the rule-content ones, when given. */
export function featureTokensOf(feature: string, featureTokens?: Record<string, string[]>): string[] {
  return [...new Set([...tokensFor(feature), ...(featureTokens?.[feature] ?? [])])];
}

/** How many of the feature's tokens a link names, by path segment, label or test id. 0 means no match. */
export function linkTokenMatches(link: Pick<PageControl, 'href' | 'label' | 'testid'>, tokens: string[]): number {
  let segments: string[] = [];
  try { segments = link.href ? new URL(link.href).pathname.toLowerCase().split('/').filter(Boolean) : []; } catch { segments = []; }
  const words = new Set(normalizeWords(`${link.label} ${link.testid ?? ''}`).split(' ').filter(Boolean));
  let n = 0;
  for (const tok of tokens) {
    const tokWords = normalizeWords(tok);
    if (segments.some((s) => segmentMatchesTokens(s, [tok])) || (tokWords.length > 0 && tokWords.split(' ').every((w) => words.has(w)))) n++;
  }
  return n;
}

/** origin + path, trailing slash and query and hash dropped. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return url;
  }
}

/** The path a human reads in a line. */
function pathOf(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

/* ── Rule split ───────────────────────────────────────────────────────────── */

/**
 * Which side each rule of a state-dependent feature is planned on. A rule
 * whose words name the trigger's action (the verb of the trigger phrase:
 * "add" as add, adds, adding, added) and do not name the revealed page is an
 * origin rule: R6 "Adding a product from its detail page increases the cart
 * count shown in the header" is verified before the cart link is followed.
 * Every other rule is a revealed-page rule. The revealed page is named by
 * "<feature token> page" ("cart page") or by a heading or title phrase of
 * two or more words read off the revealed page; a single-word heading such
 * as "Cart" is the feature's own noun and names nothing on its own. Judged on
 * the rule text from the requirements map, normalized like featureTokenMap
 * reads rule content, never on a scenario name the model wrote.
 */
export function splitRulesByPage(
  rules: Array<Pick<RequirementRule, 'id' | 'text'>>,
  opts: { tokens: string[]; phrases: string[]; revealedTitle?: string; revealedHeadings?: string[] },
): Array<{ ruleId: string; side: 'origin' | 'revealed' }> {
  const verbs = [...new Set(opts.phrases.map((p) => normalizeWords(p).split(' ')[0]!).filter(Boolean))];
  const verbRe = verbs.length > 0 ? new RegExp(`\\b(${verbs.join('|')})(s|es|ed|d|ing)?\\b`) : null;
  const tokenWords = opts.tokens.map((t) => normalizeWords(t)).filter(Boolean);
  const pageRe = tokenWords.length > 0 ? new RegExp(`\\b(${tokenWords.join('|')}) pages?\\b`) : null;
  const pagePhrases = [...(opts.revealedHeadings ?? []), ...(opts.revealedTitle ?? '').split(/[|:·•-]+/)]
    .map((h) => normalizeWords(h))
    .filter((h) => h.split(' ').length >= 2);
  return rules.map((r) => {
    const words = normalizeWords(r.text);
    const namesAction = !!verbRe && verbRe.test(words);
    const namesPage = (!!pageRe && pageRe.test(words)) || pagePhrases.some((p) => ` ${words} `.includes(` ${p} `));
    return { ruleId: r.id, side: namesAction && !namesPage ? 'origin' : 'revealed' };
  });
}

/* ── Detection ────────────────────────────────────────────────────────────── */

/** One feature the probe should run on: its tokens and the trigger phrases that apply. */
export interface StateCandidateFeature {
  feature: RequirementFeature;
  tokens: string[];
  phrases: string[];
}

/**
 * The state-dependent candidates: features with stated rules that no
 * candidate page carries by page evidence (an SRS-stated URL, or a path
 * segment matching the feature's tokens over EVERY candidate before the
 * filter) and whose tokens have a trigger row. A tag from the page filter's
 * model pick is never read: it is model text, not page evidence.
 */
export function detectStateFeatures(map: RequirementsMap | undefined, candidates: DiscoveredPage[], featureTokens?: Record<string, string[]>): StateCandidateFeature[] {
  if (!map) return [];
  const out: StateCandidateFeature[] = [];
  for (const f of map.features) {
    if (f.rules.length === 0) continue;
    if (candidates.some((p) => p.source === 'srs' && p.feature === f.name)) continue;
    if (pagesCarryingFeature(candidates.filter((p) => p.source !== 'action'), f.name, featureTokens).length > 0) continue;
    const tokens = featureTokensOf(f.name, featureTokens);
    const phrases = triggerPhrasesFor(tokens);
    if (phrases.length === 0) continue;
    out.push({ feature: f, tokens, phrases });
  }
  return out;
}

/* ── The probe ────────────────────────────────────────────────────────────── */

/** One crawl candidate as the probe sees it: its URL, whether it is volatile, which page linked to it, and the controls the crawl kept. */
export interface ProbeCandidate {
  url: string;
  volatile?: boolean;
  linkedFrom?: string;
  controls?: PageControl[];
  /** Set on an item page the probe reached by the item hop: the item link clicked on the listing (linkedFrom). */
  hopControl?: string;
}

export interface ProbeOptions {
  feature: string;
  tokens: string[];
  phrases: string[];
  /** The crawl candidates in crawl order (every page the winning rung found, before the filter). */
  candidates: ProbeCandidate[];
  robots?: Pick<RobotsInfo, 'disallow'>;
  /** Fresh-context page factory. Defaults to a headless Chromium launched only when a page must load. */
  openPage?: ProbePageFactory;
  /** Pause between page loads. Smokes set 0; the default is CRAWL_DELAY_MS. */
  delayMs?: number;
  /** How long to wait for a new link after a trigger click. */
  revealWaitMs?: number;
  /** The anchor settle cap before the pre-click read (discovery's waitForAnchors). */
  anchorWaitMs?: number;
  /** The settle cap for a loaded page. */
  settleCapMs?: number;
}

export interface ProbeResult {
  probe: Omit<StateProbe, 'rulesSplit'>;
  /** The revealed page, source 'action', with reachedBy. */
  page?: DiscoveredPage;
  /** The revealed page as the probe's own context saw it after the action. In memory only. */
  snapshot?: PageSnapshot;
  /** The trigger phrase that fired. */
  phrase?: string;
  /**
   * The origin when it is an item page the hop reached (revealed or robots):
   * source 'action', reachedBy the item click from the listing, and its
   * snapshot before the trigger click (in memory only).
   */
  originPage?: OriginPage;
  /** The origin a robots-blocked reveal found (outcome robots), so its origin rules are still planned there. */
  blocked?: { origin: string; originPage?: OriginPage };
}

/** An item page the hop made the origin: reached by clicking the item on the listing, never by its URL. */
export interface OriginPage {
  page: DiscoveredPage & { reachedBy: NonNullable<DiscoveredPage['reachedBy']> };
  snapshot: PageSnapshot;
}

interface Qualified {
  triggerUrl: string;
  triggerVolatile: boolean;
  origin: string;
  revealed: string;
  actions: ReachAction[];
  tokensMatched: number;
  depth: number;
  index: number;
  snapshot: PageSnapshot;
  phrase: string;
  /** Set when the trigger page was reached by the item hop. */
  hop?: { listing: string; item: string; control: string; snapshot: PageSnapshot };
}

/** A robots-blocked reveal: the origin found, the path and the rule, and the hop when the origin is an item page. */
interface Blocked {
  triggerVolatile: boolean;
  origin: string;
  path: string;
  rule: string;
  depth: number;
  index: number;
  hop?: { listing: string; item: string; control: string; snapshot: PageSnapshot };
}

/**
 * The item links on a page, in document order: same-origin anchors whose
 * path carries a generated id (isVolatilePath, the kind discovery tags
 * volatile, such as /product/<ulid>). Category and other stable listings are
 * never item links, so a hop never lands on another listing.
 */
export function itemLinks(controls: PageControl[], pageUrl: string): PageControl[] {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const seen = new Set<string>();
  return controls.filter((c) => {
    if (c.role !== 'link' || !c.href) return false;
    let u: URL;
    try { u = new URL(c.href); } catch { return false; }
    if (u.origin !== origin || !isVolatilePath(u.pathname)) return false;
    const key = pageKey(c.href);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The locator an item link is clicked by: its test id when the test id holds
 * no generated id, else its role and visible name (gate RULE 6 refuses a
 * selector that embeds a generated id). A card's name often ends with its
 * price ("Combination Pliers $14.15"); the name is cut before the first
 * currency amount, because gate RULE 8 refuses a price in a locator name.
 */
export function itemLinkLocator(c: Pick<PageControl, 'label' | 'testid'>): string {
  const testid = c.testid && !generatedIdFragment(c.testid) ? c.testid : undefined;
  const price = currencyAmountIn(c.label);
  const name = price ? c.label.slice(0, c.label.indexOf(price)).trim() || c.label : c.label;
  return controlLocator({ role: 'link', label: name, ...(testid ? { testid } : {}) });
}

/** The nearest stable page up the linkedFrom chain, or null. */
function stableAncestor(c: ProbeCandidate, byUrl: Map<string, ProbeCandidate>): string | null {
  let cur: string | undefined = c.linkedFrom;
  for (let hops = 0; cur && hops < 6; hops++) {
    let volatile = false;
    try { volatile = isVolatilePath(new URL(cur).pathname); } catch { return null; }
    if (!volatile) return cur;
    cur = byUrl.get(cur)?.linkedFrom;
  }
  return null;
}

/** Same-origin anchors that are new against a path set and name the feature, best match first. */
function newMatchingLinks(anchors: PageControl[], before: Set<string>, origin: string, tokens: string[]): Array<{ a: PageControl; n: number }> {
  const out: Array<{ a: PageControl; n: number }> = [];
  for (const a of anchors) {
    if (a.role !== 'link' || !a.href) continue;
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (u.origin !== origin) continue;
    if (before.has(pageKey(a.href))) continue;
    const n = linkTokenMatches(a, tokens);
    if (n > 0) out.push({ a, n });
  }
  return out.sort((x, y) => y.n - x.n);
}

/**
 * Probe one feature. Looks for a trigger on at most STATE_PROBE_PAGE_CAP
 * loaded pages (a page whose controls the browser crawl kept is judged from
 * that load), stable before volatile, then shallowest, then crawl order;
 * clicks at most STATE_PROBE_CLICK_CAP triggers, each in a fresh context,
 * never a denied control; takes as revealed a same-origin anchor that was
 * absent before the click and names the feature's tokens; follows it in the
 * same context and snapshots the page. Robots is honored for the page loaded
 * and for the revealed path. Never throws: a browser failure is outcome
 * error with its message.
 */
export async function probeStateFeature(opts: ProbeOptions): Promise<ProbeResult> {
  const { feature, tokens, phrases } = opts;
  const robots = opts.robots ?? { disallow: [] };
  const delayMs = opts.delayMs ?? CRAWL_DELAY_MS;
  const revealWaitMs = opts.revealWaitMs ?? STATE_PROBE_REVEAL_WAIT_MS;
  const tried: StateProbe['tried'] = [];
  const qualified: Qualified[] = [];
  const blocked: Blocked[] = [];
  const byUrl = new Map(opts.candidates.map((c) => [c.url, c]));
  const candidateKeys = new Set(opts.candidates.map((c) => pageKey(c.url)));
  const ordered = opts.candidates
    .map((c, i) => ({ c, i, volatile: c.volatile ?? (() => { try { return isVolatilePath(new URL(c.url).pathname); } catch { return false; } })(), depth: pathOf(c.url).split('/').filter(Boolean).length }))
    .sort((a, b) => Number(a.volatile) - Number(b.volatile) || a.depth - b.depth || a.i - b.i);
  // The item hop (invariant 78): a page with no trigger whose item links are
  // none of them candidates gets its FIRST item link tried right after it,
  // as a page of its own (a load against the page cap, after the delay,
  // robots checked). When an item page is already a candidate it is probed
  // on its own, as before.
  const hopFrom = (c: ProbeCandidate, controls: PageControl[], volatile: boolean): { item: PageControl; control: string } | null => {
    // One hop, from a stable listing only: an item page never hops again.
    if (c.hopControl || volatile) return null;
    const items = itemLinks(controls, c.url);
    if (items.length === 0 || items.some((l) => candidateKeys.has(pageKey(l.href!)))) return null;
    return { item: items[0]!, control: itemLinkLocator(items[0]!) };
  };

  let loads = 0;
  let clicks = 0;
  let robotsBlocked = false;
  let browserClose: (() => Promise<void>) | undefined;
  let open = opts.openPage;
  const openFresh = async (): Promise<ProbePageHandle> => {
    if (!open) {
      const d = await defaultPageFactory();
      open = d.open;
      browserClose = d.close;
    }
    return open();
  };

  // Every page that ended in an error, with the step and the message. A
  // failure is recorded on its own candidate and never ends the probe.
  const errored: Array<{ url: string; result: string }> = [];
  // Clicks that completed without qualifying (no new link, a denied link, no stable origin).
  let cleanMisses = 0;
  const pageCapUntried: string[] = [];
  let clickCapUntried: string[] = [];

  /** The item page a hop made the origin, reached by clicking the item on the listing. */
  const originPageOf = (feature: string, hop: NonNullable<Qualified['hop']>): OriginPage => ({
    page: {
      url: pageKey(hop.item),
      source: 'action',
      feature,
      volatile: true,
      reachedBy: { origin: hop.listing, feature, actions: [{ kind: 'click', via: 'item-link', control: hop.control }] },
    },
    snapshot: hop.snapshot,
  });
  const hopRecord = (hop: Qualified['hop']): Pick<StateProbe, 'hop'> => (hop ? { hop: { listing: hop.listing, item: pageKey(hop.item), control: hop.control } } : {});

  const finish = (globalError?: string): ProbeResult => {
    qualified.sort((a, b) => Number(a.triggerVolatile) - Number(b.triggerVolatile) || b.tokensMatched - a.tokensMatched || a.depth - b.depth || a.index - b.index);
    blocked.sort((a, b) => Number(a.triggerVolatile) - Number(b.triggerVolatile) || a.depth - b.depth || a.index - b.index);
    const best = qualified[0];
    const triedPaths = tried.map((t) => pathOf(t.url)).filter((p, i, a) => a.indexOf(p) === i);
    const capNotes = [
      ...(pageCapUntried.length > 0 ? [`page cap ${STATE_PROBE_PAGE_CAP} reached; not tried: ${pageCapUntried.join(', ')}`] : []),
      ...(clickCapUntried.length > 0 ? [`click cap ${STATE_PROBE_CLICK_CAP} reached; not tried: ${clickCapUntried.join(', ')}`] : []),
    ];
    const capped = capNotes.length > 0 ? capNotes.join('; ') : undefined;
    const capSuffix = capped ? `; ${capped}` : '';
    // A page that qualified is never discarded by a later failure.
    if (best) {
      const page: DiscoveredPage = { url: best.revealed, source: 'action', feature, reachedBy: { origin: best.origin, feature, actions: best.actions } };
      // With the hop, the item page is the origin (it holds the trigger); a
      // scenario still starts on the listing and clicks the item.
      const originOf = (q: Qualified): string => (q.hop ? pageKey(q.hop.item) : q.origin);
      return {
        probe: {
          feature,
          outcome: 'revealed',
          origins: qualified.map(originOf).filter((o, i, a) => a.indexOf(o) === i),
          tried,
          revealed: best.revealed,
          detail: best.hop
            ? `revealed ${pathOf(best.revealed)} from item page ${pathOf(best.hop.item)}, hopped from listing ${pathOf(best.hop.listing)}${capSuffix}`
            : `revealed ${pathOf(best.revealed)} from ${pathOf(best.origin)}${capSuffix}`,
          ...(capped ? { capped } : {}),
          ...hopRecord(best.hop),
        },
        page,
        snapshot: best.snapshot,
        phrase: best.phrase,
        ...(best.hop ? { originPage: originPageOf(feature, best.hop) } : {}),
      };
    }
    // Nothing qualified. robots first, then a click that completed and found
    // no link, then errors: 'error' only when every page the probe acted on
    // (loaded, clicked) failed with one, never when a clean result exists.
    const outcome: StateProbe['outcome'] = globalError
      ? 'error'
      : robotsBlocked ? 'robots' : cleanMisses > 0 ? 'no-new-link' : errored.length > 0 ? 'error' : 'no-trigger';
    const triedText = triedPaths.length > 0 ? `tried ${triedPaths.join(', ')}` : 'no candidate page to try';
    const robotsHit = tried.find((t) => /robots\.txt disallows/.test(t.result));
    const detail = globalError
      ? `no page revealed: probe error (${globalError}); ${triedText}${capSuffix}`
      : outcome === 'error'
        ? `no page revealed: probe error on ${errored.map((e) => `${pathOf(e.url)} (${e.result})`).join(', ')}; ${triedText}${capSuffix}`
        : `no page revealed: ${triedText}${outcome === 'robots' && robotsHit ? `; ${robotsHit.result}` : ''}${capSuffix}`;
    // A robots-blocked reveal still found an origin: its origin rules are
    // planned there (invariant 78), the hop's item page reached by action.
    const b = outcome === 'robots' ? blocked[0] : undefined;
    return {
      probe: {
        feature, outcome, origins: [], tried, detail, ...(capped ? { capped } : {}),
        ...(b ? { robotsBlocked: { origin: b.hop ? pageKey(b.hop.item) : b.origin, path: b.path, rule: b.rule }, ...hopRecord(b.hop) } : {}),
      },
      ...(b ? { blocked: { origin: b.origin, ...(b.hop ? { originPage: originPageOf(feature, b.hop) } : {}) } } : {}),
    };
  };

  /** One line of a Playwright error: its first line, without the trailing full stop. */
  const brief = (err: unknown): string => ((err as Error)?.message ?? String(err)).split('\n')[0]!.trim().replace(/\.$/, '');

  try {
    for (let k = 0; k < ordered.length; k++) {
      const { c, volatile, depth, i } = ordered[k]!;
      if (clicks >= STATE_PROBE_CLICK_CAP) {
        // The click cap stopped the probe: every candidate left is named.
        clickCapUntried = ordered.slice(k).map((o) => pathOf(o.c.url));
        break;
      }
      let path = '/';
      try { path = new URL(c.url).pathname; } catch { continue; }
      if (!robotsAllows(robots, path)) {
        tried.push({ url: c.url, result: `robots.txt disallows ${path}` });
        robotsBlocked = true;
        continue;
      }
      /** The tried entry for a page with no usable trigger; it queues the item hop when the page has one. */
      const noTrigger = (controls: PageControl[], triggers: TriggerControl[]): void => {
        const result = disabledResult(disabledTriggers(controls, phrases)) ?? deniedResult(triggers) ?? 'no trigger';
        const hop = result === 'no trigger' ? hopFrom(c, controls, volatile) : null;
        if (!hop) { tried.push({ url: c.url, result }); return; }
        const itemUrl = pageKey(hop.item.href!);
        tried.push({ url: c.url, result: `no trigger; hopped to item page ${pathOf(itemUrl)} by ${hop.control}` });
        let itemDepth = 0;
        try { itemDepth = new URL(itemUrl).pathname.split('/').filter(Boolean).length; } catch { itemDepth = 0; }
        ordered.splice(k + 1, 0, { c: { url: itemUrl, volatile: true, linkedFrom: c.url, hopControl: hop.control }, i, volatile: true, depth: itemDepth });
      };
      // A page the browser crawl already read is judged from that load.
      if (c.controls) {
        const known = findTriggers(c.controls, phrases);
        if (!known.some((t) => !t.denied)) {
          noTrigger(c.controls, known);
          continue;
        }
      }
      if (loads >= STATE_PROBE_PAGE_CAP) {
        // The page cap: this page needed a load. Pages the crawl read are still judged.
        pageCapUntried.push(path);
        continue;
      }
      if (loads > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      loads++;
      // Each candidate's work is its own: a failure names the step on THIS
      // page and the probe moves on to the next candidate.
      let fail = (msg: string): string => `opening a browser page failed (${msg})`;
      let handle: ProbePageHandle | undefined;
      let clicked: string | undefined;
      try {
        handle = await openFresh();
        const { page } = handle;
        fail = (msg) => `load failed (${msg})`;
        await page.goto(c.url, { waitUntil: 'load', timeout: 15_000 });
        fail = (msg) => `reading the page failed (${msg})`;
        await settleForSnapshot(page, opts.settleCapMs);
        await waitForAnchors(page, opts.anchorWaitMs);
        const controls = await readControls(page);
        const triggers = findTriggers(controls, phrases);
        const usable = triggers.filter((t) => !t.denied);
        if (usable.length === 0) {
          noTrigger(controls, triggers);
          continue;
        }
        const trigger = usable[0]!;
        clicked = trigger.control;
        // An item page the hop reached is the origin: its snapshot before the
        // trigger click is what its origin rules are planned from.
        const hop = c.hopControl && c.linkedFrom
          ? { listing: c.linkedFrom, item: c.url, control: c.hopControl, snapshot: await snapshotPage(page) }
          : undefined;
        const before = new Set((await readControls(page)).filter((a) => a.role === 'link' && a.href).map((a) => pageKey(a.href!)));
        before.add(pageKey(page.url()));
        clicks++;
        fail = (msg) => `clicked ${trigger.control} failed (${msg})`;
        await page.locator(CONTROL_SELECTOR).nth(trigger.index).click({ timeout: 5000 });
        // Read the anchors again until a new one names the feature, or the wait ends.
        const deadline = Date.now() + revealWaitMs;
        let links: Array<{ a: PageControl; n: number }> = [];
        const origin = new URL(c.url).origin;
        while (Date.now() <= deadline) {
          try { links = newMatchingLinks(await readControls(page), before, origin, tokens); } catch { links = []; }
          if (links.length > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (links.length === 0) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, no new ${feature} link within ${revealWaitMs} ms` });
          cleanMisses++;
          continue;
        }
        // The deny list is checked before every click, the link's too.
        const allowed = links.filter((l) => !deniedBy(normalizeWords(`${l.a.label} ${l.a.testid ?? ''}`)));
        if (allowed.length === 0) {
          const d = links[0]!.a;
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, the new link ${controlLocator(d)} names "${deniedBy(normalizeWords(`${d.label} ${d.testid ?? ''}`))}" and was never clicked` });
          cleanMisses++;
          continue;
        }
        const link = allowed[0]!;
        const revealedPath = new URL(link.a.href!).pathname;
        const linkControl = controlLocator(link.a);
        // Only a qualifying page's entry says "revealed"; these say what appeared.
        const originUrl = volatile ? stableAncestor(c, byUrl) : c.url;
        const revealedRule = robotsRuleFor(robots, revealedPath);
        if (revealedRule !== null) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, a new link to ${revealedPath} appeared, but robots.txt disallows ${revealedPath}` });
          robotsBlocked = true;
          // The origin is still found: its origin rules are planned there.
          if (originUrl) blocked.push({ triggerVolatile: volatile, origin: originUrl, path: revealedPath, rule: revealedRule, depth, index: i, ...(hop ? { hop } : {}) });
          continue;
        }
        if (!originUrl) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, a new link to ${revealedPath} appeared, but no stable page links to this volatile page` });
          cleanMisses++;
          continue;
        }
        // Follow the revealed link in the same context, so the snapshot is
        // the page with the action's state in it (one item in the cart).
        fail = (msg) => `clicked ${trigger.control}, a new link to ${revealedPath} appeared, then clicking ${linkControl} failed (${msg})`;
        await page.locator(CONTROL_SELECTOR).nth(link.a.index).click({ timeout: 5000 });
        await page.waitForURL((u) => pageKey(u.toString()) === pageKey(link.a.href!), { timeout: 10_000 }).catch(() => {});
        await page.waitForLoadState('load').catch(() => {});
        fail = (msg) => `clicked ${trigger.control} and ${linkControl}, but the snapshot of ${revealedPath} failed (${msg})`;
        await settleForSnapshot(page, opts.settleCapMs);
        const snapshot = await snapshotPage(page);
        const revealed = pageKey(link.a.href!);
        const actions: ReachAction[] = [
          ...(volatile ? [(hop ? { kind: 'click', via: 'item-link', control: hop.control } : { kind: 'click', via: 'item-link' }) as ReachAction] : []),
          { kind: 'click', control: trigger.control },
          { kind: 'click', control: linkControl },
        ];
        tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, revealed ${revealedPath}` });
        qualified.push({ triggerUrl: c.url, triggerVolatile: volatile, origin: originUrl, revealed, actions, tokensMatched: link.n, depth, index: i, snapshot, phrase: trigger.phrase, ...(hop ? { hop } : {}) });
      } catch (err) {
        const result = fail(brief(err));
        tried.push({ url: c.url, ...(clicked ? { control: clicked } : {}), result });
        errored.push({ url: c.url, result });
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return finish();
  } catch (err) {
    return finish(brief(err) || 'unknown error');
  } finally {
    await browserClose?.().catch(() => {});
  }
}

/** The tried result for a page whose only triggers are disabled, or null when none is. */
function disabledResult(triggers: TriggerControl[]): string | null {
  const d = triggers[0];
  return d ? `trigger disabled (${d.control})` : null;
}

/** The tried result for a page whose only triggers are denied, or null when none is. */
function deniedResult(triggers: TriggerControl[]): string | null {
  const d = triggers.find((t) => t.denied);
  return d ? `never clicked ${d.control} (names "${d.denied}")` : null;
}

/** A headless Chromium with a fresh context per page, the discovery user agent and the eval shim. */
async function defaultPageFactory(): Promise<{ open: ProbePageFactory; close: () => Promise<void> }> {
  const { chromium } = await import('playwright');
  const { installEvalShim } = await import('./eval-shim.js');
  const browser = await chromium.launch({ headless: true });
  return {
    open: async () => {
      const ctx = await browser.newContext({ userAgent: DISCOVERY_UA });
      await installEvalShim(ctx);
      const page = await ctx.newPage();
      return { page, close: () => ctx.close() };
    },
    close: () => browser.close(),
  };
}

/* ── The login action (invariant 88) ──────────────────────────────────────── */

/**
 * Feature tokens that name a page behind a sign-in (design brief section 7).
 * Used for two narrow decisions only, never to find a page: a feature with
 * these tokens and no page is named as not looked for when the run has no
 * test account, and a feature with these tokens whose ONE page is also linked
 * signed out is checked for a login wall.
 */
export const LOGIN_GATED_TOKENS: readonly string[] = ['account', 'profile', 'orders', 'order', 'invoices', 'invoice', 'favorites', 'favorite', 'favourites', 'favourite'];
/** Most pages the login probe reveals per run. */
export const LOGIN_PROBE_REVEAL_CAP = 3;
/** Most signed-out loads the login probe makes per run to check for a login wall. */
export const LOGIN_GATE_CHECK_CAP = 3;
/** A link that ends the session is never followed. Whole words, like the deny list. */
export const LOGIN_LINK_DENY: readonly string[] = ['log out', 'logout', 'sign out', 'signout', 'log off'];

/** The test account and where to sign in. Values are typed into the page and never written anywhere. */
export interface LoginAccess {
  /** The run URL. */
  url: string;
  /** The --login-url value, when one was given. */
  loginUrl?: string;
  user: string;
  pass: string;
}

/** One requirements feature as the login probe judges it. */
export interface LoginCandidateFeature {
  feature: RequirementFeature;
  tokens: string[];
  /** The crawl candidates that carry the feature by page evidence, as page keys. Empty when none does. */
  carriedBy: string[];
  /** True when the feature's tokens meet LOGIN_GATED_TOKENS. */
  gatedTokens: boolean;
}

/**
 * The features the login probe judges: every feature with stated rules and
 * no SRS-stated page, with the candidates that carry it by page evidence
 * (path segments, never a model-written tag). A feature that at least two
 * candidates carry is never moved behind the sign-in; the probe decides the
 * rest from the links it reads off the page.
 */
export function detectLoginFeatures(map: RequirementsMap | undefined, candidates: DiscoveredPage[], featureTokens?: Record<string, string[]>): LoginCandidateFeature[] {
  if (!map) return [];
  const gated = new Set(LOGIN_GATED_TOKENS);
  const out: LoginCandidateFeature[] = [];
  for (const f of map.features) {
    if (f.rules.length === 0) continue;
    if (candidates.some((p) => p.source === 'srs' && p.feature === f.name)) continue;
    const tokens = featureTokensOf(f.name, featureTokens);
    const carriedBy = [...new Set(pagesCarryingFeature(candidates.filter((p) => p.source !== 'action'), f.name, featureTokens).map((p) => pageKey(p.url)))];
    if (carriedBy.length > 1) continue;
    out.push({ feature: f, tokens, carriedBy, gatedTokens: tokens.some((t) => gated.has(t.toLowerCase())) });
  }
  return out;
}

/** The feature a page behind the sign-in is filed under when no requirements map names one: its last path segment, as a slug. */
export function featureFromPath(url: string): string {
  let segments: string[] = [];
  try { segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean); } catch { segments = []; }
  const last = (segments[segments.length - 1] ?? 'account').replace(/\.[a-z0-9]+$/, '');
  return last.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
}

/** The deny phrase a link after sign-in names (the deny list, or a link that ends the session), or null. */
export function loginLinkDenied(link: Pick<PageControl, 'label' | 'testid'>): string | null {
  const words = normalizeWords(`${link.label} ${link.testid ?? ''}`);
  return deniedBy(words) ?? LOGIN_LINK_DENY.find((p) => hasPhrase(words, p)) ?? null;
}

/**
 * The locator a link behind the sign-in is clicked by. A header often shows
 * the signed-in user's own email as the link text; such a label is never
 * written into a locator (invariant 70 g), the link is named by its path.
 */
export function loginLinkLocator(link: Pick<PageControl, 'role' | 'label' | 'testid' | 'href'>, user: string): string {
  const u = user.trim().toLowerCase();
  if (!link.testid && u !== '' && link.label.toLowerCase().includes(u)) {
    let p = '';
    try { p = new URL(link.href ?? '').pathname; } catch { p = ''; }
    if (p) return emitLocatorCall('css', `a[href$=${JSON.stringify(p)}]`).replace(/^page\./, '');
  }
  return controlLocator(link);
}

/** Every string of a snapshot with the test account's identifier replaced, so the Planner never reads it and so never writes it into a name. */
export function withoutIdentifier<T>(value: T, user: string): T {
  const u = user.trim();
  if (u === '') return value;
  const rx = new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(rx, '[the test account]');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** What the login probe found for one feature. */
export interface LoginFeatureResult {
  feature: string;
  tried: StateProbe['tried'];
  /** The page behind the sign-in, when one was revealed. */
  page?: DiscoveredPage & { reachedBy: NonNullable<DiscoveredPage['reachedBy']> };
  snapshot?: PageSnapshot;
  /** True when the revealed link also exists signed out and is a login wall there. */
  gated?: boolean;
  /** Set when the link was found and robots.txt disallows its path. */
  robots?: { path: string; rule: string };
  /** One line: what was revealed, or why nothing was. */
  detail: string;
  /** True when a load or a click failed for this feature. */
  errored?: boolean;
}

export interface LoginProbeResult {
  /** The sign-in itself: ok, failed (the form refused the account), unreached (no login page), or error (a browser failure). */
  outcome: PreflightLoginResult['outcome'] | 'error';
  loginUrl?: string;
  landing?: string;
  /** One entry per feature the probe judged and has something to say about. A feature it had no reason to touch is absent. */
  features: LoginFeatureResult[];
  /** Same-origin links that appeared only after sign-in, as paths, in page order. */
  newLinks: string[];
  /** The new links no feature claimed and the probe did not reveal, as paths. */
  unnamed: string[];
  /** The one console line for the probe, printed whole. */
  line: string;
}

export interface LoginProbeOptions {
  access: LoginAccess;
  /** The map's features to judge (detectLoginFeatures). Empty with no map. */
  features: LoginCandidateFeature[];
  /**
   * No requirements map: reveal the new links themselves, each filed under
   * `featureFromPath`, or under the listed feature whose tokens it names when
   * `names` is given (the --features list).
   */
  open?: { names?: string[] };
  /** Every crawl candidate, to know which links the crawl already found signed out. */
  candidates: Array<{ url: string }>;
  robots?: Pick<RobotsInfo, 'disallow'>;
  openPage?: ProbePageFactory;
  delayMs?: number;
  anchorWaitMs?: number;
  settleCapMs?: number;
  /** Test seam: replaces the sign-in. */
  signIn?: typeof signInOn;
}

/**
 * The login probe (invariant 88): sign in once with the test account in one
 * browser context, read the links the page shows, and reveal the pages
 * behind the sign-in. A link counts for a feature when it names the
 * feature's tokens and either appeared only after the sign-in, or exists
 * signed out too and a signed-out load of it ends on the login page (a login
 * wall). The sign-in types the correct password once, so it adds nothing to
 * the wrong-password count. The session lives in the probe's own context and
 * is never written to disk. Never throws.
 */
export async function probeLogin(opts: LoginProbeOptions): Promise<LoginProbeResult> {
  const robots = opts.robots ?? { disallow: [] };
  const delayMs = opts.delayMs ?? CRAWL_DELAY_MS;
  const candidateKeys = new Set(opts.candidates.map((c) => pageKey(c.url)));
  const results = new Map<string, LoginFeatureResult>();
  const resultFor = (feature: string): LoginFeatureResult => {
    let r = results.get(feature);
    if (!r) { r = { feature, tried: [], detail: '' }; results.set(feature, r); }
    return r;
  };
  const brief = (err: unknown): string => ((err as Error)?.message ?? String(err)).split('\n')[0]!.trim().replace(/\.$/, '');
  const pause = async (): Promise<void> => { if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs)); };

  let browserClose: (() => Promise<void>) | undefined;
  let open = opts.openPage;
  const openFresh = async (): Promise<ProbePageHandle> => {
    if (!open) {
      const d = await defaultPageFactory();
      open = d.open;
      browserClose = d.close;
    }
    return open();
  };
  /** Every feature with no page gets the same reason when the sign-in itself did not work. */
  const failAll = (outcome: LoginProbeResult['outcome'], why: string, loginUrl?: string): LoginProbeResult => {
    const features = opts.features.filter((f) => f.carriedBy.length === 0).map((f): LoginFeatureResult => ({
      feature: f.feature.name,
      tried: [{ url: loginUrl ?? opts.access.url, result: why }],
      detail: `no page revealed: ${why}`,
      errored: true,
    }));
    return { outcome, ...(loginUrl ? { loginUrl } : {}), features, newLinks: [], unnamed: [], line: `Login probe: ${why}; no page behind the sign-in was looked for.` };
  };

  let handle: ProbePageHandle | undefined;
  try {
    handle = await openFresh();
    const page = handle.page;
    page.setDefaultTimeout(15_000);
    let before = new Set<string>();
    const signed = await (opts.signIn ?? signInOn)(page, { url: opts.access.url, ...(opts.access.loginUrl ? { loginUrl: opts.access.loginUrl } : {}), user: opts.access.user, pass: opts.access.pass }, {
      beforeSubmit: async (p) => {
        before = new Set((await readControls(p)).filter((a) => a.role === 'link' && a.href).map((a) => pageKey(a.href!)));
      },
    });
    if (signed.outcome === 'unreached') return failAll('unreached', `no login page was found (tried ${signed.tried.map(pathOf).join(', ')})`);
    // The page's own words are left out: a login error can repeat the address typed.
    if (signed.outcome !== 'ok' || !signed.loginUrl) return failAll('failed', `the sign-in on ${pathOf(signed.loginUrl ?? opts.access.url)} gave no positive signal`, signed.loginUrl);

    const loginKey = pageKey(signed.loginUrl);
    await page.waitForLoadState('load').catch(() => {});
    await settleForSnapshot(page, opts.settleCapMs);
    await waitForAnchors(page, opts.anchorWaitMs);
    const landing = pageKey(page.url());
    const origin = new URL(landing).origin;
    const sameOrigin = (href: string): boolean => { try { return new URL(href).origin === origin; } catch { return false; } };
    /**
     * The links the signed-in page shows right now: same origin, never the
     * login page, never the page itself, one per target page. An anchor with
     * href="#" (a menu toggle) resolves to the page it sits on; it is no link
     * to a page, and its label ("Categories") must never name one.
     */
    const readLinks = async (): Promise<PageControl[]> => {
      const seen = new Set<string>();
      const here = pageKey(page.url());
      return (await readControls(page)).filter((a) => {
        if (a.role !== 'link' || !a.href || !sameOrigin(a.href)) return false;
        const key = pageKey(a.href);
        if (key === loginKey || key === here || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const back = async (): Promise<void> => {
      if (pageKey(page.url()) === landing) return;
      await pause();
      await page.goto(landing, { waitUntil: 'load', timeout: 15_000 });
      await settleForSnapshot(page, opts.settleCapMs);
      await waitForAnchors(page, opts.anchorWaitMs);
    };
    const links = await readLinks();
    // The page the sign-in landed on is a page behind the sign-in too, reached
    // by the sign-in alone. It is named by its path only, never by a label.
    const landingLink: PageControl | null = landing !== loginKey ? { index: -1, tag: 'a', role: 'link', label: '', href: landing } : null;
    const all = [...(landingLink ? [landingLink] : []), ...links];
    const isNew = (l: PageControl): boolean => !before.has(pageKey(l.href!)) && !candidateKeys.has(pageKey(l.href!));
    const followable = (l: PageControl): boolean => {
      try { if (isVolatilePath(new URL(l.href!).pathname)) return false; } catch { return false; }
      return loginLinkDenied(l) === null;
    };
    const newLinks = all.filter((l) => isNew(l) && followable(l));
    const revealedKeys = new Set<string>();
    let reveals = 0;
    let gateChecks = 0;

    /** A signed-out load of the link: a login wall when it ends on another path that is the login page or shows a password field. */
    const loginWall = async (href: string): Promise<{ wall: boolean; final: string }> => {
      await pause();
      const h = await openFresh();
      try {
        await h.page.goto(href, { waitUntil: 'load', timeout: 15_000 });
        await settleForSnapshot(h.page, opts.settleCapMs);
        // A client-side guard redirects a moment after the shell loads.
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && pageKey(h.page.url()) === pageKey(href)) await new Promise((r) => setTimeout(r, 150));
        const final = pageKey(h.page.url());
        if (final === pageKey(href)) return { wall: false, final };
        const finalPath = pathOf(final).replace(/\/+$/, '') || '/';
        const password = (await h.page.locator('input[type="password"]').count().catch(() => 0)) > 0;
        return { wall: final === loginKey || LOGIN_PATHS.includes(finalPath) || password, final };
      } finally {
        await h.close().catch(() => {});
      }
    };

    /** Follow the link in the signed-in context and snapshot what it opens. */
    const reveal = async (feature: string, link: PageControl, gated: boolean): Promise<void> => {
      const r = resultFor(feature);
      const target = pageKey(link.href!);
      const path = pathOf(target);
      const viaLanding = target === landing;
      const control = viaLanding ? undefined : loginLinkLocator(link, opts.access.user);
      try {
        await back();
        if (!viaLanding) {
          const now = (await readControls(page)).find((a) => a.role === 'link' && a.href && pageKey(a.href) === target);
          if (!now) {
            r.tried.push({ url: landing, ...(control ? { control } : {}), result: `signed in, the link to ${path} was no longer on ${pathOf(landing)}` });
            r.errored = true;
            r.detail = `no page revealed: signed in on ${pathOf(loginKey)}, the link to ${path} was no longer on ${pathOf(landing)}`;
            return;
          }
          await pause();
          await page.locator(CONTROL_SELECTOR).nth(now.index).click({ timeout: 5000 });
          await page.waitForURL((u) => pageKey(u.toString()) === target, { timeout: 10_000 }).catch(() => {});
          await page.waitForLoadState('load').catch(() => {});
        }
        await settleForSnapshot(page, opts.settleCapMs);
        const snapshot = withoutIdentifier(await snapshotPage(page), opts.access.user);
        const actions: ReachAction[] = [{ kind: 'login' }, ...(control ? [{ kind: 'click', control } as ReachAction] : [])];
        r.page = { url: target, source: 'action', feature, reachedBy: { origin: loginKey, feature, actions } };
        r.snapshot = snapshot;
        if (gated) r.gated = true;
        r.tried.push({ url: landing, ...(control ? { control } : {}), result: viaLanding ? `signed in, landed on ${path}` : `signed in, clicked ${control}, revealed ${path}` });
        r.detail = `revealed ${path} after sign-in on ${pathOf(loginKey)}${gated ? ` (signed out, ${path} ends on the login page)` : ''}`;
        revealedKeys.add(target);
        reveals++;
      } catch (err) {
        r.tried.push({ url: landing, ...(control ? { control } : {}), result: `signed in, opening ${path} failed (${brief(err)})` });
        r.errored = true;
        r.detail = `no page revealed: signed in on ${pathOf(loginKey)}, opening ${path} failed (${brief(err)})`;
      }
    };

    // Every (feature, link) pair where the link names the feature, best
    // first: a link whose last path segment is the feature's own name, then
    // one whose last segment is any of its tokens, then a link that appeared
    // only after sign-in, then the shallower path, then the most tokens. A
    // feature takes one link and a link serves one feature, so "account"
    // (whose tokens include "profile") never takes /account/profile from a
    // feature called "profile".
    const lastSegment = (l: PageControl): string => {
      try { return new URL(l.href!).pathname.toLowerCase().split('/').filter(Boolean).pop() ?? ''; } catch { return ''; }
    };
    const depthOf = (l: PageControl): number => pathOf(pageKey(l.href!)).split('/').filter(Boolean).length;
    /** The feature's own name as path segments read it: the whole name hyphenated, and each of its words. */
    const nameSlugs = (name: string): string[] => {
      const w = name.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return [...new Set([w.join('-'), ...w])];
    };
    const pairs = opts.features.flatMap((f, order) => all
      .filter((l) => followable(l))
      .map((l) => ({
        f,
        order,
        l,
        n: linkTokenMatches(l, f.tokens),
        own: segmentMatchesTokens(lastSegment(l), nameSlugs(f.feature.name)),
        last: segmentMatchesTokens(lastSegment(l), f.tokens),
        fresh: isNew(l),
      }))
      .filter((m) => m.n > 0))
      .sort((x, y) => Number(y.own) - Number(x.own) || Number(y.last) - Number(x.last) || Number(y.fresh) - Number(x.fresh) || depthOf(x.l) - depthOf(y.l) || y.n - x.n || x.order - y.order || x.l.index - y.l.index);
    const done = new Set<string>();
    for (const m of pairs) {
      const f = m.f;
      const name = f.feature.name;
      const target = pageKey(m.l.href!);
      if (done.has(name) || revealedKeys.has(target)) continue;
      const noPage = f.carriedBy.length === 0;
      const path = pathOf(target);
      let gated = false;
      if (m.fresh) {
        // A public feature that merely gains a link after sign-in keeps its own page.
        if (!noPage) continue;
      } else {
        // The link exists signed out too: only a login wall makes it a page behind the sign-in.
        const onlyCarrier = noPage || (f.gatedTokens && f.carriedBy.length === 1 && f.carriedBy[0] === target);
        if (!onlyCarrier) continue;
        const r = resultFor(name);
        if (gateChecks >= LOGIN_GATE_CHECK_CAP) {
          r.tried.push({ url: target, result: `signed-out check cap ${LOGIN_GATE_CHECK_CAP} reached; ${path} not checked for a login wall` });
          r.detail = `no page revealed: signed-out check cap ${LOGIN_GATE_CHECK_CAP} reached before ${path} was checked for a login wall`;
          continue;
        }
        gateChecks++;
        let wall: { wall: boolean; final: string };
        try {
          wall = await loginWall(m.l.href!);
        } catch (err) {
          r.tried.push({ url: target, result: `signed-out load failed (${brief(err)})` });
          r.errored = true;
          r.detail = `no page revealed: the signed-out load of ${path} failed (${brief(err)})`;
          continue;
        }
        if (!wall.wall) {
          // The page loads without a sign-in: it is planned like any other page, as before.
          if (noPage) {
            r.tried.push({ url: target, result: `signed out, ${path} loads without a sign-in` });
            r.detail = `no page revealed: ${path} loads without a sign-in and is linked signed out, so it is not a page behind the sign-in`;
          } else if (r.tried.length === 0) {
            results.delete(name);
          }
          continue;
        }
        gated = true;
        r.errored = false;
        r.tried.push({ url: target, result: `signed out, ${path} ends on ${pathOf(wall.final)}` });
      }
      const rule = robotsRuleFor(robots, path);
      const r = resultFor(name);
      if (rule !== null) {
        r.tried.push({ url: landing, result: `signed in, a link to ${path} is there, but robots.txt disallows ${path}` });
        r.robots = { path, rule };
        r.detail = `no page revealed: signed in on ${pathOf(loginKey)}, robots.txt disallows ${path} (rule Disallow: ${rule})`;
        done.add(name);
        continue;
      }
      if (reveals >= LOGIN_PROBE_REVEAL_CAP) {
        r.tried.push({ url: landing, result: `reveal cap ${LOGIN_PROBE_REVEAL_CAP} reached; ${path} not opened` });
        r.detail = `no page revealed: reveal cap ${LOGIN_PROBE_REVEAL_CAP} reached before ${path} was opened`;
        done.add(name);
        continue;
      }
      await reveal(name, m.l, gated);
      if (r.page) done.add(name);
    }
    // A feature with no page of its own that nothing behind the sign-in names says so.
    for (const f of opts.features) {
      const name = f.feature.name;
      if (f.carriedBy.length > 0 || results.has(name)) continue;
      const r = resultFor(name);
      r.tried.push({ url: landing, result: `signed in, no link on ${pathOf(landing)} names ${name}` });
      r.detail = `no page revealed: signed in on ${pathOf(loginKey)}, no link on ${pathOf(landing)} names ${name}`;
    }

    // No requirements map: the new links are the pages behind the sign-in.
    if (opts.open) {
      const names = (opts.open.names ?? []).map((n) => n.trim()).filter((n) => n.length > 0);
      for (const l of newLinks) {
        if (reveals >= LOGIN_PROBE_REVEAL_CAP) break;
        const target = pageKey(l.href!);
        if (revealedKeys.has(target)) continue;
        const named = names.find((n) => linkTokenMatches(l, tokensFor(n)) > 0);
        if (names.length > 0 && !named) continue;
        if (robotsRuleFor(robots, pathOf(target)) !== null) continue;
        const feature = named ?? featureFromPath(target);
        if (results.get(feature)?.page) continue;
        await reveal(feature, l, false);
      }
    }

    const features = [...results.values()];
    const revealedList = features.filter((f) => f.page).map((f) => `${pathOf(f.page!.url)} (${f.feature})`);
    const newPaths = newLinks.map((l) => pathOf(pageKey(l.href!)));
    const unnamed = newLinks.map((l) => pageKey(l.href!)).filter((k) => !revealedKeys.has(k)).map(pathOf);
    const parts = [
      `Login probe: signed in on ${pathOf(loginKey)}, landed on ${pathOf(landing)}`,
      revealedList.length > 0 ? `revealed ${revealedList.join(', ')}` : 'no page revealed',
      ...(unnamed.length > 0 ? [`${opts.open ? 'also behind the sign-in, not opened' : 'also behind the sign-in, named by no requirements feature'}: ${unnamed.join(', ')}`] : []),
    ];
    return { outcome: 'ok', loginUrl: loginKey, landing, features, newLinks: newPaths, unnamed, line: parts.join('; ') };
  } catch (err) {
    return failAll('error', `the login probe failed (${brief(err) || 'unknown error'})`);
  } finally {
    await handle?.close().catch(() => {});
    await browserClose?.().catch(() => {});
  }
}

/* ── Lines ────────────────────────────────────────────────────────────────── */

/** The actions as a reader follows them: "click an item" for the item hop (with the item link the hop used, when known), else the control. */
export function describeActions(actions: ReachAction[]): string {
  return actions.map((a) => (a.via === 'item-link' ? (a.control ? `click the item ${a.control}` : 'click an item') : a.kind === 'login' ? 'sign in' : a.control ?? a.kind)).join(', ');
}

/** The coverage detail of a revealed-side rule whose revealed page robots.txt disallows (invariant 78). */
export function robotsBlockedRuleDetail(rb: NonNullable<StateProbe['robotsBlocked']>): string {
  return `the action on ${pathOf(rb.origin)} reveals ${rb.path}, which robots.txt disallows (rule Disallow: ${rb.rule}); not loaded`;
}

/**
 * Per rule, the coverage reason a robots-blocked probe gives (invariant 78):
 * a revealed-side rule reads robots-disallowed with the path and the rule; an
 * origin-side rule was planned on the origin, so it reads not-planned when no
 * scenario cites it, never not-revealed. Rules of every other probe are
 * absent. A structural type, so the report's stored probes feed it.
 */
export function probeRuleReasons(stateProbes: Array<Pick<StateProbe, 'robotsBlocked' | 'rulesSplit'>> | undefined): Record<string, { reason: 'robots-disallowed' | 'not-planned'; detail?: string }> {
  const out: Record<string, { reason: 'robots-disallowed' | 'not-planned'; detail?: string }> = {};
  for (const p of stateProbes ?? []) {
    if (!p.robotsBlocked) continue;
    for (const r of p.rulesSplit ?? []) {
      out[r.ruleId] = r.side === 'revealed' ? { reason: 'robots-disallowed', detail: robotsBlockedRuleDetail(p.robotsBlocked) } : { reason: 'not-planned' };
    }
  }
  return out;
}

/**
 * The one console line per probe, printed whole (the CLI exempts it from the
 * message cap). Revealed names the page, the origin and the actions; not
 * revealed names every page and control tried.
 */
export function stateProbeLine(probe: StateProbe, reachedBy?: { actions: ReachAction[] }): string {
  const head = `State probe "${probe.feature}":`;
  if (probe.outcome === 'revealed' && probe.revealed && probe.origins[0]) {
    const from = probe.hop ? `item page ${pathOf(probe.hop.item)}, hopped from listing ${pathOf(probe.hop.listing)}` : pathOf(probe.origins[0]);
    return `${head} revealed ${pathOf(probe.revealed)} from ${from}${reachedBy ? ` (${describeActions(reachedBy.actions)})` : ''}${probe.capped ? `; ${probe.capped}` : ''}`;
  }
  const n = probe.rulesSplit.length;
  const plural = (k: number): string => `rule${k === 1 ? '' : 's'}`;
  // No test account (invariant 88): nothing behind the sign-in was looked for, and the line says so.
  if (probe.outcome === 'no-credentials') {
    return `${head} not looked for behind the sign-in (${probe.detail}); any of its ${n} ${plural(n)} still uncited after planning will report not-revealed`;
  }
  // A robots-blocked reveal found its origin: the origin rules are planned
  // there, and the rest read robots-disallowed, never not-revealed.
  const rb = probe.robotsBlocked;
  const originIds = probe.rulesSplit.filter((r) => r.side === 'origin').map((r) => r.ruleId);
  const where = rb ? (probe.hop ? `item page ${pathOf(probe.hop.item)}, reached from listing ${pathOf(probe.hop.listing)} by a click` : pathOf(rb.origin)) : '';
  const tail = rb
    ? `${originIds.length > 0 ? `its origin ${plural(originIds.length)} ${originIds.join(', ')} ${originIds.length === 1 ? 'is' : 'are'} planned on ${where}; ` : ''}any of its ${n - originIds.length} ${originIds.length > 0 ? 'other ' : ''}${plural(n - originIds.length)} still uncited after planning will report robots-disallowed`
    : `any of its ${n} ${plural(n)} still uncited after planning will report not-revealed`;
  if (probe.outcome === 'error') return `${head} ${probe.detail}; ${tail}`;
  const tried = probe.tried.length > 0
    ? `tried ${probe.tried.map((t) => `${pathOf(t.url)} (${t.result})`).join(', ')}`
    : 'no candidate page to try';
  return `${head} no page revealed; ${tried}${probe.capped ? `; ${probe.capped}` : ''}; ${tail}`;
}

/** The rule split line: every rule id and its side. */
export function rulesSplitLine(probe: Pick<StateProbe, 'feature' | 'rulesSplit'>): string {
  return `State probe "${probe.feature}" rule split: ${probe.rulesSplit.map((r) => `${r.ruleId} ${r.side}`).join(', ') || 'no rules'}`;
}

/* ── All features ─────────────────────────────────────────────────────────── */

/** A feature whose probe revealed a page: the page, its snapshot, and which rules go where. */
export interface RevealedFeature {
  feature: string;
  page: DiscoveredPage & { reachedBy: NonNullable<DiscoveredPage['reachedBy']> };
  snapshot: PageSnapshot;
  originRuleIds: string[];
  revealedRuleIds: string[];
  /** Set when the item hop found the trigger: the item page is the origin, planned from its own snapshot and reached by a click (invariant 78). */
  originPage?: OriginPage;
  /** Set when the page is behind the sign-in (invariant 88): the origin is the login page, which carries none of the feature's rules. */
  viaLogin?: true;
}

/**
 * A feature whose trigger revealed a link robots.txt disallows (invariant
 * 78): nothing is revealed, and the origin rules are still planned on the
 * origin. `origin` is the page a scenario starts on; `originPage` is set when
 * the origin is an item page the hop reached.
 */
export interface BlockedFeature {
  feature: string;
  origin: string;
  originPage?: OriginPage;
  originRuleIds: string[];
  revealedRuleIds: string[];
}

export interface StateProbesResult {
  probes: StateProbe[];
  revealed: RevealedFeature[];
  /** Features whose revealed page robots.txt disallows, each with the origin its origin rules are planned on. */
  blocked: BlockedFeature[];
  /** The console lines, in order: per feature, the probe line then the rule split line; then the login probe's own line. */
  lines: string[];
  /** What the login probe saw, when it ran (invariant 88). */
  loginProbe?: LoginProbeRecord;
}

/** The login probe as the run records it: where it signed in, where it landed, and the links that exist only signed in. */
export interface LoginProbeRecord {
  outcome: LoginProbeResult['outcome'];
  loginUrl?: string;
  landing?: string;
  /** Paths of the same-origin links that appeared only after sign-in. */
  newLinks: string[];
  /** Paths of the pages revealed and planned. */
  revealed: string[];
  /** Paths of the new links no feature claimed. */
  unnamed: string[];
}

/**
 * Detect the state-dependent features and probe each one. Sequential, one
 * feature at a time. With no candidate feature nothing loads and nothing is
 * printed.
 *
 * The login action (invariant 88) runs after the click probes when `login`
 * is given. With a test account the probe signs in once and reveals the
 * pages behind the sign-in: for a requirements map, per feature with rules
 * and no page of its own (or one page that is a login wall); with no map,
 * the links that appear only after sign-in. With no account, a feature with
 * no page whose tokens name an account page is recorded as not looked for
 * (outcome no-credentials), never left as a quiet not-planned. A feature has
 * one probe record: a click probe that revealed nothing and a login probe
 * share it.
 */
export async function runStateProbes(opts: {
  map: RequirementsMap | undefined;
  /** Every candidate the winning rung found, before the filter. */
  candidates: DiscoveredPage[];
  pageControls?: Record<string, PageControl[]>;
  robots?: Pick<RobotsInfo, 'disallow'>;
  featureTokens?: Record<string, string[]>;
  openPage?: ProbePageFactory;
  delayMs?: number;
  revealWaitMs?: number;
  anchorWaitMs?: number;
  settleCapMs?: number;
  /**
   * The login action: the test account when the run has one, else why it has
   * none (`unavailable`: no credentials, or no login page found). `names` is
   * the --features list, read only when there is no requirements map.
   */
  login?: { access?: LoginAccess; unavailable?: string; names?: string[]; signIn?: typeof signInOn };
}): Promise<StateProbesResult> {
  const features = detectStateFeatures(opts.map, opts.candidates, opts.featureTokens);
  const entries: Array<{ probe: StateProbe; reachedBy?: { actions: ReachAction[] } }> = [];
  const revealed: RevealedFeature[] = [];
  const blocked: BlockedFeature[] = [];
  const candidates: ProbeCandidate[] = opts.candidates
    .filter((p) => p.source !== 'action')
    .map((p) => ({ url: p.url, ...(p.volatile ? { volatile: true } : {}), ...(p.linkedFrom ? { linkedFrom: p.linkedFrom } : {}), ...(opts.pageControls?.[p.url] ? { controls: opts.pageControls[p.url] } : {}) }));
  for (const f of features) {
    const r = await probeStateFeature({
      feature: f.feature.name,
      tokens: f.tokens,
      phrases: f.phrases,
      candidates,
      ...(opts.robots ? { robots: opts.robots } : {}),
      ...(opts.openPage ? { openPage: opts.openPage } : {}),
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      ...(opts.revealWaitMs !== undefined ? { revealWaitMs: opts.revealWaitMs } : {}),
      ...(opts.anchorWaitMs !== undefined ? { anchorWaitMs: opts.anchorWaitMs } : {}),
      ...(opts.settleCapMs !== undefined ? { settleCapMs: opts.settleCapMs } : {}),
    });
    const rulesSplit = splitRulesByPage(f.feature.rules, {
      tokens: f.tokens,
      phrases: r.phrase ? [r.phrase] : f.phrases,
      ...(r.snapshot ? { revealedTitle: r.snapshot.title, revealedHeadings: r.snapshot.headings.map((h) => h.label ?? '') } : {}),
    });
    const probe: StateProbe = { ...r.probe, rulesSplit };
    entries.push({ probe, ...(r.page?.reachedBy ? { reachedBy: r.page.reachedBy } : {}) });
    const originRuleIds = rulesSplit.filter((s) => s.side === 'origin').map((s) => s.ruleId);
    const revealedRuleIds = rulesSplit.filter((s) => s.side === 'revealed').map((s) => s.ruleId);
    if (r.page?.reachedBy && r.snapshot) {
      revealed.push({
        feature: f.feature.name,
        page: { ...r.page, reachedBy: r.page.reachedBy },
        snapshot: r.snapshot,
        originRuleIds,
        revealedRuleIds,
        ...(r.originPage ? { originPage: r.originPage } : {}),
      });
    } else if (r.blocked) {
      blocked.push({ feature: f.feature.name, origin: r.blocked.origin, ...(r.blocked.originPage ? { originPage: r.blocked.originPage } : {}), originRuleIds, revealedRuleIds });
    }
  }

  // The login action. A feature the click probe settled (revealed, or its
  // origin found behind robots) is left as it is.
  const settled = new Set([...revealed.map((r) => r.feature), ...blocked.map((b) => b.feature)]);
  const loginFeatures = opts.login ? detectLoginFeatures(opts.map, opts.candidates, opts.featureTokens).filter((f) => !settled.has(f.feature.name)) : [];
  let loginLine: string | undefined;
  let loginProbe: LoginProbeRecord | undefined;
  /** Every rule of a page behind the sign-in is planned on that page: the login page carries none of them. */
  const allRevealed = (f: RequirementFeature): StateProbe['rulesSplit'] => f.rules.map((r) => ({ ruleId: r.id, side: 'revealed' as const }));
  if (opts.login?.access && (loginFeatures.length > 0 || !opts.map)) {
    const lr = await probeLogin({
      access: opts.login.access,
      features: loginFeatures,
      ...(!opts.map ? { open: { ...(opts.login.names ? { names: opts.login.names } : {}) } } : {}),
      candidates,
      ...(opts.robots ? { robots: opts.robots } : {}),
      ...(opts.openPage ? { openPage: opts.openPage } : {}),
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      ...(opts.anchorWaitMs !== undefined ? { anchorWaitMs: opts.anchorWaitMs } : {}),
      ...(opts.settleCapMs !== undefined ? { settleCapMs: opts.settleCapMs } : {}),
      ...(opts.login.signIn ? { signIn: opts.login.signIn } : {}),
    });
    loginLine = lr.line;
    loginProbe = {
      outcome: lr.outcome,
      ...(lr.loginUrl ? { loginUrl: lr.loginUrl } : {}),
      ...(lr.landing ? { landing: lr.landing } : {}),
      newLinks: lr.newLinks,
      revealed: lr.features.filter((f) => f.page).map((f) => pathOf(f.page!.url)),
      unnamed: lr.unnamed,
    };
    const login = lr.loginUrl && lr.landing ? { loginUrl: lr.loginUrl, landing: lr.landing } : undefined;
    for (const fr of lr.features) {
      const mapped = loginFeatures.find((f) => f.feature.name === fr.feature);
      const rulesSplit = mapped ? allRevealed(mapped.feature) : [];
      const existing = entries.find((e) => e.probe.feature === fr.feature);
      if (fr.page && fr.snapshot) {
        const probe: StateProbe = {
          feature: fr.feature,
          outcome: 'revealed',
          origins: [fr.page.reachedBy.origin],
          tried: [...(existing?.probe.tried ?? []), ...fr.tried],
          revealed: fr.page.url,
          detail: fr.detail,
          rulesSplit,
          ...(login ? { login: { ...login, ...(fr.gated ? { gated: true } : {}) } } : {}),
        };
        if (existing) { existing.probe = probe; existing.reachedBy = fr.page.reachedBy; } else entries.push({ probe, reachedBy: fr.page.reachedBy });
        revealed.push({ feature: fr.feature, page: fr.page, snapshot: fr.snapshot, originRuleIds: [], revealedRuleIds: rulesSplit.map((s) => s.ruleId), viaLogin: true });
        continue;
      }
      if (existing) {
        // The click probe revealed nothing and neither did the sign-in: one record says both.
        existing.probe = {
          ...existing.probe,
          tried: [...existing.probe.tried, ...fr.tried],
          detail: `${existing.probe.detail}; behind the sign-in: ${fr.detail.replace(/^no page revealed: /, '')}`,
          ...(login ? { login } : {}),
        };
        continue;
      }
      entries.push({
        probe: {
          feature: fr.feature,
          outcome: fr.robots ? 'robots' : fr.errored ? 'error' : 'no-new-link',
          origins: [],
          tried: fr.tried,
          detail: fr.detail,
          rulesSplit,
          ...(fr.robots && login ? { robotsBlocked: { origin: login.loginUrl, path: fr.robots.path, rule: fr.robots.rule } } : {}),
          ...(login ? { login } : {}),
        },
      });
    }
  } else if (opts.login && !opts.login.access) {
    const why = opts.login.unavailable ?? 'test credentials not provided';
    for (const f of loginFeatures) {
      if (f.carriedBy.length > 0 || !f.gatedTokens) continue;
      const existing = entries.find((e) => e.probe.feature === f.feature.name);
      if (existing) {
        existing.probe = { ...existing.probe, detail: `${existing.probe.detail}; not looked for behind the sign-in (${why})` };
        continue;
      }
      entries.push({ probe: { feature: f.feature.name, outcome: 'no-credentials', origins: [], tried: [], detail: why, rulesSplit: allRevealed(f.feature) } });
    }
  }

  const lines: string[] = [];
  for (const e of entries) {
    lines.push(stateProbeLine(e.probe, e.reachedBy));
    // A page filed with no requirements map has no rules to split.
    if (opts.map) lines.push(rulesSplitLine(e.probe));
  }
  if (loginLine) lines.push(loginLine);
  return { probes: entries.map((e) => e.probe), revealed, blocked, lines, ...(loginProbe ? { loginProbe } : {}) };
}
